import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import * as DateTime from "effect/DateTime"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { ProtocolCandidateReview, ProtocolCandidateReviewDetail } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchProtocolCandidateDetail, type ReportResult } from "../controller.ts"
import { formatDateTime } from "../format.ts"
import { createPagedList, type PagedListState } from "../paging.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
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
const MAX_HASHES = 5
const MAX_TRANSACTION_TYPES = 8

const joinPreview = (values: ReadonlyArray<string>, limit: number): string => {
  const visible = values.slice(0, limit)
  const suffix = values.length > limit ? ` +${values.length - limit} more` : ""
  return `${visible.join(", ")}${suffix}`
}

const formatApiDateTime = (value: DateTime.Utc): string => formatDateTime(DateTime.formatIso(value))

export function ProtocolCandidateDetailScreen(props: {
  readonly session: CliSession
  readonly candidate: ProtocolCandidateReview
  readonly active: () => boolean
  readonly onBack: () => void
  readonly onQuit: () => void
}) {
  const [state, setState] = createSignal<DetailState>({ _tag: "loading" })
  const observationList = createPagedList<ProtocolCandidateObservation>(async (cursor) => {
    const result = await fetchProtocolCandidateDetail(props.session, props.candidate.id, {
      observationCursor: cursor,
    })
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
      hints={["[m] load more", "[r] refresh", "[b] back", "[q] quit"]}
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
              <box flexDirection="column">
                <text fg={theme.textSecondary}>Candidate</text>
                <Field label="subject kind" value={loaded.metadata.candidate.subjectKind} />
                <Field label="subject id" value={loaded.metadata.candidate.subjectIdentifier} />
                <Field
                  label="protocol hint"
                  value={loaded.metadata.candidate.protocolNameHint ?? "none"}
                />
                <Field
                  label="category hint"
                  value={loaded.metadata.candidate.categoryHint ?? "none"}
                />
                <Field
                  label="review status"
                  value={loaded.metadata.candidate.mappingStatus}
                  color={theme.warning}
                />
                <Field
                  label="seen"
                  value={`${formatApiDateTime(loaded.metadata.candidate.firstSeenAt)} to ${formatApiDateTime(
                    loaded.metadata.candidate.lastSeenAt
                  )}`}
                />
              </box>
              <box flexDirection="column">
                <text fg={theme.textSecondary}>Observations</text>
                <For each={loaded.observations.rows}>
                  {(observation) => (
                    <box flexDirection="column" paddingLeft={1}>
                      <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
                        {`${observation.onchainDataSource} · ${observation.interactionCount} interactions`}
                      </text>
                      <Field
                        label="window"
                        value={`${formatApiDateTime(observation.observedWindowStart)} to ${formatApiDateTime(
                          observation.observedWindowEnd
                        )}`}
                      />
                      <Field
                        label="counts"
                        value={`transactions ${observation.transactionCount ?? "n/a"} · actors ${
                          observation.uniqueActorCount ?? "n/a"
                        }`}
                      />
                      <Show when={observation.relatedSubjectIdentifiers.length > 0}>
                        <Field
                          label="related subjects"
                          value={joinPreview(observation.relatedSubjectIdentifiers, MAX_SUBJECTS)}
                        />
                      </Show>
                      <Show when={observation.sampleTransactionHashes.length > 0}>
                        <Field
                          label="sample hashes"
                          value={joinPreview(observation.sampleTransactionHashes, MAX_HASHES)}
                        />
                      </Show>
                      <Field
                        label="source"
                        value={`Dune query ${observation.sourceMetadata.queryId} v${observation.sourceMetadata.queryVersion}: ${observation.sourceMetadata.queryName}`}
                      />
                    </box>
                  )}
                </For>
                <text fg={theme.textMuted}>{statusLine(loaded.observations)}</text>
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
                <text fg={theme.textSecondary}>TaxMaxi transaction types</text>
                <For
                  each={loaded.metadata.transactionTypes.transactionTypes.slice(
                    0,
                    MAX_TRANSACTION_TYPES
                  )}
                >
                  {(transactionType) => (
                    <Field
                      label={transactionType.typeKey}
                      value={`${transactionType.labelEn} · ${transactionType.categoryKey ?? "uncategorized"}`}
                    />
                  )}
                </For>
                <Show
                  when={
                    loaded.metadata.transactionTypes.transactionTypes.length > MAX_TRANSACTION_TYPES
                  }
                >
                  <text fg={theme.textMuted}>
                    {`+${loaded.metadata.transactionTypes.transactionTypes.length - MAX_TRANSACTION_TYPES} more transaction types`}
                  </text>
                </Show>
              </box>
            </box>
          )}
        </Match>
      </Switch>
    </ScreenFrame>
  )
}
