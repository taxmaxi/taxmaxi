# Ralph Loop

This directory contains a TaxMaxi-specific Ralph loop for running one scoped story at a time through a coding agent with local verification backpressure. Stories are meant to be generated based on GitHub issues that were created by the local `.agents/skills/to-prd`, `.agents/skills/to-issues`, `.agents/skills/request-refactor-plan`, and `.agents/skills/triage-issue` skills.

## Files

- `ralph/ralph.sh`: main loop script. It selects the next runnable story from `ralph/prd.json`, renders `ralph/PROMPT.md`, runs the configured coding agent, checks for `STORY_COMPLETE` or `STORY_BLOCKED`, runs verification, updates story status, records progress, and optionally commits.
- `ralph/PROMPT.md`: TaxMaxi-specific prompt template injected into each iteration.
- `ralph/prd.json`: machine-readable story backlog. It starts with an example story and is updated by the `.agents/skills/ralph` skill.
- `ralph/progress.txt`: short iteration log that gives later iterations continuity.
- `ralph/reset.sh`: resets `prd.json`, `progress.txt`, and local Ralph output back to template state.

Local runtime output goes under `ralph/.output/`, which is ignored by git.

## GitHub Issue Flow

1. Create a planning or implementation issue using one of the existing skills:
   - `.agents/skills/to-prd`
   - `.agents/skills/to-issues`
   - `.agents/skills/request-refactor-plan`
   - `.agents/skills/triage-issue`
2. Ask an agent to use the `ralph` skill to import the issue. The skill splits that one issue into multiple stories in `ralph/prd.json`, for example:

   ```text
   Use the ralph skill to import #123 into ralph/prd.json.
   ```

3. Review the stories in `ralph/prd.json`.
4. Run the loop with a provider name (`gpt`, `grok`, or `claude`):

   ```bash
   bash ralph/ralph.sh grok --max-iterations 10
   ```

`gpt` is the default and runs Codex. `grok` runs the Grok CLI. `claude` runs Claude Code.

By default, the loop does not commit. This keeps the repo aligned with `AGENTS.md`, which requires explicit user intent before commits. If you want Ralph's classic one-story-one-commit behavior, opt in:

```bash
bash ralph/ralph.sh grok --commit --max-iterations 10
```

## Story Schema

Each story should have this shape:

```json
{
  "id": "API-001",
  "epic": "Short epic name",
  "title": "Imperative story title",
  "description": "What changes and why.",
  "source": {
    "kind": "github_issue",
    "issue": 123,
    "url": "https://github.com/owner/repo/issues/123",
    "template": "to-issues"
  },
  "blocked_by": [],
  "blocked_by_issues": [],
  "acceptance_criteria": ["Observable, verifiable criterion"],
  "implementation_notes": ["Durable implementation guidance from the source issue"],
  "testing_notes": ["Behavior-focused test guidance"],
  "priority": "high",
  "status": "pending",
  "estimated_complexity": "small",
  "verification": ["pnpm run test -- packages/rest-api/tests/example.test.ts"]
}
```

`blocked_by` contains Ralph story IDs. `blocked_by_issues` preserves GitHub issue references for traceability only. Prefer root Vitest commands with explicit file paths for package tests unless the affected workspace has its own `test` script.

## Running

Prerequisites:

- `jq`
- `pnpm`
- a supported coding-agent CLI (`codex` for `gpt`, `grok` for `grok`, `claude` for `claude`)

Agents must not run `pnpm install` or set `CI=true` to confirm a modules purge. Grok's workspace sandbox cannot use the global pnpm store, so an install there rewrites `node_modules` against `./.pnpm-store` and the next local `pnpm run test` asks to wipe the tree. The loop sets `npm_config_verify_deps_before_run=false` so verification never does that.

Choose the provider as the first argument. Only these names are accepted:

```bash
bash ralph/ralph.sh gpt
bash ralph/ralph.sh grok
bash ralph/ralph.sh claude
```

Override the provider command with `AGENT_CMD_BASE`:

```bash
AGENT_CMD_BASE="cursor agent --model gpt-5.5-extra-high-fast --print --output-format stream-json --trust" \
  bash ralph/ralph.sh --max-iterations 10
```

The script refuses dangerous bypass flags such as `--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`, `--yolo`, `--force`, and `--dangerously-skip-permissions`.

Useful options:

- `--dry-run`: run verification only.
- `--max-iterations <n>`: cap loop iterations.
- `--commit`: commit successful stories.
- `--allow-dirty`: allow starting with existing uncommitted changes.

## Resetting

Reset Ralph working state before merging scaffolding or after finishing a batch:

```bash
bash ralph/reset.sh
```

This restores template `prd.json` and `progress.txt`, removes `ralph/.output/`, and removes `ralph/intake.md` if present.
