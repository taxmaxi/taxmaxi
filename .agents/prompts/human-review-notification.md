# Human review notification template

Use this template when sending the maintainer a Telegram notification that a TaxMaxi PR is ready for human review.

Destination:

- `<configured Telegram target>`

Do not use ready-for-human-review labels. The Telegram message is the readiness signal.

Required information to gather before sending:

- PR number and URL
- linked issue number(s)
- concise implementation summary
- review-loop summary: number of Codex review-fix passes, or why no pass was needed
- current CI/check status
- exact local commands already run by Codex/Hermes
- suggested human verification steps
- any caveats, skipped checks, or decisions needed from the maintainer

Message shape:

```text
TaxMaxi PR ready for human review: <PR_TITLE>

PR: <PR_URL>
Issue: #<ISSUE_NUMBER or n/a>

What changed:
- <bullet>
- <bullet>
- <bullet>

Automation status:
- Codex implementation: complete
- Codex GitHub App review loop: <0/1/2/3> pass(es)
- CI/checks: <green/pending/failing/no CI>
- Remaining actionable Codex comments: <none/list>

Checks already run:
- `<exact command>` → <passed/failed/skipped + reason>
- `<exact command>` → <passed/failed/skipped + reason>

Suggested human test:
1. Checkout the PR:
   `cd <repo root> && gh pr checkout <PR_NUMBER>`

2. Run local verification:
   `<exact command>`
   Expected: <expected result>

3. CLI/API verification:
   `<tax CLI command or curl/Postman endpoint>`
   Expected: <expected result>

Notes/caveats:
- <omit section if none>
```

Guidelines:

- Keep it concise enough for Telegram but complete enough to act on.
- Prefer exact commands over vague advice.
- If the change affects the CLI, include `tax ...` commands where possible.
- If the change affects the API, include method/path/body and expected response for Postman/curl.
- If the change affects sync/provider behavior, include the smallest reproducible scenario or fixture/test command.
- If anything is failing or uncertain, say so clearly instead of calling it ready.
