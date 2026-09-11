import type { RefObject } from "react"
import type { TransactionDetail } from "taxmaxi"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import { Button } from "#/components/ui/button"
import {
  formatTransactionAmount,
  transactionMovementCause,
  transactionMovementFacts,
  transactionMovementLabel,
} from "#/lib/transaction-display"
import { m } from "#/paraglide/messages"

export type TransactionDetailView = "evidence" | "tax" | "classification"

/** Concise completed-run facts; current work never replaces a known amount with a spinner. */
export function TransactionSummary({
  detail,
  updating,
  onShowDetails,
  viewFocusRef,
}: {
  detail: TransactionDetail
  updating: boolean
  onShowDetails: (view: TransactionDetailView) => void
  viewFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const principal = detail.movements.filter((movement) => movement.kind !== "fee")
  const fees = detail.movements.filter((movement) => movement.kind === "fee")
  const gains = detail.movements.flatMap((movement) => movement.capture?.realizedResults ?? [])
  const gainCurrencies = [...new Set(gains.map((result) => result.currency))]
  const income = detail.calculation.income
  const incomeValue = sum(income.map((result) => result.value))
  const currency = detail.calculation.run?.reportingCurrency ?? null
  const hasFeeGain = fees.some((movement) => (movement.capture?.realizedResults.length ?? 0) > 0)
  return (
    <section aria-label={m["app.inspector.summary.title"]()} className="flex flex-col gap-4">
      <h3 className="font-semibold">{m["app.inspector.summary.title"]()}</h3>
      {updating && (
        <p role="status" className="text-sm text-muted-foreground">
          {m["app.inspector.summary.updating"]()}
        </p>
      )}
      {principal.length === 0 && (
        <p className="text-sm text-muted-foreground">{m["app.inspector.summary.noMovements"]()}</p>
      )}
      {principal.map((movement) => (
        <MovementSummary key={movement.id} movement={movement} onShowDetails={onShowDetails} />
      ))}
      {fees.length > 0 && (
        <section
          aria-label={m["app.inspector.summary.fees"]()}
          className="flex flex-col gap-3 border-t pt-3"
        >
          <h4 className="text-sm font-medium">{m["app.inspector.summary.fees"]()}</h4>
          {fees.map((movement) => (
            <MovementSummary key={movement.id} movement={movement} onShowDetails={onShowDetails} />
          ))}
        </section>
      )}
      {(income.length > 0 || principal.some((movement) => movement.kind === "income")) && (
        <Fact
          label={m["app.dashboard.transactions.income"]()}
          amount={
            incomeValue === null && detail.calculation.state === "partial"
              ? m["app.dashboard.transactions.gainLossPending"]()
              : formatTransactionAmount({ value: incomeValue, currency })
          }
        />
      )}
      {gainCurrencies.map((gainCurrency) => (
        <Fact
          key={gainCurrency}
          label={
            hasFeeGain
              ? m["app.dashboard.transactions.totalGainLoss"]()
              : m["app.dashboard.transactions.realizedGainLoss"]()
          }
          amount={formatTransactionAmount({
            value: sum(
              gains
                .filter((result) => result.currency === gainCurrency)
                .map((result) => result.gainLoss)
            ),
            currency: gainCurrency,
          })}
        />
      ))}
      {gainCurrencies.length === 0 &&
        detail.movements.some(
          (movement) =>
            movement.kind === "fee" ||
            (movement.kind === "disposal" && detail.transactionType !== "internal_transfer")
        ) && (
          <Fact
            label={m["app.dashboard.transactions.realizedGainLoss"]()}
            amount={
              detail.calculation.state === "partial"
                ? m["app.dashboard.transactions.gainLossPending"]()
                : m["app.dashboard.transactions.valueUnavailable"]()
            }
          />
        )}
      {detail.attention && (
        <p role="status" className="text-sm text-muted-foreground">
          {m["app.inspector.summary.review"]()}
        </p>
      )}
      <nav aria-label={m["app.inspector.summary.details"]()} className="flex flex-col gap-2">
        <Button
          ref={viewFocusRef}
          variant="outline"
          className="min-h-11"
          onClick={() => onShowDetails("evidence")}
        >
          {m["app.inspector.summary.evidence"]()}
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => onShowDetails("tax")}>
          {m["app.inspector.summary.tax"]()}
        </Button>
        <Button
          variant="outline"
          className="min-h-11 whitespace-normal"
          onClick={() => onShowDetails("classification")}
        >
          {m["app.inspector.summary.classification"]()}
        </Button>
      </nav>
    </section>
  )
}

function MovementSummary({
  movement,
  onShowDetails,
}: {
  movement: TransactionDetail["movements"][number]
  onShowDetails: (view: TransactionDetailView) => void
}) {
  const capture = movement.capture
  const display = {
    targetId: movement.movementCorrectionTargetId,
    kind: movement.kind,
    amount: movement.amount,
    assetSymbol: capture?.assetSymbol ?? m["app.inspector.summary.unknownAsset"](),
    capture,
  }
  const cause = transactionMovementCause(display)
  const missingValue =
    capture === null ||
    capture.valuationState === "missing" ||
    capture.valuationState === "ambiguous"
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <h4 className="break-words font-medium tabular-nums">{transactionMovementLabel(display)}</h4>
      {cause && <p className="text-muted-foreground">{cause}</p>}
      {capture?.outcome === "withheld" && (
        <p className="text-muted-foreground">{m["app.inspector.state.withheld"]()}</p>
      )}
      {capture?.outcome === "outside_period" && (
        <p className="text-muted-foreground">{m["app.inspector.state.outside_period"]()}</p>
      )}
      {capture?.outcome === "absent" && (
        <p className="text-muted-foreground">{m["app.inspector.state.absent"]()}</p>
      )}
      {transactionMovementFacts(display).map((fact, index) => (
        <Fact key={`${fact.label}:${index}`} {...fact} />
      ))}
      {capture?.eventKind === "acquisition" && (
        <Fact
          label={m["app.inspector.summary.originalBasis"]()}
          amount={m["app.dashboard.transactions.valueUnavailable"]()}
        />
      )}
      {missingValue && (
        <Button
          variant="ghost"
          className="min-h-11 justify-start whitespace-normal text-left"
          onClick={() => onShowDetails("evidence")}
        >
          {m["app.inspector.summary.missingValue"]()}
        </Button>
      )}
      {capture?.cause === "unknown" && (
        <Button
          variant="ghost"
          className="min-h-11 justify-start whitespace-normal text-left"
          onClick={() => onShowDetails("classification")}
        >
          {m["app.inspector.summary.missingCategory"]()}
        </Button>
      )}
    </article>
  )
}

function Fact({ label, amount }: { label: string; amount: string }) {
  return (
    <dl className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-medium tabular-nums">{amount}</dd>
    </dl>
  )
}

function sum(values: ReadonlyArray<string | null>): string | null {
  if (values.length === 0) return null
  let total = BigDecimal.make(0n, 0)
  for (const value of values) {
    if (value === null) return null
    const parsed = BigDecimal.fromString(value)
    if (Option.isNone(parsed)) return null
    total = BigDecimal.sum(total, parsed.value)
  }
  return BigDecimal.format(total)
}
