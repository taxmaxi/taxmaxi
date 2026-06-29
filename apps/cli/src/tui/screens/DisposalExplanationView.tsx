import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import type { SourceDisposalExplanation } from "taxmaxi"
import type { CliSession } from "../../session.ts"
import { fetchDisposalExplanation, type ReportResult } from "../controller.ts"
import {
  formatAmount,
  formatDateTime,
  formatFiat,
  formatLabel,
  formatSigned,
  gainLossColor,
  treatmentColor,
} from "../format.ts"
import { theme } from "../theme.ts"
import { Field } from "../ui/Field.tsx"
import { ScreenFrame } from "../ui/ScreenFrame.tsx"
import { Spinner } from "../ui/Spinner.tsx"

type ExplanationState = { readonly _tag: "loading" } | ReportResult<SourceDisposalExplanation>

const MAX_MATCHED_LOTS = 6

/**
 * Deterministic explanation for one disposal leg. Rendered by the tax
 * events and FIFO lots screens in place of their list while open, so the
 * list state survives back navigation.
 */
export function DisposalExplanationView(props: {
  readonly session: CliSession
  readonly sourceId: string
  readonly legId: string
  readonly sourceName: string
  readonly active: () => boolean
  readonly onBack: () => void
  readonly onSessionExpired: () => void
  readonly onQuit: () => void
}) {
  const [state, setState] = createSignal<ExplanationState>({ _tag: "loading" })

  const refresh = async () => {
    setState({ _tag: "loading" })
    const result = await fetchDisposalExplanation(props.session, {
      sourceId: props.sourceId,
      legId: props.legId,
    })
    if (result._tag === "unauthorized") {
      props.onSessionExpired()
      return
    }
    setState(result)
  }
  void refresh()

  const explanation = (): SourceDisposalExplanation | undefined => {
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
      title="Disposal explanation"
      subtitle={props.sourceName}
      hints={["[r] refresh", "[b] back", "[q] quit"]}
    >
      <Switch>
        <Match when={state()._tag === "loading"}>
          <Spinner label="Loading disposal explanation…" />
        </Match>
        <Match when={errorMessage()}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.error} wrapMode="word">
              {errorMessage()}
            </text>
            <text fg={theme.textMuted}>[r] retry · [b] back</text>
          </box>
        </Match>
        <Match when={explanation()} keyed>
          {(data: SourceDisposalExplanation) => (
            <box flexDirection="column" gap={1}>
              <box flexDirection="column">
                <Field label="asset" value={`${data.asset.symbol} · ${data.asset.name}`} />
                <Field label="amount" value={formatAmount(data.amount)} />
                <Field label="disposed at" value={formatDateTime(data.disposedAt)} />
                <Show when={data.acquiredAt} keyed>
                  {(acquiredAt: string) => (
                    <Field label="acquired at" value={formatDateTime(acquiredAt)} />
                  )}
                </Show>
                <Field
                  label="proceeds"
                  value={data.proceeds === null ? "unknown" : formatFiat(data.proceeds, null)}
                />
                <Field label="cost basis" value={formatFiat(data.costBasis, null)} />
                <Field
                  label="gain/loss"
                  value={formatSigned(data.gainLoss)}
                  color={gainLossColor(data.gainLoss)}
                />
                <Field
                  label="treatment"
                  value={formatLabel(data.taxableTreatment)}
                  color={treatmentColor(data.taxableTreatment)}
                />
                <Field
                  label="provenance"
                  value={
                    data.derivationRule === null
                      ? data.provenance
                      : `${data.provenance} · rule ${data.derivationRule}`
                  }
                />
                <Show when={data.transactionId} keyed>
                  {(transactionId: string) => <Field label="transaction" value={transactionId} />}
                </Show>
                <Field label="disposal leg" value={data.disposalLegId} />
              </box>
              <box flexDirection="column">
                <text fg={theme.textSecondary}>
                  {`Matched FIFO lots (${data.matchedLots.length})`}
                </text>
                <Show when={data.matchedLots.length === 0}>
                  <text fg={theme.textMuted}>No matched lots returned for this disposal.</text>
                </Show>
                <For each={data.matchedLots.slice(0, MAX_MATCHED_LOTS)}>
                  {(lot) => (
                    <box flexDirection="row" gap={1} paddingLeft={1}>
                      <text fg={theme.textMuted}>{formatDateTime(lot.acquiredAt)}</text>
                      <text fg={theme.textSoft}>
                        {`${formatAmount(lot.matchedAmount)} ${lot.asset.symbol}`}
                      </text>
                      <text
                        fg={theme.textSecondary}
                      >{`basis ${formatFiat(lot.costBasis, null)}`}</text>
                      <text fg={gainLossColor(lot.gainLoss)}>{formatSigned(lot.gainLoss)}</text>
                      <text fg={treatmentColor(lot.taxableTreatment)}>
                        {formatLabel(lot.taxableTreatment)}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={data.matchedLots.length > MAX_MATCHED_LOTS}>
                  <text fg={theme.textMuted}>
                    {`+${data.matchedLots.length - MAX_MATCHED_LOTS} more lots`}
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
