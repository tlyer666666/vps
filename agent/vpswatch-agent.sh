#!/usr/bin/env bash
# VPSWatch agent — collects Linux metrics from /proc and pushes them to the hub.
# Zero dependencies beyond bash, coreutils and curl. Every kernel path and
# external command is overridable via environment (also how the tests drive it).
#
# Usage: vpswatch-agent.sh [--once|--print-payload]
#   (default)      loop forever, sampling and reporting every INTERVAL seconds
#   --once         sample and report once; exit 0 on success, 2 on report failure
#   --print-payload  sample and print the JSON payload (updates local state)
# Exit codes: 0 ok, 1 configuration missing, 2 report failure (--once)
set -u

CONF_FILE="${VPSWATCH_CONF:-/etc/vpswatch/agent.conf}"
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

SERVER_URL="${SERVER_URL:-}"
TOKEN="${TOKEN:-}"
INTERVAL="${INTERVAL:-10}"
# A broken interval from a hand-edited conf must not turn the loop into a
# sample/report spin loop — clamp to a sane default instead.
case "$INTERVAL" in (*[!0-9]*|'') INTERVAL=10 ;; esac
[ "$INTERVAL" -ge 1 ] 2>/dev/null || INTERVAL=10
PROC="${PROC:-/proc}"
STATE_FILE="${STATE_FILE:-/var/lib/vpswatch/state}"
DF_CMD="${DF_CMD:-df}"
CURL_CMD="${CURL_CMD:-curl}"
DATE_CMD="${DATE_CMD:-date}"
HOSTNAME_CMD="${HOSTNAME_CMD:-hostname}"
CORES_CMD="${CORES_CMD:-getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1}"
MOUNTS="${MOUNTS:-}"
VERSION="${AGENT_VERSION:-1.0.0}"

MODE="${1:-loop}"

log() { echo "vpswatch-agent: $*" >&2; }

die_config() {
  log "SERVER_URL and TOKEN must be set (env or $CONF_FILE)"
  exit 1
}

# ---- collectors ------------------------------------------------------------

read_cpu_counters() { # sets CPU_TOTAL CPU_IDLE from the aggregate "cpu" line
  [ -r "$PROC/stat" ] || return 1
  # one awk pass: total = sum of all fields, idle = idle + iowait
  read -r CPU_TOTAL CPU_IDLE <<< "$(awk 'NR==1 { t=0; for (i=2; i<=NF; i++) t+=$i; print t, $5+$6 }' "$PROC/stat" 2>/dev/null)"
  [ -n "$CPU_TOTAL" ] || return 1
}

read_mem() { # sets MEM_TOTAL MEM_USED SWAP_TOTAL SWAP_USED (bytes)
  [ -r "$PROC/meminfo" ] || { MEM_TOTAL=""; return; }
  # one awk pass; MemAvailable falls back to Free+Buffers+Cached in-kernel-style
  read -r mt av st sf <<< "$(awk '
    /^MemTotal:/      { mt = $2 }
    /^MemAvailable:/  { av = $2; avf = 1 }
    /^MemFree:/       { fr = $2 }
    /^Buffers:/       { buf = $2 }
    /^Cached:/        { cch = $2 }
    /^SwapTotal:/     { st = $2 }
    /^SwapFree:/      { sf = $2 }
    END { if (!avf) av = fr + buf + cch; print mt + 0, av + 0, st + 0, sf + 0 }
  ' "$PROC/meminfo" 2>/dev/null)"
  [ -n "$mt" ] && [ "$mt" -gt 0 ] 2>/dev/null || { MEM_TOTAL=""; return; }
  MEM_TOTAL=$(( mt * 1024 ))
  MEM_USED=$(( (mt - av) * 1024 ))
  if [ "$st" -gt 0 ] 2>/dev/null; then
    SWAP_TOTAL=$(( st * 1024 ))
    SWAP_USED=$(( (st - sf) * 1024 ))
  else
    SWAP_TOTAL=""; SWAP_USED=""
  fi
}

read_load() { # LOAD1 LOAD5 LOAD15 — pure bash, no subprocesses
  [ -r "$PROC/loadavg" ] || { LOAD1=""; return; }
  read -r LOAD1 LOAD5 LOAD15 _ < "$PROC/loadavg"
}

read_uptime() { # UPTIME seconds
  UPTIME=$(cut -d' ' -f1 "$PROC/uptime" 2>/dev/null)
}

read_net() { # sums non-lo interfaces; sets NET_RX NET_TX (bytes) — one awk pass
  local rx=0 tx=0
  if [ -r "$PROC/net/dev" ]; then
    read -r rx tx <<< "$(awk -F: '
      NF > 1 {
        n = $1; gsub(/ /, "", n)
        if (n != "lo") {
          split($2, a, " ")
          if (a[1] ~ /^[0-9]+$/ && a[9] ~ /^[0-9]+$/) { rx += a[1]; tx += a[9] }
        }
      }
      END { print rx + 0, tx + 0 }
    ' "$PROC/net/dev" 2>/dev/null)"
  fi
  NET_RX="$rx"
  NET_TX="$tx"
}

read_tcp() { # established connections across tcp/tcp6; TCP_CONNS
  local n=0
  local f
  for f in "$PROC/net/tcp" "$PROC/net/tcp6"; do
    if [ -r "$f" ]; then
      local c
      c=$(awk '$4 == "01" {c++} END {print c+0}' "$f")
      n=$(( n + c ))
    fi
  done
  TCP_CONNS="$n"
}

count_procs() { # number of processes = numeric dirs in $PROC
  local n=0
  local d
  for d in "$PROC"/[0-9]*; do
    [ -d "$d" ] && n=$(( n + 1 ))
  done
  PROCS="$n"
}

read_disks() { # builds DISKS_JSON for / and $MOUNTS
  local parts="" m size used line
  for m in / $MOUNTS; do
    line=$("$DF_CMD" -kP "$m" 2>/dev/null | tail -n 1)
    [ -z "$line" ] && continue
    read -r _ size used _ <<< "$line"
    case "$size" in (*[!0-9]*|'') continue ;; esac
    case "$used" in (*[!0-9]*|'') continue ;; esac
    parts="$parts{\"mount\":\"$m\",\"total\":$((size * 1024)),\"used\":$((used * 1024))},"
  done
  parts="${parts%,}"
  DISKS_JSON="[$parts]"
}

# ---- traffic ledger (survives hub restarts; state lives on the VPS) --------

load_state() {
  prev_cpu_total=""; prev_cpu_idle=""; prev_rx=""; prev_tx=""
  day=""; daily_rx=0; daily_tx=0; month=""; monthly_rx=0; monthly_tx=0
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
    # A hand-edited or corrupt state file must degrade to first-sample
    # behavior, never feed garbage into arithmetic (crash loop under set -u).
    case "$prev_cpu_total" in (*[!0-9]*|'') prev_cpu_total="" ;; esac
    case "$prev_cpu_idle" in (*[!0-9]*|'') prev_cpu_idle="" ;; esac
    case "$prev_rx" in (*[!0-9]*|'') prev_rx="" ;; esac
    case "$prev_tx" in (*[!0-9]*|'') prev_tx="" ;; esac
    case "$day" in (*[!0-9]*|'') day="" ;; esac
    case "$month" in (*[!0-9]*|'') month="" ;; esac
    case "$daily_rx" in (*[!0-9]*|'') daily_rx=0 ;; esac
    case "$daily_tx" in (*[!0-9]*|'') daily_tx=0 ;; esac
    case "$monthly_rx" in (*[!0-9]*|'') monthly_rx=0 ;; esac
    case "$monthly_tx" in (*[!0-9]*|'') monthly_tx=0 ;; esac
  fi
}

save_state() {
  local dir
  dir=$(dirname "$STATE_FILE")
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "cannot create state dir $dir; traffic ledger disabled"
    return
  fi
  local tmp="$STATE_FILE.tmp.$$"
  if ! cat > "$tmp" <<EOF
prev_cpu_total=$CPU_TOTAL
prev_cpu_idle=$CPU_IDLE
prev_rx=$NET_RX
prev_tx=$NET_TX
day=$TODAY
daily_rx=$daily_rx
daily_tx=$daily_tx
month=$MONTH
monthly_rx=$monthly_rx
monthly_tx=$monthly_tx
EOF
  then
    log "cannot write state file $STATE_FILE; traffic ledger disabled"
    rm -f "$tmp"
    return
  fi
  mv -f "$tmp" "$STATE_FILE"
}

# ---- sampling and payload --------------------------------------------------

sample() {
  # defensive defaults: degraded /proc must degrade the payload, never crash
  HOSTNAME_OUT=""; CORES=1
  CPU_TOTAL=""; CPU_IDLE=""; CPU_PCT="0.0"
  MEM_TOTAL=""; MEM_USED=""; SWAP_TOTAL=""; SWAP_USED=""
  LOAD1=""; LOAD5=""; LOAD15=""; UPTIME=""
  NET_RX=0; NET_TX=0; TCP_CONNS=0; PROCS=0; DISKS_JSON="[]"

  HOSTNAME_OUT=$("$HOSTNAME_CMD" 2>/dev/null | head -n 1)
  case "$HOSTNAME_OUT" in (*[!A-Za-z0-9._-]*) HOSTNAME_OUT="" ;; esac
  CORES=$("$CORES_CMD" 2>/dev/null | head -n 1)
  case "$CORES" in (*[!0-9]*|'') CORES=1 ;; esac

  read_cpu_counters || { CPU_TOTAL=""; CPU_IDLE=""; }
  read_mem
  read_load
  read_uptime
  read_net
  read_tcp
  count_procs
  read_disks

  TODAY=$("$DATE_CMD" +%Y%m%d)
  MONTH="${TODAY:0:6}"   # same clock, no second date subprocess

  load_state

  # cpu usage vs previous sample
  if [ -n "$prev_cpu_total" ] && [ -n "$CPU_TOTAL" ] && [ "$CPU_TOTAL" -gt "$prev_cpu_total" ]; then
    CPU_PCT=$(awk -v t="$CPU_TOTAL" -v pt="$prev_cpu_total" -v i="$CPU_IDLE" -v pi="$prev_cpu_idle" \
      'BEGIN { d = t - pt; busy = d - (i - pi); if (busy < 0) busy = 0; printf "%.1f", (busy / d) * 100 }')
  else
    CPU_PCT="0.0"
  fi

  # traffic ledger — delta computed inline (no subshell forks)
  if [ "$day" != "$TODAY" ]; then daily_rx=0; daily_tx=0; fi
  if [ "$month" != "$MONTH" ]; then monthly_rx=0; monthly_tx=0; fi
  delta=0
  if [ -n "$prev_rx" ] && [ "$NET_RX" -ge "$prev_rx" ]; then delta=$(( NET_RX - prev_rx )); fi
  daily_rx=$(( daily_rx + delta ))
  monthly_rx=$(( monthly_rx + delta ))
  delta=0
  if [ -n "$prev_tx" ] && [ "$NET_TX" -ge "$prev_tx" ]; then delta=$(( NET_TX - prev_tx )); fi
  daily_tx=$(( daily_tx + delta ))
  monthly_tx=$(( monthly_tx + delta ))

  save_state
}

build_json() {
  local swap_pair="" load_pair="" host_pair=""
  [ -n "$SWAP_TOTAL" ] && swap_pair="\"swap_total\":$SWAP_TOTAL,\"swap_used\":${SWAP_USED:-0},"
  [ -n "${LOAD1:-}" ] && load_pair=",\"load1\":${LOAD1:-0},\"load5\":${LOAD5:-0},\"load15\":${LOAD15:-0}"
  [ -n "$HOSTNAME_OUT" ] && host_pair="\"hostname\":\"$HOSTNAME_OUT\","
  printf '{%s"version":"%s","uptime":%s,"cpu":{"usage_pct":%s,"cores":%s%s},"mem":{%s"total":%s,"used":%s},"disks":%s,"net":{"rx_bytes":%s,"tx_bytes":%s},"daily_rx":%s,"daily_tx":%s,"monthly_rx":%s,"monthly_tx":%s,"tcp_conns":%s,"processes":%s,"ts":%s}' \
    "$host_pair" "$VERSION" "${UPTIME:-0}" "$CPU_PCT" "$CORES" "$load_pair" \
    "$swap_pair" "${MEM_TOTAL:-0}" "${MEM_USED:-0}" \
    "$DISKS_JSON" "$NET_RX" "$NET_TX" \
    "$daily_rx" "$daily_tx" "$monthly_rx" "$monthly_tx" \
    "${TCP_CONNS:-0}" "${PROCS:-0}" "$("$DATE_CMD" +%s)"
}

report() {
  local json="$1"
  # Token reaches curl via stdin config (-K -) so it never appears in
  # /proc/*/cmdline (ps) where any local user could read it.
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
    | "$CURL_CMD" -K - -sf -m 5 -X POST \
      -H "Content-Type: application/json" \
      --data "$json" \
      "$SERVER_URL/api/agent/report" >/dev/null
}

case "$MODE" in
  --print-payload)
    sample
    build_json
    ;;
  --once)
    [ -n "$SERVER_URL" ] && [ -n "$TOKEN" ] || die_config
    sample
    if report "$(build_json)"; then
      exit 0
    fi
    log "report failed (will retry next interval)"
    exit 2
    ;;
  *)
    [ -n "$SERVER_URL" ] && [ -n "$TOKEN" ] || die_config
    log "starting: reporting to $SERVER_URL every ${INTERVAL}s"
    while :; do
      sample
      if ! report "$(build_json)"; then
        log "report failed (will retry next interval)"
      fi
      sleep "$INTERVAL" 2>/dev/null || sleep 10
    done
    ;;
esac
