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
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=-$APP_DIR/data -/var/lib/vpswatch
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
UMask=0077

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
# node:sqlite is importable without a flag only from 22.13 — older nodes hit
# "Unknown builtin module" and crash-loop under Restart=always.
if ! node -e 'const [ma,mi]=process.versions.node.split(".").map(Number); process.exit((ma>22||(ma===22&&mi>=13))?0:1)' 2>/dev/null; then
  echo "error: node >= 22.13 is required (found $(node --version)); node:sqlite needs 22.13+" >&2
  exit 1
fi
# ProtectHome=true hides anything under $HOME from the service — a hub started
# from an nvm/fnm path would die with status=203/EXEC, so refuse up front.
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  "$HOME"/*|"$HOME") echo "error: node at $NODE_BIN is under \$HOME, which the sandboxed systemd unit cannot read (ProtectHome=true). Install node system-wide (e.g. /usr/local/bin) or run with --no-start." >&2; exit 1 ;;
esac

echo "installing vpswatch hub..."
mkdir -p "$APP_DIR" "$APP_DIR/data" "$(dirname "$CONF")" "${PREFIX}/var/lib/vpswatch"
# Reinstall (upgrade) must replace the trees, not nest them inside old ones.
rm -rf "$APP_DIR/server" "$APP_DIR/scripts" "$APP_DIR/agent"
cp -R "$SRC_DIR" "$APP_DIR/server"
# The hub serves /install-agent.sh and /agent.sh from these trees — without
# them the panel's copy-paste agent one-liner 404s in the installed layout.
cp -R "$SCRIPT_DIR/../scripts" "$SCRIPT_DIR/../agent" "$APP_DIR/"
# "type":"module" must exist at the app root — node's syntax auto-detection
# covers supported versions, but an explicit marker removes the fallback risk.
cp "$SCRIPT_DIR/../package.json" "$APP_DIR/"

GENERATED=""
HAD_CONF=0
[ -f "$CONF" ] && HAD_CONF=1
if [ -z "$PASSWORD" ]; then
  PASSWORD=$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 16)
  GENERATED="$PASSWORD"
fi

cat > "$CONF" <<EOF
VPSWATCH_PORT="$PORT"
VPSWATCH_ADMIN_PASSWORD="$PASSWORD"
VPSWATCH_TRUST_PROXY=$TRUST_PROXY
VPSWATCH_DATA_DIR="$APP_DIR/data"
EOF
chmod 600 "$CONF"

if [ "$HAD_CONF" -eq 1 ]; then
  echo "注意:检测到已有配置 —— 若数据库已初始化,此密码不生效,请继续使用原密码或在面板修改。"
fi

[ "$NO_START" -eq 1 ] && { echo "installed (not started: --no-start)"; exit 0; }

if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  print_unit > "$UNIT"
  systemctl daemon-reload
  if [ -f "${UNIT}.old" ] || systemctl cat vpswatch.service >/dev/null 2>&1; then
    # upgrade: an active unit keeps the OLD code until restarted
    systemctl restart vpswatch.service
    echo "installed and restarted via systemd (vpswatch.service)"
  else
    systemctl enable --now vpswatch.service
    echo "installed and started via systemd (vpswatch.service)"
  fi
else
  echo "systemd not detected; start manually with:"
  echo "  set -a; . $CONF; set +a; node $APP_DIR/server/main.js"
fi

if [ -n "$GENERATED" ]; then
  echo "管理员密码(仅显示一次,请立即保存): $GENERATED"
fi
echo "done."
