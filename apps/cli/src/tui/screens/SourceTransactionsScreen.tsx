import type { MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { Source, SourceTransactions } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSourceTransactions } from "../controller.ts"
import { formatAmount, formatDate, formatDateTime, formatFiat, truncateText } from "../format.ts"
import { createListViewport, createPagedList } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type TransactionRow = SourceTransactions["transactions"][number]
type Movement = TransactionRow["movements"][number]

// Rows used by everything around the transaction list: app header, panel
// chrome, key hints, the list status line, and the detail pane.
const RESERVED_ROWS = 24
const MAX_DETAIL_MOVEMENTS = 4
const DESCRIPTION_LENGTH = 36

const movementKindColor = (kind: Movement["kind"]): string => {
  if (kind === "acquisition" || kind === "income") {
    return theme.success
  }
  if (kind === "disposal") {
    return theme.warning
  }
  return theme.textMuted
}

const movementLabel = (movement: Movement): string => {
  const fiat =
    movement.fiatAmount === null
      ? ""
      : ` (${formatFiat(movement.fiatAmount, movement.fiatCurrency)})`
  const rule = movement.derivationRule === null ? "" : ` · rule ${movement.derivationRule}`
  return `${formatAmount(movement.amount)} ${movement.asset.symbol}${fiat} · ${movement.provenance}${rule}`
}

function TransactionLine(props: {
  readonly row: TransactionRow
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
}) {
  return (
    <ListItem selected={props.selected} onMouseDown={props.onSelect} onMouseOver={props.onHover}>
      <ListItemText selected={props.selected} muted>
        {formatDate(props.row.timestamp)}
      </ListItemText>
      <ListItemText selected={props.selected}>
        {(props.row.transactionType ?? props.row.providerTransactionType ?? "unknown").padEnd(14)}
      </ListItemText>
      <ListItemText selected={props.selected} color={theme.accent}>
        {`${props.row.movements.length} legs`}
      </ListItemText>
      <Show when={props.row.providerDescription} keyed>
        {(description: string) => (
          <ListItemText selected={props.selected} muted>
            {truncateText(description, DESCRIPTION_LENGTH)}
          </ListItemText>
        )}
      </Show>
    </ListItem>
  )
}

export function SourceTransactionsScreen(props: {
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

  const list = createPagedList<TransactionRow>(async (cursor) => {
    const result = await fetchSourceTransactions(props.session, {
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
        rows: result.data.transactions,
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

  const rows = (): ReadonlyArray<TransactionRow> => {
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

  const selectedRow = (): TransactionRow | undefined => rows()[selected()]

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

  const statusLine = (): string => {
    const current = okState()
    if (current === undefined) {
      return ""
    }
    const position = `${selected() + 1}/${current.rows.length} transactions`
    if (current.loadingMore) {
      return `${position} · loading more…`
    }
    return current.hasMore ? `${position} · [m] load more` : position
  }

  useKeyboard((evt) => {
    if (!props.active()) {
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
      title="Transactions"
      subtitle={props.source.name}
      hints={["[↑/↓] select", "[m] load more", "[r] refresh", "[b] back", "[q] quit"]}
      onMouseScroll={onWheel}
    >
      <Switch>
        <Match when={list.state()._tag === "loading"}>
          <Spinner label="Loading transactions…" />
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
          <text fg={theme.textSecondary}>No transactions imported yet.</text>
        </Match>
        <Match when={list.state()._tag === "ok"}>
          <box flexDirection="column" flexGrow={1} gap={1}>
            <box flexDirection="column">
              <For each={rows().slice(bounds().start, bounds().end)}>
                {(row, index) => (
                  <TransactionLine
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
              {(row: TransactionRow) => (
                <box flexDirection="column">
                  <text fg={theme.textSecondary}>{formatDateTime(row.timestamp)}</text>
                  <Field
                    label="type"
                    value={`${row.transactionType ?? "unknown"} · provider ${row.providerTransactionType ?? "unknown"}${row.providerStatus === null ? "" : ` (${row.providerStatus})`}`}
                  />
                  <Show when={row.providerDescription} keyed>
                    {(description: string) => <Field label="description" value={description} />}
                  </Show>
                  <Show when={row.externalId} keyed>
                    {(externalId: string) => <Field label="external id" value={externalId} />}
                  </Show>
                  <For each={row.movements.slice(0, MAX_DETAIL_MOVEMENTS)}>
                    {(movement) => (
                      <Field
                        label={movement.kind}
                        value={movementLabel(movement)}
                        color={movementKindColor(movement.kind)}
                      />
                    )}
                  </For>
                  <Show when={row.movements.length > MAX_DETAIL_MOVEMENTS}>
                    <text fg={theme.textMuted}>
                      {`+${row.movements.length - MAX_DETAIL_MOVEMENTS} more legs`}
                    </text>
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
