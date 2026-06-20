# Codex prompt: address Codex GitHub App review feedback

Use this prompt with a fresh `codex exec --full-auto` session for each review-fix pass.

Replace placeholders before running:

- `<PR_NUMBER>`
- `<PASS_NUMBER>`: 1, 2, or 3
- `<OPTIONAL_SCOPE_NOTES>`

```text
You are addressing actionable Codex GitHub App review feedback on PR #<PR_NUMBER> in taxmaxi/taxmaxi.

This is review-fix pass <PASS_NUMBER> of a maximum of 3.

Before editing files:
1. Read AGENTS.md and follow it strictly.
2. Use `gh pr view <PR_NUMBER> --repo taxmaxi/taxmaxi --comments` to read PR context and top-level comments.
3. Use GitHub/gh commands to inspect formal reviews, review comments, latest branch, checks, and commits. If gh's default output is insufficient, use `gh api` for:
   - `/repos/taxmaxi/taxmaxi/pulls/<PR_NUMBER>/reviews`
   - `/repos/taxmaxi/taxmaxi/pulls/<PR_NUMBER>/comments`
   - `/repos/taxmaxi/taxmaxi/issues/<PR_NUMBER>/comments`
4. Check out/update the PR branch if needed.
5. Inspect the current diff against `origin/main`.

Scope notes from the orchestrator/user:
<OPTIONAL_SCOPE_NOTES>

Feedback triage rules:
- Address only actionable review feedback from Codex/Codex GitHub App or feedback explicitly called out by the orchestrator.
- Ignore stale comments that refer to code already changed or removed.
- Ignore purely informational praise/status comments.
- Do not broaden scope beyond the original issue/PR.
- Stop and ask for human/orchestrator clarification if:
  - comments conflict with each other
  - comments require product, tax, legal, or architectural judgment
  - fixing the comment would substantially expand PR scope
  - the review appears to request an unsafe or AGENTS.md-incompatible change

Implementation rules:
- Make the smallest scoped changes needed to satisfy actionable feedback.
- Preserve all working behavior from the original PR.
- Prefer behavior-focused tests for changed behavior.
- Do not edit files under `repos/` unless explicitly instructed.
- Do not use `any` or non-null assertions (`!`).
- Respect all TaxMaxi architecture and documentation rules from AGENTS.md.

Command rules:
- Use `mise x -- pnpm ...` for Node/package-manager commands.
- Do not call `pnpm`, `npm`, `node`, `vitest`, `tsc`, `oxlint`, or `oxfmt` directly unless explicitly requested.

Validation:
1. Run targeted tests/checks relevant to the fix.
2. If the fix touches broad contracts or shared packages, run broader checks, usually some subset of:
   - `mise x -- pnpm run test --project=unit`
   - `mise x -- pnpm run test`
   - `mise x -- pnpm run lint`
   - `mise x -- pnpm run type-check`
   - `mise x -- pnpm run format`
3. Fix failures caused by your changes. Do not hide failing checks.

Finishing:
1. Show the final diff summary.
2. Commit with a Conventional Commit message, e.g. `fix: address PR review feedback` with a body listing the addressed comments when helpful.
3. Push the PR branch.
4. Do not merge.
5. Final output must include:
   - review comments addressed
   - comments intentionally skipped and why
   - commands run and pass/fail status
   - whether another Codex GitHub App review is expected after the push
```
