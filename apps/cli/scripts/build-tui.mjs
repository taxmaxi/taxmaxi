// Bundles the Solid + OpenTUI terminal UI into dist/tui/run.js.
//
// The TUI cannot go through plain tsc like the rest of the CLI because
// Solid JSX needs the babel-preset-solid transform (universal mode with
// @opentui/solid as the runtime module). solid-js and @opentui/solid are
// bundled with the "browser" export condition because their "node"
// condition resolves to Solid's SSR build, which has no client reactivity.
// @opentui/core stays external so its native library loading keeps working.
//
// Relative imports shared with the CLI (session, api/*) are bundled in, so
// they exist twice in dist: once as tsc output, once inside run.js. That is
// intentional — shared state lives on disk, and the size cost is small.
import { spawn } from "node:child_process"
import { build, context } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const watch = process.argv.includes("--watch")
const run = process.argv.includes("--run")
const shouldRunOnRebuild = watch && run

const cliEntrypoint = "dist/index.js"
const restartDelayMs = 50
const forceKillDelayMs = 2_000

/** @type {import("node:child_process").ChildProcess | undefined} */
let child
/** @type {NodeJS.Timeout | undefined} */
let restartTimer

const stopChild = () =>
  new Promise((resolve) => {
    if (child === undefined || child.killed) {
      child = undefined
      resolve()
      return
    }

    const activeChild = child
    const forceKillTimer = setTimeout(() => {
      if (!activeChild.killed) {
        activeChild.kill("SIGKILL")
      }
    }, forceKillDelayMs)

    activeChild.once("exit", () => {
      clearTimeout(forceKillTimer)
      if (child === activeChild) {
        child = undefined
      }
      resolve()
    })

    activeChild.kill("SIGHUP")
  })

const startChild = () => {
  child = spawn(process.execPath, ["--experimental-ffi", cliEntrypoint], {
    stdio: "inherit",
    env: process.env,
  })

  const activeChild = child
  activeChild.once("exit", () => {
    if (child === activeChild) {
      child = undefined
    }
  })
}

const scheduleRestart = () => {
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    restartTimer = undefined
    void stopChild().then(startChild)
  }, restartDelayMs)
}

const shutdown = async () => {
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer)
    restartTimer = undefined
  }

  await stopChild()
}

if (shouldRunOnRebuild) {
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(130))
  })
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143))
  })
}

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
    ...(shouldRunOnRebuild
      ? [
          {
            name: "restart-tui-on-rebuild",
            setup(build) {
              build.onEnd((result) => {
                if (result.errors.length > 0) {
                  return
                }

                scheduleRestart()
              })
            },
          },
        ]
      : []),
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
