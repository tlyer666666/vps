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
for f in scripts/install-agent.sh scripts/install-server.sh scripts/uninstall-agent.sh scripts/uninstall-server.sh; do
  if bash -n "$f" 2>"$TMP/syn.err"; then ok "bash -n $f"; else fail "bash -n $f" "$(cat "$TMP/syn.err")"; fi
done

# ---- 2. --print-unit -------------------------------------------------------
unit=$(bash scripts/install-agent.sh --print-unit 2>/dev/null)
echo "$unit" | grep -q 'ExecStart=' && ok "agent unit has ExecStart" || fail "agent unit ExecStart" "$unit"
echo "$unit" | grep -q 'Restart=always' && ok "agent unit restarts always" || fail "agent unit Restart" "$unit"
echo "$unit" | grep -q 'NoNewPrivileges=true' && ok "agent unit sandboxed (NoNewPrivileges)" || fail "agent sandbox" "missing"
echo "$unit" | grep -q 'ProtectSystem=strict' && ok "agent unit ProtectSystem" || fail "agent ProtectSystem" "missing"
unit2=$(bash scripts/install-server.sh --print-unit 2>/dev/null)
echo "$unit2" | grep -q 'ExecStart=.*main.js' && ok "server unit runs main.js" || fail "server unit ExecStart" "$unit2"
echo "$unit2" | grep -q 'Restart=always' && ok "server unit restarts always" || fail "server unit Restart" "$unit2"
echo "$unit2" | grep -q 'NoNewPrivileges=true' && ok "server unit sandboxed" || fail "server sandbox" "missing"
echo "$unit2" | grep -vq 'MemoryDenyWriteExecute' && ok "hub unit avoids MemoryDenyWriteExecute (V8 JIT)" || fail "hub unit" "MDWE would crash node"

# ---- 3a. missing required args ---------------------------------------------
err=$(bash scripts/install-agent.sh --server http://x 2>&1 >/dev/null)
[ $? -ne 0 ] && ok "missing --token exits non-zero" || fail "missing --token exit" "code=0"
[ -n "$err" ] && ok "missing --token prints stderr hint" || fail "missing --token stderr" "empty"
bash scripts/install-agent.sh --server http://x --token t --user no-such-user-xyz >/dev/null 2>&1
[ $? -ne 0 ] && ok "unknown --user rejected" || fail "--user validation" "accepted unknown user"

err=$(bash scripts/install-server.sh --no-such-flag 2>&1 >/dev/null)
[ $? -ne 0 ] && ok "unknown flag rejected (server)" || fail "unknown flag" "exit 0"

# ---- 3b. server install with temp PREFIX copies trees (review finding 2) ----
PREFIX="$TMP/root2" bash scripts/install-server.sh --port 12345 --password dummy123 --no-start >/dev/null 2>&1
[ -f "$TMP/root2/opt/vpswatch/server/main.js" ] && ok "server tree installed" || fail "server tree" "missing"
[ -f "$TMP/root2/opt/vpswatch/scripts/install-agent.sh" ] && ok "scripts tree installed" || fail "scripts tree" "missing"
[ -f "$TMP/root2/opt/vpswatch/agent/vpswatch-agent.sh" ] && ok "agent tree installed" || fail "agent tree" "missing"

# ---- 3c. reinstall (upgrade) must not nest trees (iteration 1 finding 3) -----
PREFIX="$TMP/root2" bash scripts/install-server.sh --port 12346 --password dummy123 --no-start >/dev/null 2>&1
[ -f "$TMP/root2/opt/vpswatch/server/main.js" ] && ok "reinstall keeps main.js top-level" || fail "reinstall" "nested server/server"
[ ! -d "$TMP/root2/opt/vpswatch/server/server" ] && ok "reinstall does not nest server dir" || fail "reinstall nest" "server/server exists"

# ---- 3d. installer rejects non-numeric interval (iteration 1 finding 4) ------
bash scripts/install-agent.sh --server http://x --token t --interval 10s >/dev/null 2>&1
[ $? -ne 0 ] && ok "non-numeric --interval rejected" || fail "interval validation" "accepted 10s"
bash scripts/install-agent.sh --server http://x --token t --interval 0 >/dev/null 2>&1
[ $? -ne 0 ] && ok "zero --interval rejected" || fail "interval validation" "accepted 0"

# ---- 3e. deploy-readiness (final review findings) ---------------------------
[ -d "$TMP/root2/opt/vpswatch/data" ] && ok "data dir pre-created for sandboxed boot" || fail "data dir" "missing (EROFS crash loop)"
grep -q 'VPSWATCH_DATA_DIR' "$TMP/root2/etc/vpswatch/hub.env" && ok "hub.env pins data dir" || fail "hub.env data dir" "missing"
[ -f "$TMP/root2/opt/vpswatch/package.json" ] && ok "package.json copied (ESM module detection)" || fail "package.json" "missing"
bash scripts/install-server.sh --print-unit | grep -q 'ReadWritePaths=.*-/var/lib/vpswatch' && ok "unit ReadWritePaths points at real state dir" || fail "ReadWritePaths" "$(bash scripts/install-server.sh --print-unit | grep ReadWritePaths)"
# old node without node:sqlite must abort with a clear message
mkdir -p "$TMP/oldnode-bin"
printf '#!/usr/bin/env bash\nif [ "$1" = "-e" ]; then echo "old node"; exit 1; fi\nexit 0\n' > "$TMP/oldnode-bin/node"
chmod +x "$TMP/oldnode-bin/node"
err=$(PATH="$TMP/oldnode-bin:$PATH" bash scripts/install-server.sh --port 1 --password x --no-start 2>&1 >/dev/null)
[ $? -ne 0 ] && echo "$err" | grep -qi '22.13' && ok "old node rejected with version hint" || fail "old node check" "$err"
# node under $HOME would be invisible to the sandboxed unit (ProtectHome=true)
FAKEHOME="$TMP/fakehome"; mkdir -p "$FAKEHOME/bin"
printf '#!/usr/bin/env bash\necho v22.19.0\n' > "$FAKEHOME/bin/node"; chmod +x "$FAKEHOME/bin/node"
err=$(HOME="$FAKEHOME" PATH="$FAKEHOME/bin:$PATH" bash scripts/install-server.sh --port 1 --password x --no-start 2>&1 >/dev/null)
[ $? -ne 0 ] && echo "$err" | grep -qi 'HOME\|nvm\|ProtectHome' && ok "node under \$HOME refused (ProtectHome)" || fail "home node check" "$err"
# reinstall with explicit --password prints the no-effect warning
out=$(PREFIX="$TMP/root2" bash scripts/install-server.sh --port 12347 --password another-pw --no-start 2>&1 || true)
echo "$out" | grep -q '原密码' && ok "--password reinstall warns about existing db" || fail "reinstall warning" "$out"

# ---- 4. agent install with temp PREFIX (no systemd, no start) ---------------
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

# ---- 5. uninstall clears the tree -------------------------------------------
PREFIX="$TMP/root" bash scripts/uninstall-agent.sh >/dev/null 2>&1
[ ! -f "$TMP/root/usr/local/bin/vpswatch-agent" ] && ok "uninstall removes binary" || fail "uninstall binary" "still there"
[ ! -f "$TMP/root/etc/vpswatch/agent.conf" ] && ok "uninstall removes conf" || fail "uninstall conf" "still there"

# ---- 5b. server uninstall removes trees and unit -----------------------------
PREFIX="$TMP/root2" bash scripts/uninstall-server.sh --purge-data >/dev/null 2>&1
[ ! -d "$TMP/root2/opt/vpswatch" ] && ok "server uninstall removes app dir" || fail "server uninstall" "opt/vpswatch remains"
[ ! -f "$TMP/root2/etc/vpswatch/hub.env" ] && ok "server uninstall removes hub.env" || fail "server uninstall env" "still there"
[ ! -d "$TMP/root2/var/lib/vpswatch" ] && ok "purge-data removes state dir" || fail "purge-data" "state dir remains"

# ---- 6. hub serves the scripts (Task 9 ruling) -------------------------------
PORT=39871
node --input-type=module -e '
const { createApp } = await import("./server/http.js");
const { openStore } = await import("./server/store.js");
const store = openStore(":memory:");
const app = createApp({ config: {}, store, log: {info(){},warn(){},error(){}} });
app.listen(39871, "127.0.0.1", () => console.log("ready"));
setTimeout(() => process.exit(0), 4000);
' > "$TMP/hub.log" 2>&1 &
HUB_PID=$!
sleep 0.8
ct=$(curl -s -o "$TMP/dl-install.sh" -w '%{content_type}' http://127.0.0.1:39871/install-agent.sh)
echo "$ct" | grep -q 'text/x-shellscript\|text/plain' && ok "install-agent.sh served as script" || fail "install script content-type" "$ct"
grep -q 'vpswatch' "$TMP/dl-install.sh" && ok "install script has content" || fail "install script body" "empty"
curl -s http://127.0.0.1:39871/agent.sh | grep -q '#!/usr/bin/env bash' && ok "agent.sh served" || fail "agent.sh body" "empty"
wait $HUB_PID 2>/dev/null

finish
