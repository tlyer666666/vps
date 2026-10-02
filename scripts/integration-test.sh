#!/usr/bin/env bash
# VPSWatch end-to-end integration test.
# Real hub (node server/main.js) + real agent (bash, fixture /proc) + real curl.
# Exit 0 = all scenes passed. Prints "ok N - <scene>" per step.
set -u
cd "$(dirname "$0")/.."

HUB_PID=""
WEBHOOK_PID=""
TMP=""

cleanup() {
  [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null
  [ -n "$WEBHOOK_PID" ] && kill "$WEBHOOK_PID" 2>/dev/null
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

TMP="$(mktemp -d /tmp/vw-integration.XXXXXX)"
PORT=$((RANDOM % 5000 + 35000))
BASE="http://127.0.0.1:$PORT"
JAR="$TMP/cookies"
N=0
ok()   { N=$((N+1)); echo "ok $N - $1"; }
die()  { echo "FAIL - $1" >&2; exit 1; }

jget() { # reads JSON on stdin, prints value at dotted path
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    let v = d;
    for (const k of process.argv[1].split(".")) v = v?.[k];
    console.log(v === undefined ? "undefined" : v);
  ' "$1"
}

# ---------- fixtures ----------
make_proc() { # dir rx tx mem_avail_kb
  local d="$1" rx="$2" tx="$3" avail="$4"
  mkdir -p "$d/net"
  printf 'cpu  100 0 100 700 0 0 0 0 0 0\ncpu0 50 0 50 350 0 0 0 0 0 0\n' > "$d/stat"
  printf 'MemTotal:       4000000 kB\nMemAvailable:   %s kB\nSwapTotal:      1000000 kB\nSwapFree:        800000 kB\n' "$avail" > "$d/meminfo"
  printf '9999.5 19999.0\n' > "$d/uptime"
  printf '0.15 0.25 0.35 1/100 1234\n' > "$d/loadavg"
  printf 'lo: 100 5\neth0: %s 40 0 0 0 0 0 0 %s 30 0 0 0 0 0 0\n' "$rx" "$tx" > "$d/net/dev"
  printf '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 0\n' > "$d/net/tcp"
  : > "$d/net/tcp6"
  mkdir -p "$d/1" "$d/42"
}

cat > "$TMP/fake-df" <<'EOF'
#!/usr/bin/env bash
echo "Filesystem 1024-blocks     Used Available Capacity Mounted on"
echo "/dev/vda1      40960000 10240000 30720000      25% /"
EOF
chmod +x "$TMP/fake-df"
printf '#!/usr/bin/env bash\necho hub-test-vm\n' > "$TMP/hostname"; chmod +x "$TMP/hostname"
printf '#!/usr/bin/env bash\necho 2\n' > "$TMP/cores"; chmod +x "$TMP/cores"

agent_report() { # proc_dir token
  ( export SERVER_URL="$BASE" TOKEN="$2" PROC="$1" STATE_FILE="$TMP/agent-$(basename "$1")-state"
    export DF_CMD="$TMP/fake-df" HOSTNAME_CMD="$TMP/hostname" CORES_CMD="$TMP/cores"
    unset DATE_CMD
    bash agent/vpswatch-agent.sh --once >/dev/null 2>&1 )
}

# ---------- scene 1: hub boots ----------------------------------------------
make_proc "$TMP/procA" 5000 3000 1000000
make_proc "$TMP/procB" 8000 9000 2000000

node server/main.js --port "$PORT" --db-path "$TMP/data.db" --data-dir "$TMP" \
  --admin-password testpw >"$TMP/hub.log" 2>&1 &
HUB_PID=$!

ready=1
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BASE/api/overview"; then ready=0; break; fi
  sleep 0.2
done
[ "$ready" -eq 0 ] || die "hub did not start: $(cat "$TMP/hub.log")"
ok "hub starts and answers"

# ---------- scene 2: login + create servers ----------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'content-type: application/json' \
  -d '{"password":"wrong"}' "$BASE/api/login")
[ "$code" = "401" ] || die "wrong password accepted (code=$code)"
curl -s -c "$JAR" -H 'content-type: application/json' \
  -d '{"password":"testpw"}' "$BASE/api/login" | grep -q '"ok":true' || die "login failed"
ok "login works"

create() { # name -> id token
  curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" \
    "$BASE/api/admin/servers" > "$TMP/created-$1.json"
  echo "$(jget id < "$TMP/created-$1.json") $(jget token < "$TMP/created-$1.json")"
}
read -r ID_A TOK_A <<< "$(create alpha)"
read -r ID_B TOK_B <<< "$(create beta)"
[ -n "$TOK_A" ] && [ -n "$TOK_B" ] || die "server creation failed"
ok "two servers created with tokens"

# ---------- scene 3: agents report 5 times each ------------------------------
for _ in $(seq 1 5); do
  agent_report "$TMP/procA" "$TOK_A" || die "agent A report failed"
  agent_report "$TMP/procB" "$TOK_B" || die "agent B report failed"
  sleep 0.2
done
ok "agents report via real HTTP"

# ---------- scene 4: overview matches fixtures --------------------------------
curl -s -b "$JAR" "$BASE/api/overview" > "$TMP/overview.json"
[ "$(jget length < "$TMP/overview.json")" = "2" ] || die "overview should list 2 servers"
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const a = d.find((s) => s.name === "alpha");
const b = d.find((s) => s.name === "beta");
const bad = [];
if (!a?.online) bad.push("alpha not online");
if (!b?.online) bad.push("beta not online");
if (a?.metric?.rxBytes !== 5000) bad.push("alpha rx " + a?.metric?.rxBytes);
if (b?.metric?.rxBytes !== 8000) bad.push("beta rx " + b?.metric?.rxBytes);
if (a?.metric?.memUsed !== (4000000 - 1000000) * 1024) bad.push("alpha mem " + a?.metric?.memUsed);
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
' "$TMP/overview.json" || die "overview fixture mismatch"
ok "overview shows both servers online with fixture values"

# ---------- scene 5: history ---------------------------------------------------
pts=$(curl -s -b "$JAR" "$BASE/api/servers/$ID_A/history?range=1h" | jget 'points.length')
[ "${pts:-0}" -ge 5 ] || die "history has $pts points, want >=5"
ok "history endpoint returns $pts points"

# ---------- scene 6: SSE frame -------------------------------------------------
curl -s -N -m 3 -b "$JAR" "$BASE/api/stream" > "$TMP/sse.txt" 2>/dev/null
grep -q 'event: overview' "$TMP/sse.txt" || die "no SSE frame: $(head -c 200 "$TMP/sse.txt")"
grep -q 'alpha' "$TMP/sse.txt" && grep -q 'beta' "$TMP/sse.txt" || die "SSE frame missing servers"
ok "SSE pushes an overview frame"

# ---------- scene 7: cpu alert + webhook --------------------------------------
node -e '
const http = require("node:http");
const fs = require("fs");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    fs.appendFileSync(process.argv[1], body + "\n");
    res.writeHead(200); res.end("ok");
  });
});
srv.listen(Number(process.argv[2]), "127.0.0.1", () => console.log("ready"));
setTimeout(() => process.exit(0), 30000);
' "$TMP/webhook.log" "$((PORT + 1))" > /dev/null 2>&1 &
# ^ node -e argv: [1]=webhook.log [2]=port
WEBHOOK_PID=$!
sleep 0.5

curl -s -b "$JAR" -X PUT -H 'content-type: application/json' \
  -d '{"thresholds":{"cpu":50,"consecutive":1},"webhookUrl":"http://127.0.0.1:'"$((PORT + 1))"'/hook"}' \
  "$BASE/api/admin/settings" > /dev/null

read -r ID_C TOK_C <<< "$(create gamma)"
for i in 1 2 3; do
  mkdir -p "$TMP/procC/net" "$TMP/procC/1"
  printf 'cpu  %s 0 100 0 0 0 0 0 0 0\n' "$((100 + i * 100))" > "$TMP/procC/stat"
  cp "$TMP/procA/meminfo" "$TMP/procC/meminfo"
  cp "$TMP/procA/uptime" "$TMP/procC/uptime"
  cp "$TMP/procA/loadavg" "$TMP/procC/loadavg"
  cp "$TMP/procA/net/dev" "$TMP/procC/net/dev"
  cp "$TMP/procA/net/tcp" "$TMP/procC/net/tcp"
  : > "$TMP/procC/net/tcp6"
  agent_report "$TMP/procC" "$TOK_C" || die "agent C report failed"
  sleep 0.1
done

curl -s -b "$JAR" "$BASE/api/events?limit=20" > "$TMP/events.json"
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const open = d.find((e) => e.type === "cpu" && e.resolvedAt === null);
if (!open) { console.error("no open cpu event: " + JSON.stringify(d).slice(0, 300)); process.exit(1); }
' "$TMP/events.json" || die "cpu alert did not fire"
ok "cpu threshold alert fires (consecutive=1, >50%)"

[ -s "$TMP/webhook.log" ] || die "webhook stub received nothing"
grep -q 'VPSWatch' "$TMP/webhook.log" || die "webhook payload lacks VPSWatch text"
ok "webhook notification delivered"

# ---------- scene 8: offline alert (real 60s+ window) --------------------------
echo "... waiting for the offline window (max 90s) ..."
offfound=0
for _ in $(seq 1 30); do
  sleep 3
  curl -s -b "$JAR" "$BASE/api/events?limit=50" 2>/dev/null | grep -q '"type":"offline"' && { offfound=1; break; }
done
[ "$offfound" -eq 1 ] || die "offline alert never fired"
ok "offline alert fires after silence"

# ---------- scene 9: restart persistence ---------------------------------------
kill "$HUB_PID" 2>/dev/null; wait "$HUB_PID" 2>/dev/null
node server/main.js --port "$PORT" --db-path "$TMP/data.db" --data-dir "$TMP" \
  --admin-password testpw >>"$TMP/hub.log" 2>&1 &
HUB_PID=$!
ready=1
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BASE/api/overview"; then ready=0; break; fi
  sleep 0.2
done
[ "$ready" -eq 0 ] || die "hub did not restart"
curl -s -b "$JAR" "$BASE/api/overview" > "$TMP/overview2.json"
[ "$(jget length < "$TMP/overview2.json")" = "3" ] || die "servers lost after restart"
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const a = d.find((s) => s.name === "alpha");
if (!a?.metric || a.metric.rxBytes !== 5000) { console.error("alpha metric lost"); process.exit(1); }
if (a.online) { console.error("alpha should read offline right after restart (no new reports)"); process.exit(1); }
' "$TMP/overview2.json" || die "metric state not rebuilt from db"
ok "restart rebuilds servers and history from sqlite (no fake outage)"

# ---------- scene 10: static dashboard + install script ------------------------
curl -s "$BASE/" | grep -q '<title>VPSWatch' || die "dashboard html not served"
curl -s -o /dev/null -w '%{http_code}' "$BASE/install-agent.sh" | grep -q 200 || die "install-agent.sh not served"
ok "dashboard and install script are served"

# ---------- scene 11: retention prune on the real db ---------------------------
kill "$HUB_PID" 2>/dev/null; wait "$HUB_PID" 2>/dev/null; HUB_PID=""
node -e '
const { openStore } = require("./server/store.js");
const store = openStore(process.argv[1]);
const old = Date.now() - 40 * 86400 * 1000;
store.insertMetric(Number(process.argv[2]), { ts: old, cpuPct: 1 });
const before = store.getHistory(Number(process.argv[2]), 0, Date.now(), 100000).points.length;
const removed = store.pruneOlderThan(Date.now() - 30 * 86400 * 1000);
const after = store.getHistory(Number(process.argv[2]), 0, Date.now(), 100000).points.length;
if (!(removed >= 1 && after === before - 1)) { console.error("prune mismatch", removed, before, after); process.exit(1); }
console.log("pruned", removed);
' "$TMP/data.db" "$ID_A" > /dev/null || die "prune failed"
ok "retention prune removes 40d-old rows"

echo "ALL PASS ($N scenes)"
exit 0
