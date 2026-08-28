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

describe("sync-engine import boundaries", () => {
  it.effect("does not import persistence packages, persistence internals, or drizzle-orm", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const syncEngineSrcDir = path.resolve(import.meta.dirname, "../../src")
      const files = yield* collectTypeScriptFiles(syncEngineSrcDir, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        const source = yield* fileSystem.readFileString(file)
        const relativePath = path.relative(syncEngineSrcDir, file)
        const forbiddenMatches = [
          { pattern: /from\s+["']drizzle-orm(?:\/[^"']*)?["']/u, label: "drizzle-orm" },
          {
            pattern: /from\s+["']@my\/persistence(?:\/[^"']*)?["']/u,
            label: "@my/persistence**",
          },
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
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("keeps generic service contracts independent from provider modules", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const syncEngineSrcDir = path.resolve(import.meta.dirname, "../../src")
      const servicesDir = path.resolve(syncEngineSrcDir, "services")
      const files = yield* collectTypeScriptFiles(servicesDir, fileSystem, path)
      const violations: Array<string> = []

      for (const file of files) {
        const source = yield* fileSystem.readFileString(file)
        const relativePath = path.relative(syncEngineSrcDir, file)
        const forbiddenMatches = [
          {
            pattern: /from\s+["']\.\.\/providers\/[^"']*["']/u,
            label: "relative provider import",
          },
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
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
