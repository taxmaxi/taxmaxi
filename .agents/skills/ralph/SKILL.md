---
name: ralph
description: Manage TaxMaxi Ralph workflow files, especially importing GitHub issues created by the local planning skills into ralph/prd.json stories.
compatibility: Designed for Codex, Cursor CLI, and similar coding agents.
allowed-tools: Bash Read Write Edit Grep
---

# Ralph Workflow Skill

Use this skill when the user asks to:

- Import a GitHub issue into Ralph stories.
- Populate or update `ralph/prd.json`.
- Convert issues created by `to-prd`, `to-issues`, `request-refactor-plan`, or `triage-issue` into executable Ralph stories.
- Reset or maintain Ralph working files.

## Core Principle

Do not rely on transient chat context as the source of truth. Materialize the GitHub issue into `ralph/intake.md`, then update `ralph/prd.json` from that stable artifact.

Preferred flow:

1. Fetch the source issue with `gh issue view <number-or-url> --comments --json number,title,body,url,labels,state,comments`.
2. Write or update `ralph/intake.md` with the issue metadata, detected template, parsed sections, constraints, and verification expectations.
3. Read `ralph/prd.json`.
4. Generate or update Ralph stories from `ralph/intake.md`.
5. Write `ralph/prd.json` and summarize the changes.

## Supported Source Issue Templates

### `to-prd`

Detected sections:

- `Problem Statement`
- `Solution`
- `User Stories`
- `Implementation Decisions`
- `Testing Decisions`
- `Out of Scope`
- `Further Notes`

Conversion:

- Prefer one Ralph story per cohesive user-story cluster.
- Preserve the PRD issue as `source`.
- Put durable architecture guidance in `implementation_notes`.
- Put behavior-focused testing guidance in `testing_notes`.
- Do not copy file paths or brittle implementation details into stories.

### `to-issues`

Detected sections:

- `Parent`
- `What to build`
- `Acceptance criteria`
- `Blocked by`

Conversion:

- Usually create exactly one Ralph story per implementation issue.
- Use `What to build` as `description`.
- Use checklist items from `Acceptance criteria` as `acceptance_criteria`.
- Preserve GitHub blockers in `blocked_by_issues`.
- Use `blocked_by` only for Ralph story IDs that exist in `ralph/prd.json`.

### `request-refactor-plan`

Detected sections:

- `Problem Statement`
- `Solution`
- `Commits`
- `Decision Document`
- `Testing Decisions`
- `Out of Scope`
- `Further Notes`

Conversion:

- Create one Ralph story per independently verifiable commit step or small commit group.
- Keep each story behavior-preserving unless the source issue explicitly includes a behavior change.
- Put durable design decisions in `implementation_notes`.
- Put testing decisions in `testing_notes`.

### `triage-issue`

Detected sections:

- `Problem`
- `Root Cause Analysis`
- `TDD Fix Plan`
- `Acceptance Criteria`

Conversion:

- Create one Ralph story per RED/GREEN cycle when cycles are independently verifiable.
- Otherwise create one story for the smallest complete bug fix.
- Use observable acceptance criteria, not internal implementation assertions.
- Preserve root-cause summary in `implementation_notes`.

## `ralph/intake.md` Format

Write this file before changing `ralph/prd.json`:

```md
# Ralph Intake

## Source

- Issue: #123
- URL: https://github.com/owner/repo/issues/123
- Title: Issue title
- Template: to-issues | to-prd | request-refactor-plan | triage-issue | unknown

## Goal

Concise summary of what the issue asks for.

## Parsed Sections

Durable summary of relevant issue sections.

## Out Of Scope

What should not be implemented.

## Dependencies

GitHub issue blockers and Ralph story blockers.

## Verification Expectations

Package-scoped commands and any specific tests implied by the issue.
```

## Story Schema

Every story in `ralph/prd.json` must match this shape:

```json
{
  "id": "<PREFIX>-<NNN>",
  "epic": "Short epic name",
  "title": "Imperative sentence",
  "description": "1-2 sentences: what changes and why.",
  "source": {
    "kind": "github_issue",
    "issue": 123,
    "url": "https://github.com/owner/repo/issues/123",
    "template": "to-issues"
  },
  "blocked_by": [],
  "blocked_by_issues": ["#122"],
  "acceptance_criteria": ["Specific, observable, verifiable criterion."],
  "implementation_notes": ["Durable implementation guidance."],
  "testing_notes": ["Behavior-focused testing guidance."],
  "priority": "high | medium | low",
  "status": "pending",
  "estimated_complexity": "small | medium | large",
  "verification": ["pnpm run test -- <path-to-test-file>"]
}
```

## Add Stories Workflow

1. Read `ralph/prd.json` to understand existing stories, ID prefixes, source issue references, and metadata.
2. Read or create `ralph/intake.md` from the source issue.
3. If the PRD still contains the example story (`EX-001` / `Example story title`), remove it when adding real stories.
4. Update PRD metadata:
   - `title`: short name for the imported issue or issue group.
   - `project`: `TaxMaxi`.
   - `description`: one-sentence summary.
   - `created_at`: today's date if replacing the template.
   - `updated_at`: today's date.
   - Preserve `global_verification` and `completion_criteria` unless the user asks otherwise.
5. Choose an ID prefix:
   - Do not use `EX`.
   - Use 2-4 uppercase letters derived from the feature or issue type.
   - Continue numbering from existing real stories with the same prefix.
6. Generate small, ordered stories:
   - Foundation and dependency stories first.
   - End-to-end tracer bullets where possible.
   - Prefer one issue-slice story for `to-issues`.
   - Prefer RED/GREEN cycle stories for `triage-issue`.
   - Prefer behavior-preserving small steps for `request-refactor-plan`.
7. Deduplicate:
   - Do not generate a story when `source.issue` and title/scope are already represented.
   - Do not edit existing real stories unless the user asks for an update.
8. Write valid formatted JSON to `ralph/prd.json`.

## Verification Command Rules

- Prefer commands that already exist in `package.json`.
- Use examples such as:
  - `pnpm --filter @my/core run type-check`
  - `pnpm --filter @my/rest-api run type-check`
  - `pnpm --filter @my/persistence run type-check`
  - `pnpm --filter @my/sync-engine run type-check`
  - `pnpm --filter server run type-check`
  - `pnpm --filter taxmaxi run test`
  - `pnpm --filter frontend run test`
  - `pnpm run test -- path/to/file.test.ts`
- Include `pnpm run type-check`, `pnpm run lint`, and `pnpm run test` only in `global_verification`, not every story.
- If no narrower package command exists, use `pnpm run test -t "<behavior name>"` or `pnpm run test -- path/to/test.ts`.

## Rules

- New stories must start with `status: "pending"`.
- Valid statuses are `pending`, `in_progress`, `done`, and `blocked`.
- Use `blocked_by` only for Ralph story IDs. Use `blocked_by_issues` for GitHub issue numbers.
- Acceptance criteria must be observable and verifiable.
- Do not copy long issue prose verbatim; summarize it.
- Do not include brittle file paths or line numbers from issue bodies unless a path is itself the public contract under test.
- Do not create stories for out-of-scope work.
- Keep stories small enough that Ralph can finish one in a single iteration or a few corrective iterations.
- Do not modify git history.
- Do not delete Ralph infrastructure files unless explicitly requested.

## Output Requirements

After updating `ralph/prd.json`, report:

- Source issue URL.
- Detected issue template.
- Short changelog of PRD updates.
- Table of added stories: ID, title, priority, complexity, verification.
- Assumptions or blockers.
