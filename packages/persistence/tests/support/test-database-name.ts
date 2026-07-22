import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const WORKTREE_ROOT = fileURLToPath(new URL("../../../..", import.meta.url))
const HASH_SUFFIX_LENGTH = 12
const POSTGRESQL_IDENTIFIER_MAX_LENGTH = 63

const makeHashSuffix = (identity: string): string =>
  createHash("sha256").update(identity).digest("hex").slice(0, HASH_SUFFIX_LENGTH)

export const makeTestDatabaseTemplateName = (worktreeRoot: string): string => {
  const suffix = makeHashSuffix(worktreeRoot)
  return `taxmaxi_template_${suffix}`
}

export const makeIntegrationTestDatabaseName = ({
  databaseNamePrefix,
  workerId,
  worktreeRoot = WORKTREE_ROOT,
}: {
  readonly databaseNamePrefix: string
  readonly workerId: string
  readonly worktreeRoot?: string
}): string => {
  const suffix = makeHashSuffix(`${worktreeRoot}\0${databaseNamePrefix}\0${workerId}`)
  const maximumPrefixLength = POSTGRESQL_IDENTIFIER_MAX_LENGTH - HASH_SUFFIX_LENGTH - 1
  return `${databaseNamePrefix.slice(0, maximumPrefixLength)}_${suffix}`
}

export const MIGRATED_TEST_DATABASE_TEMPLATE_NAME = makeTestDatabaseTemplateName(WORKTREE_ROOT)
