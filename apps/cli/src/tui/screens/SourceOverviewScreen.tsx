import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { Source, SourceOverview } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchSourceOverview, type ReportResult } from "../controller.ts"
import { formatAmount, formatDate, formatDateTime, formatSigned, gainLossColor } from "../format.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type OverviewState = { readonly _tag: "loading" } | ReportResult<SourceOverview>

const MAX_REVIEW_ISSUES = 3

const syncStatusColor = (status: string | null): string => {
  if (status === "completed") {
    return theme.success
  }
  if (status === "failed") {
    return theme.error
  }
  if (status === null) {
    return theme.textMuted
  }
  return theme.warning
}

const syncStatusLabel = (overview: SourceOverview): string => {
  const sync = overview.latestSync
  if (sync.status === null) {
    return "never synced"
  }
  return sync.mode === "replay" ? `${sync.status} (replay)` : sync.status
}

const syncRecordsLabel = (overview: SourceOverview): string | undefined => {
  const sync = overview.latestSync
  if (sync.importedRecords === null && sync.normalizedRecords === null) {
    return undefined
  }
  return [
    `imported ${sync.importedRecords ?? 0}`,
    `normalized ${sync.normalizedRecords ?? 0}`,
    `failed ${sync.failedRecords ?? 0}`,
  ].join(" · ")
}

export function SourceOverviewScreen(props: {
  readonly session: CliSession
  readonly source: Source
  readonly active: () => boolean
  readonly onOpenAssetPnl: () => void
  readonly onOpenTransactions: () => void
  readonly onOpenTaxEvents: () => void
  readonly onOpenFifoLots: () => void
  readonly onBack: () => void
  readonly onQuit: () => void
}) {
  const [state, setState] = createSignal<OverviewState>({ _tag: "loading" })

  const refresh = async () => {
    setState({ _tag: "loading" })
    setState(await fetchSourceOverview(props.session, props.source.id))
  }
  void refresh()

  const overview = (): SourceOverview | undefined => {
    const current = state()
    return current._tag === "ok" ? current.data : undefined
  }

  const errorMessage = (): string | undefined => {
    const current = state()
    return current._tag === "error" ? current.message : undefined
  }

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "p") {
      props.onOpenAssetPnl()
      return
    }
    if (evt.name === "t") {
      props.onOpenTransactions()
      return
    }
    if (evt.name === "e") {
      props.onOpenTaxEvents()
      return
    }
    if (evt.name === "f") {
      props.onOpenFifoLots()
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
    }
  })

  return (
    <ScreenFrame
      title={props.source.name}
      subtitle={`${props.source.providerKey ?? "unknown"} · ${props.source.sourceRef._tag} · added ${formatDate(props.source.createdAt.toISOString())}`}
      hints={[
        "[p] asset p&l",
        "[t] transactions",
        "[e] tax events",
        "[f] fifo lots",
        "[r] refresh",
        "[b] back",
        "[q] quit",
      ]}
    >
      <Switch>
        <Match when={state()._tag === "loading"}>
          <Spinner label="Loading overview…" />
        </Match>
        <Match when={errorMessage()}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.error} wrapMode="word">
              {errorMessage()}
            </text>
            <text fg={theme.textMuted}>[r] retry</text>
          </box>
        </Match>
        <Match when={overview()} keyed>
          {(data: SourceOverview) => (
            <box flexDirection="column" gap={1}>
              <box flexDirection="column">
                <text fg={theme.textSecondary}>Latest sync</text>
                <Field
                  label="status"
                  value={syncStatusLabel(data)}
                  color={syncStatusColor(data.latestSync.status)}
                />
                <Show when={data.latestSync.lastSyncedAt} keyed>
                  {(syncedAt: string) => (
                    <Field label="last synced" value={formatDateTime(syncedAt)} />
                  )}
                </Show>
                <Show when={syncRecordsLabel(data)} keyed>
                  {(records: string) => <Field label="records" value={records} />}
                </Show>
                <Show when={data.latestSync.lastErrorMessage} keyed>
                  {(message: string) => (
                    <Field label="last error" value={message} color={theme.error} />
                  )}
                </Show>
              </box>
              <box flexDirection="column">
                <text fg={theme.textSecondary}>Totals</text>
                <Field
                  label="activity"
                  value={`${data.totals.transactionCount} transactions · ${data.totals.legCount} legs · ${data.totals.assetCount} assets`}
                />
                <Field
                  label="tax records"
                  value={`${data.totals.fifoLotCount} fifo lots · ${data.totals.disposalCount} disposals · ${data.totals.incomeCount} income · ${data.totals.feeCount} fees`}
                />
                <Field
                  label="realized p&l"
                  value={`${formatSigned(data.totals.realizedGainLoss)} ${data.totals.currency ?? ""}`.trim()}
                  color={gainLossColor(data.totals.realizedGainLoss)}
                />
                <Field
                  label="income total"
                  value={`${formatAmount(data.totals.incomeTotal)} ${data.totals.currency ?? ""}`.trim()}
                />
              </box>
              <box flexDirection="column">
                <text fg={theme.textSecondary}>Review</text>
                <Field
                  label="status"
                  value={
                    data.review.status === "ok"
                      ? "ok"
                      : `needs review (${data.review.needsReviewCount} items, ${data.review.blockingIssueCount} blocking)`
                  }
                  color={data.review.status === "ok" ? theme.success : theme.warning}
                />
                <For each={data.review.issues.slice(0, MAX_REVIEW_ISSUES)}>
                  {(issue) => (
                    <Field
                      label={issue.blocking ? "blocking issue" : "issue"}
                      value={`${issue.summary} (${issue.count})`}
                      color={issue.blocking ? theme.error : theme.warning}
                    />
                  )}
                </For>
                <Show when={data.review.issues.length > MAX_REVIEW_ISSUES}>
                  <text fg={theme.textMuted}>
                    {`+${data.review.issues.length - MAX_REVIEW_ISSUES} more issues`}
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
