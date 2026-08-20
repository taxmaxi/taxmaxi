#!/usr/bin/env bash

# WorktreeCreate hook for Claude Code.
#
# When this hook is configured, Claude Code does not run `git worktree add`
# itself: the hook must create the worktree and print its path as the only
# line on stdout. Everything else must go to stderr. The JSON payload on
# stdin carries the worktree name in `.name` and the launch directory in
# `.cwd`; there is no `worktree_path` field anymore.
set -euo pipefail

payload=$(cat)

name=$(printf '%s' "$payload" | jq -r '.name // empty')

if [[ -z "$name" ]]; then
  printf 'worktree-create: payload has no name: %s\n' "$payload" >&2
  exit 1
fi

launch_dir=$(printf '%s' "$payload" | jq -r '.cwd // empty')
launch_dir=${launch_dir:-$PWD}

# The session may already run inside another worktree. Place new worktrees
# under the main checkout, like Claude Code does by default.
common_git_dir=$(git -C "$launch_dir" rev-parse --git-common-dir)

if [[ "$common_git_dir" != /* ]]; then
  common_git_dir="$launch_dir/$common_git_dir"
fi

repo_root=$(cd "$common_git_dir/.." && pwd -P)
worktree_dir="$repo_root/.claude/worktrees/$name"
branch="claude/$name"

{
  # Branch from the default branch on the remote when we can resolve it,
  # like Claude Code's built-in "fresh" base. Fall back to local HEAD.
  base=""

  if default_ref=$(git -C "$repo_root" symbolic-ref --quiet refs/remotes/origin/HEAD); then
    git -C "$repo_root" fetch --quiet origin "${default_ref#refs/remotes/origin/}" || true
    base="$default_ref"
  fi

  if [[ -n "$base" ]]; then
    git -C "$repo_root" worktree add "$worktree_dir" -b "$branch" "$base"
  else
    git -C "$repo_root" worktree add "$worktree_dir" -b "$branch"
  fi

  cd "$worktree_dir"

  # The environment this hook runs in can carry a PATH where an old node
  # (for example a leftover nvm install) shadows the mise one, and
  # `mise x` does not fix the ordering when mise paths are already on
  # PATH. Put the mise tool paths first before running setup.
  mise trust
  PATH="$(mise bin-paths | paste -sd: -):$PATH"
  export PATH

  ./setup.sh
} >&2

printf '%s\n' "$worktree_dir"
