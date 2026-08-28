import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, type PlatformError } from "effect"

const collectTypeScriptFiles = (
  directory: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory)
    const files: Array<string> = []

    for (const entry of entries) {
      if (entry === "node_modules") {
        continue
      }
      const entryPath = path.join(directory, entry)
      const info = yield* fileSystem.stat(entryPath)
      if (info.type === "Directory") {
        files.push(...(yield* collectTypeScriptFiles(entryPath, fileSystem, path)))
      } else if (info.type === "File" && entry.endsWith(".ts")) {
        files.push(entryPath)
      }
    }

    return files
  })

describe("persistence sync boundaries", () => {
  it.effect("keeps sync orchestration and provider live modules outside persistence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const persistenceSrcDir = path.resolve(import.meta.dirname, "../../src")
      const files = yield* collectTypeScriptFiles(persistenceSrcDir, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        const source = yield* fileSystem.readFileString(file)
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
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect(
    "only allows persistence to depend on the Coinbase credential repository contract",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const persistenceSrcDir = path.resolve(import.meta.dirname, "../../src")
        const files = yield* collectTypeScriptFiles(persistenceSrcDir, fileSystem, path)
        const violations: Array<string> = []
        const allowedProviderContractFile = "layers/CoinbaseCredentialRepositoryLive.ts"

        for (const file of files) {
          const source = yield* fileSystem.readFileString(file)
          const relativePath = path.relative(persistenceSrcDir, file)
          const importsCoinbaseProviderContracts =
            /from\s+["']@my\/sync-engine\/providers\/coinbase(?:\/services)?["']/u.test(source)

          if (importsCoinbaseProviderContracts && relativePath !== allowedProviderContractFile) {
            violations.push(relativePath)
          }
        }

        expect(violations).toEqual([])
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does not import BullMQ from persistence source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const persistenceSrcDir = path.resolve(import.meta.dirname, "../../src")
      const files = yield* collectTypeScriptFiles(persistenceSrcDir, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        const source = yield* fileSystem.readFileString(file)
        const relativePath = path.relative(persistenceSrcDir, file)
        if (/from\s+["']bullmq["']/u.test(source)) {
          violations.push(relativePath)
        }
      }

      expect(violations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
