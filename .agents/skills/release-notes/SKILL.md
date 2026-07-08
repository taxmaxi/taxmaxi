---
name: release-notes
description: Write TaxMaxi GitHub release notes from commits between the latest version tag and HEAD. Use when asked to draft release notes, prepare a GitHub Release body, summarize changes since the last tag, or follow the TaxMaxi release style.
---

# TaxMaxi Release Notes

Use this skill to draft release notes for commits between the latest TaxMaxi version tag and `HEAD`.

## Workflow

1. Find the previous version tag reachable from `HEAD`:

   ```bash
   git describe --tags --abbrev=0 --match 'v[0-9]*'
   ```

2. Inspect the commits since that tag:

   ```bash
   git log --oneline <last-tag>..HEAD
   ```

3. Inspect the changed surfaces when commit subjects are too vague:

   ```bash
   git diff --stat <last-tag>..HEAD
   git diff --name-only <last-tag>..HEAD
   ```

4. Draft only the release body. Do not create, edit, or publish a GitHub Release unless the user asks.

## House Style

TaxMaxi release notes are concise and product-focused. Use simple, concrete words.

Default structure:

```markdown
This release <one or two sentence summary of the main theme>.

### What changed

- <User-facing or operator-facing change.>
- <Another concrete change.>

### Deployment notes

<Short paragraph or bullets. Say "No new environment variables are required." when true.>

### Commits since `<last-tag>`

- `<short-sha>` <commit subject>
- `<short-sha>` <commit subject>
```

Use this structure for normal releases or beta releases, matching `v0.1.0` and `v0.1.0-beta.3`.

For a first public or unusually broad launch release, use the longer `v0.1.0-beta.1` shape:

```markdown
This is the first public release of [TaxMaxi](https://www.taxmaxi.com).

TaxMaxi is an open-source crypto tax API and CLI. <Short launch summary.>

### What is included

- <Major product surface>

### CLI quick start

...

### Supported in this beta

| Area              | Status    |
| ----------------- | --------- |
| Germany tax rules | Supported |

### Notes

<Testing and tax-advice caveats.>
```

Only use the longer launch shape when the release is a first/broad public product announcement or a major upgrade. Most releases should use the default structure.

## Writing Rules

- Do not start with a version heading. GitHub has a separate release title field for the version.
- Start with one short paragraph that names the release theme.
- Prefer `### What changed`, not generic categories like "Features" and "Fixes".
- Include `### Deployment notes` even when there is nothing special to do.
- Include `### Commits since \`<last-tag>\``using`git log --oneline` order unless the user asks for grouping.
- Keep commit bullets as short SHA in backticks plus the original subject.
- Do not include "Full Changelog" unless asked or when drafting directly for GitHub's generated-release flow.
- Do not overstate user-facing impact. If the release is mostly infrastructure, say that plainly.
- Mention environment variables, migrations, seed data, image tags, worker/server rollout, and breaking changes when relevant.
- If a commit subject is unclear, inspect the diff before summarizing it.
- If there are no commits since the last tag, say there is nothing to release.

## Tone Examples

Use wording like:

- "This release focuses on deployment readiness..."
- "This release continues the observability work from beta.2..."
- "No new environment variables are required."
- "This release does not add user-facing API or CLI features. It is mainly an infrastructure beta..."

Avoid marketing language, long feature prose, and vague claims like "improves the experience" unless the commits show the specific improvement.
