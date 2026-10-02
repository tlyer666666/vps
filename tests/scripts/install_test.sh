#!/usr/bin/env bash
# Install-script tests. Everything runs against a temp PREFIX, no root needed.
set -u
cd "$(dirname "$0")/../.."

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok - $1"; }
fail() { FAIL=$((FAIL+1)); echo "NOT OK - $1: $2"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected [$2] got [$3]"; fi }
finish() { echo "passed: $PASS, failed: $FAIL"; [ "$FAIL" -eq 0 ]; }

TMP="$(mktemp -d /tmp/vw-install-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# ---- 1. bash -n on every script -------------------------------------------
for f in scripts/install-agent.sh scripts/install-server.sh scripts/uninstall-agent.sh; do
  if bash -n "$f" 2>"$TMP/syn.err"; then ok "bash -n $f"; else fail "bash -n $f" "$(cat "$TMP/syn.err")"; fi
done

# ---- 2. --print-unit -------------------------------------------------------
unit=$(bash scripts/install-agent.sh --print-unit 2>/dev/null)
echo "$unit" | grep -q 'ExecStart=' && ok "agent unit has ExecStart" || fail "agent unit ExecStart" "$unit"
echo "$unit" | grep -q 'Restart=always' && ok "agent unit restarts always" || fail "agent unit Restart" "$unit"
unit2=$(bash scripts/install-server.sh --print-unit 2>/dev/null)
echo "$unit2" | grep -q 'ExecStart=.*main.js' && ok "server unit runs main.js" || fail "server unit ExecStart" "$unit2"
echo "$unit2" | grep -q 'Restart=always' && ok "server unit restarts always" || fail "server unit Restart" "$unit2"

# ---- 3. missing required args ---------------------------------------------
err=$(bash scripts/install-agent.sh --server http://x 2>&1 >/dev/null)
code=$?
[ "$code" -ne 0 ] && ok "missing --token exits non-zero" || fail "missing --token exit" "code=$code"
[ -n "$err" ] && ok "missing --token prints stderr hint" || fail "missing --token stderr" "empty"

err=$(bash scripts/install-server.sh --no-such-flag 2>&1 >/dev/null)
[ $? -ne 0 ] && ok "unknown flag rejected (server)" || fail "unknown flag" "exit 0"

# ---- 3b. server install with temp PREFIX copies scripts + agent trees (review finding 2)
PREFIX="$TMP/root2" bash scripts/install-server.sh --port 12345 --password dummy123 --no-start >/dev/null 2>&1
[ -f "$TMP/root2/opt/vpswatch/server/main.js" ] && ok "server tree installed" || fail "server tree" "missing"
[ -f "$TMP/root2/opt/vpswatch/scripts/install-agent.sh" ] && ok "scripts tree installed" || fail "scripts tree" "missing"
[ -f "$TMP/root2/opt/vpswatch/agent/vpswatch-agent.sh" ] && ok "agent tree installed" || fail "agent tree" "missing"

# ---- 4. agent install with temp PREFIX (no systemd, no start) --------------
PREFIX="$TMP/root" bash scripts/install-agent.sh \
  --server http://hub.example:3577 --token tok123 --interval 15 --no-start >/dev/null 2>&1
code=$?
assert_eq "install exit code 0" "0" "$code"
[ -x "$TMP/root/usr/local/bin/vpswatch-agent" ] && ok "agent binary installed executable" || fail "agent binary" "missing"
[ -f "$TMP/root/etc/vpswatch/agent.conf" ] && ok "agent conf written" || fail "agent conf" "missing"
grep -q 'SERVER_URL="http://hub.example:3577"' "$TMP/root/etc/vpswatch/agent.conf" && ok "conf has server url" || fail "conf server url" "$(cat "$TMP/root/etc/vpswatch/agent.conf" 2>/dev/null)"
grep -q 'TOKEN="tok123"' "$TMP/root/etc/vpswatch/agent.conf" && ok "conf has token" || fail "conf token" "missing"
grep -q 'INTERVAL="15"' "$TMP/root/etc/vpswatch/agent.conf" && ok "conf has interval" || fail "conf interval" "missing"

perm=$(stat -f %Lp "$TMP/root/etc/vpswatch/agent.conf" 2>/dev/null || stat -c %a "$TMP/root/etc/vpswatch/agent.conf")
assert_eq "conf permission is 600" "600" "$perm"

[ -d "$TMP/root/var/lib/vpswatch" ] && ok "state dir created" || fail "state dir" "missing"

# conf file is sourceable by the agent (manual smoke)
SERVER_URL="" TOKEN=""
# shellcheck disable=SC1090
. "$TMP/root/etc/vpswatch/agent.conf"
assert_eq "conf sources cleanly" "http://hub.example:3577" "$SERVER_URL"

# ---- 5. uninstall clears the tree ------------------------------------------
PREFIX="$TMP/root" bash scripts/uninstall-agent.sh >/dev/null 2>&1
[ ! -f "$TMP/root/usr/local/bin/vpswatch-agent" ] && ok "uninstall removes binary" || fail "uninstall binary" "still there"
[ ! -f "$TMP/root/etc/vpswatch/agent.conf" ] && ok "uninstall removes conf" || fail "uninstall conf" "still there"

# ---- 6. hub serves the scripts (Task 9 ruling) ------------------------------
PORT=39871
node -e '
const { createApp } = await import("./server/http.js");
const { openStore } = await import("./server/store.js");
const store = openStore(":memory:");
const app = createApp({ config: {}, store, log: {info(){},warn(){},error(){}} });
app.listen(39871, "127.0.0.1", () => console.log("ready"));
setTimeout(() => process.exit(0), 4000);
' --input-type=module >"$TMP/hub.log" 2>&1 &
HUB_PID=$!
sleep 0.8
ct=$(curl -s -o "$TMP/dl-install.sh" -w '%{content_type}' http://127.0.0.1:39871/install-agent.sh)
echo "$ct" | grep -q 'text/x-shellscript\|text/plain' && ok "install-agent.sh served as script" || fail "install script content-type" "$ct"
grep -q 'vpswatch' "$TMP/dl-install.sh" && ok "install script has content" || fail "install script body" "empty"
curl -s http://127.0.0.1:39871/agent.sh | grep -q '#!/usr/bin/env bash' && ok "agent.sh served" || fail "agent.sh body" "empty"
wait $HUB_PID 2>/dev/null

finish
