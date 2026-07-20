import { describe, expect, it } from "vitest"
import { makeTestDatabaseTemplateName } from "./test-database-name.ts"

describe("test database template name", () => {
  it("isolates migrated templates by worktree path", () => {
    const first = makeTestDatabaseTemplateName("/worktrees/first/taxmaxi")
    const second = makeTestDatabaseTemplateName("/worktrees/second/taxmaxi")

    expect(first).not.toBe(second)
    expect(first).toMatch(/^taxmaxi_template_[a-f0-9]{12}$/)
    expect(first.length).toBeLessThanOrEqual(63)
  })
})
