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
  local line
  line=$(head -n 1 "$PROC/stat" 2>/dev/null) || return 1
  # fields: user nice system idle iowait irq softirq steal guest guest_nice
  local total idle iowait
  total=$(echo "$line" | awk '{s=0; for (i=2; i<=NF; i++) s+=$i; print s}')
  idle=$(echo "$line" | awk '{print $5}')
  iowait=$(echo "$line" | awk '{print $6}')
  CPU_TOTAL="$total"
  CPU_IDLE=$(( idle + iowait ))
}

read_mem() { # sets MEM_TOTAL MEM_USED SWAP_TOTAL SWAP_USED (bytes)
  local mt av st sf
  mt=$(awk '/^MemTotal:/ {print $2}' "$PROC/meminfo" 2>/dev/null)
  av=$(awk '/^MemAvailable:/ {print $2}' "$PROC/meminfo" 2>/dev/null)
  st=$(awk '/^SwapTotal:/ {print $2}' "$PROC/meminfo" 2>/dev/null)
  sf=$(awk '/^SwapFree:/ {print $2}' "$PROC/meminfo" 2>/dev/null)
  [ -z "$mt" ] && { MEM_TOTAL=""; return; }
  MEM_TOTAL=$(( mt * 1024 ))
  if [ -z "$av" ]; then
    local fr buf cach
    fr=$(awk '/^MemFree:/ {print $2}' "$PROC/meminfo")
    buf=$(awk '/^Buffers:/ {print $2}' "$PROC/meminfo")
    cach=$(awk '/^Cached:/ {print $2}' "$PROC/meminfo")
    av=$(( fr + buf + cach ))
  fi
  MEM_USED=$(( (mt - av) * 1024 ))
  if [ -n "$st" ]; then
    SWAP_TOTAL=$(( st * 1024 ))
    SWAP_USED=$(( (st - sf) * 1024 ))
  else
    SWAP_TOTAL=""; SWAP_USED=""
  fi
}

read_load() { # LOAD1 LOAD5 LOAD15
  local line
  line=$(head -n 1 "$PROC/loadavg" 2>/dev/null) || { LOAD1=""; return; }
  LOAD1=$(echo "$line" | cut -d' ' -f1)
  LOAD5=$(echo "$line" | cut -d' ' -f2)
  LOAD15=$(echo "$line" | cut -d' ' -f3)
}

read_uptime() { # UPTIME seconds
  UPTIME=$(cut -d' ' -f1 "$PROC/uptime" 2>/dev/null)
}

read_net() { # sums non-lo interfaces; sets NET_RX NET_TX (bytes)
  local rx=0 tx=0 iface line rxv txv
  if [ -r "$PROC/net/dev" ]; then
    while IFS= read -r line; do
      case "$line" in
        *'|'*) continue ;;                     # header
      esac
      iface="${line%%:*}"
      iface=$(echo "$iface" | tr -d ' ')
      [ "$iface" = "lo" ] && continue
      line="${line#*:}"
      rxv=$(echo "$line" | awk '{print $1}')
      txv=$(echo "$line" | awk '{print $9}')
      case "$rxv" in (*[!0-9]*|'') continue ;; esac
      case "$txv" in (*[!0-9]*|'') continue ;; esac
      rx=$(( rx + rxv ))
      tx=$(( tx + txv ))
    done < "$PROC/net/dev"
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
    size=$(echo "$line" | awk '{print $2 * 1024}')
    used=$(echo "$line" | awk '{print $3 * 1024}')
    case "$size" in (*[!0-9]*|'') continue ;; esac
    parts="$parts{\"mount\":\"$m\",\"total\":$size,\"used\":$used},"
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

delta_guard() { # prints delta or 0 on counter rollback/first sample
  local prev="$1" cur="$2"
  if [ -z "$prev" ]; then echo 0; return; fi
  if [ "$cur" -lt "$prev" ]; then echo 0; return; fi
  echo $(( cur - prev ))
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
  MONTH=$("$DATE_CMD" +%Y%m)

  load_state

  # cpu usage vs previous sample
  if [ -n "$prev_cpu_total" ] && [ -n "$CPU_TOTAL" ] && [ "$CPU_TOTAL" -gt "$prev_cpu_total" ]; then
    CPU_PCT=$(awk -v t="$CPU_TOTAL" -v pt="$prev_cpu_total" -v i="$CPU_IDLE" -v pi="$prev_cpu_idle" \
      'BEGIN { d = t - pt; busy = d - (i - pi); if (busy < 0) busy = 0; printf "%.1f", (busy / d) * 100 }')
  else
    CPU_PCT="0.0"
  fi

  # traffic ledger
  if [ "$day" != "$TODAY" ]; then daily_rx=0; daily_tx=0; fi
  if [ "$month" != "$MONTH" ]; then monthly_rx=0; monthly_tx=0; fi
  daily_rx=$(( daily_rx + $(delta_guard "$prev_rx" "$NET_RX") ))
  daily_tx=$(( daily_tx + $(delta_guard "$prev_tx" "$NET_TX") ))
  monthly_rx=$(( monthly_rx + $(delta_guard "$prev_rx" "$NET_RX") ))
  monthly_tx=$(( monthly_tx + $(delta_guard "$prev_tx" "$NET_TX") ))

  save_state
}

build_json() {
  local swap_pair="" load_pair=""
  [ -n "$SWAP_TOTAL" ] && swap_pair="\"swap_total\":$SWAP_TOTAL,\"swap_used\":${SWAP_USED:-0},"
  [ -n "${LOAD1:-}" ] && load_pair=",\"load1\":${LOAD1:-0},\"load5\":${LOAD5:-0},\"load15\":${LOAD15:-0}"
  printf '{"hostname":"%s","version":"%s","uptime":%s,"cpu":{"usage_pct":%s,"cores":%s%s},"mem":{%s"total":%s,"used":%s},"disks":%s,"net":{"rx_bytes":%s,"tx_bytes":%s},"daily_rx":%s,"daily_tx":%s,"monthly_rx":%s,"monthly_tx":%s,"tcp_conns":%s,"processes":%s,"ts":%s}' \
    "$HOSTNAME_OUT" "$VERSION" "${UPTIME:-0}" "$CPU_PCT" "$CORES" "$load_pair" \
    "$swap_pair" "${MEM_TOTAL:-0}" "${MEM_USED:-0}" \
    "$DISKS_JSON" "$NET_RX" "$NET_TX" \
    "$daily_rx" "$daily_tx" "$monthly_rx" "$monthly_tx" \
    "${TCP_CONNS:-0}" "${PROCS:-0}" "$("$DATE_CMD" +%s)"
}

report() {
  local json="$1"
  "$CURL_CMD" -sf -m 5 -X POST \
    -H "Authorization: Bearer $TOKEN" \
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
      sleep "$INTERVAL"
    done
    ;;
esac
