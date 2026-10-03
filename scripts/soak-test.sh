#!/usr/bin/env bash
# VPSWatch stability soak: high-frequency multi-agent load with churning
# probes, invalid payloads and public traffic for ~40s. Asserts the hub
# survives with bounded memory and no fatal errors.
set -u
cd "$(dirname "$0")/.."

TMP="$(mktemp -d /tmp/vw-soak.XXXXXX)"
HUB_PID=""
BG_PIDS=()
PORT=$((RANDOM % 3000 + 31000))
BASE="http://127.0.0.1:$PORT"
cleanup() {
  [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null
  for p in "${BG_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

node server/main.js --port "$PORT" --db-path "$TMP/d.db" --data-dir "$TMP" \
  --admin-password soakpw > "$TMP/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "$BASE/api/overview" && break; sleep 0.2; done
curl -s -c "$TMP/jar" -H 'content-type: application/json' -d '{"password":"soakpw"}' "$BASE/api/login" > /dev/null

# 3 servers, one with a quota; a flapping probe target; public status on
TOKENS=()
for i in 1 2 3; do
  curl -s -b "$TMP/jar" -H 'content-type: application/json' \
    -d "{\"name\":\"soak-$i\",\"intervalSec\":10,\"monthlyQuotaBytes\":$((i * 1024 ** 3))}" \
    "$BASE/api/admin/servers" > "$TMP/s$i.json"
  TOKENS+=("$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/s$i.json','utf8')).token)")")
done
curl -s -b "$TMP/jar" -X PUT -H 'content-type: application/json' \
  -d '{"public_status":true,"thresholds":{"cpu":50}}' "$BASE/api/admin/settings" > /dev/null
node -e '
const http = require("node:http");
let flip = 0;
setInterval(() => { flip = 1 - flip; }, 4000); // flapping target
http.createServer((req, res) => { res.writeHead(flip ? 200 : 500); res.end("x"); })
  .listen(Number(process.argv[2]), "127.0.0.1", () => console.log("ready"));
setTimeout(() => process.exit(0), 120000);
' "$((PORT + 1))" > /dev/null 2>&1 &
BG_PIDS+=($!)
sleep 0.4
FLAP_PORT=$((PORT + 1))
curl -s -b "$TMP/jar" -H 'content-type: application/json' \
  -d "{\"name\":\"flap\",\"type\":\"http\",\"target\":\"http://127.0.0.1:$FLAP_PORT/\",\"intervalSec\":10}" \
  "$BASE/api/admin/probes" > /dev/null

# agent loops: 3 servers x ~0.3s valid reports + occasional garbage
DURATION=${1:-35}
rss_before=$(ps -o rss= -p "$HUB_PID" | tr -d ' ')
END=$((SECONDS + DURATION))
agent_loop() {
  local idx="$1" token="$2" n=0
  while [ $SECONDS -lt $END ]; do
    n=$((n + 1))
    if [ $((n % 17)) -eq 0 ]; then
      curl -s -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'content-type: application/json' \
        -d '{"uptime":-5,"cpu":{"usage_pct":999,"cores":1},"mem":{"total":1,"used":0},"disks":[],"net":{}}' \
        "$BASE/api/agent/report"
    elif [ $((n % 13)) -eq 0 ]; then
      curl -s -o /dev/null -X POST -H "Authorization: Bearer WRONG" -H 'content-type: application/json' -d '{}' "$BASE/api/agent/report"
    else
      curl -s -o /dev/null -m 3 -X POST -H "Authorization: Bearer $token" -H 'content-type: application/json' \
        -d "{\"hostname\":\"soak-$idx\",\"uptime\":$n,\"cpu\":{\"usage_pct\":$((n % 100)),\"cores\":2},\"mem\":{\"total\":4000000,\"used\":1000000},\"disks\":[{\"mount\":\"/\",\"total\":10000000,\"used\":1000000}],\"net\":{\"rx_bytes\":$((n * 1000)),\"tx_bytes\":$((n * 500))},\"daily_rx\":$((n * 10)),\"daily_tx\":$((n * 5)),\"monthly_rx\":$((n * 100)),\"monthly_tx\":$((n * 50))}" \
        "$BASE/api/agent/report"
    fi
    sleep 0.3
  done
}
for i in 1 2 3; do
  agent_loop "$i" "${TOKENS[$((i - 1))]}" &
  BG_PIDS+=($!)
done
# public page hammer + events poll during the soak
(
  while [ $SECONDS -lt $END ]; do
    curl -s -o /dev/null -m 3 "$BASE/api/public/overview"
    curl -s -o /dev/null -m 3 -b "$TMP/jar" "$BASE/api/events?limit=20"
    sleep 0.5
  done
) &
BG_PIDS+=($!)

while [ $SECONDS -lt $END ]; do sleep 1; done
sleep 2 # let in-flight requests settle

fail=0
if ! kill -0 "$HUB_PID" 2>/dev/null; then
  echo "FAIL - hub process died during soak"; fail=1
else
  echo "ok - hub survived ${DURATION}s soak"
fi
rss_after=$(ps -o rss= -p "$HUB_PID" | tr -d ' ')
growth=$(( (rss_after - rss_before) / 1024 ))
if [ "$growth" -lt 80 ]; then
  echo "ok - hub RSS growth ${growth} MB (bounded)"
else
  echo "FAIL - hub RSS grew ${growth} MB"; fail=1
fi
rows=$(node -e '
const { openStore } = require("./server/store.js");
const store = openStore(process.argv[1]);
console.log(store.db.prepare("SELECT COUNT(*) c FROM metrics").get().c);
' "$TMP/d.db" 2>/dev/null)
expected=$((DURATION * 3 * 3))
if [ "${rows:-0}" -ge $((expected * 8 / 10)) ]; then
  echo "ok - metric rows persisted: ${rows} (expected ≈${expected})"
else
  echo "FAIL - metric rows ${rows}, expected ≈${expected}"; fail=1
fi
if grep -qiE 'unhandled rejection|fatal-guard' "$TMP/hub.log"; then
  echo "FAIL - fatal guard tripped in hub log"; fail=1
else
  echo "ok - no unhandled rejections"
fi
# quota alert must have opened for soak-1 (n*100+n*50 bytes monthly, no quota hit) — just report event count
events=$(curl -s -b "$TMP/jar" "$BASE/api/events?limit=100" | grep -c '"type"')
echo "... alert events during soak: $events"

if [ "$fail" -eq 0 ]; then
  echo "SOAK PASS"
else
  echo "SOAK FAIL" >&2
fi
exit "$fail"
