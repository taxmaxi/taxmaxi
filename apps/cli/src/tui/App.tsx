import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, Show, Switch } from "solid-js"
import type { CliSession } from "../session.ts"
import { loadSessionState } from "./controller.ts"
import { AddSourceDialog } from "./screens/AddSourceDialog.tsx"
import { CoinbaseConnectScreen } from "./screens/CoinbaseConnectScreen.tsx"
import { SourceListScreen } from "./screens/SourceListScreen.tsx"
import { UserMenuDialog } from "./screens/UserMenuDialog.tsx"
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx"
import { theme } from "./theme.ts"
import { Spinner } from "./ui/Spinner.tsx"

type Screen =
  | { readonly type: "boot" }
  | { readonly type: "bootError"; readonly message: string }
  | { readonly type: "welcome"; readonly note?: string }
  | { readonly type: "sources" }
  | { readonly type: "connect" }

type DialogKind = "addSource" | "userMenu"

export function App(props: { readonly requestExit: () => void }) {
  const dimensions = useTerminalDimensions()
  const [screen, setScreen] = createSignal<Screen>({ type: "boot" })
  const [session, setSession] = createSignal<CliSession | undefined>(undefined)
  const [dialog, setDialog] = createSignal<DialogKind | undefined>(undefined)

  const noDialog = () => dialog() === undefined

  const boot = async () => {
    setScreen({ type: "boot" })
    const state = await loadSessionState()
    if (state._tag === "valid") {
      setSession(state.session)
      setScreen({ type: "sources" })
      return
    }
    if (state._tag === "missing") {
      setScreen({ type: "welcome" })
      return
    }
    if (state._tag === "invalid") {
      setScreen({ type: "welcome", note: state.message })
      return
    }
    setScreen({ type: "bootError", message: state.message })
  }
  void boot()

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      props.requestExit()
      return
    }
    if (screen().type === "bootError") {
      if (evt.name === "r") {
        void boot()
        return
      }
      if (evt.name === "q") {
        props.requestExit()
      }
    }
  })

  const openConnect = () => {
    setDialog(undefined)
    setScreen({ type: "connect" })
  }

  const handleConnected = (connected: CliSession) => {
    setSession(connected)
    setScreen({ type: "sources" })
  }

  const handleConnectBack = () => {
    setScreen(session() === undefined ? { type: "welcome" } : { type: "sources" })
  }

  const welcomeNote = (): string | undefined => {
    const current = screen()
    return current.type === "welcome" ? current.note : undefined
  }

  const bootErrorMessage = (): string | undefined => {
    const current = screen()
    return current.type === "bootError" ? current.message : undefined
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
    >
      <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          ◆ TaxMaxi
        </text>
        <text fg={theme.textMuted}>crypto taxes in your terminal</text>
      </box>
      <Switch>
        <Match when={screen().type === "boot"}>
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <Spinner label="Loading session…" />
          </box>
        </Match>
        <Match when={bootErrorMessage()}>
          <box
            flexGrow={1}
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            gap={1}
          >
            <text fg={theme.error} wrapMode="word">
              {bootErrorMessage()}
            </text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.accent}>[r] retry</text>
              <text fg={theme.textMuted}>[q] quit</text>
            </box>
          </box>
        </Match>
        <Match when={screen().type === "welcome"}>
          <WelcomeScreen
            note={welcomeNote()}
            active={noDialog}
            onConnect={openConnect}
            onQuit={props.requestExit}
          />
        </Match>
        <Match when={screen().type === "connect"}>
          <CoinbaseConnectScreen onConnected={handleConnected} onBack={handleConnectBack} />
        </Match>
        <Match when={screen().type === "sources"}>
          <Show when={session()} keyed>
            {(currentSession: CliSession) => (
              <SourceListScreen
                session={currentSession}
                active={noDialog}
                onAddSource={() => setDialog("addSource")}
                onUserMenu={() => setDialog("userMenu")}
                onQuit={props.requestExit}
              />
            )}
          </Show>
        </Match>
      </Switch>
      <Show when={dialog() === "addSource"}>
        <AddSourceDialog onPickCoinbase={openConnect} onClose={() => setDialog(undefined)} />
      </Show>
      <Show when={dialog() === "userMenu"}>
        <Show when={session()} keyed>
          {(currentSession: CliSession) => (
            <UserMenuDialog
              session={currentSession}
              onReconnect={openConnect}
              onQuit={props.requestExit}
              onClose={() => setDialog(undefined)}
            />
          )}
        </Show>
      </Show>
    </box>
  )
}
