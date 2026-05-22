#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKSPACE="$SCRIPT_DIR/legacy/claude-code"

OLLAMA_BASE_URL_VALUE="${OLLAMA_BASE_URL:-}"
OLLAMA_MODEL_VALUE="${OLLAMA_MODEL:-}"
WORKSPACE_VALUE="${WORKSPACE_DIR:-}"

if [[ -z "${WORKSPACE_VALUE}" && -d "${DEFAULT_WORKSPACE}" ]]; then
  WORKSPACE_VALUE="${DEFAULT_WORKSPACE}"
fi

print_help() {
  cat <<'EOF'
Usage:
  ./test.sh [options]

Options:
  -u, --url URL           Ollama/OpenAI-compatible base URL
  -m, --model MODEL       Model name
  -w, --workspace DIR     Workspace directory to mount
  -p, --prompt            Prompt interactively for missing values
  -h, --help              Show this help

Examples:
  ./test.sh --url https://example.trycloudflare.com --model qwen3.5:9b
  ./test.sh --workspace /path/to/project

Environment variables:
  OLLAMA_BASE_URL         Default API base URL
  OLLAMA_MODEL            Default model name
  WORKSPACE_DIR           Default workspace directory
EOF
}

should_prompt="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--url)
      OLLAMA_BASE_URL_VALUE="${2:-}"
      shift 2
      ;;
    -m|--model)
      OLLAMA_MODEL_VALUE="${2:-}"
      shift 2
      ;;
    -w|--workspace)
      WORKSPACE_VALUE="${2:-}"
      shift 2
      ;;
    -p|--prompt)
      should_prompt="true"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

prompt_if_missing() {
  local label="$1"
  local current_value="$2"
  local result=""

  if [[ -n "${current_value}" ]]; then
    printf '%s [%s]: ' "${label}" "${current_value}" >&2
  else
    printf '%s: ' "${label}" >&2
  fi

  read -r result
  if [[ -n "${result}" ]]; then
    printf '%s' "${result}"
  else
    printf '%s' "${current_value}"
  fi
}

if [[ "${should_prompt}" == "true" || -z "${OLLAMA_BASE_URL_VALUE}" || -z "${OLLAMA_MODEL_VALUE}" ]]; then
  OLLAMA_BASE_URL_VALUE="$(prompt_if_missing "Ollama base URL" "${OLLAMA_BASE_URL_VALUE}")"
  OLLAMA_MODEL_VALUE="$(prompt_if_missing "Model name" "${OLLAMA_MODEL_VALUE}")"
  WORKSPACE_VALUE="$(prompt_if_missing "Workspace directory" "${WORKSPACE_VALUE}")"
fi

if [[ -z "${OLLAMA_BASE_URL_VALUE}" ]]; then
  echo "Missing Ollama base URL. Pass --url or set OLLAMA_BASE_URL." >&2
  exit 1
fi

if [[ -z "${OLLAMA_MODEL_VALUE}" ]]; then
  echo "Missing model name. Pass --model or set OLLAMA_MODEL." >&2
  exit 1
fi

if [[ -z "${WORKSPACE_VALUE}" ]]; then
  echo "Missing workspace directory. Pass --workspace or set WORKSPACE_DIR." >&2
  exit 1
fi

WORKSPACE_VALUE="$(cd "${WORKSPACE_VALUE}" && pwd)"

export OLLAMA_BASE_URL="${OLLAMA_BASE_URL_VALUE}"
export OLLAMA_MODEL="${OLLAMA_MODEL_VALUE}"

echo "Starting Local Coding Agent"
echo "  API:       ${OLLAMA_BASE_URL}"
echo "  Model:     ${OLLAMA_MODEL}"
echo "  Workspace: ${WORKSPACE_VALUE}"
echo ""

cd "${SCRIPT_DIR}"
exec node src/cli.js "${WORKSPACE_VALUE}"
