#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

log() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  local command_name=$1

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Usage: ./setup.sh

Bootstraps a fresh TaxMaxi checkout or Codex worktree.

Environment overrides:
  RUN_CHECKS=1      Also run type-check, lint, and tests.
EOF
}

print_codex_context() {
  if [[ -n "${CODEX_WORKTREE_PATH:-}" ]]; then
    printf 'CODEX_WORKTREE_PATH=%s\n' "${CODEX_WORKTREE_PATH}"
  fi

  if [[ -n "${CODEX_SOURCE_TREE_PATH:-}" ]]; then
    printf 'CODEX_SOURCE_TREE_PATH=%s\n' "${CODEX_SOURCE_TREE_PATH}"
  fi
}

print_env_status() {
  local label=$1
  local target_path=$2
  local environment_name=$3

  if [[ -e "$target_path" || -L "$target_path" || -p "$target_path" ]]; then
    printf 'Found %s env: %s\n' "$label" "$target_path"
    return 0
  fi

  printf 'Missing %s env: %s\n' "$label" "$target_path"
  printf '  Mount 1Password Environment "%s" to that exact path for this worktree.\n' \
    "$environment_name"
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  if [[ $# -gt 0 ]]; then
    usage >&2
    exit 1
  fi

  require_command mise
  require_command pnpm

  cd "$SCRIPT_DIR"

  log "Trusting mise configuration"
  mise trust

  if [[ -n "${CODEX_WORKTREE_PATH:-}" || -n "${CODEX_SOURCE_TREE_PATH:-}" ]]; then
    log "Codex worktree context"
    print_codex_context
  fi

  log "Checking local env mounts"
  print_env_status "server" "$SCRIPT_DIR/apps/server/.env" "TaxMaxi Server Dev"
  print_env_status "worker" "$SCRIPT_DIR/apps/worker/.env" "TaxMaxi Worker Dev"

  log "Installing dependencies"
  pnpm install

  if [[ "${RUN_CHECKS:-0}" == "1" ]]; then
    log "Type checking workspace"
    pnpm run type-check

    log "Linting workspace"
    pnpm run lint

    log "Running tests"
    pnpm run test
  fi

  printf '\nSetup complete.\n'
}

main "$@"
