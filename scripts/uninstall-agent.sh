#!/usr/bin/env bash
# Remove the vpswatch agent (thin wrapper around install-agent.sh --uninstall).
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/install-agent.sh" --uninstall "$@"
