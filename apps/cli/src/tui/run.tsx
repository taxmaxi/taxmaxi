/**
 * TaxMaxi TUI entrypoint: owns the OpenTUI renderer lifecycle.
 *
 * Bundled by scripts/build-tui.mjs into dist/tui/run.js and lazily
 * imported by the root command when `tax` runs without arguments.
 */
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { Deferred, Effect } from "effect"
import { mapUnknownToCliCommandError, type CliCommandError } from "../errors.ts"
import { App } from "./App.tsx"
import { disposeController } from "./controller.ts"
import { ThemeProvider } from "./theme.ts"
import { DialogProvider } from "./ui/Dialog.tsx"

const mapRendererError = mapUnknownToCliCommandError("Failed to start the TaxMaxi TUI.")
const mapRenderError = mapUnknownToCliCommandError(
  "The TaxMaxi TUI exited with an unexpected error."
)

const destroyRenderer = (
  renderer: Pick<CliRenderer, "destroy" | "isDestroyed" | "setTerminalTitle">
) => {
  renderer.setTerminalTitle("")
  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

const acquireRenderer = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 60,
      }),
    catch: mapRendererError,
  }),
  (renderer) => Effect.sync(() => destroyRenderer(renderer))
)

const onSignal = (signal: NodeJS.Signals, handler: NodeJS.SignalsListener) =>
  Effect.acquireRelease(
    Effect.sync(() => process.on(signal, handler)),
    () => Effect.sync(() => process.off(signal, handler))
  )

export const runTui: Effect.Effect<void, CliCommandError> = Effect.scoped(
  Effect.gen(function* () {
    const renderer = yield* acquireRenderer
    const shutdown = yield* Deferred.make<void>()
    const requestExit = () => destroyRenderer(renderer)
    const requestExitFromSignal = () => requestExit()

    renderer.setTerminalTitle("TaxMaxi")
    renderer.once("destroy", () => Deferred.unsafeDone(shutdown, Effect.void))

    yield* Effect.addFinalizer(() => Effect.promise(() => disposeController()))
    yield* onSignal("SIGHUP", requestExitFromSignal)
    yield* onSignal("SIGTERM", requestExitFromSignal)

    yield* Effect.tryPromise({
      try: () =>
        render(
          () => (
            <ThemeProvider>
              <DialogProvider>
                <App requestExit={requestExit} />
              </DialogProvider>
            </ThemeProvider>
          ),
          renderer
        ),
      catch: mapRenderError,
    })
    yield* Deferred.await(shutdown)
  })
)
