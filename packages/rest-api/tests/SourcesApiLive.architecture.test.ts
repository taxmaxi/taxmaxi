import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const sourcesApiLivePath = path.resolve(import.meta.dirname, "../src/layers/SourcesApiLive.ts")
const restApiRoot = path.resolve(import.meta.dirname, "..")
const currentArchitectureTestPath = path.resolve(
  import.meta.dirname,
  "./SourcesApiLive.architecture.test.ts"
)

const collectTypeScriptFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          return []
        }
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

describe("SourcesApiLive imports", () => {
  it("loads sync orchestration from sync-engine instead of persistence", async () => {
    const source = await readFile(sourcesApiLivePath, "utf8")

    expect(source).toMatch(
      /import\s*\{[^}]*\bSourceSyncService\b[^}]*\}\s*from\s*"@my\/sync-engine\/services"/u
    )
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bSourceSyncService\b[^}]*\}\s*from\s*"@my\/persistence\/services"/u
    )
  })

  it("does not import persistence sync internals from source or test code", async () => {
    const files = await collectTypeScriptFiles(restApiRoot)
    const violations: Array<string> = []

    for (const file of files) {
      if (file === currentArchitectureTestPath) {
        continue
      }

      const source = await readFile(file, "utf8")
      const relativePath = path.relative(restApiRoot, file)
      const forbiddenMatches = [
        {
          pattern:
            /import\s*\{[^}]*\b(?:SourceSyncService|SourceSyncProvider|SourceSyncJobRepository|SourceSyncStateRepository|SourceRawRecordRepository|SourceNormalizationRepository|SourceReplayRepository|ProviderReferenceRepository)\b[^}]*\}\s*from\s*["']@my\/persistence(?:\/services|\/layers)?["']/u,
          label: "persistence sync contract import",
        },
        {
          pattern:
            /["'][^"']*persistence\/src\/(?:services|layers)\/(?:SourceSync|SourceReplay|SourceRawRecord|SourceNormalization|ProviderReference)[^"']*["']/u,
          label: "persistence sync internal path",
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

  it("does not import BullMQ from rest-api source or test code", async () => {
    const files = await collectTypeScriptFiles(restApiRoot)
    const violations: Array<string> = []

    for (const file of files) {
      if (file === currentArchitectureTestPath) {
        continue
      }

      const source = await readFile(file, "utf8")
      const relativePath = path.relative(restApiRoot, file)

      if (/from\s+["']bullmq["']/u.test(source)) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })
})
