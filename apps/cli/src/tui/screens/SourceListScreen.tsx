import { TextAttributes, type MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Switch } from "solid-js"
import type { Source } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSources, type SourcesResult } from "../controller.ts"
import { createListViewport } from "../paging.ts"
import { theme } from "../theme.ts"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type ListState = { readonly _tag: "loading" } | SourcesResult

// Rows used by everything around the source list: app header, panel
// chrome, the panel title, and the key hints.
const RESERVED_ROWS = 11

function SourceRow(props: {
  readonly source: Source
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
  readonly onActivate: () => void
}) {
  return (
    <ListItem
      selected={props.selected}
      onMouseDown={props.onSelect}
      onMouseOver={props.onHover}
      onMouseUp={props.onActivate}
    >
      <ListItemText selected={props.selected}>{props.source.name}</ListItemText>
      <ListItemText selected={props.selected} color={theme.accent}>
        {props.source.providerKey ?? "unknown"}
      </ListItemText>
      <ListItemText selected={props.selected} muted>
        added {props.source.createdAt.toISOString().slice(0, 10)}
      </ListItemText>
    </ListItem>
  )
}

export function SourceListScreen(props: {
  readonly session: CliSession
  readonly active: () => boolean
  readonly onOpenSource: (source: Source) => void
  readonly onAddSource: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [state, setState] = createSignal<ListState>({ _tag: "loading" })
  const [selected, setSelected] = createSignal(0)
  const viewport = createListViewport()

  const refresh = async () => {
    setState({ _tag: "loading" })
    const result = await fetchSources(props.session)
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return
    }
    setState(result)
    setSelected(0)
    viewport.reset()
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

  const visibleRows = () => Math.max(4, dimensions().height - RESERVED_ROWS)

  const bounds = () => viewport.bounds({ length: sources().length, visible: visibleRows() })

  const moveSelection = (delta: number) => {
    if (sources().length === 0) {
      return
    }
    const next = (selected() + sources().length + delta) % sources().length
    setSelected(next)
    viewport.ensureVisible({ index: next, visible: visibleRows() })
  }

  const selectRow = (index: number) => {
    if (props.active()) {
      setSelected(index)
    }
  }

  // Pointing at a row selects it, except while a text drag-select is running.
  const hoverRow = (index: number) => {
    if (renderer.getSelection()?.isDragging !== true) {
      selectRow(index)
    }
  }

  // A mouse-up that ends a text drag-select is a copy, not a click.
  const activateRow = (source: Source) => {
    const dragText = renderer.getSelection()?.getSelectedText() ?? ""
    if (props.active() && dragText.length === 0) {
      props.onOpenSource(source)
    }
  }

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "return") {
      const source = sources()[selected()]
      if (source !== undefined) {
        props.onOpenSource(source)
      }
      return
    }
    if (evt.name === "a") {
      props.onAddSource()
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
    if (evt.name === "up") {
      moveSelection(-1)
      return
    }
    if (evt.name === "down") {
      moveSelection(1)
    }
  })

  const onWheel = (evt: MouseEvent) => {
    if (!props.active()) {
      return
    }
    const direction = evt.scroll?.direction
    if (direction !== "up" && direction !== "down") {
      return
    }
    viewport.scrollBy({
      delta: direction === "up" ? -1 : 1,
      length: sources().length,
      visible: visibleRows(),
    })
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      onMouseScroll={onWheel}
    >
      <box
        flexGrow={1}
        flexDirection="column"
        gap={1}
        backgroundColor={theme.backgroundPanel}
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
            <For each={sources().slice(bounds().start, bounds().end)}>
              {(source, index) => (
                <SourceRow
                  source={source}
                  selected={bounds().start + index() === selected()}
                  onSelect={() => selectRow(bounds().start + index())}
                  onHover={() => hoverRow(bounds().start + index())}
                  onActivate={() => activateRow(source)}
                />
              )}
            </For>
          </Match>
        </Switch>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={theme.textMuted}>[enter] open</text>
        <text fg={theme.textMuted}>[a] add source</text>
        <text fg={theme.textMuted}>[↑/↓] select</text>
        <text fg={theme.textMuted}>[r] refresh</text>
        <text fg={theme.textMuted}>[q] quit</text>
      </box>
    </box>
  )
}
