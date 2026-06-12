/**
 * TaxMaxi TUI entrypoint: owns the OpenTUI renderer lifecycle.
 *
 * Bundled by scripts/build-tui.mjs into dist/tui/run.js and lazily
 * imported by the root command when `tax` runs without arguments.
 */
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { disposeController } from "./controller.ts"

export const runTui = async (): Promise<void> => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  })
  renderer.setTerminalTitle("TaxMaxi")

  const finished = new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })

  const requestExit = () => {
    renderer.setTerminalTitle("")
    if (!renderer.isDestroyed) {
      renderer.destroy()
    }
  }

  await render(() => <App requestExit={requestExit} />, renderer)
  await finished
  await disposeController()
}
