// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TransactionDetail, TransactionListItem } from "taxmaxi"
import * as BigDecimal from "effect/BigDecimal"
import { TransactionSummary } from "#/components/transaction-summary"
import { transactionMovementFacts, transactionResults } from "#/lib/transaction-display"
import { setLocale } from "#/paraglide/runtime"

const TIME = "2025-03-01T00:00:00.000Z"
type Movement = TransactionDetail["movements"][number]
const capture: NonNullable<Movement["capture"]> = {
  runId: "run",
  eventId: "purchase",
  outcome: "included",
  quantity: "2",
  assetId: "asset",
  assetSymbol: "ETH",
  eventKind: "acquisition",
  cause: "purchase",
  valuationState: "selected",
  selectedValue: { kind: "observed_consideration", amount: "20", currency: "EUR" },
  providerConsiderations: [{ amount: "20", currency: "EUR" }],
  acquisitionCostBasis: null,
  realizedResults: [],
}
function movement(overrides: Partial<Movement> = {}): Movement {
  return {
    capture,
    imported: { timestamp: TIME, assetId: "asset", amount: "2", kind: "acquisition" },
    id: "movement",
    transactionId: "transaction",
    sourceId: "source",
    timestamp: TIME,
    assetId: "asset",
    amount: "2",
    kind: "acquisition",
    provenance: "rule",
    derivationRule: null,
    movementCorrectionTargetId: "target",
    sourceRawRecordId: null,
    sourceRepresentationUseId: null,
    providerAssetRowId: null,
    assetRepresentationId: null,
    originKind: "none",
    providerTransferId: null,
    sourceTransferId: null,
    feeForTransactionId: null,
    evidence: null,
    evidenceStatus: "unavailable",
    ...overrides,
  }
}
function detail(movements: ReadonlyArray<Movement>): TransactionDetail {
  return {
    attention: false,
    transactionId: "transaction",
    timestamp: TIME,
    source: { sourceId: "source", name: "Exchange", kind: "cex" },
    sourceRawRecordId: null,
    transactionType: "buy_fiat",
    providerTransactionType: null,
    description: null,
    externalId: null,
    classificationHistoryStatus: "unavailable",
    movements,
    sourceEvidence: [],
    reconciliations: [],
    movementOverrides: [],
    assetOverrides: [],
    calculation: {
      run: {
        id: "run",
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        status: "complete",
        engineVersion: "test",
        ruleSetVersion: "test",
        inputLedgerRevision: "1",
        valuationRevision: "1",
        failureCode: null,
      },
      state: "complete",
      monetaryStatus: "available",
      derivedLots: [],
      allocations: [],
      income: [],
      blockers: [],
      processedEventIds: [],
      correctionInputs: [],
    },
  }
}
function show(data: TransactionDetail, updating = false) {
  const onShowDetails = vi.fn()
  const props = {
    detail: data,
    updating,
    onShowDetails,
    viewFocusRef: createRef<HTMLButtonElement>(),
  }
  return { ...render(<TransactionSummary {...props} />), props, onShowDetails }
}
function fact(label: string, scope: HTMLElement = screen.getByRole("region", { name: "Summary" })) {
  const term = within(scope).getByText(label)
  return term.parentElement?.textContent
}
afterEach(cleanup)

describe("transaction summary", () => {
  it("keeps purchase consideration 20 and fee 1 separate, without inventing original acquisition basis", () => {
    const fee = movement({
      id: "fee",
      kind: "fee",
      amount: "0.01",
      capture: {
        ...capture,
        eventId: "fee",
        eventKind: "disposition",
        cause: "fee",
        quantity: "0.01",
        providerConsiderations: [{ amount: "1", currency: "EUR" }],
        selectedValue: { kind: "market_quote", amount: "1", currency: "EUR" },
      },
    })
    show(detail([movement(), fee]))
    expect(fact("Paid")).toContain("20.00")
    expect(fact("Fee paid", screen.getByRole("region", { name: "Fees" }))).toContain("1.00")
    expect(fact("Original acquisition cost basis")).toContain("Unavailable")
    expect(screen.queryByText(/21.00/)).toBeNull()
  })

  it("uses the row's captured proceeds 30 and gain 10 and retains them during updates", () => {
    const sale = movement({
      kind: "disposal",
      capture: {
        ...capture,
        eventKind: "disposition",
        cause: "sale",
        providerConsiderations: [{ amount: "30", currency: "EUR" }],
        selectedValue: null,
        realizedResults: [
          {
            acquisitionEventId: "purchase",
            quantity: "2",
            costBasis: "20",
            proceeds: "30",
            gainLoss: "10",
            currency: "EUR",
          },
        ],
      },
    })
    const row: TransactionListItem = {
      transactionId: "transaction",
      timestamp: TIME,
      source: { sourceId: "source", name: "Exchange", kind: "cex" },
      transactionType: "sell_fiat",
      description: null,
      externalId: null,
      movements: [
        {
          targetId: sale.movementCorrectionTargetId,
          kind: sale.kind,
          amount: sale.amount,
          assetSymbol: "ETH",
          capture: sale.capture,
        },
      ],
      income: null,
      realizedGainLoss: "10",
      fiatCurrency: "EUR",
      calculationState: "complete",
      needsReview: false,
      attention: false,
    }
    const view = show(detail([sale]))
    const rowMovement = row.movements[0]
    if (!rowMovement) throw new Error("Missing fixture movement")
    const rowProceeds = transactionMovementFacts(rowMovement).find(
      (value) => value.label === "Proceeds"
    )
    expect(fact("Proceeds")).toContain(rowProceeds?.amount)
    expect(fact("Realized gain/loss")).toContain(transactionResults(row)[0]?.amount)
    view.rerender(<TransactionSummary {...view.props} updating />)
    expect(screen.getByRole("status").textContent).toContain("last calculated values")
    expect(fact("Proceeds")).toContain("30.00")
    expect(fact("Realized gain/loss")).toContain("10.00")
  })

  it("labels fee gain separately and the combined gain explicitly", () => {
    const result = {
      acquisitionEventId: "purchase",
      quantity: "1",
      costBasis: "20",
      proceeds: "30",
      gainLoss: "10",
      currency: "EUR",
    }
    show(
      detail([
        movement({
          kind: "disposal",
          capture: {
            ...capture,
            cause: "sale",
            eventKind: "disposition",
            realizedResults: [result],
          },
        }),
        movement({
          id: "fee",
          kind: "fee",
          capture: {
            ...capture,
            cause: "fee",
            eventKind: "disposition",
            realizedResults: [{ ...result, costBasis: "2", proceeds: "1", gainLoss: "-1" }],
          },
        }),
      ])
    )
    expect(fact("Fee gain/loss", screen.getByRole("region", { name: "Fees" }))).toContain("1.00")
    expect(fact("Total gain/loss (including fees)")).toContain("9.00")
  })

  it.each(["en", "de"] as const)(
    "keeps producer-serialized tiny and zero values visible in %s",
    async (locale) => {
      await setLocale(locale, { reload: false })
      try {
        const tiny = BigDecimal.format(BigDecimal.make(1n, 20))
        show(
          detail([
            movement({
              capture: {
                ...capture,
                selectedValue: { kind: "market_quote", amount: tiny, currency: "EUR" },
                providerConsiderations: [{ amount: "0", currency: "EUR" }],
              },
            }),
          ])
        )
        expect(screen.getByText(/\+<.*0[.,]01/)).toBeTruthy()
        expect(screen.getByText(/^(€0\.00|0,00\s*€)$/)).toBeTruthy()
      } finally {
        await setLocale("en", { reload: false })
      }
    }
  )

  it("offers evidence and classification context for absent inputs without inventing an editor", () => {
    const view = show(
      detail([
        movement({ capture: null }),
        movement({
          id: "unknown",
          capture: {
            ...capture,
            cause: "unknown",
            valuationState: "missing",
            selectedValue: null,
            providerConsiderations: [],
          },
        }),
      ])
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: "Check evidence for missing value" })[0] ??
        screen.getByRole("button", { name: "View evidence" })
    )
    expect(view.onShowDetails).toHaveBeenLastCalledWith("evidence")
    fireEvent.click(screen.getByRole("button", { name: "Check missing classification" }))
    expect(view.onShowDetails).toHaveBeenLastCalledWith("classification")
    expect(screen.getByText(/asset unavailable/)).toBeTruthy()
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})
