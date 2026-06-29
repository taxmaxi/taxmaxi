import { TextAttributes, type MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, Match, Show, Switch } from "solid-js"
import type { ProtocolCandidateReview } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchProtocolCandidates } from "../controller.ts"
import { createListViewport, createPagedList } from "../paging.ts"
import { theme } from "../theme.ts"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { Spinner } from "../ui/Spinner.tsx"

const RESERVED_ROWS = 17

type CandidateGroup = {
  readonly key: string
  readonly label: string
  readonly category: string
  readonly subjectKind: string
  readonly observationCount: number
  readonly candidates: ReadonlyArray<{
    readonly candidate: ProtocolCandidateReview
    readonly index: number
  }>
}

type CandidateRenderRow =
  | { readonly _tag: "spacer" }
  | { readonly _tag: "group"; readonly group: CandidateGroup }
  | {
      readonly _tag: "candidate"
      readonly group: CandidateGroup
      readonly candidate: ProtocolCandidateReview
      readonly candidateIndex: number
      readonly groupCandidateIndex: number
    }

type SelectableCandidateRow = Extract<CandidateRenderRow, { readonly _tag: "candidate" }> & {
  readonly renderRowIndex: number
}

export type ProtocolCandidateListViewState = {
  readonly selectedCandidateId: string | undefined
  readonly viewportOffset: number
}

const protocolKey = (candidate: ProtocolCandidateReview): string =>
  candidate.protocolNameHint ?? candidate.subjectIdentifier

const plural = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`

const compactIdentifier = (value: string): string =>
  value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`

const groupCandidates = (
  candidates: ReadonlyArray<ProtocolCandidateReview>
): ReadonlyArray<CandidateGroup> => {
  const groups = new Map<string, CandidateGroup>()

  candidates.forEach((candidate, index) => {
    const key = protocolKey(candidate)
    const existing = groups.get(key)
    const category = candidate.categoryHint ?? "uncategorized"
    const subjectKind = candidate.subjectKind

    if (existing === undefined) {
      groups.set(key, {
        key,
        label: key,
        category,
        subjectKind,
        observationCount: candidate.observationCount,
        candidates: [{ candidate, index }],
      })
      return
    }

    const categories = new Set([existing.category, category])
    const subjectKinds = new Set([existing.subjectKind, subjectKind])

    groups.set(key, {
      ...existing,
      category: categories.size === 1 ? existing.category : "mixed",
      subjectKind: subjectKinds.size === 1 ? existing.subjectKind : "subject",
      observationCount: existing.observationCount + candidate.observationCount,
      candidates: [...existing.candidates, { candidate, index }],
    })
  })

  return [...groups.values()]
}

const renderRowsForGroups = (
  groups: ReadonlyArray<CandidateGroup>
): ReadonlyArray<CandidateRenderRow> =>
  groups.flatMap((group, groupIndex) => {
    const groupRows: ReadonlyArray<CandidateRenderRow> = [
      { _tag: "group", group },
      ...group.candidates.map(
        ({ candidate, index }, groupCandidateIndex): CandidateRenderRow => ({
          _tag: "candidate",
          group,
          candidate,
          candidateIndex: index,
          groupCandidateIndex,
        })
      ),
    ]
    return groupIndex === 0 ? groupRows : [{ _tag: "spacer" }, ...groupRows]
  })

function CandidateGroupHeader(props: { readonly group: CandidateGroup }) {
  const candidateCount = () => props.group.candidates.length

  return (
    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
        {props.group.label}
      </text>
      <text fg={theme.textMuted}>
        {`${candidateCount()} ${plural(candidateCount(), props.group.subjectKind)}`}
      </text>
      <text fg={theme.textMuted}>{props.group.category}</text>
      <text fg={theme.textMuted}>{`${props.group.observationCount} observations`}</text>
    </box>
  )
}

function CandidateRow(props: {
  readonly candidate: ProtocolCandidateReview
  readonly groupCandidateIndex: number
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
      <ListItemText selected={props.selected}>
        {compactIdentifier(props.candidate.subjectIdentifier)}
      </ListItemText>
      <ListItemText selected={props.selected} color={theme.accent}>
        {props.candidate.subjectKind}
      </ListItemText>
      <ListItemText
        selected={props.selected}
        muted
      >{`#${props.groupCandidateIndex + 1}`}</ListItemText>
      <ListItemText
        selected={props.selected}
        muted
      >{`${props.candidate.observationCount} observations`}</ListItemText>
    </ListItem>
  )
}

export function ProtocolCandidateListScreen(props: {
  readonly session: CliSession
  readonly active: () => boolean
  readonly initialViewState: ProtocolCandidateListViewState | undefined
  readonly onOpenCandidate: (candidate: ProtocolCandidateReview) => void
  readonly onViewStateChange: (state: ProtocolCandidateListViewState) => void
  readonly onBack: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal(0)
  const viewport = createListViewport(props.initialViewState?.viewportOffset ?? 0)
  let restoredInitialView = false
  const list = createPagedList<ProtocolCandidateReview>(async (cursor) => {
    const result = await fetchProtocolCandidates(props.session, { cursor })
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return { _tag: "error", message: result.message }
    }
    if (result._tag === "blocked" || result._tag === "error") {
      return { _tag: "error", message: result.message }
    }
    return {
      _tag: "ok",
      page: {
        rows: result.data.candidates,
        nextCursor: result.data.page.nextCursor,
        hasMore: result.data.page.hasMore,
      },
    }
  })

  const refresh = async () => {
    setSelected(0)
    viewport.reset()
    props.onViewStateChange({ selectedCandidateId: undefined, viewportOffset: 0 })
    await list.reload()
  }

  const candidates = (): ReadonlyArray<ProtocolCandidateReview> => {
    const current = list.state()
    return current._tag === "ok" ? current.rows : []
  }

  const groups = (): ReadonlyArray<CandidateGroup> => groupCandidates(candidates())
  const renderRows = (): ReadonlyArray<CandidateRenderRow> => renderRowsForGroups(groups())

  const message = (): string | undefined => {
    const current = list.state()
    return current._tag === "error" ? current.message : undefined
  }

  const okState = () => {
    const current = list.state()
    return current._tag === "ok" ? current : undefined
  }

  const visibleRows = () => Math.max(4, dimensions().height - RESERVED_ROWS)
  const bounds = () => viewport.bounds({ length: renderRows().length, visible: visibleRows() })
  const selectableRows = (): ReadonlyArray<SelectableCandidateRow> =>
    renderRows().flatMap((row, renderRowIndex) =>
      row._tag === "candidate" ? [{ ...row, renderRowIndex }] : []
    )

  const statusLine = (): string => {
    const current = okState()
    if (current === undefined) {
      return ""
    }
    const rows = selectableRows()
    const visualPosition =
      Math.max(
        0,
        rows.findIndex((row) => row.candidateIndex === selected())
      ) + 1
    const position = `${visualPosition}/${current.rows.length} candidates · ${groups().length} protocols`
    if (current.loadingMore) {
      return `${position} · loading more…`
    }
    return current.hasMore ? `${position} · [m] load more` : position
  }

  const saveViewState = (selectedIndex: number) => {
    const normalizedBounds = bounds()
    props.onViewStateChange({
      selectedCandidateId: candidates()[selectedIndex]?.id,
      viewportOffset: normalizedBounds.start,
    })
  }

  createEffect(() => {
    const initialSelectedCandidateId = props.initialViewState?.selectedCandidateId
    const current = okState()
    if (restoredInitialView || initialSelectedCandidateId === undefined || current === undefined) {
      return
    }
    const restoredIndex = current.rows.findIndex(
      (candidate) => candidate.id === initialSelectedCandidateId
    )
    if (restoredIndex < 0) {
      if (current.hasMore && !current.loadingMore) {
        void list.loadMore()
      }
      if (!current.hasMore) {
        restoredInitialView = true
      }
      return
    }
    setSelected(restoredIndex)
    viewport.setOffset(props.initialViewState?.viewportOffset ?? 0)
    restoredInitialView = true
  })

  const moveSelection = (delta: number) => {
    const rows = selectableRows()
    if (rows.length === 0) {
      return
    }
    const currentPosition = Math.max(
      0,
      rows.findIndex((row) => row.candidateIndex === selected())
    )
    const next = rows[(currentPosition + rows.length + delta) % rows.length]
    if (next === undefined) {
      return
    }
    selectRow(next)
  }

  const selectRow = (row: SelectableCandidateRow) => {
    if (props.active()) {
      setSelected(row.candidateIndex)
      viewport.ensureVisible({ index: row.renderRowIndex, visible: visibleRows() })
      const previousRow = renderRows()[row.renderRowIndex - 1]
      if (viewport.offset() === row.renderRowIndex && previousRow?._tag === "group") {
        viewport.setOffset(row.renderRowIndex - 1)
      }
      saveViewState(row.candidateIndex)
    }
  }

  const selectCandidateIndex = (candidateIndex: number) => {
    const row = selectableRows().find(
      (candidateRow) => candidateRow.candidateIndex === candidateIndex
    )
    if (row !== undefined) {
      selectRow(row)
    }
  }

  const hoverRow = (index: number) => {
    if (renderer.getSelection()?.isDragging !== true) {
      selectCandidateIndex(index)
    }
  }

  const activateRow = (candidate: ProtocolCandidateReview) => {
    const dragText = renderer.getSelection()?.getSelectedText() ?? ""
    if (props.active() && dragText.length === 0) {
      saveViewState(selected())
      props.onOpenCandidate(candidate)
    }
  }

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "return") {
      const candidate = candidates()[selected()]
      if (candidate !== undefined) {
        saveViewState(selected())
        props.onOpenCandidate(candidate)
      }
      return
    }
    if (evt.name === "r") {
      void refresh()
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
      length: renderRows().length,
      visible: visibleRows(),
    })
    saveViewState(selected())
  }

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      flexDirection="column"
      minHeight={0}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      onMouseScroll={onWheel}
    >
      <box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        minHeight={0}
        gap={1}
        backgroundColor={theme.backgroundPanel}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="row" gap={2}>
          <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
            Protocol candidates
          </text>
          <text fg={theme.textMuted}>pending review</text>
        </box>
        <Switch>
          <Match when={list.state()._tag === "loading"}>
            <Spinner label="Loading protocol candidates…" />
          </Match>
          <Match when={message()}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.error} wrapMode="word">
                {message()}
              </text>
              <text fg={theme.textMuted}>[r] retry</text>
            </box>
          </Match>
          <Match when={list.state()._tag === "ok" && candidates().length === 0}>
            <text fg={theme.textSecondary}>No protocol candidates waiting for review.</text>
          </Match>
          <Match when={list.state()._tag === "ok"}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
                Pending protocols
              </text>
              <box flexDirection="column" height={visibleRows()} overflow="hidden">
                <For each={renderRows().slice(bounds().start, bounds().end)}>
                  {(row, index) =>
                    row._tag === "spacer" ? (
                      <box height={1} />
                    ) : row._tag === "group" ? (
                      <CandidateGroupHeader group={row.group} />
                    ) : (
                      <CandidateRow
                        candidate={row.candidate}
                        groupCandidateIndex={row.groupCandidateIndex}
                        selected={row.candidateIndex === selected()}
                        onSelect={() =>
                          selectRow({ ...row, renderRowIndex: bounds().start + index() })
                        }
                        onHover={() => hoverRow(row.candidateIndex)}
                        onActivate={() => activateRow(row.candidate)}
                      />
                    )
                  }
                </For>
              </box>
              <text fg={theme.textMuted}>{statusLine()}</text>
              <Show when={okState()?.loadMoreError} keyed>
                {(loadMoreError: string) => (
                  <text fg={theme.error} wrapMode="word">
                    {loadMoreError}
                  </text>
                )}
              </Show>
            </box>
          </Match>
        </Switch>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={theme.textMuted}>[enter] open</text>
        <text fg={theme.textMuted}>[↑/↓] select</text>
        <text fg={theme.textMuted}>[m] load more</text>
        <text fg={theme.textMuted}>[r] refresh</text>
        <text fg={theme.textMuted}>[b] back</text>
        <text fg={theme.textMuted}>[q] quit</text>
      </box>
    </box>
  )
}
