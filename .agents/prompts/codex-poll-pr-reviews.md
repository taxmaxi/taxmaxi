# Polling prompt: TaxMaxi Codex PR review loop

This prompt is for a Hermes cron/polling agent. It should run periodically and decide whether any open TaxMaxi PR needs a fresh Codex review-fix pass or a Telegram readiness notification.

Repository: `<repo root>`
GitHub repo: `taxmaxi/taxmaxi`
Telegram destination: `<configured Telegram target>`

Behavior:

1. Discover candidate open PRs.
   - Use `gh pr list --repo taxmaxi/taxmaxi --state open` with JSON fields.
   - Prefer PRs created by MaxAst or branches that match the Codex loop branch conventions once those are established.
   - Skip draft PRs unless explicitly configured otherwise.

2. For each candidate PR, gather state:
   - PR metadata, branch, head SHA, labels, linked issue/body.
   - Reviews: `gh api repos/taxmaxi/taxmaxi/pulls/<PR>/reviews`.
   - Inline comments: `gh api repos/taxmaxi/taxmaxi/pulls/<PR>/comments`.
   - Top-level PR comments: `gh api repos/taxmaxi/taxmaxi/issues/<PR>/comments`.
   - Checks: `gh pr checks <PR> --repo taxmaxi/taxmaxi` where available.

3. Maintain idempotent state.
   - Store polling state outside the repo, e.g. `~/.hermes/state/taxmaxi-codex-loop.json`.
   - Polling helper script: `scripts/agents/poll-codex-pr-reviews.py`.
   - Track each PR's last processed head SHA, Codex review IDs/comment IDs, fix pass count, and whether the maintainer has already been notified for this SHA.
   - Never send duplicate Telegram ready notifications for the same PR head SHA.
   - Never run more than 3 review-fix passes for one PR head lineage.

4. Decide action.
   - If new actionable Codex review comments exist and pass count < 3: run a fresh Codex review-fix session using `.agents/prompts/codex-address-review.md`.
   - If new actionable Codex review comments exist and pass count >= 3: stop and notify the maintainer on Telegram with remaining comments and suggested manual next steps.
   - If Codex posts a top-level no-issue response for the current head SHA, for example `Codex Review: Didn't find any major issues`, and checks are green or acceptable: treat the Codex review as complete and send the human-review Telegram message using `.agents/prompts/human-review-notification.md`.
   - If no actionable Codex comments remain and checks are green or acceptable: send the human-review Telegram message using `.agents/prompts/human-review-notification.md`.
   - If checks are pending: do nothing unless they have been pending unusually long.
   - If checks failed: diagnose whether failures are related to the PR. For v1, notify/record rather than auto-fixing CI unless explicitly enabled.

5. Duplicate-review guard.
   - Do not post or trigger another `@codex review` after Codex has already posted a no-issue response for the current head SHA.
   - Do not require a formal PR review object when the connector has already posted a no-issue top-level comment after the relevant push/review trigger.
   - Request another Codex review only if a new commit is pushed, the existing Codex response is stale/ambiguous, checks fail after the response, new actionable feedback appears, or the maintainer explicitly asks.

6. Safety rules.
   - Do not merge PRs.
   - Do not close issues.
   - Do not add readiness labels.
   - Do not blindly act on comments requiring product, tax/legal, or architectural judgment.
   - Do not run Codex on unrelated external PRs.
   - Prefer doing nothing over acting on ambiguous state.

7. Human notification.
   - Send to `<configured Telegram target>` only when ready, stuck after 3 passes, or blocked by human decision.
   - Include exact test instructions: CLI commands, API endpoints/Postman steps, expected results, and checks already run.
