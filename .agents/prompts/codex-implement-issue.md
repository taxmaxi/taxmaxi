# Codex prompt: implement a TaxMaxi GitHub issue

Use this prompt with `codex exec --full-auto` from the TaxMaxi repository or an isolated worktree.

Replace placeholders before running:

- `<ISSUE_NUMBER>`
- `<OPTIONAL_SCOPE_NOTES>`

```text
You are implementing GitHub issue #<ISSUE_NUMBER> in taxmaxi/taxmaxi.

Repository root: <repo root>, or the current git worktree if this prompt is run elsewhere.

Before editing files:
1. Read AGENTS.md and follow it strictly.
2. Use `gh issue view <ISSUE_NUMBER> --repo taxmaxi/taxmaxi --comments` to read the issue and discussion.
3. Inspect the relevant code and existing tests.
4. Summarize the intended implementation in a few bullets.
5. Stop and ask for clarification if any of these are true:
   - acceptance criteria are ambiguous
   - product/tax/legal judgment is required
   - the issue appears too broad for one PR
   - the requested change conflicts with AGENTS.md or existing architecture

Scope notes from the orchestrator/user:
<OPTIONAL_SCOPE_NOTES>

Implementation rules:
- Keep the PR scoped to issue #<ISSUE_NUMBER>.
- Prefer TDD when the change has observable behavior: write/adjust a failing test first, then implement the minimal fix.
- Verify behavior through public interfaces, not implementation details.
- Use existing repo placement and naming patterns before creating new files.
- Do not edit files under `repos/` unless explicitly instructed.
- Do not add CMS, billing, admin console, or marketing-site features.
- Do not use `any` or non-null assertions (`!`).
- Use Effect idioms from the repo and, when needed, inspect `repos/effect/` as read-only reference material.
- Respect architecture boundaries:
  - `packages/core/**` must not import infrastructure/adapters.
  - persistence service files contain contracts/tags/types only; live implementation belongs in layers.
  - REST contracts/schemas belong in definitions; runtime handlers belong in layers.
  - provider sync logic belongs under sync-engine provider/service/layer boundaries.
- Add JSDoc with `@module` for new persistence service/layer files.
- Only add barrel exports when they are actually imported externally.

Command rules:
- Use `mise x -- pnpm ...` for Node/package-manager commands.
- Do not call `pnpm`, `npm`, `node`, `vitest`, `tsc`, `oxlint`, or `oxfmt` directly unless explicitly requested.
- Prefer package scripts over custom one-off commands.

Validation:
1. Run the smallest relevant test command first.
2. Then run broader checks as appropriate for the change, usually some subset of:
   - `mise x -- pnpm run test --project=unit`
   - `mise x -- pnpm run test`
   - `mise x -- pnpm run lint`
   - `mise x -- pnpm run type-check`
   - `mise x -- pnpm run format`
3. If a check fails, diagnose and fix it. Do not hide failing checks.

Finishing:
1. Show `git diff --stat` and inspect the final diff for accidental scope creep.
2. Commit the completed change with a Conventional Commit message following AGENTS.md. Include `Refs: #<ISSUE_NUMBER>` or `Closes #<ISSUE_NUMBER>` in the commit body only when appropriate.
3. Do not merge.
4. If pushing/PR creation is requested in the surrounding command, create a PR with:
   - concise title
   - summary bullets
   - test plan with exact commands run
   - `Closes #<ISSUE_NUMBER>` when the PR fully resolves the issue
5. Leave enough final output for the orchestrator to create a human-review test plan.
```
