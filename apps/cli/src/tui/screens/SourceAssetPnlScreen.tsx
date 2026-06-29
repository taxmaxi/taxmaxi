import type { MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { Source, SourceAssetPnl } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSourceAssetPnl, type ReportResult } from "../controller.ts"
import { formatAmount, formatSigned, gainLossColor } from "../format.ts"
import { createListViewport } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type AssetRow = SourceAssetPnl["assets"][number]

type PnlState = { readonly _tag: "loading" } | ReportResult<SourceAssetPnl>

// Rows used by everything around the asset list: app header, panel chrome,
// key hints, and the detail pane for the selected asset.
const RESERVED_ROWS = 21

function AssetLine(props: {
  readonly row: AssetRow
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
}) {
  return (
    <ListItem selected={props.selected} onMouseDown={props.onSelect} onMouseOver={props.onHover}>
      <ListItemText selected={props.selected}>{props.row.asset.symbol.padEnd(10)}</ListItemText>
      <ListItemText selected={props.selected} color={theme.accent}>
        {`open ${formatAmount(props.row.openAmount)}`}
      </ListItemText>
      <ListItemText selected={props.selected} color={gainLossColor(props.row.realizedGainLoss)}>
        {`p&l ${formatSigned(props.row.realizedGainLoss)}`}
      </ListItemText>
      <Show when={props.row.review.status === "needs_review"}>
        <ListItemText selected={props.selected} color={theme.warning}>
          ⚠ review
        </ListItemText>
      </Show>
    </ListItem>
  )
}

export function SourceAssetPnlScreen(props: {
  readonly session: CliSession
  readonly source: Source
  readonly active: () => boolean
  readonly onBack: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [state, setState] = createSignal<PnlState>({ _tag: "loading" })
  const [selected, setSelected] = createSignal(0)
  const viewport = createListViewport()

  const refresh = async () => {
    setState({ _tag: "loading" })
    const result = await fetchSourceAssetPnl(props.session, props.source.id)
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return
    }
    setState(result)
    setSelected(0)
    viewport.reset()
  }
  void refresh()

  const rows = (): ReadonlyArray<AssetRow> => {
    const current = state()
    return current._tag === "ok" ? current.data.assets : []
  }

  const errorMessage = (): string | undefined => {
    const current = state()
    return current._tag === "error" ? current.message : undefined
  }

  const selectedRow = (): AssetRow | undefined => rows()[selected()]

  const visibleRows = () => Math.max(4, dimensions().height - RESERVED_ROWS)

  const bounds = () => viewport.bounds({ length: rows().length, visible: visibleRows() })

  const moveSelection = (delta: number) => {
    if (rows().length === 0) {
      return
    }
    const next = (selected() + rows().length + delta) % rows().length
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

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "r") {
      void refresh()
      return
    }
    if (evt.name === "escape" || evt.name === "b") {
      props.onBack()
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
      length: rows().length,
      visible: visibleRows(),
    })
  }

  return (
    <ScreenFrame
      title="Asset P&L"
      subtitle={props.source.name}
      hints={["[↑/↓] select", "[r] refresh", "[b] back", "[q] quit"]}
      onMouseScroll={onWheel}
    >
      <Switch>
        <Match when={state()._tag === "loading"}>
          <Spinner label="Loading asset P&L…" />
        </Match>
        <Match when={errorMessage()}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.error} wrapMode="word">
              {errorMessage()}
            </text>
            <text fg={theme.textMuted}>[r] retry</text>
          </box>
        </Match>
        <Match when={state()._tag === "ok" && rows().length === 0}>
          <text fg={theme.textSecondary}>No asset activity for this source yet.</text>
        </Match>
        <Match when={state()._tag === "ok"}>
          <box flexDirection="column" flexGrow={1} gap={1}>
            <box flexDirection="column">
              <For each={rows().slice(bounds().start, bounds().end)}>
                {(row, index) => (
                  <AssetLine
                    row={row}
                    selected={bounds().start + index() === selected()}
                    onSelect={() => selectRow(bounds().start + index())}
                    onHover={() => hoverRow(bounds().start + index())}
                  />
                )}
              </For>
            </box>
            <text fg={theme.textMuted}>{`${selected() + 1}/${rows().length} assets`}</text>
            <Show when={selectedRow()} keyed>
              {(row: AssetRow) => (
                <box flexDirection="column">
                  <text fg={theme.textSecondary}>{`${row.asset.symbol} · ${row.asset.name}`}</text>
                  <Field
                    label="amounts"
                    value={`acquired ${formatAmount(row.acquiredAmount)} · disposed ${formatAmount(row.disposedAmount)} · open ${formatAmount(row.openAmount)}`}
                  />
                  <Field
                    label="open cost basis"
                    value={`${formatAmount(row.costBasis)} ${row.currency ?? ""}`.trim()}
                  />
                  <Field
                    label="proceeds"
                    value={`${formatAmount(row.proceeds)} ${row.currency ?? ""}`.trim()}
                  />
                  <Field
                    label="realized p&l"
                    value={`${formatSigned(row.realizedGainLoss)} ${row.currency ?? ""}`.trim()}
                    color={gainLossColor(row.realizedGainLoss)}
                  />
                  <Show when={row.review.issues.length > 0}>
                    <Field
                      label="review"
                      value={row.review.issues
                        .map((issue) => `${issue.summary} (${issue.count})`)
                        .join(" · ")}
                      color={theme.warning}
                    />
                  </Show>
                </box>
              )}
            </Show>
          </box>
        </Match>
      </Switch>
    </ScreenFrame>
  )
}
