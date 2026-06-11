// Bundles the Solid + OpenTUI terminal UI into dist/tui/run.js.
//
// The TUI cannot go through plain tsc like the rest of the CLI because
// Solid JSX needs the babel-preset-solid transform (universal mode with
// @opentui/solid as the runtime module). solid-js and @opentui/solid are
// bundled with the "browser" export condition because their "node"
// condition resolves to Solid's SSR build, which has no client reactivity.
// @opentui/core stays external so its native library loading keeps working.
import { build, context } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/tui/run.tsx"],
  outfile: "dist/tui/run.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  conditions: ["browser"],
  external: ["@opentui/core", "effect", "@effect/*", "taxmaxi"],
  plugins: [
    solidPlugin({
      solid: {
        moduleName: "@opentui/solid",
        generate: "universal",
      },
    }),
  ],
  logLevel: "info",
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
