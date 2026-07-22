import { describe, expect, it } from "vitest"
import {
  makeIntegrationTestDatabaseName,
  makeTestDatabaseTemplateName,
} from "./test-database-name.ts"

describe("test database names", () => {
  it("isolates migrated templates by worktree path", () => {
    const first = makeTestDatabaseTemplateName("/worktrees/first/taxmaxi")
    const second = makeTestDatabaseTemplateName("/worktrees/second/taxmaxi")

    expect(first).not.toBe(second)
    expect(first).toMatch(/^taxmaxi_template_[a-f0-9]{12}$/)
  })

  it("isolates temporary databases by worktree and worker", () => {
    const base = {
      databaseNamePrefix: "taxmaxi_source_sync_repo",
      workerId: "1",
      worktreeRoot: "/worktrees/first/taxmaxi",
    }

    const first = makeIntegrationTestDatabaseName(base)
    const otherWorker = makeIntegrationTestDatabaseName({ ...base, workerId: "2" })
    const otherWorktree = makeIntegrationTestDatabaseName({
      ...base,
      worktreeRoot: "/worktrees/second/taxmaxi",
    })

    expect(new Set([first, otherWorker, otherWorktree]).size).toBe(3)
  })

  it("keeps temporary database names within PostgreSQL's identifier limit", () => {
    const databaseName = makeIntegrationTestDatabaseName({
      databaseNamePrefix: `taxmaxi_${"long_prefix_".repeat(10)}`,
      workerId: "worker-with-a-long-identifier",
      worktreeRoot: "/worktrees/first/taxmaxi",
    })

    expect(databaseName.length).toBeLessThanOrEqual(63)
  })
})
