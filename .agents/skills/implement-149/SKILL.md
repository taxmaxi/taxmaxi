---
name: implement-149
description: "Implement one delivery task from the principal asset override spec (#149). Pass the task ID as the argument, e.g. /implement-149 T06."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #149 (principal asset identity and inclusion overrides). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Only T06, T07, T09, T14, T15, and T16, in that order. T05, T08, and T10–T13 are blocked until #212's T17 merges and need re-scoping first — if asked to do one, stop and say so. The latest sequencing comment on #149 (2026-08-31) governs.

## Fixed reading list (always, before any code)

1. `gh issue view 149 --comments` — the spec, acceptance criteria, delivery checklist, and sequencing comments.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. `docs/adr/0002` (asset identity) and `docs/adr/0005` through `0010` (accounting engine) — overrides live on the fact layer that feeds the engine.
4. The "Tax accounting language" section of `packages/core/CONTEXT.md` — use this vocabulary for naming.

## Two active streams — coordination rules

Another agent stream is working #212 at the same time.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- Your PR must not contain a Drizzle migration while any other unmerged PR (either epic) contains one. Check open PRs first; wait if needed.
- Do not touch calculation-run, portfolio-reader, report-reader, or accounting-engine files — #212 owns them. If resolving a merge conflict requires touching files outside your task's surface, stop and report instead of resolving.

## Scope fence

- Do only the one task. Target 5–8 changed files including tests and migrations; going somewhat over is fine when the task genuinely requires it; heading past ~15 files means the task was cut wrong — stop and say so.
- These tasks add new behavior (new tables, services, endpoints). State that in the PR description. They must not change any existing calculation result; if the task seems to require that, stop and report.

## Domain rules that bite (from the #149 spec)

- Override history is append-only. Create, replace, and withdraw all append records carrying actor, timestamp, required user reason, the inspected system conclusion and revision, and a supersession link. Never UPDATE or DELETE a history row.
- Mutations use compare-and-set against both the inspected system revision and the expected active override ID. A stale write returns a typed conflict with the current effective projection and writes nothing.
- Reads must make absent and unowned targets indistinguishable.
- An exact representation target is blockchain + representation type + canonical contract, mint, or native identity. It must not require or create a global asset_representations row. The principal-plus-provider-asset target is only the fallback for chainless custody observations.
- An identity override may select only an existing economic asset. Fungible/NFT mismatch is rejected; symbols, names, market-data identity, and system confidence are warnings, not vetoes.
- T07 and T09 read and validate only — do not schedule replay or recomputation work; that belongs to the blocked T08.

## Seams for TDD

- Schema and repositories (T06, T07, T09): the existing `*.integration.test.ts` pattern.
- REST endpoints (T14, T15): the existing REST integration pattern, including typed conflicts and the absent-versus-unowned check.
- SDK (T16): typed resource tests in both Effect and Promise clients.

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #149` in the footer.
4. Open a PR referencing #149 and the task ID. State that the PR adds new behavior and changes no existing results. Paste the text of any spec decision the PR relies on, with its source.
