---
name: sweep
description: "Audit a set of open issues against merged main before an epic run: a verdict per issue (green/yellow/red), an honest PR-size estimate, and drafted refresh comments. Nothing is posted until Max approves the report. Pass a selector, e.g. /sweep label:assets label:transactions."
disable-model-invocation: true
---

Audit every open issue matched by the selector against merged `main` at a named commit. Issues written before an architecture change go stale in knowable ways; the sweep finds those cheaply in one batch, so the orchestrator's pickup audit only has to catch what execution alone can reveal.

## Read first

`AGENTS.md`; the ADRs touching the issues' area; the closing and harvest comments of the epics that changed the ground under them; the owning context's `CONTEXT.md`.

## Verdict per issue

- **GREEN** — executes as written against current main.
- **YELLOW** — stale but fixable: references replaced code, schema, or vocabulary, but the goal survives. Draft the refresh comment: what changed, which ADR or recorded decision grounds it now, what the issue means today.
- **RED** — superseded or needs a real re-spec. Name the superseder or the missing decision.

For every issue, regardless of color: estimate its honest size in PRs under the delivery sizing rules (`docs/agents/delivery-process.md`). More than 2 PRs means it was cut too broad — draft a split proposal. Also flag overlaps where two issues now describe the same work.

## Report

One markdown report in this session, milestone members first: verdict, evidence with file and ADR references, PR estimate, and the drafted comment for each yellow and red, with a five-line summary up top (counts per color, the reds, the splits). **Post nothing to the tracker.**

## After Max approves

Post the refresh comments on the yellows, the split and supersession proposals on the affected issues, and close any red he explicitly confirms, each naming its successor. Real user data stays out of public issues per `docs/agents/issue-tracker.md`.
