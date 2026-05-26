#!/usr/bin/env bash
set -euo pipefail

RALPH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PRD_FILE="${RALPH_DIR}/prd.json"
PROGRESS_FILE="${RALPH_DIR}/progress.txt"
OUTPUT_DIR="${RALPH_DIR}/.output"
INTAKE_FILE="${RALPH_DIR}/intake.md"

cat > "${PRD_FILE}" <<'JSON'
{
  "title": "Example PRD",
  "project": "TaxMaxi",
  "description": "Short description of the work Ralph should implement.",
  "version": "1.0.0",
  "created_at": "YYYY-MM-DD",
  "updated_at": "YYYY-MM-DD",
  "global_verification": ["pnpm run type-check", "pnpm run lint", "pnpm run test"],
  "completion_criteria": {
    "all_stories_done": "Every story has status: 'done'",
    "output_token": "STORY_COMPLETE"
  },
  "stories": [
    {
      "id": "EX-001",
      "epic": "Example Epic",
      "title": "Example story title",
      "description": "Short description of what the story changes and why.",
      "source": {
        "kind": "github_issue",
        "issue": 0,
        "url": "https://github.com/example/example/issues/0",
        "template": "example"
      },
      "blocked_by": [],
      "blocked_by_issues": [],
      "acceptance_criteria": ["Acceptance criterion 1", "Acceptance criterion 2"],
      "implementation_notes": ["Important implementation note from the source issue."],
      "testing_notes": ["Important testing note from the source issue."],
      "priority": "high",
      "status": "pending",
      "estimated_complexity": "small",
      "verification": ["pnpm run test"]
    }
  ]
}
JSON

cat > "${PROGRESS_FILE}" <<'TEXT'
## Iteration 1 - YYYY-MM-DD HH:MM
**Story**: EX-001 - Example story title
**Status**: done
---
TEXT

rm -rf "${OUTPUT_DIR}"
rm -f "${INTAKE_FILE}"

echo "Reset complete:"
echo "- ${PRD_FILE}"
echo "- ${PROGRESS_FILE}"
echo "- removed ${OUTPUT_DIR} (if present)"
echo "- removed ${INTAKE_FILE} (if present)"
