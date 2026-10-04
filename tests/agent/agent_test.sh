#!/usr/bin/env bash
# VPSWatch agent test suite. Runs on macOS and Linux: every kernel input is a
# fixture under a temp dir, curl/date are faked. Pure bash assertions.
set -u
cd "$(dirname "$0")/../.."
AGENT="agent/vpswatch-agent.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok - $1"; }
fail() { FAIL=$((FAIL+1)); echo "NOT OK - $1: $2"; }
assert_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}
finish() {
  echo "passed: $PASS, failed: $FAIL"
  [ "$FAIL" -eq 0 ]
}

TMP="$(mktemp -d /tmp/vw-agent-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# ---- fixtures ------------------------------------------------------------
PROC="$TMP/proc"
mkdir -p "$PROC/net"

write_stat() { printf 'cpu  %s 0 100 700 0 0 0 0 0 0\ncpu0 50 0 50 350 0 0 0 0 0 0\n' "$1" > "$PROC/stat"; }
write_stat 100   # totals: user 100 + sys 100 + idle 700 = 900, idle+iowait = 700
cat > "$PROC/meminfo" <<'EOF'
MemTotal:       4000000 kB
MemFree:         800000 kB
MemAvailable:   1000000 kB
Buffers:         100000 kB
Cached:          300000 kB
SwapTotal:      2000000 kB
SwapFree:       1500000 kB
EOF
printf '12345.67 49000.00\n' > "$PROC/uptime"
printf '0.10 0.20 0.30 1/100 1234\n' > "$PROC/loadavg"
cat > "$PROC/net/dev" <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000      10    0    0    0     0          0         0        1000      10    0    0    0     0       0          0
  eth0: 5000      40    0    0    0     0          0         0        3000      30    0    0    0     0       0          0
EOF
cat > "$PROC/net/tcp" <<'EOF'
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1
   1: 0100007F:A4C0 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 1 2
   2: 0100007F:A4C1 0100007F:1F90 06 00000000:00000000 00:00000000 00000000  1000        0 1 3
EOF
: > "$PROC/net/tcp6"
mkdir -p "$PROC/1" "$PROC/42"   # two fake process dirs

cat > "$TMP/fake-df" <<'EOF'
#!/usr/bin/env bash
# mimic df -kP <mount>
echo "Filesystem 1024-blocks     Used Available Capacity Mounted on"
echo "/dev/vda1      40960000 10240000 30720000      25% /"
EOF
chmod +x "$TMP/fake-df"

cat > "$TMP/fake-curl-ok" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo "args: $*" >> "$FAKE_CURL_LOG"
exit 0
EOF
chmod +x "$TMP/fake-curl-ok"

# records stdin (curl -K - reads the config from there) without leaking it to logs
cat > "$TMP/fake-curl-stdin" <<'EOF'
#!/usr/bin/env bash
cat > "$FAKE_CURL_STDIN"
echo "args: $*" >> "$FAKE_CURL_LOG"
exit 0
EOF
chmod +x "$TMP/fake-curl-stdin"

cat > "$TMP/fake-curl-fail" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
exit 7
EOF
chmod +x "$TMP/fake-curl-fail"

make_date() { # current day number -> emits +Y%m%d / +Y%m / +%s
  local day="$1"
  cat > "$TMP/fake-date" <<EOF
#!/usr/bin/env bash
case "\$1" in
  +%Y%m%d) echo "$day" ;;
  +%Y%m)   echo "${day:0:6}" ;;
  +%s)     echo "1800000000" ;;
  *)       echo "unknown" ;;
esac
EOF
  chmod +x "$TMP/fake-date"
}

make_date 20260101

HOSTNM="$TMP/hostname-bin"
printf '#!/usr/bin/env bash\necho web-1\n' > "$HOSTNM"; chmod +x "$HOSTNM"
CORES="$TMP/cores-bin"
printf '#!/usr/bin/env bash\necho 4\n' > "$CORES"; chmod +x "$CORES"

# jget FILE EXPR -> value via node
jget() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let v = d;
    for (const k of path) v = v?.[k];
    console.log(v === undefined ? "undefined" : v);
  ' "$1" "$2"
}

run_print() {
  ( export PROC STATE_FILE="$TMP/state" DF_CMD="$TMP/fake-df" CURL_CMD="$TMP/fake-curl-ok"
    export DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES" VERSION_OVERRIDE=1
    unset SERVER_URL TOKEN
    bash "$AGENT" --print-payload 2>"$TMP/err.log" )
}

# ---- 1. syntax ------------------------------------------------------------
if bash -n "$AGENT" 2>"$TMP/syn.err"; then ok "bash -n syntax"; else fail "bash -n syntax" "$(cat "$TMP/syn.err")"; fi

# ---- 2. print-payload parses, required keys present -----------------------
run_print > "$TMP/p1.json"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP/p1.json" 2>"$TMP/json.err"; then
  ok "payload is valid JSON"
else
  fail "payload is valid JSON" "$(cat "$TMP/json.err")"
fi
assert_eq "hostname"         "web-1"        "$(jget "$TMP/p1.json" hostname)"
assert_eq "cpu.cores"        "4"            "$(jget "$TMP/p1.json" cpu.cores)"
assert_eq "cpu.usage_pct first run" "0"  "$(jget "$TMP/p1.json" cpu.usage_pct)"
assert_eq "mem.total bytes"  "4096000000"   "$(jget "$TMP/p1.json" mem.total)"       # 4000000 kB * 1024
assert_eq "mem.used bytes"   "3072000000"   "$(jget "$TMP/p1.json" mem.used)"        # 4000000-1000000 avail
assert_eq "mem.swap_used"    "512000000"    "$(jget "$TMP/p1.json" mem.swap_used)"   # 2000000-1500000
assert_eq "load1"            "0.1"          "$(jget "$TMP/p1.json" cpu.load1)"
assert_eq "net.rx_bytes"     "5000"         "$(jget "$TMP/p1.json" net.rx_bytes)"
assert_eq "net.tx_bytes"     "3000"         "$(jget "$TMP/p1.json" net.tx_bytes)"
assert_eq "tcp_conns"        "1"            "$(jget "$TMP/p1.json" tcp_conns)"
assert_eq "processes"        "2"            "$(jget "$TMP/p1.json" processes)"       # cpu0 + cpu lines? see note
assert_eq "uptime"           "12345.67"     "$(jget "$TMP/p1.json" uptime)"
assert_eq "disk.mount"       "/"            "$(jget "$TMP/p1.json" disks.0.mount)"
assert_eq "disk.total"       "41943040000"  "$(jget "$TMP/p1.json" disks.0.total)"   # 40960000 kB * 1024

# ---- 3. cpu differential via state ----------------------------------------
write_stat 200   # total 1000, busy delta = (1000-700)-(900-700) = 100 of 100 -> 100%
run_print > "$TMP/p2.json"
assert_eq "cpu.usage_pct second run" "100" "$(jget "$TMP/p2.json" cpu.usage_pct)"

# ---- 4. net/traffic ledger across days ------------------------------------
# state after two runs: prev_rx=5000, day=20260101, daily_* unchanged (first run added nothing)
assert_eq "daily_rx same day" "0" "$(jget "$TMP/p2.json" daily_rx)"
sed -i '' 's/  eth0: 5000/  eth0: 7000/' "$PROC/net/dev" 2>/dev/null || sed -i 's/  eth0: 5000/  eth0: 7000/' "$PROC/net/dev"
run_print > "$TMP/p3.json"
assert_eq "daily_rx accumulates 2000" "2000" "$(jget "$TMP/p3.json" daily_rx)"
assert_eq "net.rx_bytes 7000" "7000" "$(jget "$TMP/p3.json" net.rx_bytes)"

make_date 20260102
sed -i '' 's/  eth0: 7000/  eth0: 9000/' "$PROC/net/dev" 2>/dev/null || sed -i 's/  eth0: 7000/  eth0: 9000/' "$PROC/net/dev"
run_print > "$TMP/p4.json"
assert_eq "daily resets on new day" "2000" "$(jget "$TMP/p4.json" daily_rx)"

# counter rollback (reboot): delta counts as 0
sed -i '' 's/  eth0: 9000/  eth0: 100/' "$PROC/net/dev" 2>/dev/null || sed -i 's/  eth0: 9000/  eth0: 100/' "$PROC/net/dev"
run_print > "$TMP/p5.json"
assert_eq "rollback keeps daily at 2000" "2000" "$(jget "$TMP/p5.json" daily_rx)"
assert_eq "rollback reports cur rx" "100" "$(jget "$TMP/p5.json" net.rx_bytes)"

# ---- 5. config validation and curl failures --------------------------------
( export PROC="$PROC" STATE_FILE="$TMP/state2" DF_CMD="$TMP/fake-df" CURL_CMD="$TMP/fake-curl-ok"
  export DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  unset SERVER_URL TOKEN
  bash "$AGENT" --once >/dev/null 2>&1 )
assert_eq "missing config exit code 1" "1" "$?"

( export SERVER_URL="http://127.0.0.1:1" TOKEN="abc" PROC="$PROC" STATE_FILE="$TMP/state3"
  export DF_CMD="$TMP/fake-df" CURL_CMD="$TMP/fake-curl-fail" DATE_CMD="$TMP/fake-date"
  export HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  bash "$AGENT" --once >/dev/null 2>&1 )
assert_eq "curl failure exit code 2" "2" "$?"

FAKE_CURL_LOG="$TMP/curl.log"
export FAKE_CURL_LOG
FAKE_CURL_STDIN="$TMP/curl-stdin.txt"
export FAKE_CURL_STDIN
: > "$FAKE_CURL_LOG"; : > "$FAKE_CURL_STDIN"
( export SERVER_URL="http://127.0.0.1:1" TOKEN="abc123" PROC="$PROC" STATE_FILE="$TMP/state4"
  export DF_CMD="$TMP/fake-df" CURL_CMD="$TMP/fake-curl-stdin" DATE_CMD="$TMP/fake-date"
  export HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  bash "$AGENT" --once >/dev/null 2>&1 )
assert_eq "curl success exit code 0" "0" "$?"
grep -q "api/agent/report" "$TMP/curl.log" && ok "posts to /api/agent/report" || fail "posts to /api/agent/report" "$(cat "$TMP/curl.log" 2>/dev/null)"
grep -q -- "-H" "$TMP/curl.log" && ok "sends headers" || fail "sends headers" "no -H found"
grep -q 'Authorization: Bearer abc123' "$FAKE_CURL_STDIN" && ok "token reaches curl via stdin config" || fail "token via stdin" "$(cat "$FAKE_CURL_STDIN" 2>/dev/null)"
if grep -q 'abc123' "$TMP/curl.log"; then
  fail "token stays off argv" "token leaked into process args"
else
  ok "token stays off argv"
fi

# ---- 6. degraded environments must not crash (set -u) ----------------------
mkdir -p "$TMP/empty-proc"
( export PROC="$TMP/empty-proc" STATE_FILE="$TMP/state-emptyp" DF_CMD="$TMP/fake-df"
  export CURL_CMD="$TMP/fake-curl-ok" DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  unset SERVER_URL TOKEN
  bash "$AGENT" --print-payload 2>"$TMP/err-empty.log" )
assert_eq "empty /proc still prints payload, exit 0" "0" "$?"
grep -qi '不可读' "$TMP/err-empty.log" 2>/dev/null && ok "missing /proc produces a one-time diagnostic" || fail "/proc diagnostic" "$(cat "$TMP/err-empty.log" 2>/dev/null | head -2)"

( export PROC="$TMP/empty-proc" STATE_FILE="$TMP/nonexistent-dir/state" DF_CMD="$TMP/fake-df"
  export CURL_CMD="$TMP/fake-curl-ok" DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  unset SERVER_URL TOKEN
  bash "$AGENT" --print-payload 2>/dev/null )
assert_eq "unwritable state dir still prints payload, exit 0" "0" "$?"

# ---- 7. corrupted state file degrades safely (iteration 1 finding 7) -------
mkdir -p "$TMP/corrupt"
printf 'prev_rx=abc\nprev_tx=\ncorruptline\nprev_cpu_total=xyz\nday=garbage\nmonth=1\n' > "$TMP/corrupt/state"
( export PROC="$PROC" STATE_FILE="$TMP/corrupt/state" DF_CMD="$TMP/fake-df"
  export CURL_CMD="$TMP/fake-curl-ok" DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  unset SERVER_URL TOKEN
  bash "$AGENT" --print-payload >"$TMP/corrupt-payload.json" 2>/dev/null )
assert_eq "corrupted state still prints payload, exit 0" "0" "$?"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP/corrupt-payload.json" 2>/dev/null; then
  ok "corrupted state yields valid JSON"
else
  fail "corrupted state yields valid JSON" "unparseable payload"
fi
assert_eq "corrupted state resets daily ledger" "0" "$(jget "$TMP/corrupt-payload.json" daily_rx)"
assert_eq "corrupted state resets cpu to first-sample" "0" "$(jget "$TMP/corrupt-payload.json" cpu.usage_pct)"

# ---- 8. INTERVAL from conf/env is clamped (iteration 1 finding 4) ----------
( export PROC="$PROC" STATE_FILE="$TMP/state-clamp" DF_CMD="$TMP/fake-df"
  export CURL_CMD="$TMP/fake-curl-ok" DATE_CMD="$TMP/fake-date" HOSTNAME_CMD="$HOSTNM" CORES_CMD="$CORES"
  export INTERVAL=abc
  unset SERVER_URL TOKEN
  bash "$AGENT" --print-payload >/dev/null 2>&1 )
assert_eq "INTERVAL=abc does not crash" "0" "$?"

finish
