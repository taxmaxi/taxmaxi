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
  RUN_CHECKS=1                 Also run type-check, lint, and tests.
  TAXMAXI_ENV_SOURCE_TREE=PATH Use 1Password env mounts from this checkout.
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

resolve_env_source_tree() {
  local common_git_dir

  if [[ -n "${TAXMAXI_ENV_SOURCE_TREE:-}" ]]; then
    (cd "$TAXMAXI_ENV_SOURCE_TREE" && pwd -P)
    return
  fi

  if common_git_dir=$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null); then
    if [[ "$common_git_dir" != /* ]]; then
      common_git_dir="$SCRIPT_DIR/$common_git_dir"
    fi

    (cd "$common_git_dir/.." && pwd -P)
    return
  fi

  if [[ -n "${CODEX_SOURCE_TREE_PATH:-}" ]]; then
    (cd "$CODEX_SOURCE_TREE_PATH" && pwd -P)
    return
  fi

  printf '%s\n' "$SCRIPT_DIR"
}

link_env_mount() {
  local label=$1
  local relative_path=$2
  local environment_name=$3
  local source_tree=$4
  local source_path="$source_tree/$relative_path"
  local target_path="$SCRIPT_DIR/$relative_path"

  if [[ -e "$target_path" || -L "$target_path" || -p "$target_path" ]]; then
    if [[ "$source_tree" != "$SCRIPT_DIR" && "$target_path" -ef "$source_path" ]]; then
      printf 'Linked %s env to 1Password mount: %s\n' "$label" "$target_path"
    else
      printf 'Found %s env: %s\n' "$label" "$target_path"
    fi
    return 0
  fi

  if [[ "$source_tree" != "$SCRIPT_DIR" ]] && \
    [[ -e "$source_path" || -L "$source_path" || -p "$source_path" ]]; then
    ln -s "$source_path" "$target_path"
    printf 'Linked %s env to 1Password mount: %s -> %s\n' \
      "$label" "$target_path" "$source_path"
    return 0
  fi

  printf 'Missing %s env: %s\n' "$label" "$target_path"
  printf '  Mount 1Password Environment "%s" at %s\n' \
    "$environment_name" "$source_path"
}

create_www_env_local() {
  local target_path="$SCRIPT_DIR/apps/www/.env.local"

  if [[ -e "$target_path" || -L "$target_path" ]]; then
    printf 'Found www env: %s\n' "$target_path"
    return 0
  fi

  cat >"$target_path" <<'EOF'
VITE_POSTHOG_KEY=phc_rTqIM7RX677xpUoAHTCQKFtafRswFEI4vs0OnlEGvIs
VITE_POSTHOG_HOST=https://eu.i.posthog.com
VITE_TAXMAXI_API_BASE_URL=http://localhost:4000
TAXMAXI_API_BASE_URL=http://localhost:4000
EOF

  printf 'Created www env: %s\n' "$target_path"
}

main() {
  local env_source_tree

  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  if [[ $# -gt 0 ]]; then
    usage >&2
    exit 1
  fi

  require_command mise

  cd "$SCRIPT_DIR"

  log "Trusting mise configuration"
  mise trust

  log "Installing mise-managed tools"
  mise install

  # Automation environments can carry a PATH where an old node (for
  # example a leftover nvm install) shadows the mise one, and `mise x`
  # does not fix the ordering when mise paths are already on PATH. Put
  # the mise tool paths first so pnpm always runs on the pinned node.
  PATH="$(mise bin-paths | paste -sd: -):$PATH"
  export PATH

  if [[ -n "${CODEX_WORKTREE_PATH:-}" || -n "${CODEX_SOURCE_TREE_PATH:-}" ]]; then
    log "Codex worktree context"
    print_codex_context
  fi

  env_source_tree=$(resolve_env_source_tree)

  log "Linking 1Password env mounts"
  if [[ "$env_source_tree" != "$SCRIPT_DIR" ]]; then
    printf 'Using env mounts from: %s\n' "$env_source_tree"
  fi
  link_env_mount "server" "apps/server/.env" "TaxMaxi Server Dev" "$env_source_tree"
  link_env_mount "worker" "apps/worker/.env" "TaxMaxi Worker Dev" "$env_source_tree"

  log "Creating www env"
  create_www_env_local

  log "Installing dependencies"
  mise x -- pnpm install

  if [[ "${RUN_CHECKS:-0}" == "1" ]]; then
    log "Type checking workspace"
    mise x -- pnpm run type-check

    log "Linting workspace"
    mise x -- pnpm run lint

    log "Running tests"
    mise x -- pnpm run test
  fi

  printf '\nSetup complete.\n'
}

main "$@"
