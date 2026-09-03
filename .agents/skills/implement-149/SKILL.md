---
name: implement-149
description: "Implement one delivery task from the principal asset override spec (#149). Pass the task ID as the argument, e.g. /implement-149 T12a2."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #149 (principal asset identity and inclusion overrides). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

#212 is complete and the #149 apply track is active. The record and API tasks (T06–T09, T14–T16) and the apply tasks through T12a2 are done. Remaining work: any T12 remainder per the recorded T12 amendment, T13, and T17.

- T13 is a supersession proposal, not an implementation of the old checklist text (per the approved re-scope): propose the supersession note plus any thin remainder on #149, then stop for Max's explicit approval before acting.
- The latest recorded decisions on #149 always govern over this file. If this file and a newer #149 decision disagree, follow the decision and say so in the PR.

## Fixed reading list (always, before any code)

1. `gh issue view 149 --comments` — the spec, acceptance criteria, delivery checklist, the approved re-scope, and the T10b/T12 amendments. The newest decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. `docs/adr/0002` (asset identity) and `docs/adr/0005` through `0010` (accounting engine) — overrides live on the fact layer that feeds the engine.
4. The "Tax accounting language" section of `packages/core/CONTEXT.md` — use this vocabulary for naming.

## Coordination rules

The #212 stream is finished; this is the only active epic.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- Your PR must not contain a Drizzle migration while any other unmerged in-flight PR contains one. Deferred/reference-only PR #210 is exempt under its recorded decision.
- If resolving a merge conflict requires touching files outside your task's surface, stop and report instead of resolving.

## Scope fence

- Do only the one task. Target 5–8 changed files including tests and migrations; going somewhat over is fine when the task genuinely requires it; heading past ~15 files means the task was cut wrong — stop and say so.
- State the result classification in the PR description (result-preserving or result-changing) and paste the recorded decision text for every result the PR changes on purpose, with its source.

## Domain rules that bite

- Override history is append-only. Create, replace, and withdraw all append records carrying actor, timestamp, required user reason, the inspected system conclusion and revision, and a supersession link. Never UPDATE or DELETE a history row.
- Mutations use compare-and-set against both the inspected system revision and the expected active override ID. A stale write returns a typed conflict with the current effective projection and writes nothing.
- Reads must make absent and unowned targets indistinguishable.
- An exact representation target is blockchain + representation type + canonical contract, mint, or native identity. It must not require or create a global asset_representations row. The principal-plus-provider-asset target is only the fallback for chainless custody observations.
- An identity override may select only an existing economic asset. Fungible/NFT mismatch is rejected; symbols, names, market-data identity, and system confidence are warnings, not vetoes.
- **Stored facts are never matched to override targets by shape.** Transaction, direction, amount, address, coordinate counts, sibling rows, and multiplicity may not be used to discover a fact's target. A fact carries the target recorded by its writer, or is replayed to regenerate the link, or the adapter returns a typed blocker. If a fix you are writing starts adding matching, grouping, or counting logic over stored rows, stop — that is inference where a recorded fact should exist, and the task is cut wrong.
- The calculation run's input revision must cover the override history the adapter read (the recorded factual-content-hash rule). Different override state must never share one input revision.

## Seams for TDD

- Schema and repositories: the existing `*.integration.test.ts` pattern.
- Fact adaptation and inclusion behavior: the factual-ledger and override-application integration suites; fixtures go through the real source write path and first assert their stored target links.
- REST: the existing REST integration pattern, including typed conflicts and the absent-versus-unowned check.
- SDK: typed resource tests in both Effect and Promise clients.
- T17: public-seam tests only (REST/SDK), per the original spec text.

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #149` in the footer.
4. Open a PR referencing #149 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
