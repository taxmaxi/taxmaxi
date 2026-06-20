/**
 * Launches the TaxMaxi TUI for the bare `tax` invocation.
 *
 * OpenTUI's native renderer needs Node's experimental FFI (`node:ffi`,
 * Node >= 26). The shebang cannot pass flags, so when FFI is unavailable
 * this module re-executes the CLI once with `--experimental-ffi` and
 * inherited stdio. Subcommands never pay this cost; they skip the TUI
 * path entirely.
 */
import { spawnSync } from "node:child_process"
import { Config, Effect } from "effect"
import * as Option from "effect/Option"
import { CliCommandError, mapUnknownToCliCommandError } from "./errors.ts"

const RESPAWN_ENV_VAR = "TAX_TUI_FFI_RESPAWN"
const FFI_MODULE_SPECIFIER = "node:ffi"
const MINIMUM_NODE_MAJOR = 26

const NODE_26_MESSAGE =
  "The TaxMaxi TUI needs Node.js 26 or newer (it uses Node's experimental FFI). " +
  "Update Node, or keep using subcommands like `tax coinbase`."

type TuiModule = {
  readonly runTui: () => Promise<void>
}

/**
 * The TUI only runs for a bare `tax` call in an interactive terminal.
 * Any argument or flag keeps the existing CLI behavior.
 */
export const shouldLaunchTui = (argv: ReadonlyArray<string>): boolean =>
  argv.length <= 2 && process.stdout.isTTY === true && process.stdin.isTTY === true

const isFfiAvailable = Effect.tryPromise({
  try: () => import(FFI_MODULE_SPECIFIER),
  catch: () => new CliCommandError({ message: "Node FFI is not available." }),
}).pipe(
  Effect.as(true),
  Effect.catchAll(() => Effect.succeed(false))
)

const runTuiInProcess = Effect.gen(function* () {
  const tuiModule: TuiModule = yield* Effect.tryPromise({
    try: () => import(new URL("./tui/run.js", import.meta.url).href),
    catch: () =>
      new CliCommandError({
        message: "Failed to load the TaxMaxi TUI bundle. Try reinstalling the CLI.",
      }),
  })

  yield* Effect.tryPromise({
    try: () => tuiModule.runTui(),
    catch: mapUnknownToCliCommandError("The TaxMaxi TUI exited with an unexpected error."),
  })
})

const nodeMajorVersion = (): number => Number.parseInt(process.versions.node, 10)

const respawnWithFfi = Effect.gen(function* () {
  const scriptPath = process.argv[1]
  if (scriptPath === undefined) {
    return yield* new CliCommandError({ message: NODE_26_MESSAGE })
  }

  const result = yield* Effect.sync(() =>
    spawnSync(process.execPath, ["--experimental-ffi", scriptPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, [RESPAWN_ENV_VAR]: "1" },
    })
  )

  if (result.error !== undefined) {
    return yield* new CliCommandError({ message: NODE_26_MESSAGE })
  }

  yield* Effect.sync(() => {
    if (result.signal !== null) {
      // Mirror a signal-killed child instead of exiting 0.
      process.kill(process.pid, result.signal)
      return
    }
    process.exitCode = result.status ?? 0
  })
})

export const launchTui = Effect.gen(function* () {
  const ffiAvailable = yield* isFfiAvailable
  if (ffiAvailable) {
    return yield* runTuiInProcess
  }

  if (nodeMajorVersion() < MINIMUM_NODE_MAJOR) {
    return yield* new CliCommandError({ message: NODE_26_MESSAGE })
  }

  const alreadyRespawned = yield* Config.option(Config.string(RESPAWN_ENV_VAR))
  if (Option.isSome(alreadyRespawned)) {
    return yield* new CliCommandError({ message: NODE_26_MESSAGE })
  }

  yield* respawnWithFfi
})
