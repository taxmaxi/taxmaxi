import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

const ALLOWED_MULTI_EXPORT_FILES = new Set(["PgClientLive.ts", "RepositoriesLive.ts"])

describe("persistence layer export boundaries", () => {
  it.effect("keeps individual *Live layer files limited to their layer export", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layersDir = path.resolve(import.meta.dirname, "../../src/layers")
      const layerFiles = (yield* fileSystem.readDirectory(layersDir))
        .filter((fileName) => fileName.endsWith("Live.ts"))
        .filter((fileName) => !ALLOWED_MULTI_EXPORT_FILES.has(fileName))
        .sort()

      for (const fileName of layerFiles) {
        const expectedExportName = fileName.replace(/\.ts$/, "")
        const source = yield* fileSystem.readFileString(path.join(layersDir, fileName))
        const exportLines = source
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("export "))

        expect(
          exportLines,
          `${fileName} should only export ${expectedExportName}; move helper exports into services/errors/helpers modules`
        ).toEqual([expect.stringMatching(new RegExp(`^export const ${expectedExportName}\\b`))])
      }
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
