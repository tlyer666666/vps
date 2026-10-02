#!/usr/bin/env bash
# VPSWatch hub installer (run on the monitoring server itself).
# Copies the repo's server/ tree into /opt/vpswatch, writes a config,
# and registers a systemd service. PREFIX env var redirects the root (tests).
#
#   scripts/install-server.sh [--port 3577] [--password PW] [--no-start] [--print-unit]
set -u

usage() {
  echo "usage: $0 [--port N] [--password PW] [--no-start] [--print-unit]" >&2
}

PORT="3577"
PASSWORD=""
TRUST_PROXY="false"
NO_START=0
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-3577}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --trust-proxy) TRUST_PROXY="true"; shift ;;
    --no-start) NO_START=1; shift ;;
    --print-unit) MODE="print-unit"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

PREFIX="${PREFIX:-}"
APP_DIR="${PREFIX}/opt/vpswatch"
CONF="${PREFIX}/etc/vpswatch/hub.env"
UNIT="${PREFIX}/etc/systemd/system/vpswatch.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../server"

print_unit() {
  cat <<EOF
[Unit]
Description=VPSWatch hub
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node || echo /usr/bin/node) $APP_DIR/server/main.js
EnvironmentFile=$CONF
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$MODE" = "print-unit" ]; then
  print_unit
  exit 0
fi

if [ ! -d "$SRC_DIR" ]; then
  echo "error: $SRC_DIR not found — run this from a vpswatch repo checkout" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>= 22.13)" >&2
  exit 1
fi

echo "installing vpswatch hub..."
mkdir -p "$APP_DIR" "$(dirname "$CONF")" "${PREFIX}/var/lib/vpswatch"
cp -R "$SRC_DIR" "$APP_DIR/server"
# The hub serves /install-agent.sh and /agent.sh from these trees — without
# them the panel's copy-paste agent one-liner 404s in the installed layout.
cp -R "$SCRIPT_DIR/../scripts" "$SCRIPT_DIR/../agent" "$APP_DIR/"

GENERATED=""
if [ -z "$PASSWORD" ]; then
  PASSWORD=$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 16)
  GENERATED="$PASSWORD"
fi

cat > "$CONF" <<EOF
VPSWATCH_PORT="$PORT"
VPSWATCH_ADMIN_PASSWORD="$PASSWORD"
VPSWATCH_TRUST_PROXY=$TRUST_PROXY
EOF
chmod 600 "$CONF"

[ "$NO_START" -eq 1 ] && { echo "installed (not started: --no-start)"; exit 0; }

if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  print_unit > "$UNIT"
  systemctl daemon-reload
  systemctl enable --now vpswatch.service
  echo "installed and started via systemd (vpswatch.service)"
else
  echo "systemd not detected; start manually with:"
  echo "  set -a; . $CONF; set +a; node $APP_DIR/server/main.js"
fi

if [ -n "$GENERATED" ]; then
  echo "管理员密码(仅显示一次,请立即保存): $GENERATED"
fi
echo "done."
