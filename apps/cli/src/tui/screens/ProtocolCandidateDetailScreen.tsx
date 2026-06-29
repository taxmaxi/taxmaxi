import { TextAttributes, type MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as DateTime from "effect/DateTime"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { ProtocolCandidateReview, ProtocolCandidateReviewDetail } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchProtocolCandidateDetail, type ReportResult } from "../controller.ts"
import { createListViewport, createPagedList, type PagedListState } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ListItem, ListItemText } from "../ui/ListItem.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type DetailData = {
  readonly candidate: ProtocolCandidateReviewDetail["candidate"]
  readonly transactionTypes: {
    readonly transactionTypes: ReadonlyArray<{
      readonly typeKey: string
      readonly categoryKey: string | null
      readonly subcategoryKey: string | null
      readonly labelEn: string
      readonly labelDe: string
    }>
  }
}

type DetailState = { readonly _tag: "loading" } | ReportResult<DetailData>
type ProtocolCandidateObservation = ProtocolCandidateReviewDetail["observations"][number]
type DetailViewData = {
  readonly metadata: DetailData
  readonly observations: Extract<
    PagedListState<ProtocolCandidateObservation>,
    { readonly _tag: "ok" }
  >
}

const MAX_SUBJECTS = 6
const MAX_HASHES = 3
const MAX_RELATED_TRANSACTION_TYPES = 5
const RESERVED_ROWS = 31
const SOLSCAN_TX_BASE_URL = "https://solscan.io/tx"
const KNOWN_CATEGORY_HINTS = new Set(["swap"])

const joinPreview = (values: ReadonlyArray<string>, limit: number): string => {
  const visible = values.slice(0, limit)
  const suffix = values.length > limit ? ` +${values.length - limit} more` : ""
  return `${visible.join(", ")}${suffix}`
}

const formatApiDate = (value: DateTime.Utc): string => DateTime.formatIso(value).slice(0, 10)
const solscanTransactionUrl = (hash: string): string => `${SOLSCAN_TX_BASE_URL}/${hash}`

const compactText = (value: string, start = 10, end = 8): string =>
  value.length <= start + end + 1 ? value : `${value.slice(0, start)}…${value.slice(-end)}`

const categoryIsKnown = (categoryHint: string | null): boolean =>
  categoryHint !== null && KNOWN_CATEGORY_HINTS.has(categoryHint)

const formatNumericText = (value: string | null): string => {
  if (value === null) {
    return "n/a"
  }
  try {
    return BigInt(value).toLocaleString("en-US")
  } catch {
    return value
  }
}

const sumNumericText = (values: ReadonlyArray<string>): string => {
  if (values.length === 0) {
    return "n/a"
  }

  const total = values.reduce<bigint | null>((current, value) => {
    if (current === null) {
      return null
    }
    try {
      return current + BigInt(value)
    } catch {
      return null
    }
  }, 0n)

  return total === null ? "n/a" : total.toLocaleString("en-US")
}

const matchesHint = (
  transactionType: DetailData["transactionTypes"]["transactionTypes"][number],
  hint: string
): boolean => {
  const normalized = hint.toLowerCase()
  return [
    transactionType.typeKey,
    transactionType.categoryKey ?? "",
    transactionType.subcategoryKey ?? "",
    transactionType.labelEn,
    transactionType.labelDe,
  ].some((value) => value.toLowerCase().includes(normalized))
}

const relatedTransactionTypes = (
  transactionTypes: DetailData["transactionTypes"]["transactionTypes"],
  categoryHint: string | null
) => {
  if (categoryHint === null || !KNOWN_CATEGORY_HINTS.has(categoryHint)) {
    return transactionTypes.slice(0, MAX_RELATED_TRANSACTION_TYPES)
  }
  const matches = transactionTypes.filter((transactionType) =>
    matchesHint(transactionType, categoryHint)
  )
  return (matches.length > 0 ? matches : transactionTypes).slice(0, MAX_RELATED_TRANSACTION_TYPES)
}

const categoryHintValue = (categoryHint: string | null): string => {
  if (categoryHint === null) {
    return "none"
  }
  return KNOWN_CATEGORY_HINTS.has(categoryHint) ? categoryHint : `unrecognized: ${categoryHint}`
}

const categoryHintNote = (categoryHint: string | null): string =>
  categoryHint === null
    ? "No source category. Suggestions below are unfiltered."
    : KNOWN_CATEGORY_HINTS.has(categoryHint)
      ? "Source hint from Dune. Use evidence before approving."
      : "Invalid source category. Treat as stale/bad import data."

const observationSourceLabel = (observation: ProtocolCandidateObservation): string =>
  `Dune ${observation.sourceMetadata.queryId} v${observation.sourceMetadata.queryVersion} · ${observation.sourceMetadata.queryName}`

function SectionTitle(props: { readonly children: string }) {
  return (
    <text fg={theme.textSecondary} attributes={TextAttributes.BOLD}>
      {props.children}
    </text>
  )
}

function Badge(props: { readonly label: string; readonly color?: string }) {
  return (
    <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
      <text fg={props.color ?? theme.textSecondary}>{props.label}</text>
    </box>
  )
}

function Metric(props: { readonly label: string; readonly value: string }) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={theme.textMuted}>{props.label}</text>
      <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
        {props.value}
      </text>
    </box>
  )
}

function ObservationRow(props: {
  readonly observation: ProtocolCandidateObservation
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onHover: () => void
}) {
  return (
    <ListItem selected={props.selected} onMouseDown={props.onSelect} onMouseOver={props.onHover}>
      <ListItemText selected={props.selected}>
        {formatApiDate(props.observation.observedWindowStart)}
      </ListItemText>
      <ListItemText selected={props.selected} muted>
        {`${formatNumericText(props.observation.interactionCount)} trade rows`}
      </ListItemText>
      <ListItemText selected={props.selected} muted>
        {`${formatNumericText(props.observation.transactionCount)} txs`}
      </ListItemText>
      <ListItemText selected={props.selected} muted>
        {`${props.observation.sampleTransactionHashes.length} samples`}
      </ListItemText>
    </ListItem>
  )
}

export function ProtocolCandidateDetailScreen(props: {
  readonly session: CliSession
  readonly candidate: ProtocolCandidateReview
  readonly active: () => boolean
  readonly onBack: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [state, setState] = createSignal<DetailState>({ _tag: "loading" })
  const [selectedObservation, setSelectedObservation] = createSignal(0)
  const viewport = createListViewport()
  const observationList = createPagedList<ProtocolCandidateObservation>(async (cursor) => {
    const result = await fetchProtocolCandidateDetail(props.session, props.candidate.id, {
      observationCursor: cursor,
    })
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return { _tag: "error", message: result.message }
    }
    if (result._tag === "error") {
      if (cursor === null) {
        setState(result)
      }
      return result
    }

    setState({
      _tag: "ok",
      data: {
        candidate: result.data.candidate.candidate,
        transactionTypes: result.data.transactionTypes,
      },
    })
    return {
      _tag: "ok",
      page: {
        rows: result.data.candidate.observations,
        nextCursor: result.data.candidate.observationsPage.nextCursor,
        hasMore: result.data.candidate.observationsPage.hasMore,
      },
    }
  })

  const refresh = async () => {
    setState({ _tag: "loading" })
    setSelectedObservation(0)
    viewport.reset()
    await observationList.reload()
  }

  const data = (): DetailData | undefined => {
    const current = state()
    return current._tag === "ok" ? current.data : undefined
  }

  const errorMessage = (): string | undefined => {
    const current = state()
    return current._tag === "error" ? current.message : undefined
  }

  const viewData = (): DetailViewData | undefined => {
    const metadata = data()
    const observations = observationList.state()
    return metadata !== undefined && observations._tag === "ok"
      ? { metadata, observations }
      : undefined
  }

  const statusLine = (observations: DetailViewData["observations"]): string => {
    const position = `${observations.rows.length} observations loaded`
    if (observations.loadingMore) {
      return `${position} · loading more…`
    }
    return observations.hasMore ? `${position} · [m] load more` : position
  }

  const visibleObservationRows = () => Math.max(3, dimensions().height - RESERVED_ROWS)
  const observationBounds = (observations: DetailViewData["observations"]) =>
    viewport.bounds({ length: observations.rows.length, visible: visibleObservationRows() })

  const selectedEvidence = (
    observations: DetailViewData["observations"]
  ): ProtocolCandidateObservation | undefined => observations.rows[selectedObservation()]

  const selectObservation = (index: number) => {
    if (!props.active()) {
      return
    }
    setSelectedObservation(index)
    viewport.ensureVisible({ index, visible: visibleObservationRows() })
  }

  const hoverObservation = (index: number) => {
    if (renderer.getSelection()?.isDragging !== true) {
      selectObservation(index)
    }
  }

  const moveObservation = (delta: number) => {
    const view = viewData()
    if (view === undefined || view.observations.rows.length === 0) {
      return
    }
    const next =
      (selectedObservation() + view.observations.rows.length + delta) %
      view.observations.rows.length
    selectObservation(next)
  }

  const onWheel = (evt: MouseEvent) => {
    if (!props.active()) {
      return
    }
    const view = viewData()
    const direction = evt.scroll?.direction
    if (view === undefined || (direction !== "up" && direction !== "down")) {
      return
    }
    viewport.scrollBy({
      delta: direction === "up" ? -1 : 1,
      length: view.observations.rows.length,
      visible: visibleObservationRows(),
    })
  }

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "r") {
      void refresh()
      return
    }
    if (evt.name === "m") {
      void observationList.loadMore()
      return
    }
    if (evt.name === "up") {
      moveObservation(-1)
      return
    }
    if (evt.name === "down") {
      moveObservation(1)
      return
    }
    if (evt.name === "escape" || evt.name === "b") {
      props.onBack()
      return
    }
    if (evt.name === "q") {
      props.onQuit()
    }
  })

  return (
    <ScreenFrame
      title={props.candidate.protocolNameHint ?? props.candidate.subjectIdentifier}
      subtitle={`${props.candidate.blockchainName} · ${props.candidate.subjectKind}`}
      hints={["[↑/↓] evidence", "[m] load more", "[r] refresh", "[b] back", "[q] quit"]}
      onMouseScroll={onWheel}
    >
      <Switch>
        <Match when={state()._tag === "loading" || observationList.state()._tag === "loading"}>
          <Spinner label="Loading protocol candidate…" />
        </Match>
        <Match when={errorMessage()}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.error} wrapMode="word">
              {errorMessage()}
            </text>
            <text fg={theme.textMuted}>[r] retry</text>
          </box>
        </Match>
        <Match when={viewData()} keyed>
          {(loaded: DetailViewData) => (
            <box flexDirection="column" gap={1}>
              <box flexDirection="column" gap={1}>
                <box flexDirection="row" gap={1}>
                  <Badge label={loaded.metadata.candidate.mappingStatus} color={theme.warning} />
                  <Badge
                    label={`category ${categoryHintValue(loaded.metadata.candidate.categoryHint)}`}
                    color={
                      categoryIsKnown(loaded.metadata.candidate.categoryHint)
                        ? theme.textSecondary
                        : theme.error
                    }
                  />
                  <Badge label={`${loaded.metadata.candidate.observationCount} observations`} />
                  <Badge label={loaded.metadata.candidate.blockchainName} />
                </box>
                <text fg={theme.textMuted} wrapMode="word">
                  {`Subject ${compactText(loaded.metadata.candidate.subjectIdentifier, 18, 10)} · seen ${formatApiDate(loaded.metadata.candidate.firstSeenAt)} to ${formatApiDate(loaded.metadata.candidate.lastSeenAt)} · ${categoryHintNote(loaded.metadata.candidate.categoryHint)}`}
                </text>
              </box>
              <box flexDirection="row" gap={2}>
                <Metric label="loaded" value={String(loaded.observations.rows.length)} />
                <Metric
                  label="trade rows"
                  value={sumNumericText(
                    loaded.observations.rows.map((observation) => observation.interactionCount)
                  )}
                />
                <Metric
                  label="approx txs"
                  value={sumNumericText(
                    loaded.observations.rows
                      .map((observation) => observation.transactionCount)
                      .filter((value): value is string => value !== null)
                  )}
                />
                <Metric
                  label="protocol"
                  value={
                    loaded.metadata.candidate.protocolNameHint === null
                      ? "none"
                      : compactText(loaded.metadata.candidate.protocolNameHint, 14, 8)
                  }
                />
              </box>
              <box flexDirection="column">
                <box flexDirection="row" gap={2}>
                  <SectionTitle>Observations</SectionTitle>
                  <text fg={theme.textMuted}>{statusLine(loaded.observations)}</text>
                </box>
                <For
                  each={loaded.observations.rows.slice(
                    observationBounds(loaded.observations).start,
                    observationBounds(loaded.observations).end
                  )}
                >
                  {(observation, index) => {
                    const absoluteIndex = () =>
                      observationBounds(loaded.observations).start + index()
                    return (
                      <ObservationRow
                        observation={observation}
                        selected={absoluteIndex() === selectedObservation()}
                        onSelect={() => selectObservation(absoluteIndex())}
                        onHover={() => hoverObservation(absoluteIndex())}
                      />
                    )
                  }}
                </For>
                <Show when={loaded.observations.loadMoreError} keyed>
                  {(loadMoreError: string) => (
                    <text fg={theme.error} wrapMode="word">
                      {loadMoreError}
                    </text>
                  )}
                </Show>
                <Show when={loaded.observations.rows.length === 0}>
                  <text fg={theme.textMuted}>
                    No source observations have been imported for this candidate.
                  </text>
                </Show>
              </box>
              <box flexDirection="column">
                <SectionTitle>Selected Evidence</SectionTitle>
                <Show when={selectedEvidence(loaded.observations)} keyed>
                  {(observation: ProtocolCandidateObservation) => (
                    <box flexDirection="column">
                      <Field
                        label="window"
                        value={`${formatApiDate(observation.observedWindowStart)} to ${formatApiDate(
                          observation.observedWindowEnd
                        )}`}
                      />
                      <Field
                        label="counts"
                        value={`trade rows ${formatNumericText(
                          observation.interactionCount
                        )} · approx txs ${formatNumericText(
                          observation.transactionCount
                        )} · actors ${formatNumericText(observation.uniqueActorCount)}`}
                      />
                      <Show when={observation.relatedSubjectIdentifiers.length > 0}>
                        <Field
                          label="programs"
                          value={joinPreview(observation.relatedSubjectIdentifiers, MAX_SUBJECTS)}
                        />
                      </Show>
                      <Show when={observation.sampleTransactionHashes.length > 0}>
                        <box flexDirection="column">
                          <text fg={theme.textMuted}>sample txs</text>
                          <For each={observation.sampleTransactionHashes.slice(0, MAX_HASHES)}>
                            {(hash) => (
                              <box flexDirection="row" gap={1} paddingLeft={2}>
                                <text fg={theme.textSoft}>{compactText(hash, 12, 10)}</text>
                                <text fg={theme.accent} wrapMode="word">
                                  {solscanTransactionUrl(hash)}
                                </text>
                              </box>
                            )}
                          </For>
                          <Show when={observation.sampleTransactionHashes.length > MAX_HASHES}>
                            <text fg={theme.textMuted}>
                              {`+${observation.sampleTransactionHashes.length - MAX_HASHES} more`}
                            </text>
                          </Show>
                        </box>
                      </Show>
                      <Show when={observation.sampleTransactionHashes.length === 0}>
                        <Field label="sample txs" value="none for this window" />
                      </Show>
                      <Field label="source" value={observationSourceLabel(observation)} />
                    </box>
                  )}
                </Show>
              </box>
              <box flexDirection="column">
                <box flexDirection="row" gap={2}>
                  <SectionTitle>TaxMaxi Type Candidates</SectionTitle>
                  <text fg={theme.textMuted}>
                    {categoryIsKnown(loaded.metadata.candidate.categoryHint)
                      ? `filtered by ${loaded.metadata.candidate.categoryHint}`
                      : "unfiltered"}
                  </text>
                </box>
                <Field
                  label="review rule"
                  value="Pick only if samples and balance deltas support it. Candidate data is not approval."
                />
                <For
                  each={relatedTransactionTypes(
                    loaded.metadata.transactionTypes.transactionTypes,
                    loaded.metadata.candidate.categoryHint
                  )}
                >
                  {(transactionType) => (
                    <box flexDirection="row" gap={1} paddingLeft={1}>
                      <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
                        {transactionType.typeKey}
                      </text>
                      <text fg={theme.textMuted} wrapMode="word">
                        {`${transactionType.labelEn} · ${
                          transactionType.categoryKey ?? "uncategorized"
                        }`}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </box>
          )}
        </Match>
      </Switch>
    </ScreenFrame>
  )
}
