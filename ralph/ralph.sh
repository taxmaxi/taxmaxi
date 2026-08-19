#!/usr/bin/env bash

# Ralph Loop - TaxMaxi-specific agent orchestrator.

set -euo pipefail

DRY_RUN=false
MAX_ITERATIONS=10
COMMIT_CHANGES=false
ALLOW_DIRTY=false
PROVIDER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'TEXT'
Usage: bash ralph/ralph.sh [provider] [options] [max_iterations]

Providers:
  gpt      Codex CLI (default)
  grok     Grok CLI
  claude   Claude Code CLI

Options:
  --dry-run              Run verification only; do not start the agent loop.
  --max-iterations <n>   Maximum loop iterations. Default: 10.
  --commit               Commit each successfully verified story.
  --allow-dirty          Allow starting with existing uncommitted changes.
  --help                 Show this help.

Environment:
  AGENT_CMD_BASE         Override the provider command entirely. When set, the
                         provider argument is ignored.
TEXT
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --max-iterations)
      MAX_ITERATIONS=$2
      shift 2
      ;;
    --commit)
      COMMIT_CHANGES=true
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    gpt|grok|claude)
      if [ -n "$PROVIDER" ] && [ "$PROVIDER" != "$1" ]; then
        echo "Provider already set to $PROVIDER" >&2
        usage
        exit 1
      fi
      PROVIDER=$1
      shift
      ;;
    [0-9]*)
      MAX_ITERATIONS=$1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

PROVIDER="${PROVIDER:-gpt}"

PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
PROMPT_FILE="$SCRIPT_DIR/PROMPT.md"
OUTPUT_DIR="$SCRIPT_DIR/.output"

AGENT_CMD_OVERRIDE="${AGENT_CMD_BASE:-}"
AGENT_BIN=""
AGENT_DISPLAY=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log() {
  local level=$1
  shift
  local message="$*"
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  case $level in
    "INFO") echo -e "${BLUE}[$timestamp]${NC} $message" ;;
    "SUCCESS") echo -e "${GREEN}[$timestamp]${NC} $message" ;;
    "WARN") echo -e "${YELLOW}[$timestamp]${NC} $message" ;;
    "ERROR") echo -e "${RED}[$timestamp]${NC} $message" ;;
  esac

  echo "[$timestamp] [$level] $message" >> "$OUTPUT_DIR/ralph.log"
}

resolve_agent() {
  if [ -n "$AGENT_CMD_OVERRIDE" ]; then
    AGENT_BIN="${AGENT_CMD_OVERRIDE%% *}"
    AGENT_DISPLAY="$AGENT_CMD_OVERRIDE"
    if [ "$PROVIDER" != "gpt" ]; then
      log "WARN" "AGENT_CMD_BASE is set; ignoring provider $PROVIDER"
    fi
    return
  fi

  case "$PROVIDER" in
    gpt)
      AGENT_BIN="codex"
      AGENT_DISPLAY='codex exec --model gpt-5.6-sol --sandbox workspace-write --approve-for-me --json'
      ;;
    grok)
      AGENT_BIN="grok"
      AGENT_DISPLAY='grok --prompt-file <prompt> --output-format streaming-messages-json --sandbox workspace --always-approve'
      ;;
    claude)
      AGENT_BIN="claude"
      AGENT_DISPLAY='claude -p --model claude-sonnet-5 --output-format stream-json --verbose --allowedTools Read,Edit,Write,Bash,...'
      ;;
  esac
}

enforce_agent_policy() {
  local cmd="$AGENT_DISPLAY"

  if [[ "$cmd" == *"--dangerously-bypass"* ]] ||
    [[ "$cmd" == *"danger-full-access"* ]] ||
    [[ "$cmd" == *"--yolo"* ]] ||
    [[ "$cmd" == *"--force"* ]] ||
    [[ "$cmd" == *"--dangerously-skip-permissions"* ]]; then
    log "ERROR" "Unsafe agent permission-bypass flags are disabled for this repository."
    exit 1
  fi
}

check_prerequisites() {
  log "INFO" "Checking prerequisites..."
  resolve_agent
  enforce_agent_policy

  if ! command -v "$AGENT_BIN" > /dev/null 2>&1; then
    log "ERROR" "Agent command is not available: $AGENT_BIN"
    exit 1
  fi

  if ! command -v jq > /dev/null 2>&1; then
    log "ERROR" "jq is not installed or not in PATH"
    exit 1
  fi

  if ! command -v pnpm > /dev/null 2>&1; then
    log "ERROR" "pnpm is not installed or not in PATH"
    exit 1
  fi

  if [ ! -f "$PRD_FILE" ]; then
    log "ERROR" "PRD file not found: $PRD_FILE"
    exit 1
  fi

  if [ ! -f "$PROMPT_FILE" ]; then
    log "ERROR" "Prompt file not found: $PROMPT_FILE"
    exit 1
  fi

  if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log "ERROR" "Not in a git repository"
    exit 1
  fi

  jq -e '
    (.stories | type == "array") and
    all(.stories[]; (.id | type == "string") and (.title | type == "string") and (.status | type == "string"))
  ' "$PRD_FILE" > /dev/null

  if [ "$DRY_RUN" = false ] &&
    jq -e '(.stories | length == 1) and (.stories[0].id == "EX-001")' "$PRD_FILE" > /dev/null; then
    log "ERROR" "ralph/prd.json still contains the template story. Import a GitHub issue with the ralph skill first."
    exit 1
  fi

  if [ "$ALLOW_DIRTY" = false ] && [ -n "$(git status --porcelain)" ]; then
    log "ERROR" "Working tree has uncommitted changes. Commit/stash them or pass --allow-dirty."
    exit 1
  fi

  if [ ! -f "$PROGRESS_FILE" ]; then
    echo "# Progress Log" > "$PROGRESS_FILE"
    echo "" >> "$PROGRESS_FILE"
  fi

  log "SUCCESS" "Prerequisites check passed"
}

get_current_story() {
  jq -c '
    def deps($story):
      if ($story.blocked_by? | type) == "array" then $story.blocked_by else [] end;
    def done_ids:
      [.stories[] | select(.status == "done") | .id];

    done_ids as $done |
    ([.stories[] | select(.status == "in_progress") | select(((deps(.) - $done) | length) == 0)] | .[0]) //
    ([.stories[] | select(.status == "pending") | select(((deps(.) - $done) | length) == 0)] | .[0]) //
    empty
  ' "$PRD_FILE"
}

count_incomplete_stories() {
  jq '[.stories[] | select(.status != "done")] | length' "$PRD_FILE"
}

update_story_status() {
  local story_id="$1"
  local new_status="$2"

  jq --arg id "$story_id" --arg status "$new_status" \
    '(.stories[] | select(.id == $id)).status = $status | .updated_at = (now | strftime("%Y-%m-%d"))' \
    "$PRD_FILE" > "${PRD_FILE}.tmp" &&
    mv "${PRD_FILE}.tmp" "$PRD_FILE"
}

get_story_id() { echo "$1" | jq -r '.id'; }
get_story_title() { echo "$1" | jq -r '.title'; }
get_story_epic() { echo "$1" | jq -r '.epic // "taxmaxi"'; }

get_ci_commands() {
  if jq -e '.global_verification and (.global_verification | length > 0)' "$PRD_FILE" > /dev/null 2>&1; then
    jq -r '.global_verification[]' "$PRD_FILE"
  else
    echo "pnpm run type-check"
    echo "pnpm run lint"
    echo "pnpm run test"
  fi
}

get_story_verification() {
  local story="$1"
  echo "$story" | jq -r '.verification[]? // empty' 2> /dev/null
}

run_verification_command() {
  local cmd="$1"

  export npm_config_verify_deps_before_run="${npm_config_verify_deps_before_run:-false}"

  if command -v mise > /dev/null 2>&1 && [ -f ".mise.toml" ]; then
    mise exec -- bash -lc "$cmd"
  else
    bash -lc "$cmd"
  fi
}

run_ci_checks() {
  local story="${1:-}"
  log "INFO" "Running verification checks..."
  local ci_failed=0

  : > "$OUTPUT_DIR/ci.log"

  if [ -n "$story" ] && [ "$story" != "null" ]; then
    while IFS= read -r cmd; do
      [ -z "$cmd" ] && continue
      echo ""
      echo "Running (story): $cmd"
      if run_verification_command "$cmd" 2>&1 | tee -a "$OUTPUT_DIR/ci.log"; then
        echo -e "${GREEN}OK${NC}"
      else
        echo -e "${RED}FAILED${NC}"
        ci_failed=1
      fi
    done < <(get_story_verification "$story")
  fi

  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    echo ""
    echo "Running (global): $cmd"
    if run_verification_command "$cmd" 2>&1 | tee -a "$OUTPUT_DIR/ci.log"; then
      echo -e "${GREEN}OK${NC}"
    else
      echo -e "${RED}FAILED${NC}"
      ci_failed=1
    fi
  done < <(get_ci_commands)

  if [ "$ci_failed" -eq 0 ]; then
    log "SUCCESS" "Verification checks passed"
    : > "$OUTPUT_DIR/ci_errors.txt"
    return 0
  fi

  log "ERROR" "Verification checks failed"
  {
    echo "The previous iteration failed verification. Fix these errors before signaling completion:"
    echo ""
    echo '```'
    tail -100 "$OUTPUT_DIR/ci.log"
    echo '```'
  } > "$OUTPUT_DIR/ci_errors.txt"
  return 1
}

build_prompt() {
  local iteration=$1
  local story=$2
  local progress_content
  progress_content=$(cat "$PROGRESS_FILE")
  local prompt_template
  prompt_template=$(cat "$PROMPT_FILE")
  local ci_errors="No errors from previous iteration."

  if [ -f "$OUTPUT_DIR/ci_errors.txt" ] && [ -s "$OUTPUT_DIR/ci_errors.txt" ]; then
    ci_errors=$(cat "$OUTPUT_DIR/ci_errors.txt")
  fi

  local prompt="$prompt_template"
  prompt="${prompt//\{\{ITERATION\}\}/$iteration}"
  prompt="${prompt//\{\{MAX_ITERATIONS\}\}/$MAX_ITERATIONS}"
  prompt="${prompt//\{\{CURRENT_STORY\}\}/$story}"
  prompt="${prompt//\{\{PROGRESS_CONTENT\}\}/$progress_content}"
  prompt="${prompt//\{\{CI_ERRORS\}\}/$ci_errors}"

  echo "$prompt"
}

stream_filter() {
  while IFS= read -r line; do
    if [[ "$line" == \{* ]]; then
      local rendered
      rendered=$(printf '%s\n' "$line" | jq -r '
        if .type == "assistant" then
          (.message.content[]? |
            if .type == "text" then .text
            elif .type == "tool_use" then "> Tool: \(.name // .part.tool // "?")"
            else empty end)
        elif .type == "result" then
          (.result // empty)
        elif .type == "exec_command.started" then
          "> Shell: \(.cmd // .command // "?")"
        elif .type == "item.completed" and .item.type == "assistant_message" then
          (.item.text // .item.content[]?.text // empty)
        elif .type == "text" then
          (.data // .text // empty)
        elif .type == "tool_call" then
          "> Tool: \(.toolName // .title // .name // "?")"
        elif .type == "content_block_delta" and (.delta.type? == "text_delta") then
          (.delta.text // empty)
        else
          empty
        end
      ' 2> /dev/null || true)

      if [ -n "$rendered" ]; then
        echo -e "${CYAN}${rendered}${NC}"
      fi
    else
      echo "$line"
    fi
  done
}

append_progress_entry() {
  local iteration="$1"
  local story_id="$2"
  local story_title="$3"
  local status="$4"
  local details="$5"

  {
    echo ""
    echo "## Iteration $iteration - $(date '+%Y-%m-%d %H:%M')"
    echo "**Story**: $story_id - $story_title"
    echo "**Status**: $status"
    if [ -n "$details" ]; then
      echo "**Notes**: $details"
    fi
    echo "---"
  } >> "$PROGRESS_FILE"
}

run_agent() {
  local prompt_file="$1"
  local output_file="$2"
  local status=0

  set +e
  if [ -n "$AGENT_CMD_OVERRIDE" ]; then
    local -a agent_cmd
    read -r -a agent_cmd <<< "$AGENT_CMD_OVERRIDE"
    local prompt
    prompt=$(cat "$prompt_file")
    "${agent_cmd[@]}" "$prompt" 2>&1 | tee "$output_file" | stream_filter
  else
    case "$PROVIDER" in
      gpt)
        codex exec \
          --model gpt-5.6-sol \
          -c 'model_reasoning_effort="high"' \
          --sandbox workspace-write \
          --approve-for-me \
          --json \
          - < "$prompt_file" 2>&1 | tee "$output_file" | stream_filter
        ;;
      grok)
        grok \
          --prompt-file "$prompt_file" \
          --output-format streaming-messages-json \
          --sandbox workspace \
          --always-approve \
          --effort high \
          --verbatim \
          --no-plan \
          2>&1 | tee "$output_file" | stream_filter
        ;;
      claude)
        claude \
          -p \
          --output-format stream-json \
          --model claude-sonnet-5 \
          --verbose \
          --allowedTools "Read,Edit,Write,Bash,Grep,Glob,Agent,WebFetch,WebSearch,Skill,NotebookEdit,TodoWrite" \
          -- "$(cat "$prompt_file")" \
          2>&1 | tee "$output_file" | stream_filter
        ;;
    esac
  fi
  status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

commit_story() {
  local iteration="$1"
  local story_id="$2"
  local story_title="$3"
  local story_epic="$4"

  if [ "$COMMIT_CHANGES" = false ]; then
    log "INFO" "Commit skipped; pass --commit to enable one commit per verified story."
    return 0
  fi

  git add -A
  if git diff --cached --quiet; then
    log "WARN" "No changes to commit"
    return 0
  fi

  local scope
  scope=$(echo "$story_epic" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-' | cut -c1-30)
  if [ -z "$scope" ]; then
    scope="taxmaxi"
  fi

  local commit_msg="feat($scope): $story_title

Story: $story_id
Ralph-Iteration: $iteration

Automated commit by Ralph loop."

  git commit -m "$commit_msg"
  log "SUCCESS" "Committed: $story_id - $story_title"
}

run_iteration() {
  local iteration=$1
  local output_file="$OUTPUT_DIR/iteration_${iteration}_output.txt"

  local story
  story=$(get_current_story)
  if [ -z "$story" ] || [ "$story" = "null" ]; then
    log "ERROR" "No runnable stories found. Remaining stories may be blocked."
    return 2
  fi

  local story_id
  story_id=$(get_story_id "$story")
  local story_title
  story_title=$(get_story_title "$story")
  local story_epic
  story_epic=$(get_story_epic "$story")

  log "INFO" "Starting iteration $iteration of $MAX_ITERATIONS"
  log "INFO" "Story: $story_id - $story_title"

  update_story_status "$story_id" "in_progress"

  local prompt
  prompt=$(build_prompt "$iteration" "$story")
  local prompt_file="$OUTPUT_DIR/iteration_${iteration}_prompt.md"
  echo "$prompt" > "$prompt_file"

  log "INFO" "Running agent: $AGENT_DISPLAY"
  if run_agent "$prompt_file" "$output_file"; then
    log "SUCCESS" "Agent completed iteration $iteration"
  else
    log "WARN" "Agent exited with non-zero status"
  fi

  if grep -q "STORY_BLOCKED" "$output_file"; then
    local block_reason
    # Grok JSONL keeps the rest of the message on the same line. Stop at the
    # JSON string boundary so progress.txt does not ingest signatures.
    block_reason=$(grep -o 'STORY_BLOCKED:[^"]*' "$output_file" | head -1 || true)
    [ -z "$block_reason" ] && block_reason="STORY_BLOCKED"

    update_story_status "$story_id" "blocked"
    append_progress_entry "$iteration" "$story_id" "$story_title" "blocked" "$block_reason"
    log "WARN" "Agent signaled blocked: $block_reason"
    return 1
  fi

  if grep -q "STORY_COMPLETE" "$output_file"; then
    log "INFO" "Agent signaled story completion"
    if run_ci_checks "$story"; then
      update_story_status "$story_id" "done"
      local changed_files
      changed_files=$(git diff --name-only | paste -sd ', ' -)
      append_progress_entry "$iteration" "$story_id" "$story_title" "done" "Changed files: ${changed_files:-none}"
      commit_story "$iteration" "$story_id" "$story_title" "$story_epic"
    else
      log "WARN" "Verification failed; keeping story in progress for the next iteration."
    fi
  else
    log "WARN" "Agent did not emit STORY_COMPLETE or STORY_BLOCKED; story remains in progress."
  fi

  return 1
}

main() {
  local repo_root
  repo_root=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2> /dev/null || true)
  if [ -n "$repo_root" ]; then
    cd "$repo_root"
  fi

  mkdir -p "$OUTPUT_DIR"
  # Inherited by the agent and its `pnpm run` children.
  export npm_config_verify_deps_before_run="${npm_config_verify_deps_before_run:-false}"
  log "INFO" "Starting Ralph Loop"
  log "INFO" "Provider: $PROVIDER"
  log "INFO" "Max iterations: $MAX_ITERATIONS"
  log "INFO" "PRD file: $PRD_FILE"
  log "INFO" "Commit mode: $COMMIT_CHANGES"

  check_prerequisites

  if [ "$DRY_RUN" = true ]; then
    log "INFO" "Dry run mode"
    run_ci_checks
    exit $?
  fi

  local iteration=1
  while [ "$iteration" -le "$MAX_ITERATIONS" ]; do
    if [ "$(count_incomplete_stories)" -eq 0 ]; then
      log "SUCCESS" "All PRD stories are complete"
      exit 0
    fi

    if run_iteration "$iteration"; then
      true
    else
      status=$?
      if [ "$status" -eq 2 ]; then
        exit 1
      fi
    fi

    sleep 2
    ((iteration++))
  done

  log "WARN" "Max iterations reached"
  exit 1
}

main
