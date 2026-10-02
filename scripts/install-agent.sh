#!/usr/bin/env bash
# VPSWatch agent installer. Designed to be run as a one-liner from the hub:
#   curl -fsSL http://HUB:3577/install-agent.sh | bash -s -- --server http://HUB:3577 --token TOKEN
# Also works from a repo checkout (uses agent/vpswatch-agent.sh next to it).
#
# PREFIX env var redirects the install root (used by tests).
set -u

usage() {
  echo "usage: $0 --server URL --token TOKEN [--interval N] [--user USER] [--no-start] [--uninstall] [--print-unit]" >&2
}

SERVER_URL=""
TOKEN=""
INTERVAL="10"
RUN_USER="root"
NO_START=0
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --token)  TOKEN="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-10}"; shift 2 ;;
    --user) RUN_USER="${2:-root}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --print-unit) MODE="print-unit"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

PREFIX="${PREFIX:-}"
CONF="${PREFIX}/etc/vpswatch/agent.conf"
BIN="${PREFIX}/usr/local/bin/vpswatch-agent"
STATE_DIR="${PREFIX}/var/lib/vpswatch"
LOG_FILE="${PREFIX}/var/log/vpswatch-agent.log"
UNIT="${PREFIX}/etc/systemd/system/vpswatch-agent.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_AGENT="$SCRIPT_DIR/../agent/vpswatch-agent.sh"

print_unit() {
  cat <<EOF
[Unit]
Description=VPSWatch agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$BIN
Restart=always
RestartSec=5
User=$RUN_USER

[Install]
WantedBy=multi-user.target
EOF
}

have_systemd() {
  [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

stop_running() {
  if have_systemd; then
    systemctl stop vpswatch-agent.service >/dev/null 2>&1
    systemctl disable vpswatch-agent.service >/dev/null 2>&1
    rm -f "$UNIT"
    systemctl daemon-reload >/dev/null 2>&1
  fi
  pkill -f "$BIN" >/dev/null 2>&1
  return 0
}

if [ "$MODE" = "print-unit" ]; then
  print_unit
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  echo "stopping vpswatch agent..."
  stop_running
  rm -f "$BIN" "$CONF" "$LOG_FILE"
  echo "vpswatch agent removed (metrics state in $STATE_DIR kept; delete it manually if desired)"
  exit 0
fi

[ -n "$SERVER_URL" ] || { echo "error: --server is required" >&2; usage; exit 1; }
[ -n "$TOKEN" ] || { echo "error: --token is required" >&2; usage; exit 1; }

echo "installing vpswatch agent..."
mkdir -p "$(dirname "$BIN")" "$(dirname "$CONF")" "$STATE_DIR" "$(dirname "$LOG_FILE")"

if [ -f "$LOCAL_AGENT" ]; then
  cp -f "$LOCAL_AGENT" "$BIN"
else
  echo "downloading agent from $SERVER_URL/agent.sh ..."
  curl -fsSL "$SERVER_URL/agent.sh" -o "$BIN" || {
    echo "error: download failed (set PREFIX from a repo checkout or check the URL)" >&2
    exit 1
  }
fi
chmod +x "$BIN"

cat > "$CONF" <<EOF
SERVER_URL="$SERVER_URL"
TOKEN="$TOKEN"
INTERVAL="$INTERVAL"
STATE_FILE="$STATE_DIR/state"
EOF
chmod 600 "$CONF"

[ "$NO_START" -eq 1 ] && { echo "installed (not started: --no-start)"; exit 0; }

if have_systemd; then
  print_unit > "$UNIT"
  systemctl daemon-reload
  systemctl enable --now vpswatch-agent.service
  echo "installed and started via systemd (vpswatch-agent.service)"
else
  echo "systemd not detected, starting with nohup..."
  stop_running
  nohup "$BIN" >>"$LOG_FILE" 2>&1 &
  echo "started in background (log: $LOG_FILE). Install systemd for auto-restart."
fi
echo "done."
