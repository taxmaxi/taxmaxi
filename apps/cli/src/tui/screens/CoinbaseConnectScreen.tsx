import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Match, onCleanup, Switch } from "solid-js"
import { Effect, Fiber } from "effect"
import type { CliSession } from "../../session.ts"
import { completeCoinbaseConnect, startCoinbaseConnect } from "../controller.ts"
import { theme } from "../theme.ts"
import { Spinner } from "../ui/Spinner.tsx"

type ConnectState =
  | { readonly step: "starting" }
  | { readonly step: "waiting"; readonly url: string; readonly browserOpened: boolean }
  | { readonly step: "error"; readonly message: string }

export function CoinbaseConnectScreen(props: {
  readonly onConnected: (session: CliSession) => void
  readonly onBack: () => void
}) {
  const [state, setState] = createSignal<ConnectState>({ step: "starting" })
  let connectFiber: Fiber.Fiber<void, never> | undefined
  let connectGeneration = 0
  let screenActive = true

  const isCurrentConnect = (generation: number) => screenActive && connectGeneration === generation

  const begin = () => {
    if (connectFiber !== undefined) {
      Effect.runFork(Fiber.interrupt(connectFiber))
    }
    const generation = ++connectGeneration
    setState({ step: "starting" })
    connectFiber = Effect.runFork(
      Effect.gen(function* () {
        const started = yield* Effect.tryPromise({
          try: (signal) => startCoinbaseConnect({ signal }),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (!isCurrentConnect(generation) || started === undefined) {
          return
        }
        if (started._tag === "error") {
          setState({ step: "error", message: started.message })
          return
        }

        setState({
          step: "waiting",
          url: started.authorizationUrl,
          browserOpened: started.browserOpened,
        })
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            completeCoinbaseConnect(
              { apiUrl: started.apiUrl, oauthSessionId: started.oauthSessionId },
              { signal }
            ),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))

        if (!isCurrentConnect(generation) || result === undefined) {
          return
        }
        if (result._tag === "connected") {
          props.onConnected(result.session)
          return
        }
        setState({ step: "error", message: result.message })
      })
    )
  }
  begin()
  onCleanup(() => {
    screenActive = false
    connectGeneration++
    if (connectFiber !== undefined) {
      Effect.runFork(Fiber.interrupt(connectFiber))
    }
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      screenActive = false
      connectGeneration++
      if (connectFiber !== undefined) {
        Effect.runFork(Fiber.interrupt(connectFiber))
      }
      props.onBack()
      return
    }
    if (evt.name === "r" && state().step === "error") {
      begin()
    }
  })

  const waiting = (): { readonly url: string; readonly browserOpened: boolean } | undefined => {
    const current = state()
    return current.step === "waiting" ? current : undefined
  }

  const errorMessage = (): string | undefined => {
    const current = state()
    return current.step === "error" ? current.message : undefined
  }

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <box
        flexDirection="column"
        gap={1}
        width={70}
        backgroundColor={theme.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
          Connect Coinbase
        </text>
        <Switch>
          <Match when={state().step === "starting"}>
            <Spinner label="Starting Coinbase connect flow…" />
          </Match>
          <Match when={waiting()}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.textSecondary} wrapMode="word">
                {waiting()?.browserOpened === true
                  ? "A browser window should have opened. Authorize TaxMaxi to continue."
                  : "Could not open a browser automatically. Open this URL to continue:"}
              </text>
              <text fg={theme.accent} wrapMode="word">
                {waiting()?.url}
              </text>
              <Spinner label="Waiting for browser authorization…" />
            </box>
          </Match>
          <Match when={errorMessage()}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.error} wrapMode="word">
                {errorMessage()}
              </text>
              <text fg={theme.textMuted}>[r] retry</text>
            </box>
          </Match>
        </Switch>
        <text fg={theme.textMuted}>[esc] cancel</text>
      </box>
    </box>
  )
}
