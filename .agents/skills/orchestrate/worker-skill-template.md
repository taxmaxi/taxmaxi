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
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there.

## Scope fence

- Do only the one task.
- Every rule governing your PR — sizing and the ~15-file tripwire, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

{{DOMAIN_RULES: from the spec's Decisions — the rules a PR must never bend, each stated as behavior a worker can recognize while coding}}

## Seams for TDD

{{SEAMS: from the spec's Testing section, mapped to task ranges, naming prior art per seam}}

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass. A failure that also exists on untouched `origin/main` is noted explicitly with file and line (AGENTS.md: a red gate on main is a task, never carried past one PR).
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #{{NNN}}` in the footer.
4. Open a PR referencing #{{NNN}} and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
