// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TransactionListItem } from "taxmaxi"

import { TransactionsTable } from "#/components/transactions-table"

const transaction: TransactionListItem = {
  transactionId: "00000000-0000-4000-8000-000000000101",
  timestamp: "2025-03-10T12:00:00.000Z",
  source: {
    sourceId: "00000000-0000-4000-8000-000000000201",
    name: "Coinbase",
    kind: "cex",
  },
  transactionType: "sell_fiat",
  description: "Sold Bitcoin",
  externalId: "coinbase-sale-1",
  movements: [{ amount: "0.4", assetSymbol: "BTC", kind: "disposal" }],
  realizedGainLoss: "2000",
  fiatCurrency: "EUR",
  calculationState: "complete",
  needsReview: false,
}

const defaultProps = {
  error: false,
  hasNextPage: false,
  loading: false,
  onNextPage: vi.fn(),
  onPreviousPage: vi.fn(),
  onRetry: vi.fn(),
  pageIndex: 0,
  totalCount: 1,
  transactions: [transaction],
}

describe("TransactionsTable", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("renders real compact rows and the exact total", () => {
    render(<TransactionsTable {...defaultProps} />)

    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
    expect(screen.getByText("0.4 BTC")).toBeTruthy()
    expect(screen.getByText("Coinbase")).toBeTruthy()
    expect(screen.getByText("1 transaction")).toBeTruthy()
    expect(screen.getByText("1–1 of 1")).toBeTruthy()
  })

  it("shows incomplete valuation as pending without hiding the transaction row", () => {
    render(
      <TransactionsTable
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            calculationState: "partial",
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )

    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
    expect(screen.getAllByText("Pending")).toHaveLength(2)
  })

  it("does not label a complete transaction with no gain or loss as pending", () => {
    render(
      <TransactionsTable
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )

    expect(screen.getAllByText("Not applicable")).toHaveLength(2)
  })

  it("shows gain and calculation state in the compact mobile row", () => {
    const { rerender } = render(<TransactionsTable {...defaultProps} />)

    const mobileGain = screen
      .getAllByText("+€2,000.00")
      .find((element) => element.className.includes("sm:hidden"))
    expect(mobileGain).toBeDefined()

    rerender(
      <TransactionsTable
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            calculationState: "partial",
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )
    const mobilePending = screen
      .getAllByText("Pending")
      .find((element) => element.className.includes("sm:hidden"))
    expect(mobilePending).toBeDefined()
  })

  it("formats gains beyond Number.MAX_SAFE_INTEGER without losing precision", () => {
    render(
      <TransactionsTable
        {...defaultProps}
        transactions={[{ ...transaction, realizedGainLoss: "9007199254740993" }]}
      />
    )

    expect(screen.getAllByText("+€9,007,199,254,740,993.00")).toHaveLength(2)
  })

  it("formats large fractional losses from the exact decimal string", () => {
    render(
      <TransactionsTable
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            realizedGainLoss: "-1234567890123456789012345678.87654321",
          },
        ]}
      />
    )

    expect(screen.getAllByText("−€1,234,567,890,123,456,789,012,345,678.88")).toHaveLength(2)
  })

  it("shows loading, empty, and error states", () => {
    const { rerender } = render(<TransactionsTable {...defaultProps} loading transactions={[]} />)
    expect(screen.getByRole("status").textContent).toContain("Loading transactions")

    rerender(<TransactionsTable {...defaultProps} totalCount={0} transactions={[]} />)
    expect(screen.getByText("No transactions yet.")).toBeTruthy()

    rerender(<TransactionsTable {...defaultProps} error transactions={[]} />)
    expect(screen.getByText("Transactions could not be loaded.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(defaultProps.onRetry).toHaveBeenCalledOnce()
  })

  it("exposes previous and next cursor controls", () => {
    const { rerender } = render(<TransactionsTable {...defaultProps} hasNextPage totalCount={8} />)
    const previous = screen.getByRole("button", { name: "Previous page" })
    const next = screen.getByRole("button", { name: "Next page" })
    expect(previous.hasAttribute("disabled")).toBe(true)
    expect(next.hasAttribute("disabled")).toBe(false)

    fireEvent.click(next)
    expect(defaultProps.onNextPage).toHaveBeenCalledOnce()

    rerender(<TransactionsTable {...defaultProps} pageIndex={1} totalCount={8} transactions={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })

  it("can return to the previous page when a later page fails", () => {
    render(
      <TransactionsTable {...defaultProps} error pageIndex={1} totalCount={0} transactions={[]} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })
})
