/** @effect-diagnostics nodeBuiltinImport:skip-file asyncFunction:skip-file */
// This test compiles and starts the native OpenTUI harness using esbuild and
// Node APIs. Keep its Promise-based setup at the Vitest/process boundary.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const run = promisify(execFile)
const cliDirectory = fileURLToPath(new URL("..", import.meta.url))
let bundleDirectory: string | undefined

beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(cliDirectory, "node_modules", ".tui-test-"))
  // Match build-tui.mjs: Solid needs the universal JSX transform and the
  // browser condition for reactivity; native OpenTUI remains external.
  await build({
    absWorkingDir: cliDirectory,
    entryPoints: ["tests/support/sourceTransactionsScreenHarness.tsx"],
    outfile: join(bundleDirectory, "screen.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    conditions: ["browser"],
    external: ["@opentui/core", "effect", "@effect/*", "taxmaxi"],
    plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
  })
})

afterAll(async () => {
  if (bundleDirectory !== undefined) {
    await rm(bundleDirectory, { recursive: true, force: true })
  }
})

describe("source transaction screen frames and keyboard input", () => {
  it.each(["empty", "paginated", "partial", "zero", "short-terminal"])(
    "renders %s canonical results",
    async (scenario) => {
      assert.ok(bundleDirectory, "Screen harness was not built")
      // Isolate the native renderer and its FFI flag from the Vitest process.
      const { stdout } = await run(
        process.execPath,
        ["--experimental-ffi", join(bundleDirectory, "screen.mjs"), scenario],
        {
          timeout: 15_000,
        }
      )
      expect(stdout).toContain("Screen assertions passed")
    },
    20_000
  )
})
