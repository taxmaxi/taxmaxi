import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const syncEngineSrcDir = path.resolve(import.meta.dirname, "../../src")

const collectTypeScriptFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(entryPath)
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        return [entryPath]
      }
      return []
    })
  )

  return files.flat()
}

describe("sync-engine import boundaries", () => {
  it("does not import persistence packages, persistence internals, or drizzle-orm", async () => {
    const files = await collectTypeScriptFiles(syncEngineSrcDir)
    const violations: Array<string> = []

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const relativePath = path.relative(syncEngineSrcDir, file)
      const forbiddenMatches = [
        { pattern: /from\s+["']drizzle-orm(?:\/[^"']*)?["']/u, label: "drizzle-orm" },
        { pattern: /from\s+["']@my\/persistence(?:\/[^"']*)?["']/u, label: "@my/persistence**" },
        {
          pattern: /["'][^"']*persistence\/src\/services\/[^"']*["']/u,
          label: "packages/persistence/src/services/**",
        },
        {
          pattern: /["'][^"']*persistence\/src\/schema\/[^"']*["']/u,
          label: "packages/persistence/src/schema/**",
        },
        {
          pattern: /["'][^"']*persistence\/src\/layers\/[^"']*["']/u,
          label: "packages/persistence/src/layers/**",
        },
      ]

      for (const match of forbiddenMatches) {
        if (match.pattern.test(source)) {
          violations.push(`${relativePath}: ${match.label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it("keeps generic service contracts independent from provider modules", async () => {
    const servicesDir = path.resolve(syncEngineSrcDir, "services")
    const files = await collectTypeScriptFiles(servicesDir)
    const violations: Array<string> = []

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const relativePath = path.relative(syncEngineSrcDir, file)
      const forbiddenMatches = [
        { pattern: /from\s+["']\.\.\/providers\/[^"']*["']/u, label: "relative provider import" },
        {
          pattern: /from\s+["']@my\/sync-engine\/providers\/[^"']*["']/u,
          label: "package provider import",
        },
      ]

      for (const match of forbiddenMatches) {
        if (match.pattern.test(source)) {
          violations.push(`${relativePath}: ${match.label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
