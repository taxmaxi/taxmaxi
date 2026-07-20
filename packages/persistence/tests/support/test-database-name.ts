import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const WORKTREE_ROOT = fileURLToPath(new URL("../../../..", import.meta.url))

export const makeTestDatabaseTemplateName = (worktreeRoot: string): string => {
  const suffix = createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 12)
  return `taxmaxi_template_${suffix}`
}

export const MIGRATED_TEST_DATABASE_TEMPLATE_NAME = makeTestDatabaseTemplateName(WORKTREE_ROOT)
