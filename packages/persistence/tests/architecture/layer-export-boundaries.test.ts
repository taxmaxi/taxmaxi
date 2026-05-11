import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const layersDir = fileURLToPath(new URL("../../src/layers", import.meta.url))

const ALLOWED_MULTI_EXPORT_FILES = new Set(["PgClientLive.ts", "RepositoriesLive.ts"])

const getLayerFiles = (): ReadonlyArray<string> =>
  readdirSync(layersDir)
    .filter((fileName) => fileName.endsWith("Live.ts"))
    .filter((fileName) => !ALLOWED_MULTI_EXPORT_FILES.has(fileName))
    .sort()

const getExportLines = (fileName: string): ReadonlyArray<string> =>
  readFileSync(join(layersDir, fileName), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("export "))

describe("persistence layer export boundaries", () => {
  it("keeps individual *Live layer files limited to their layer export", () => {
    for (const fileName of getLayerFiles()) {
      const expectedExportName = fileName.replace(/\.ts$/, "")
      const exportLines = getExportLines(fileName)

      expect(
        exportLines,
        `${fileName} should only export ${expectedExportName}; move helper exports into services/errors/helpers modules`
      ).toEqual([expect.stringMatching(new RegExp(`^export const ${expectedExportName}\\b`))])
    }
  })
})
