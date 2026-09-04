---
name: capture
description: "Capture a finding as a gap issue the moment it surfaces — a bug, a missing behavior, an idea, a refactoring need. Use when a finding would otherwise live only in a conversation, or when the user says to capture, file, or track something."
---

Turn one finding into one gap issue. The rule this skill serves: **no finding lives only in chat.** Capture costs thirty seconds; a finding lost to scrollback costs a launch-readiness audit.

## Process

1. **Check for a duplicate.** `gh issue list --search "<keywords>"` — if an open issue already covers it, add a comment with the new evidence instead of filing a twin, and say so.

2. **Write the body** using the gap template from `docs/agents/delivery-process.md`: Context (where this surfaced, with links), Missing behavior (user terms, one concrete example), Impact (wrong numbers > blocked results > inconvenience), Evidence (counts, codes, file references), Suggested lane (bug | feature gap | architecture change). Problem only — no solutions, no task lists. A gap that arrives with a solution attached skips the definition lane's thinking.

3. **Title** it like a commit subject: `type(scope): what is missing`, matching the repo's conventional-commit scopes. Model example: #247.

4. **File it**: `gh issue create` with the `needs-triage` label. If a roadmap map issue covers this goal area, add the new issue to the map's list (the map body is state — edit it).

5. **Report back** with the issue link, one line.

## Rules

- One finding per issue. Three findings in one conversation are three issues.
- Real user data stays out: issues are public. Follow `docs/agents/issue-tracker.md` — describe the shape of the data, not the data.
- Capture does not judge importance — that is triage's job. When in doubt whether something is worth an issue, it is; closing a non-issue is cheaper than re-discovering a real one.
- If the finding is a security vulnerability or otherwise sensitive, do not file it publicly — tell the user and let them pick the private channel.
