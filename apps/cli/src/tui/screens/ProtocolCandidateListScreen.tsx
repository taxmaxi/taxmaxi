import { TextAttributes, type MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { ProtocolCandidateReview } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchProtocolCandidates } from "../controller.ts"
import { createListViewport, createPagedList } from "../paging.ts"
import { theme } from "../theme.ts"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

const RESERVED_ROWS = 9

const candidateLabel = (candidate: ProtocolCandidateReview): string =>
  candidate.protocolNameHint ?? candidate.subjectIdentifier

function CandidateRow(props: {
  readonly candidate: ProtocolCandidateReview
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
  readonly onActivate: () => void
}) {
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? theme.backgroundElement : theme.backgroundPanel}
      onMouseDown={props.onSelect}
      onMouseOver={props.onHover}
      onMouseUp={props.onActivate}
    >
      <text fg={props.selected ? theme.text : theme.textMuted}>{props.selected ? "›" : " "}</text>
      <text fg={props.selected ? theme.text : theme.textSoft}>
        {candidateLabel(props.candidate)}
      </text>
      <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textSecondary}>{props.candidate.subjectKind}</text>
      </box>
      <text fg={theme.textMuted}>{props.candidate.categoryHint ?? "uncategorized"}</text>
      <text fg={theme.textMuted}>{`${props.candidate.observationCount} observations`}</text>
    </box>
  )
}

export function ProtocolCandidateListScreen(props: {
  readonly session: CliSession
  readonly active: () => boolean
  readonly onOpenCandidate: (candidate: ProtocolCandidateReview) => void
  readonly onBack: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal(0)
  const viewport = createListViewport()
  const list = createPagedList<ProtocolCandidateReview>(async (cursor) => {
    const result = await fetchProtocolCandidates(props.session, { cursor })
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
    await list.reload()
  }

  const candidates = (): ReadonlyArray<ProtocolCandidateReview> => {
    const current = list.state()
    return current._tag === "ok" ? current.rows : []
  }

  const message = (): string | undefined => {
    const current = list.state()
    return current._tag === "error" ? current.message : undefined
  }

  const okState = () => {
    const current = list.state()
    return current._tag === "ok" ? current : undefined
  }

  const statusLine = (): string => {
    const current = okState()
    if (current === undefined) {
      return ""
    }
    const position = `${selected() + 1}/${current.rows.length} candidates`
    if (current.loadingMore) {
      return `${position} · loading more…`
    }
    return current.hasMore ? `${position} · [m] load more` : position
  }

  const visibleRows = () => Math.max(4, dimensions().height - RESERVED_ROWS)
  const bounds = () => viewport.bounds({ length: candidates().length, visible: visibleRows() })

  const moveSelection = (delta: number) => {
    if (candidates().length === 0) {
      return
    }
    const next = (selected() + candidates().length + delta) % candidates().length
    setSelected(next)
    viewport.ensureVisible({ index: next, visible: visibleRows() })
  }

  const selectRow = (index: number) => {
    if (props.active()) {
      setSelected(index)
    }
  }

  const hoverRow = (index: number) => {
    if (renderer.getSelection()?.isDragging !== true) {
      selectRow(index)
    }
  }

  const activateRow = (candidate: ProtocolCandidateReview) => {
    const dragText = renderer.getSelection()?.getSelectedText() ?? ""
    if (props.active() && dragText.length === 0) {
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
      length: candidates().length,
      visible: visibleRows(),
    })
  }

  return (
    <ScreenFrame
      title="Protocol candidates"
      subtitle="pending review"
      hints={[
        "[enter] open",
        "[↑/↓] select",
        "[m] load more",
        "[r] refresh",
        "[b] back",
        "[q] quit",
      ]}
    >
      <box flexDirection="column" gap={1} onMouseScroll={onWheel}>
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
                Pending candidates
              </text>
              <For each={candidates().slice(bounds().start, bounds().end)}>
                {(candidate, index) => (
                  <CandidateRow
                    candidate={candidate}
                    selected={bounds().start + index() === selected()}
                    onSelect={() => selectRow(bounds().start + index())}
                    onHover={() => hoverRow(bounds().start + index())}
                    onActivate={() => activateRow(candidate)}
                  />
                )}
              </For>
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
    </ScreenFrame>
  )
}
