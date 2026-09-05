---
name: implement-{{NNN}}
description: "Implement one delivery task from {{SPEC_SHORT_NAME}} (#{{NNN}}). Pass the task ID as the argument, e.g. /implement-{{NNN}} T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #{{NNN}} ({{SPEC_TITLE}}). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

{{ALLOWED_TASKS: which tasks this skill may run now, which are gated on an approver, which are blocked — and the instruction to refuse blocked ones and say why}}

- The latest recorded decisions on #{{NNN}} always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Fixed reading list (always, before any code)

1. `gh issue view {{NNN}} --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. {{ADRS_AND_DOCS: the ADRs and domain docs this spec touches, with one clause each on why}}
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

{{STREAMS: name every other active epic and the files it owns, or state that this is the only active epic}}

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- Your PR must not contain a Drizzle migration while any other unmerged in-flight PR contains one. Check open PRs first; wait if needed.
- If resolving a merge conflict requires touching files outside your task's surface, stop and report instead of resolving.

## Scope fence

- Do only the one task. Target 5–8 changed files including tests and migrations; going somewhat over is fine when the task genuinely requires it; heading past ~15 files means the task was cut wrong — stop and say so.
- Before any code, recheck the task's file cut against merged `main`. If the cut is wrong, record a file-list correction on the issue first, then code. A third correction on one task is a recut: stop and report.
- Fixture alignment forced by a schema or contract change (fixtures stating a fact they already have) is a category, not a count. Include every such test-only file, and list production artifacts separately from fixture files in the PR description. Production growth beyond the cut still stops.
- State the result classification in the PR description (result-preserving or result-changing) and paste the recorded decision text for every result the PR changes on purpose, with its source.
- Record facts where they are created; never infer them later from stored rows (ADR 0012). If your fix starts matching, grouping, or counting stored rows to find which decision applies to a fact, stop: a recorded fact is missing.
- A value must mean what its type says: no placeholder IDs of another kind, no defaults that record false facts, no nullable staging of a required fact.

## Domain rules that bite

{{DOMAIN_RULES: from the spec's Decisions — the rules a PR must never bend, each stated as behavior a worker can recognize while coding}}

## Seams for TDD

{{SEAMS: from the spec's Testing section, mapped to task ranges, naming prior art per seam}}

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass. A failure that also exists on untouched `origin/main` may be noted as such, but say so explicitly with the file and line; the orchestrator files a fix task and it is never carried across a second PR.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #{{NNN}}` in the footer.
4. Open a PR referencing #{{NNN}} and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
