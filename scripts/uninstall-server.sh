#!/usr/bin/env bash
# Remove the VPSWatch hub installed by install-server.sh (systemd + trees + env).
# The data directory is kept by default — pass --purge-data to delete it too.
set -u

PREFIX="${PREFIX:-}"
APP_DIR="${PREFIX}/opt/vpswatch"
CONF="${PREFIX}/etc/vpswatch/hub.env"
UNIT="${PREFIX}/etc/systemd/system/vpswatch.service"
PURGE_DATA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge-data) PURGE_DATA=1; shift ;;
    -h|--help) echo "usage: $0 [--purge-data]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

echo "stopping vpswatch hub..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop vpswatch.service >/dev/null 2>&1
  systemctl disable vpswatch.service >/dev/null 2>&1
  systemctl daemon-reload >/dev/null 2>&1
fi
pkill -f "$APP_DIR/server/main.js" >/dev/null 2>&1

rm -f "$UNIT"
rm -rf "$APP_DIR"
rm -f "$CONF"
rmdir "${PREFIX}/etc/vpswatch" 2>/dev/null

if [ "$PURGE_DATA" -eq 1 ]; then
  rm -rf "${PREFIX}/var/lib/vpswatch"
  echo "data directory removed (--purge-data)"
else
  echo "数据目录 ${PREFIX}/var/lib/vpswatch 已保留(含拨测/流量数据);确认不需要可再次运行加 --purge-data"
fi
echo "vpswatch hub removed."
