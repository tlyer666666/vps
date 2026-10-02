#!/usr/bin/env bash
# Run the full VPSWatch test suite: node unit tests, agent tests, install tests.
# (scripts/integration-test.sh is separate — it boots a real hub and takes ~2min.)
set -u
cd "$(dirname "$0")/.."

rc=0

echo "== node unit tests =="
node --test || rc=1

echo "== agent tests =="
bash tests/agent/agent_test.sh || rc=1

echo "== install script tests =="
bash tests/scripts/install_test.sh || rc=1

if [ "$rc" -eq 0 ]; then
  echo "ALL TEST SUITES PASS"
else
  echo "FAILURES PRESENT" >&2
fi
exit "$rc"
