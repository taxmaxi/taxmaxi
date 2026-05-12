import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

const readRepoFile = (relativePath: string) => readFile(path.join(repoRoot, relativePath), "utf8")

const readLatestMigration = async () => {
  const migrationRoot = path.join(repoRoot, "packages/persistence/drizzle")
  const entries = await readdir(migrationRoot, { withFileTypes: true })
  const migrationDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const migrationDirectory of [...migrationDirectories].reverse()) {
    try {
      return await readFile(path.join(migrationRoot, migrationDirectory, "migration.sql"), "utf8")
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error
      }
    }
  }

  throw new Error("No Drizzle migration SQL files found")
}

describe("principal ownership SQL regressions", () => {
  it("keeps user principal uniqueness compatible with ON CONFLICT (user_id)", async () => {
    const schema = await readRepoFile("packages/persistence/src/schema/PrincipalsTable.ts")
    const migration = await readLatestMigration()

    expect(schema).toContain('uniqueIndex("principals_user_unique").on(table.userId)')
    expect(schema).not.toContain('uniqueIndex("principals_user_unique")\n      .on(table.userId)')
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "principals_user_unique" ON "principals"(?: USING btree)? \("user_id"\);/u
    )
    expect(migration).not.toContain('WHERE "principals"."kind" = \'user\'')
  })

  it("updates transaction review conflicts through the existing user_notes column", async () => {
    const source = await readRepoFile(
      "packages/persistence/src/layers/SourceNormalizationRepositoryLive.ts"
    )

    expect(source).toContain('userNotes: sql.raw("excluded.user_notes")')
    expect(source).not.toContain("excluded.principal_notes")
  })
})
