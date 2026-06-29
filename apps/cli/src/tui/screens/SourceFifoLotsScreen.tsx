import type { MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { Source, SourceFifoLots } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSourceFifoLots } from "../controller.ts"
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatFiat,
  formatSigned,
  gainLossColor,
} from "../format.ts"
import { createListViewport, createPagedList, windowBounds } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { DisposalExplanationView } from "./DisposalExplanationView.tsx"

type FifoLotRow = SourceFifoLots["fifoLots"][number]
type DisposalMatch = FifoLotRow["disposalMatches"][number]

// Rows used by everything around the lot list: app header, panel chrome,
// key hints, the list status line, and the detail pane.
const RESERVED_ROWS = 23
const MAX_DETAIL_MATCHES = 3

function FifoLotLine(props: {
  readonly row: FifoLotRow
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
}) {
  return (
    <ListItem selected={props.selected} onMouseDown={props.onSelect} onMouseOver={props.onHover}>
      <ListItemText selected={props.selected} muted>
        {formatDate(props.row.acquiredAt)}
      </ListItemText>
      <ListItemText selected={props.selected}>{props.row.asset.symbol.padEnd(10)}</ListItemText>
      <ListItemText selected={props.selected} color={theme.accent}>
        {`${formatAmount(props.row.remainingAmount)} of ${formatAmount(props.row.originalAmount)} left`}
      </ListItemText>
      <ListItemText selected={props.selected} muted>
        {`@ ${formatFiat(props.row.costBasisPerToken, props.row.costBasisCurrency)}`}
      </ListItemText>
    </ListItem>
  )
}

export function SourceFifoLotsScreen(props: {
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
  const [selectedMatch, setSelectedMatch] = createSignal(0)
  const viewport = createListViewport()
  // While set, the explanation view replaces the list; the loaded pages and
  // selection survive backing out of it.
  const [explainLegId, setExplainLegId] = createSignal<string | undefined>(undefined)

  const list = createPagedList<FifoLotRow>(async (cursor) => {
    const result = await fetchSourceFifoLots(props.session, {
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
        rows: result.data.fifoLots,
        nextCursor: result.data.page.nextCursor,
        hasMore: result.data.page.hasMore,
      },
    }
  })

  const reload = async () => {
    setSelected(0)
    setSelectedMatch(0)
    viewport.reset()
    await list.reload()
  }

  const rows = (): ReadonlyArray<FifoLotRow> => {
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

  const selectedRow = (): FifoLotRow | undefined => rows()[selected()]

  const matches = (): ReadonlyArray<DisposalMatch> => selectedRow()?.disposalMatches ?? []

  const visibleRows = () => Math.max(4, dimensions().height - RESERVED_ROWS)

  const bounds = () => viewport.bounds({ length: rows().length, visible: visibleRows() })

  const matchBounds = () =>
    windowBounds({
      length: matches().length,
      selected: selectedMatch(),
      visible: MAX_DETAIL_MATCHES,
    })

  const statusLine = (): string => {
    const current = okState()
    if (current === undefined) {
      return ""
    }
    const position = `${selected() + 1}/${current.rows.length} lots`
    if (current.loadingMore) {
      return `${position} · loading more…`
    }
    return current.hasMore ? `${position} · [m] load more` : position
  }

  const moveSelection = (delta: number) => {
    if (rows().length === 0) {
      return
    }
    const next = (selected() + rows().length + delta) % rows().length
    setSelected(next)
    setSelectedMatch(0)
    viewport.ensureVisible({ index: next, visible: visibleRows() })
  }

  const listActive = () => props.active() && explainLegId() === undefined

  const selectRow = (index: number) => {
    if (listActive()) {
      setSelected(index)
      setSelectedMatch(0)
    }
  }

  // Pointing at a row selects it, except while a text drag-select is running.
  const hoverRow = (index: number) => {
    if (renderer.getSelection()?.isDragging !== true) {
      selectRow(index)
    }
  }

  useKeyboard((evt) => {
    if (!listActive()) {
      return
    }
    if (evt.name === "return") {
      const match = matches()[selectedMatch()]
      if (match !== undefined) {
        setExplainLegId(match.disposalLegId)
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
      return
    }
    if (evt.name === "left" && matches().length > 0) {
      setSelectedMatch((current) => (current + matches().length - 1) % matches().length)
      return
    }
    if (evt.name === "right" && matches().length > 0) {
      setSelectedMatch((current) => (current + 1) % matches().length)
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
          title="FIFO lots"
          subtitle={props.source.name}
          hints={[
            "[↑/↓] select lot",
            "[←/→] select match",
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
              <Spinner label="Loading FIFO lots…" />
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
              <text fg={theme.textSecondary}>No FIFO lots for this source yet.</text>
            </Match>
            <Match when={list.state()._tag === "ok"}>
              <box flexDirection="column" flexGrow={1} gap={1}>
                <box flexDirection="column">
                  <For each={rows().slice(bounds().start, bounds().end)}>
                    {(row, index) => (
                      <FifoLotLine
                        row={row}
                        selected={bounds().start + index() === selected()}
                        onSelect={() => selectRow(bounds().start + index())}
                        onHover={() => hoverRow(bounds().start + index())}
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
                  {(row: FifoLotRow) => (
                    <box flexDirection="column">
                      <text fg={theme.textSecondary}>
                        {`${row.asset.symbol} · ${row.asset.name} · acquired ${formatDateTime(row.acquiredAt)}`}
                      </text>
                      <Field
                        label="amounts"
                        value={`original ${formatAmount(row.originalAmount)} · remaining ${formatAmount(row.remainingAmount)}`}
                      />
                      <Field
                        label="cost basis"
                        value={`${formatFiat(row.costBasisPerToken, row.costBasisCurrency)} per token`}
                      />
                      <Show
                        when={row.disposalMatches.length > 0}
                        fallback={
                          <text fg={theme.textMuted}>No disposals matched this lot yet.</text>
                        }
                      >
                        <text fg={theme.textSecondary}>
                          {`Disposal matches (${row.disposalMatches.length})`}
                        </text>
                        <For
                          each={row.disposalMatches.slice(matchBounds().start, matchBounds().end)}
                        >
                          {(match, index) => {
                            const isSelected = () =>
                              matchBounds().start + index() === selectedMatch()
                            return (
                              <ListItem selected={isSelected()}>
                                <ListItemText selected={isSelected()}>
                                  {`matched ${formatAmount(match.matchedAmount)}`}
                                </ListItemText>
                                <ListItemText selected={isSelected()} color={theme.accent}>
                                  {`proceeds ${formatFiat(match.proceeds, row.costBasisCurrency)}`}
                                </ListItemText>
                                <ListItemText
                                  selected={isSelected()}
                                  color={gainLossColor(match.gainLoss)}
                                >
                                  {formatSigned(match.gainLoss)}
                                </ListItemText>
                              </ListItem>
                            )
                          }}
                        </For>
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
