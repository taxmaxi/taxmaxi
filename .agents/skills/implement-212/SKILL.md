---
name: implement-212
description: "Implement one delivery task from the accounting engine spec (#212). Pass the task ID as the argument, e.g. /implement-212 T04."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #212 (accounting engine extraction). The task ID (T01–T18) is given as the argument. If no argument is given, ask which task to do, then stop.

## Fixed reading list (always, before any code)

1. `gh issue view 212 --comments` — read the full spec, especially Implementation Decisions and your task's checklist entry. Comments may carry findings from earlier tasks (for example the T06 benchmark results).
2. `docs/adr/0005` through `docs/adr/0010` — the decisions this work must respect.
3. The "Tax accounting language" section of `packages/core/CONTEXT.md` — use this vocabulary for all naming.
4. The sequencing comment on issue #149 if your task touches rebuild, replay, or override scheduling.

## Scope fence

- Do only the one task. Do not start the next task, do not refactor neighboring code, do not wire in callers unless your task says so.
- Target 5–8 changed files including tests, migrations, and snapshots. Going somewhat over is fine when the task genuinely requires it; heading past ~15 files means the task was cut wrong — stop and say so instead of trimming the PR.
- Check the checklist state before starting: your task's predecessors must be merged. If they are not, stop and say so.

## Behavior class

Every task is one of two kinds; state which in the PR description:

- **Behavior-preserving** (T01–T05): output must be proven identical. The differential tests are the acceptance gate — if outputs differ, the bug is in the new code until proven otherwise. Never mix in behavior changes.
- **Behavior-changing** (T07 onward): new behavior, tested at the seams below.

## Seams for TDD

Use /tdd at these pre-agreed seams and no others:

- **Engine and core types** (T01, T02, T07, T09, T10): pure unit tests, in-memory inputs, no database, no Effect services.
- **Adapter and run storage** (T08, T11, T12): the existing `*.integration.test.ts` pattern.
- **Differential** (T03, and kept green through T04–T05): identical fixture facts through the old sync-path FIFO and the new pure module, results equal at the established scale.
- **REST end-to-end** (T13–T18): the existing REST integration pattern.

## Task-specific gates

- **T06** is a benchmark, not a feature: measure, then post findings as a comment on #212. No production code.
- **T07** must not merge before a grilling session on the event types. Review rule is the paper-US test: if filling a proposed event field requires tax-law reasoning, the field belongs in the engine or its result, not on the event.
- **T17** is deletion-heavy: split into two PRs if it grows past the size guidance.

## Repo rules that bite in this area

- All commands through mise: `mise x -- pnpm ...`. Tests run from the repo root.
- `packages/core` must not import from persistence, rest-api, or apps.
- Use `effect/BigDecimal`; consult `repos/effect/` for idiomatic usage. No `any`, no `!`.
- Persistence services stay implementation-free; implementations go in layers.
- Tests resolve workspace imports against built `dist/` — rebuild changed packages before blaming a test.

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass.
2. /code-review the work.
3. Branch from latest `main`. Commit with a conventional message scoped to the surface you touched, with `Refs: #212` in the footer.
4. Open a PR referencing #212 and the task ID, stating the behavior class.
