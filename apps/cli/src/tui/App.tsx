import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { ProtocolCandidateReview, Source } from "taxmaxi"
import type { CliSession } from "../session.ts"
import { clearLocalSession, copyToClipboard, loadSessionState, logout } from "./controller.ts"
import { AddSourceDialog } from "./screens/AddSourceDialog.tsx"
import { CoinbaseConnectScreen } from "./screens/CoinbaseConnectScreen.tsx"
import { CommandPaletteDialog } from "./screens/CommandPaletteDialog.tsx"
import { ProtocolCandidateDetailScreen } from "./screens/ProtocolCandidateDetailScreen.tsx"
import {
  ProtocolCandidateListScreen,
  type ProtocolCandidateListViewState,
} from "./screens/ProtocolCandidateListScreen.tsx"
import { SourceAssetPnlScreen } from "./screens/SourceAssetPnlScreen.tsx"
import { SourceFifoLotsScreen } from "./screens/SourceFifoLotsScreen.tsx"
import { SourceListScreen } from "./screens/SourceListScreen.tsx"
import { SourceOverviewScreen } from "./screens/SourceOverviewScreen.tsx"
import { SourceTaxEventsScreen } from "./screens/SourceTaxEventsScreen.tsx"
import { SourceTransactionsScreen } from "./screens/SourceTransactionsScreen.tsx"
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx"
import { theme } from "./theme.ts"
import { Spinner } from "./ui/Spinner.tsx"
import { createToast, Toast } from "./ui/Toast.tsx"
import { useDialog } from "./ui/Dialog.tsx"

type ReportScreenType =
  | "sourceOverview"
  | "sourceAssetPnl"
  | "sourceTransactions"
  | "sourceTaxEvents"
  | "sourceFifoLots"

type Screen =
  | { readonly type: "boot" }
  | { readonly type: "bootError"; readonly message: string }
  | { readonly type: "welcome" }
  | { readonly type: "sources" }
  | { readonly type: "protocolCandidates" }
  | { readonly type: "protocolCandidateDetail"; readonly candidate: ProtocolCandidateReview }
  | { readonly type: "connect" }
  | { readonly type: "loggingOut" }
  | { readonly type: ReportScreenType; readonly source: Source }

type MainTab = "sources" | "protocolCandidates"

const mainTabForScreen = (screen: Screen): MainTab =>
  screen.type === "protocolCandidates" || screen.type === "protocolCandidateDetail"
    ? "protocolCandidates"
    : "sources"

function MainTabBar(props: {
  readonly active: MainTab
  readonly onOpenTab: (tab: MainTab) => void
}) {
  const tabs: ReadonlyArray<{
    readonly key: MainTab
    readonly label: string
    readonly hint: string
  }> = [
    { key: "sources", label: "Sources", hint: "1" },
    { key: "protocolCandidates", label: "Review", hint: "2" },
  ]

  return (
    <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <For each={tabs}>
        {(tab) => {
          const selected = () => props.active === tab.key
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={selected() ? theme.backgroundElement : theme.background}
              onMouseDown={() => props.onOpenTab(tab.key)}
            >
              <text fg={selected() ? theme.text : theme.textMuted}>{`[${tab.hint}]`}</text>
              <text fg={selected() ? theme.textSoft : theme.textMuted}>{tab.label}</text>
            </box>
          )
        }}
      </For>
      <text fg={theme.textMuted}>[tab] switch</text>
    </box>
  )
}

export function App(props: { readonly requestExit: () => void }) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const [screen, setScreen] = createSignal<Screen>({ type: "boot" })
  const [session, setSession] = createSignal<CliSession | undefined>(undefined)
  const [protocolCandidateListView, setProtocolCandidateListView] = createSignal<
    ProtocolCandidateListViewState | undefined
  >(undefined)
  // Lives outside the screen state so the note survives welcome → connect → back.
  const [welcomeNote, setWelcomeNote] = createSignal<string | undefined>(undefined)

  const noDialog = () => !dialog.open
  const isAdmin = () => session()?.role === "admin"
  const contentHeight = () => Math.max(1, dimensions().height - (isAdmin() ? 7 : 5))

  const openMainTab = (tab: MainTab) => {
    dialog.clear()
    setScreen({ type: tab })
  }

  const boot = async () => {
    setScreen({ type: "boot" })
    setWelcomeNote(undefined)
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
      setWelcomeNote(state.message)
      setScreen({ type: "welcome" })
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
    if (noDialog() && evt.ctrl && evt.name === "p") {
      dialog.replace(() => (
        <CommandPaletteDialog onLogout={() => void handleLogout()} onQuit={props.requestExit} />
      ))
      return
    }
    if (noDialog() && isAdmin()) {
      if (evt.name === "tab") {
        openMainTab(mainTabForScreen(screen()) === "sources" ? "protocolCandidates" : "sources")
        return
      }
      if (evt.name === "1") {
        openMainTab("sources")
        return
      }
      if (evt.name === "2") {
        openMainTab("protocolCandidates")
        return
      }
    }
    if (noDialog() && screen().type === "bootError") {
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
    dialog.clear()
    setScreen({ type: "connect" })
  }

  const handleConnected = (connected: CliSession) => {
    setSession(connected)
    setWelcomeNote(undefined)
    setScreen({ type: "sources" })
  }

  const handleConnectBack = () => {
    setScreen(session() === undefined ? { type: "welcome" } : { type: "sources" })
  }

  const handleLogout = async () => {
    const currentSession = session()
    if (currentSession === undefined) {
      return
    }
    dialog.clear()
    setScreen({ type: "loggingOut" })
    const result = await logout(currentSession)
    if (result._tag === "loggedOut") {
      setSession(undefined)
      setWelcomeNote(undefined)
      setScreen({ type: "welcome" })
      return
    }
    // The local session file is still there, so the user stays logged in;
    // [r] re-boots back to the source list.
    setScreen({ type: "bootError", message: result.message })
  }

  const handleSessionExpired = () => {
    dialog.clear()
    setSession(undefined)
    setWelcomeNote("Your session expired. Please connect again.")
    setScreen({ type: "welcome" })
    void clearLocalSession()
  }

  const bootErrorMessage = (): string | undefined => {
    const current = screen()
    return current.type === "bootError" ? current.message : undefined
  }

  const reportScreenSource = (type: ReportScreenType): Source | undefined => {
    const current = screen()
    return current.type === type && "source" in current ? current.source : undefined
  }

  const reportScreen = (type: ReportScreenType, source: Source) => () => setScreen({ type, source })

  const toast = createToast()

  // Releasing the mouse after a drag-select copies the highlighted text,
  // mirroring opencode's copy-on-select behavior.
  const copySelection = () => {
    const text = renderer.getSelection()?.getSelectedText() ?? ""
    if (text.length === 0) {
      return
    }
    renderer.clearSelection()
    void copyToClipboard(text).then(() =>
      toast.show({ message: "Copied to clipboard", variant: "info" })
    )
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseUp={copySelection}
      padding={1}
    >
      <box flexDirection="row" gap={1} paddingX={2} paddingTop={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          ◆ TaxMaxi
        </text>
        <text fg={theme.textMuted}>crypto taxes in your terminal</text>
      </box>
      <Show when={isAdmin()}>
        <MainTabBar active={mainTabForScreen(screen())} onOpenTab={openMainTab} />
      </Show>
      <box flexDirection="column" height={contentHeight()} paddingTop={1}>
        <Switch>
          <Match when={screen().type === "boot"}>
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <Spinner label="Loading session…" />
            </box>
          </Match>
          <Match when={screen().type === "loggingOut"}>
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <Spinner label="Logging out…" />
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
                  onOpenSource={(source) => setScreen({ type: "sourceOverview", source })}
                  onAddSource={() =>
                    dialog.replace(() => <AddSourceDialog onPickCoinbase={openConnect} />)
                  }
                  onSessionExpired={handleSessionExpired}
                  onQuit={props.requestExit}
                />
              )}
            </Show>
          </Match>
          <Match when={screen().type === "protocolCandidates"}>
            <Show when={session()} keyed>
              {(currentSession: CliSession) => (
                <ProtocolCandidateListScreen
                  session={currentSession}
                  active={noDialog}
                  initialViewState={protocolCandidateListView()}
                  onOpenCandidate={(candidate) =>
                    setScreen({ type: "protocolCandidateDetail", candidate })
                  }
                  onViewStateChange={setProtocolCandidateListView}
                  onBack={() => setScreen({ type: "sources" })}
                  onSessionExpired={handleSessionExpired}
                  onQuit={props.requestExit}
                />
              )}
            </Show>
          </Match>
          <Match when={screen().type === "protocolCandidateDetail"}>
            <Show when={session()} keyed>
              {(currentSession: CliSession) => {
                const current = screen()
                return current.type === "protocolCandidateDetail" ? (
                  <ProtocolCandidateDetailScreen
                    session={currentSession}
                    candidate={current.candidate}
                    active={noDialog}
                    onBack={() => setScreen({ type: "protocolCandidates" })}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                ) : null
              }}
            </Show>
          </Match>
          <Match when={reportScreenSource("sourceOverview")} keyed>
            {(source: Source) => (
              <Show when={session()} keyed>
                {(currentSession: CliSession) => (
                  <SourceOverviewScreen
                    session={currentSession}
                    source={source}
                    active={noDialog}
                    onOpenAssetPnl={reportScreen("sourceAssetPnl", source)}
                    onOpenTransactions={reportScreen("sourceTransactions", source)}
                    onOpenTaxEvents={reportScreen("sourceTaxEvents", source)}
                    onOpenFifoLots={reportScreen("sourceFifoLots", source)}
                    onBack={() => setScreen({ type: "sources" })}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                )}
              </Show>
            )}
          </Match>
          <Match when={reportScreenSource("sourceAssetPnl")} keyed>
            {(source: Source) => (
              <Show when={session()} keyed>
                {(currentSession: CliSession) => (
                  <SourceAssetPnlScreen
                    session={currentSession}
                    source={source}
                    active={noDialog}
                    onBack={reportScreen("sourceOverview", source)}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                )}
              </Show>
            )}
          </Match>
          <Match when={reportScreenSource("sourceTransactions")} keyed>
            {(source: Source) => (
              <Show when={session()} keyed>
                {(currentSession: CliSession) => (
                  <SourceTransactionsScreen
                    session={currentSession}
                    source={source}
                    active={noDialog}
                    onBack={reportScreen("sourceOverview", source)}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                )}
              </Show>
            )}
          </Match>
          <Match when={reportScreenSource("sourceTaxEvents")} keyed>
            {(source: Source) => (
              <Show when={session()} keyed>
                {(currentSession: CliSession) => (
                  <SourceTaxEventsScreen
                    session={currentSession}
                    source={source}
                    active={noDialog}
                    onBack={reportScreen("sourceOverview", source)}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                )}
              </Show>
            )}
          </Match>
          <Match when={reportScreenSource("sourceFifoLots")} keyed>
            {(source: Source) => (
              <Show when={session()} keyed>
                {(currentSession: CliSession) => (
                  <SourceFifoLotsScreen
                    session={currentSession}
                    source={source}
                    active={noDialog}
                    onBack={reportScreen("sourceOverview", source)}
                    onSessionExpired={handleSessionExpired}
                    onQuit={props.requestExit}
                  />
                )}
              </Show>
            )}
          </Match>
        </Switch>
      </box>
      <Toast toast={toast} />
    </box>
  )
}
