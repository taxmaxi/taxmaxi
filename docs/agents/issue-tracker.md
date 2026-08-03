# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## What belongs in GitHub Issues

GitHub is the canonical tracker for durable product work, including:

- Bugs and feature requests
- Roadmap items
- Architecture and refactoring work
- Work that benefits from discussion or a permanent reference

Do not create an issue for every implementation task. Keep short-lived subtasks in PR descriptions, checklists, or local plans.

GitHub issues are public by default. Keep vulnerabilities, credentials, private partner details, and other sensitive work in a private channel.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`. The `gh` CLI does this automatically when run inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. If a bare reference such as `#42` is unclear, try `gh pr view 42` and then `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map` containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: a GitHub sub-issue linked to the map. If sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of the child body.
- **Child labels**: use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub's native issue dependencies. If unavailable, add `Blocked by: #<number>` to the child.
- **Claim**: assign the issue to the current developer.
- **Resolve**: comment with the result, close the child, and add the decision or context link to the map.
