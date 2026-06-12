import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Match, onCleanup, Switch } from "solid-js"
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
  let abortController: AbortController | undefined
  let screenActive = true

  const isCurrentConnect = (controller: AbortController) =>
    screenActive && abortController === controller && !controller.signal.aborted

  const begin = async () => {
    abortController?.abort()
    const controller = new AbortController()
    abortController = controller
    setState({ step: "starting" })
    const started = await startCoinbaseConnect({ signal: controller.signal }).catch(() => undefined)
    if (!isCurrentConnect(controller) || started === undefined) {
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
    const result = await completeCoinbaseConnect(
      { apiUrl: started.apiUrl, oauthSessionId: started.oauthSessionId },
      { signal: controller.signal }
    ).catch(() => undefined)

    if (!isCurrentConnect(controller) || result === undefined) {
      return
    }
    if (result._tag === "connected") {
      props.onConnected(result.session)
      return
    }
    setState({ step: "error", message: result.message })
  }
  void begin()
  onCleanup(() => {
    screenActive = false
    abortController?.abort()
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      screenActive = false
      abortController?.abort()
      props.onBack()
      return
    }
    if (evt.name === "r" && state().step === "error") {
      void begin()
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
