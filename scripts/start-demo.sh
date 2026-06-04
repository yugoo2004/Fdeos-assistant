#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_PORT="8765"
DESKTOP_PORT="${FDE_DESKTOP_PORT:-5173}"

port_in_use() {
  local port="$1"
  lsof -iTCP:"$port" -sTCP:LISTEN -nP >/dev/null 2>&1
}

if port_in_use "$GATEWAY_PORT"; then
  echo "Port $GATEWAY_PORT is already in use. Stop the existing Gateway before running the demo."
  exit 1
fi

if port_in_use "$DESKTOP_PORT"; then
  echo "Port $DESKTOP_PORT is already in use. Stop the existing Vite server before running the demo."
  exit 1
fi

export FDE_DEMO_SESSION_ID="${FDE_DEMO_SESSION_ID:-demo_session}"
export FDE_GATEWAY_PORT="$GATEWAY_PORT"

cleanup() {
  if [[ -n "${GATEWAY_PID:-}" ]]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${DESKTOP_PID:-}" ]]; then
    kill "$DESKTOP_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting Gateway on http://127.0.0.1:$GATEWAY_PORT"
"$ROOT_DIR/scripts/start-gateway.sh" &
GATEWAY_PID="$!"

cd "$ROOT_DIR/desktop"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo "Building desktop workbench for demo preview"
npm run build

echo "Starting desktop workbench on http://127.0.0.1:$DESKTOP_PORT"
npm run preview -- --host 127.0.0.1 --port "$DESKTOP_PORT" &
DESKTOP_PID="$!"

echo "Demo ready when both services finish booting: http://127.0.0.1:$DESKTOP_PORT/"
while true; do
  if ! kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    wait "$GATEWAY_PID"
    exit $?
  fi
  if ! kill -0 "$DESKTOP_PID" >/dev/null 2>&1; then
    wait "$DESKTOP_PID"
    exit $?
  fi
  sleep 1
done
