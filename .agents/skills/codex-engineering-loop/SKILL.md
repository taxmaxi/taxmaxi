---
name: codex-engineering-loop
description: Orchestrate TaxMaxi issue-to-PR work with Codex implementation, Codex GitHub App reviews, up to 3 review-fix passes, and Telegram human-review notification.
---

# TaxMaxi Codex Engineering Loop

Use this skill when the maintainer asks to run the TaxMaxi engineering loop, implement a GitHub issue with Codex, monitor Codex review feedback, or notify when a PR is ready for human review.

## Roles

- **Hermes/orchestrator**: issue quality, scope control, gh operations, Codex prompts, verification, polling/review-loop state, Telegram notification.
- **Codex CLI**: code-changing implementation worker and review-fix worker.
- **Codex GitHub App**: expected to review every push on a PR.
- **Maintainer**: final human reviewer/tester/merger.

## Important preferences

- Do not use `ready-for-codex-review` or `ready-for-human-review` labels.
- Notify the maintainer on Telegram when a PR is ready for human review.
- The Telegram notification must include how the maintainer should test the change, with concrete CLI commands or API/Postman steps.
- Do not merge PRs.
- Use a fresh Codex session for every review-fix pass.
- Stop after at most 3 review-fix passes.

## Repo context

- Repo path: `<repo root>`
- GitHub repo: `taxmaxi/taxmaxi`
- Telegram target: `<configured Telegram target>`
- Prompt files:
  - `.agents/prompts/codex-implement-issue.md`
  - `.agents/prompts/codex-address-review.md`
  - `.agents/prompts/codex-poll-pr-reviews.md`
  - `.agents/prompts/human-review-notification.md`
- Polling script: `scripts/agents/poll-codex-pr-reviews.py`

Always read and follow `AGENTS.md` before running code-changing work.

## Phase 1: create or refine the GitHub issue

If the work starts from a rough idea, use the appropriate repo-local skill first:

- `to-prd`: larger feature/product spec.
- `to-issues`: break a PRD/plan into vertical-slice issues.
- `triage-issue`: bug investigation with root cause and TDD fix plan.
- `request-refactor-plan`: refactor plan with tiny commits.

Before implementation, ensure the issue has:

- clear problem/solution or root cause
- acceptance criteria
- test expectations
- explicit out-of-scope boundaries
- labels relevant to domain/component, such as `solana`, `enhancement`, `bug`, etc.

## Phase 2: decide whether Codex can start

A GitHub issue is Codex-ready only if:

- scope is small enough for one PR
- acceptance criteria are testable
- no unresolved product/tax/legal decision is required
- dependencies/blockers are clear
- implementation can be validated locally

If not ready, refine the issue or ask the maintainer before launching Codex.

## Phase 3: run Codex implementation

Prefer an isolated branch or worktree.

Typical flow:

```bash
cd <repo root>
git fetch origin --prune
git checkout main
git pull --ff-only origin main
git checkout -b feat/issue-<number>-short-name
```

Then run Codex with `.agents/prompts/codex-implement-issue.md`, replacing placeholders.

Use `codex exec --full-auto` in a PTY-capable terminal when possible. Monitor logs and stop Codex if it expands scope or violates AGENTS.md.

## Phase 4: verify and create PR

After Codex finishes:

1. Inspect `git status`, `git diff --stat`, and relevant diffs.
2. Verify checks Codex claimed to run.
3. Run additional checks if needed. Use `mise x -- pnpm ...` only.
4. Ensure the commit message follows AGENTS.md.
5. Push the branch.
6. Create a PR with:
   - concise title
   - summary bullets
   - exact test plan
   - `Closes #<issue>` if fully resolved
7. Add relevant domain/component labels only. Do not add readiness labels.

## Phase 5: Codex review loop

The Codex GitHub App is expected to review every push on a PR.

For each review-fix pass:

1. Read latest PR reviews/comments/checks.
2. Identify actionable Codex comments.
3. Treat a Codex connector top-level comment such as `Codex Review: Didn't find any major issues` as a completed review for the current PR head when it appears after the relevant push/review trigger and checks are green. A formal PR review object is not required in that case.
4. If no actionable comments remain and checks are acceptable, prepare Telegram human-review notification.
5. If actionable comments exist and pass count is less than 3, start a fresh Codex session using `.agents/prompts/codex-address-review.md`.
6. Verify Codex's changes, commit/push if Codex did not already do so, then wait for the next Codex GitHub App review.
7. If pass count reaches 3 and actionable comments remain, stop and notify the maintainer with the remaining comments.

Do not post another `@codex review` after a no-issue Codex response for the current head SHA. Request another Codex review only after a new commit, stale/ambiguous review state, failing checks, new actionable feedback, or an explicit maintainer request.

## Phase 6: Telegram notification

Use `send_message` to `<configured Telegram target>`.

The message must include:

- PR URL
- linked issue
- concise summary
- checks already run and status
- Codex review-loop status
- exact suggested human test steps
- API endpoints/Postman steps if relevant
- caveats or remaining human decisions

Use `.agents/prompts/human-review-notification.md` as the template.

## Polling v1

Until GitHub webhooks are enabled, use polling rather than event-driven triggers.

Polling should:

- list open TaxMaxi PRs periodically
- inspect Codex review comments and checks
- keep idempotent state in `~/.hermes/state/taxmaxi-codex-loop.json`
- run at most 3 fresh Codex review-fix sessions per PR head lineage
- Telegram the maintainer exactly once per ready PR head SHA

Use `.agents/prompts/codex-poll-pr-reviews.md` as the polling behavior spec.

## Safety stops

Stop and ask/notify the maintainer instead of auto-fixing when:

- review feedback conflicts
- product/tax/legal judgment is needed
- an architectural decision is needed
- the fix would expand scope beyond the issue
- CI failures are unrelated or unclear
- Codex produces risky or broad changes
- three review-fix passes have already run
