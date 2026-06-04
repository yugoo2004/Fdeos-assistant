#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_MODEL_DIR="$ROOT_DIR/models/asr/sherpa-onnx-streaming-paraformer-bilingual-zh-en"
PORT="${FDE_GATEWAY_PORT:-8765}"

if [[ -f "$ROOT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  set +a
fi

export SHERPA_ONNX_MODEL_DIR="${SHERPA_ONNX_MODEL_DIR:-$DEFAULT_MODEL_DIR}"

cd "$ROOT_DIR/gateway"
exec uv run uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
