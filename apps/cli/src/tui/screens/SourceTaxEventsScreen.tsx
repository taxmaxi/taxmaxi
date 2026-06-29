import type { MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { Source, SourceTaxEvents } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSourceTaxEvents } from "../controller.ts"
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatFiat,
  formatLabel,
  formatSigned,
  gainLossColor,
  treatmentColor,
} from "../format.ts"
import { createListViewport, createPagedList } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { DisposalExplanationView } from "./DisposalExplanationView.tsx"

type TaxEventRow = SourceTaxEvents["taxEvents"][number]

// Rows used by everything around the event list: app header, panel chrome,
// key hints, the list status line, and the detail pane.
const RESERVED_ROWS = 23

const kindColor = (kind: TaxEventRow["kind"]): string => {
  if (kind === "acquisition" || kind === "income") {
    return theme.success
  }
  if (kind === "disposal") {
    return theme.warning
  }
  return theme.textMuted
}

function TaxEventLine(props: {
  readonly row: TaxEventRow
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
      <ListItemText selected={props.selected} muted>
        {formatDate(props.row.timestamp)}
      </ListItemText>
      <ListItemText selected={props.selected} color={kindColor(props.row.kind)}>
        {props.row.kind.padEnd(11)}
      </ListItemText>
      <ListItemText selected={props.selected}>
        {`${formatAmount(props.row.amount)} ${props.row.asset.symbol}`}
      </ListItemText>
      <Show when={props.row.gainLoss} keyed>
        {(gainLoss: string) => (
          <ListItemText selected={props.selected} color={gainLossColor(gainLoss)}>
            {formatSigned(gainLoss)}
          </ListItemText>
        )}
      </Show>
      <ListItemText selected={props.selected} color={treatmentColor(props.row.taxableTreatment)}>
        {formatLabel(props.row.taxableTreatment)}
      </ListItemText>
    </ListItem>
  )
}

export function SourceTaxEventsScreen(props: {
  readonly session: CliSession
  readonly source: Source
  readonly active: () => boolean
  readonly onBack: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal(0)
  const viewport = createListViewport()
  // While set, the explanation view replaces the list; the loaded pages and
  // selection survive backing out of it.
  const [explainLegId, setExplainLegId] = createSignal<string | undefined>(undefined)

  const list = createPagedList<TaxEventRow>(async (cursor) => {
    const result = await fetchSourceTaxEvents(props.session, {
      sourceId: props.source.id,
      cursor,
    })
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return { _tag: "error", message: result.message }
    }
    if (result._tag === "error") {
      return result
    }
    return {
      _tag: "ok",
      page: {
        rows: result.data.taxEvents,
        nextCursor: result.data.page.nextCursor,
        hasMore: result.data.page.hasMore,
      },
    }
  })

  const reload = async () => {
    setSelected(0)
    viewport.reset()
    await list.reload()
  }

  const rows = (): ReadonlyArray<TaxEventRow> => {
    const current = list.state()
    return current._tag === "ok" ? current.rows : []
  }

  const errorMessage = (): string | undefined => {
    const current = list.state()
    return current._tag === "error" ? current.message : undefined
  }

  const okState = () => {
    const current = list.state()
    return current._tag === "ok" ? current : undefined
  }

  const selectedRow = (): TaxEventRow | undefined => rows()[selected()]

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

  const statusLine = (): string => {
    const current = okState()
    if (current === undefined) {
      return ""
    }
    const position = `${selected() + 1}/${current.rows.length} tax events`
    if (current.loadingMore) {
      return `${position} · loading more…`
    }
    return current.hasMore ? `${position} · [m] load more` : position
  }

  const listActive = () => props.active() && explainLegId() === undefined

  const selectRow = (index: number) => {
    if (listActive()) {
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
  const activateRow = (row: TaxEventRow) => {
    const dragText = renderer.getSelection()?.getSelectedText() ?? ""
    if (listActive() && dragText.length === 0 && row.kind === "disposal") {
      setExplainLegId(row.legId)
    }
  }

  useKeyboard((evt) => {
    if (!listActive()) {
      return
    }
    if (evt.name === "return") {
      const row = selectedRow()
      if (row !== undefined && row.kind === "disposal") {
        setExplainLegId(row.legId)
      }
      return
    }
    if (evt.name === "r") {
      void reload()
      return
    }
    if (evt.name === "m") {
      void list.loadMore()
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
    if (!listActive()) {
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
    <Show
      when={explainLegId()}
      keyed
      fallback={
        <ScreenFrame
          title="Tax events"
          subtitle={props.source.name}
          hints={[
            "[↑/↓] select",
            "[enter] explain disposal",
            "[m] load more",
            "[r] refresh",
            "[b] back",
            "[q] quit",
          ]}
          onMouseScroll={onWheel}
        >
          <Switch>
            <Match when={list.state()._tag === "loading"}>
              <Spinner label="Loading tax events…" />
            </Match>
            <Match when={errorMessage()}>
              <box flexDirection="column" gap={1}>
                <text fg={theme.error} wrapMode="word">
                  {errorMessage()}
                </text>
                <text fg={theme.textMuted}>[r] retry</text>
              </box>
            </Match>
            <Match when={list.state()._tag === "ok" && rows().length === 0}>
              <text fg={theme.textSecondary}>No tax events for this source yet.</text>
            </Match>
            <Match when={list.state()._tag === "ok"}>
              <box flexDirection="column" flexGrow={1} gap={1}>
                <box flexDirection="column">
                  <For each={rows().slice(bounds().start, bounds().end)}>
                    {(row, index) => (
                      <TaxEventLine
                        row={row}
                        selected={bounds().start + index() === selected()}
                        onSelect={() => selectRow(bounds().start + index())}
                        onHover={() => hoverRow(bounds().start + index())}
                        onActivate={() => activateRow(row)}
                      />
                    )}
                  </For>
                </box>
                <text fg={theme.textMuted}>{statusLine()}</text>
                <Show when={okState()?.loadMoreError} keyed>
                  {(message: string) => (
                    <text fg={theme.error} wrapMode="word">
                      {message}
                    </text>
                  )}
                </Show>
                <Show when={selectedRow()} keyed>
                  {(row: TaxEventRow) => (
                    <box flexDirection="column">
                      <text fg={theme.textSecondary}>
                        {`${formatDateTime(row.timestamp)} · ${row.asset.symbol} · ${row.asset.name}`}
                      </text>
                      <Show when={row.fiatAmount} keyed>
                        {(fiatAmount: string) => (
                          <Field
                            label="fiat value"
                            value={formatFiat(fiatAmount, row.fiatCurrency)}
                          />
                        )}
                      </Show>
                      <Show when={row.costBasis} keyed>
                        {(costBasis: string) => (
                          <Field
                            label="cost basis"
                            value={formatFiat(costBasis, row.fiatCurrency)}
                          />
                        )}
                      </Show>
                      <Show when={row.proceeds} keyed>
                        {(proceeds: string) => (
                          <Field label="proceeds" value={formatFiat(proceeds, row.fiatCurrency)} />
                        )}
                      </Show>
                      <Show when={row.gainLoss} keyed>
                        {(gainLoss: string) => (
                          <Field
                            label="gain/loss"
                            value={formatSigned(gainLoss)}
                            color={gainLossColor(gainLoss)}
                          />
                        )}
                      </Show>
                      <Field
                        label="provenance"
                        value={
                          row.derivationRule === null
                            ? row.provenance
                            : `${row.provenance} · rule ${row.derivationRule}`
                        }
                      />
                      <Show when={row.kind === "disposal"}>
                        <text fg={theme.accent}>[enter] explain this disposal</text>
                      </Show>
                    </box>
                  )}
                </Show>
              </box>
            </Match>
          </Switch>
        </ScreenFrame>
      }
    >
      {(legId: string) => (
        <DisposalExplanationView
          session={props.session}
          sourceId={props.source.id}
          legId={legId}
          sourceName={props.source.name}
          active={props.active}
          onBack={() => setExplainLegId(undefined)}
          onSessionExpired={props.onSessionExpired}
          onQuit={props.onQuit}
        />
      )}
    </Show>
  )
}
