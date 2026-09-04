---
name: arm
description: "Arm an approved spec for execution: generate its implement-NNN worker skill and orchestrator prompt from the templates in this directory. Pass the issue number, e.g. /arm 247."
disable-model-invocation: true
---

Generate the two execution files for one approved spec issue, from the templates in this skill's directory:

- `worker-skill-template.md` → `.agents/skills/implement-NNN/SKILL.md` (plus a relative symlink at `.claude/skills/implement-NNN`, matching the existing links)
- `orchestrator-prompt-template.md` → `.agents/prompts/NNN-orchestrator.md`

Both are spec-scoped scaffolding; the harvest deletes them.

## Process

1. Read the spec issue (`gh issue view <NNN>`) — the body is the plan. Read `docs/agents/delivery-process.md` ("Execution") for the rules the generated files must carry.
2. Fill each `{{PLACEHOLDER}}` in the templates from the spec:
   - Domain rules that bite come from the spec's Decisions — the rules a PR must never bend, stated so a worker recognizes a violation while coding, not after.
   - Seams come from the spec's Testing section, mapped to task ranges.
   - Gates, blocked tasks, and approver names come from the delivery checklist.
   - Coordination: name every other active epic and its owned files, or state this is the only stream.
3. Do not add project state beyond what the templates ask for. The tracker is the state; the generated files must survive the plan changing under them, which is why both defer to "the newest recorded decision wins."
4. Commit both files (plus the symlink) with `docs(skills): arm spec #NNN`. Workers run in fresh worktrees and see only committed files — an uncommitted skill is invisible to them.
5. Tell Max the spec is armed and how to start the orchestrator: paste the content of `.agents/prompts/NNN-orchestrator.md` into a new session, followed by a one-line kickoff.

## Improving the templates

The templates are the durable home of everything the epics taught about execution. When a lesson from a running epic belongs in every future epic, edit the template here — not just the active spec's generated copy — and note it in the spec's Harvest log.
