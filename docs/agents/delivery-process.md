# Delivery process

How work moves from idea to merged code: capture, triage, definition, execution, harvest. This is the process that delivered #212 and #149, written down.

## Principles

1. **The issue body is the plan. Comments are events.** Reports, checkpoints, and discussion are comments. A comment that changes the plan is not done until the body reflects it.
2. **Specs are scaffolding.** They exist to build one thing reliably, then they close. Durable knowledge must move to a durable home before the spec closes (see table).
3. **A spec may only be quoted from inside its own work.** The moment a decision is quoted from another spec or epic, promote it to an ADR and quote the ADR.
4. **One issue per unit of work, upgraded in place.** A gap issue becomes the spec issue becomes the closed record. No parallel copies.
5. **Human time goes to gates.** Grilling answers, report approvals, harvest review. Agents do everything between gates.
6. **Weight by lane.** When unsure which lane, pick the lighter one.

## Skills by stage

Every stage of the pipeline has a skill. The skill is the operational how-to; this document is the why and the rules.

| Stage                            | Skill                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Capture a finding as a gap issue | `capture` (model-invocable — any session files findings the moment they surface) |
| Triage the queue                 | `triage`                                                                         |
| Ground a roadmap item            | `research`, Explore scans                                                        |
| Grill the one-way doors          | `grilling`, `grill-with-docs`                                                    |
| Upgrade a gap into a spec        | `spec`                                                                           |
| Arm a spec for execution         | `arm` (templates live in its directory)                                          |
| Execute one task                 | generated `implement-NNN` (bug lane: `implement`)                                |
| Close the spec                   | `harvest`                                                                        |
| Brief the founder afterward      | `spec-walkthrough`                                                               |

## Durable homes

| Knowledge                                                             | Home                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Architecture decision, rejected alternative, deliberate "do not undo" | `docs/adr/`                                                        |
| Domain term                                                           | `CONTEXT.md` of the owning context (see `CONTEXT-MAP.md`)          |
| Rule for how agents work                                              | `AGENTS.md`, `docs/agents/`                                        |
| Tax/legal rationale for a number                                      | Legal reference data, treatment codes, the run's explanation trace |
| Reusable how-to                                                       | `.agents/skills/`                                                  |
| Anything else in a spec                                               | Dies with the spec                                                 |

## Pipeline

```mermaid
flowchart TD
    A[Idea / bug / gap / finding] -->|"capture: small issue,\nneeds-triage — never chat-only"| B{Triage: pick lane}
    B -->|bug / small fix| C[Write the issue well\nlabel ready-for-agent]
    C --> D[One PR, review, merge, close]
    B -->|feature gap| E[Ground: Explore scan +\nresearch against primary sources]
    B -->|architecture change| E
    E --> F[Grill with Max:\none-way doors first]
    F -->|architecture lane also| G[Record: ADRs + glossary]
    F --> H[Upgrade issue body to spec\nwith delivery checklist]
    G --> H
    H --> I[Arm: generate implement-NNN skill\n+ orchestrator prompt]
    I --> J[Execute: orchestrator loop]
    J --> K[Harvest: final checklist task]
    K --> L[Close issue]
```

## Issue lifecycle

```mermaid
stateDiagram-v2
    [*] --> Gap: captured, needs-triage
    Gap --> Absorbed: folded into another spec
    Absorbed --> [*]: closed, points at carrier
    Gap --> Defining: picked from roadmap
    Defining --> Ready: body upgraded to spec,\nready-for-agent
    Ready --> Executing: orchestrator starts
    Executing --> Harvesting: last checklist task
    Harvesting --> [*]: closed
```

The issue number never changes. The body grows from problem statement to full spec; labels track the stage.

## Gap issue template

Captured at the moment of discovery by the `capture` skill — in any session, including mid-conversation, because a finding that lives only in chat is a finding lost. Problem only — no solutions.

```markdown
## Context

Where this was found, with links (spec, report, PR, review finding).

## Missing behavior

What does not happen today, in user terms, with one concrete example.

## Impact

Who is affected and how badly. Wrong numbers > blocked results > inconvenience.

## Evidence

The specific observation: counts, error codes, file references.

## Suggested lane

bug | feature gap | architecture change
```

Model example: #247.

## Spec template

The definition step rewrites the gap issue's body into:

```markdown
## Problem

(grown from the gap's Context + Missing behavior)

## Solution

What will be true afterward. Includes a short user-visible behavior list —
used to check the delivery checklist covers everything, not tracked as
separate checkboxes.

## Decisions

Recorded decisions this spec makes, including every intentional result
change. Quotable by PRs. Cross-spec decisions go to ADRs instead.

## Testing and seams

Which seams prove the behavior; prior art for each.

## Out of scope

Explicit no-list.

## Delivery checklist

- [ ] T01 — ...
- [ ] ...
- [ ] TNN — Harvest (see below; always the last task)

## Harvest log

(running list; the orchestrator appends learnings and gaps here as tasks
complete)
```

There is no separate acceptance-criteria section. Each task's checkbox text
carries its own acceptance behavior, result classification
(result-preserving or result-changing), test seam, and any decision it must
quote.

### Diagrams in specs

A spec gets a diagram when the diagram answers a question a reviewer would
otherwise have to ask. The trigger is the kind of complexity, not the part
of the system:

| Complexity in the spec                                           | Diagram                    |
| ---------------------------------------------------------------- | -------------------------- |
| A status or lifecycle (new or changed status enum)               | State diagram              |
| Ordering, atomicity, or concurrency across writers               | Sequence diagram           |
| A rule mapping (cause to treatment, input to outcome)            | Flowchart or a plain table |
| Relationship shape between tables (pointers, supersession links) | er-diagram, sparingly      |
| New dataflow across packages (architecture lane only)            | One component diagram      |

Rules:

- At most two diagrams per spec. Each states the question it answers and
  sits next to the Decisions it illustrates.
- Mermaid only. GitHub renders it, and the body is state — a diagram must be
  editable text or a re-scope will orphan it.
- Update or delete the diagram with every plan change. A stale diagram is
  false authority, worse than none.
- No class diagrams — inline the actual TypeScript shape when a type encodes
  a decision. No use-case diagrams — the behavior list covers it.
- If the lifecycle being drawn is permanent (for example a status machine
  the whole system relies on), the diagram belongs in the relevant ADR, not
  in the spec. Promote it there and link it.

Delivery checklist rules:

- One PR per checkbox, branched from latest `main` after the previous merges.
- Target 5–8 changed files including tests and migrations. Somewhat over is
  fine when the task requires it. Heading past ~15 files means the task was
  cut wrong — split the task, do not trim the PR.
- Verification tasks name the exact values they verify. "Compare results"
  invites verifying whatever is easy to compare.
- A task that deletes an old system gets an answer-key gate: the comparison
  against the old system happens first, and Max approves the report before
  deletion starts.
- Gates are checklist items and name their approver.
- The file cut in a task is a target, checked against merged `main` before
  coding. A file-list correction found by that recheck is recorded on the
  issue and is not a design amendment. A third correction on one task means
  the task was cut wrong: recut it.
- Mechanical fixture alignment is a category, not a count. When a schema or
  contract change forces test fixtures to state a fact they already have
  (an explicit origin kind, a required tagged resolver), the cut is "the
  approved production artifacts plus every such fixture". Approve the
  category once; do not re-approve per file. Production growth still stops.
- A task that adds a required recorded-fact column to a derived table
  states its replay gate in the checklist text: the PR is incomplete until
  affected sources have replayed and the new column is verified populated
  by the writer (AGENTS.md, Database).

## Execution

The `arm` step generates two files from templates that live inside the
`arm` skill directory (`.agents/skills/arm/`), the way `domain-modeling`
carries its format files:

- **`implement-NNN` worker skill**: fixed reading list, allowed tasks, scope
  fence, result classification, domain rules that bite, seams, done
  criteria, coordination rules when several streams run.
- **Orchestrator prompt**: role and operating loop, judgment rules, stop
  conditions. Two template rules are non-negotiable: the orchestrator
  **never edits code** — every change goes through a spawned worker — and
  the prompt **carries no project state** — the tracker is the state, read
  fresh each turn, and the newest recorded decision always wins over the
  prompt and the skill file.

Both generated files are spec-scoped scaffolding: the harvest deletes them.
Until the `arm` skill exists, the live orchestrator prompts sit in
`.agents/prompts/`; the `arm` templates are seeded from them. To start an
orchestrator, paste the prompt file's content into a new session.
The orchestrator loop:

```mermaid
flowchart TD
    A[Spawn worker: /implement-NNN Txx] --> B[Worker opens PR]
    B --> C{Review}
    C -->|comments| D[Assess against AGENTS.md:\nfix, fix the class, or decline with quote]
    D --> B
    C -->|approved| E[Rebase, merge, tick checkbox]
    E --> F{Learnings or gaps\nfrom this task?}
    F -->|conduct rule or\ncross-spec decision| G[Promote NOW:\nAGENTS.md / ADR]
    F -->|else| H[Append to spec's Harvest log]
    G --> I{Next task?}
    H --> I
    I -->|yes| A
    I -->|no: last task is Harvest| J[Run the harvest]
```

Two orchestrators may run in parallel. Rules: rebase before opening and
before merging; one merge at a time across all streams; never two unmerged
PRs with Drizzle migrations; a conflict outside the task's surface stops the
worker, who reports instead of resolving.

## Harvest

The mandatory final checklist task of every spec. Steps:

1. Process the Harvest log plus one sweep of the whole epic. Promote what
   meets the bar: quoted cross-spec → ADR; changes user-visible numbers →
   legal reference data / treatment codes / ADR; rule of conduct →
   `AGENTS.md`; new term → glossary.
2. File every remaining gap as a new `needs-triage` issue via the `capture`
   skill. Link them from the roadmap. Then run the blocker sweep against
   the live local database: list the active runs' blocker codes with
   counts; every code with no recorded rule and no open issue gets a gap
   issue. Check the active runs themselves first: an active run older than
   the last fact replay is stale evidence, and its blockers may point at
   rows that no longer exist. Report counts from fresh runs only, and file
   the staleness as its own gap.
3. Delete the spec's `implement-NNN` skill (and symlink) and its
   orchestrator prompt.
4. Update the reusable templates and skills with what the epic taught.
5. Post a closing summary comment (an event) and close the issue.

After the harvest, the founder can run `/spec-walkthrough` on the closed
spec: a tech-lead briefing built from the final body and the merged PRs'
result classifications — what changed, which numbers changed on purpose,
and a manual test plan. It reads state, not the comment log.

Reports containing real user data follow `docs/agents/issue-tracker.md`:
redacted summary on the issue, full report in a local file.

## Roadmap

One map issue per goal (wayfinder pattern): the body holds the ordered gap
list and an explicit Fog section for known unknowns. Picking an item off the
map is the manual act that starts its definition lane. The map's body is
state; keep it current like any spec body.
