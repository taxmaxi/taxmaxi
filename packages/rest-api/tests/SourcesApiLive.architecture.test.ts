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

describe("SourcesApiLive imports", () => {
  it.effect("loads sync orchestration from sync-engine instead of persistence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sourcesApiLivePath = path.resolve(
        import.meta.dirname,
        "../src/layers/SourcesApiLive.ts"
      )
      const source = yield* fileSystem.readFileString(sourcesApiLivePath)

      expect(source).toMatch(
        /import\s*\{[^}]*\bSourceSyncService\b[^}]*\}\s*from\s*"@my\/sync-engine\/services"/u
      )
      expect(source).not.toMatch(
        /import\s*\{[^}]*\bSourceSyncService\b[^}]*\}\s*from\s*"@my\/persistence\/services"/u
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does not import persistence sync internals from source or test code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const restApiRoot = path.resolve(import.meta.dirname, "..")
      const currentArchitectureTestPath = path.resolve(
        import.meta.dirname,
        "./SourcesApiLive.architecture.test.ts"
      )
      const files = yield* collectTypeScriptFiles(restApiRoot, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        if (file === currentArchitectureTestPath) {
          continue
        }
        const source = yield* fileSystem.readFileString(file)
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
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does not import BullMQ from rest-api source or test code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const restApiRoot = path.resolve(import.meta.dirname, "..")
      const currentArchitectureTestPath = path.resolve(
        import.meta.dirname,
        "./SourcesApiLive.architecture.test.ts"
      )
      const files = yield* collectTypeScriptFiles(restApiRoot, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        if (file === currentArchitectureTestPath) {
          continue
        }
        const source = yield* fileSystem.readFileString(file)
        const relativePath = path.relative(restApiRoot, file)
        if (/from\s+["']bullmq["']/u.test(source)) {
          violations.push(relativePath)
        }
      }

      expect(violations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
