import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const persistenceSrcDir = path.resolve(import.meta.dirname, "../../src")

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

describe("persistence sync boundaries", () => {
  it("keeps sync orchestration and provider live modules outside persistence", async () => {
    const files = await collectTypeScriptFiles(persistenceSrcDir)
    const violations: Array<string> = []

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const relativePath = path.relative(persistenceSrcDir, file)
      const forbiddenMatches = [
        {
          pattern: /from\s+["']@my\/sync-engine\/layers(?:\/[^"']*)?["']/u,
          label: "@my/sync-engine/layers**",
        },
        {
          pattern: /["'][^"']*sync-engine\/src\/layers\/[^"']*["']/u,
          label: "packages/sync-engine/src/layers/**",
        },
        {
          pattern:
            /import\s*\{[^}]*\b(?:SourceSyncService|SourceSyncProvider)\b[^}]*\}\s*from\s*["']@my\/sync-engine\/services["']/u,
          label: "sync-engine orchestration service import",
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

  it("only allows persistence to depend on the Coinbase credential repository contract", async () => {
    const files = await collectTypeScriptFiles(persistenceSrcDir)
    const violations: Array<string> = []
    const allowedProviderContractFile = "layers/CoinbaseCredentialRepositoryLive.ts"

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const relativePath = path.relative(persistenceSrcDir, file)
      const importsCoinbaseProviderContracts =
        /from\s+["']@my\/sync-engine\/providers\/coinbase(?:\/services)?["']/u.test(source)

      if (importsCoinbaseProviderContracts && relativePath !== allowedProviderContractFile) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })

  it("does not import BullMQ from persistence source", async () => {
    const files = await collectTypeScriptFiles(persistenceSrcDir)
    const violations: Array<string> = []

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const relativePath = path.relative(persistenceSrcDir, file)

      if (/from\s+["']bullmq["']/u.test(source)) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })
})
