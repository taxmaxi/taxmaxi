import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, Switch } from "solid-js"
import type { Source } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSources, type SourcesResult } from "../controller.ts"
import { theme } from "../theme.ts"
import { Spinner } from "../ui/Spinner.tsx"

type ListState = { readonly _tag: "loading" } | SourcesResult

function SourceRow(props: { readonly source: Source; readonly selected: boolean }) {
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? theme.backgroundElement : theme.backgroundPanel}
    >
      <text fg={props.selected ? theme.text : theme.textMuted}>{props.selected ? "›" : " "}</text>
      <text fg={props.selected ? theme.text : theme.textSoft}>{props.source.name}</text>
      <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textSecondary}>{props.source.providerKey ?? "unknown"}</text>
      </box>
      <text fg={theme.textMuted}>added {props.source.createdAt.toISOString().slice(0, 10)}</text>
    </box>
  )
}

export function SourceListScreen(props: {
  readonly session: CliSession
  readonly active: () => boolean
  readonly onAddSource: () => void
  readonly onUserMenu: () => void
  readonly onQuit: () => void
}) {
  const [state, setState] = createSignal<ListState>({ _tag: "loading" })
  const [selected, setSelected] = createSignal(0)

  const refresh = async () => {
    setState({ _tag: "loading" })
    const result = await fetchSources(props.session)
    setState(result)
    setSelected(0)
  }
  void refresh()

  const sources = (): ReadonlyArray<Source> => {
    const current = state()
    return current._tag === "ok" ? current.sources : []
  }

  const errorMessage = (): string | undefined => {
    const current = state()
    return current._tag === "error" ? current.message : undefined
  }

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "a") {
      props.onAddSource()
      return
    }
    if (evt.name === "u") {
      props.onUserMenu()
      return
    }
    if (evt.name === "r") {
      void refresh()
      return
    }
    if (evt.name === "q") {
      props.onQuit()
      return
    }
    if (evt.name === "up" && sources().length > 0) {
      setSelected((current) => (current + sources().length - 1) % sources().length)
      return
    }
    if (evt.name === "down" && sources().length > 0) {
      setSelected((current) => (current + 1) % sources().length)
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <box
        flexGrow={1}
        flexDirection="column"
        gap={1}
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
          Sources
        </text>
        <Switch>
          <Match when={state()._tag === "loading"}>
            <Spinner label="Loading sources…" />
          </Match>
          <Match when={errorMessage()}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.error} wrapMode="word">
                {errorMessage()}
              </text>
              <text fg={theme.textMuted}>[r] retry</text>
            </box>
          </Match>
          <Match when={state()._tag === "ok" && sources().length === 0}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.textSecondary}>No sources connected yet.</text>
              <text fg={theme.textMuted}>Press [a] to add your first source.</text>
            </box>
          </Match>
          <Match when={state()._tag === "ok"}>
            <For each={sources()}>
              {(source, index) => <SourceRow source={source} selected={index() === selected()} />}
            </For>
          </Match>
        </Switch>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={theme.accent}>[a] add source</text>
        <text fg={theme.textMuted}>[r] refresh</text>
        <text fg={theme.textMuted}>[u] session</text>
        <text fg={theme.textMuted}>[q] quit</text>
      </box>
    </box>
  )
}
