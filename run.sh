#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OLLAMA_BASE_URL=https://organisms-tue-luggage-modules.trycloudflare.com
export OLLAMA_MODEL=qwen2.5-coder:14b
export WORKSPACE_DIR=$SCRIPT_DIR/workspace
export LOCAL_AGENT_ANALYSIS=live

NODE_BIN="${NODE_BIN:-node}"
if command -v "$NODE_BIN" >/dev/null 2>&1; then
  NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
else
  NODE_MAJOR=0
fi

VSCODE_NODE="/home/hoyo/.vscode-server/bin/41dd792b5e652393e7787322889ed5fdc58bd75b/node"
if [ "${NODE_MAJOR:-0}" -lt 18 ] && [ -x "$VSCODE_NODE" ]; then
  NODE_BIN="$VSCODE_NODE"
  NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
fi

if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  printf 'Error: Node.js 18+ is required. Set NODE_BIN to a modern node executable.\n' >&2
  exit 1
fi

exec "$NODE_BIN" src/cli.js workspace
