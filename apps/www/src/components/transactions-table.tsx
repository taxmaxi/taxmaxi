import { ChevronLeft, ChevronRight, CircleAlert, Landmark, WalletCards } from "lucide-react"
import type { TransactionListItem } from "taxmaxi"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"

export const TRANSACTION_PAGE_SIZE = 7

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
})

const gainLossFormatter = (currency: string) =>
  new Intl.NumberFormat("en-GB", {
    currency,
    maximumFractionDigits: 2,
    style: "currency",
  })

const isDecimalString = (value: string): value is `${number}` =>
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)

const isZeroDecimal = (value: `${number}`): boolean => /^-?0(?:\.0+)?$/.test(value)

const typeLabel = (value: string | null): string => {
  if (value === null) return "Unclassified"
  const words = value.replaceAll("_", " ").replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const movementLabel = (transaction: TransactionListItem): string => {
  if (transaction.movements.length === 0) return "Accounting details pending"

  const visible = transaction.movements
    .slice(0, 2)
    .map((movement) => `${movement.amount} ${movement.assetSymbol}`)
    .join(" · ")
  const remaining = transaction.movements.length - 2
  return remaining > 0 ? `${visible} · +${remaining} more` : visible
}

const realizedGainLossLabel = (transaction: TransactionListItem): string => {
  if (transaction.calculationState === "partial") return "Pending"
  if (transaction.realizedGainLoss === null || transaction.fiatCurrency === null) {
    return "Not applicable"
  }

  const value = transaction.realizedGainLoss
  if (!isDecimalString(value)) return "Pending"

  const absoluteValue = value.startsWith("-") ? value.slice(1) : value
  if (!isDecimalString(absoluteValue)) return "Pending"

  const formatted = gainLossFormatter(transaction.fiatCurrency).format(absoluteValue)
  const sign = isZeroDecimal(value) ? "" : value.startsWith("-") ? "−" : "+"
  return `${sign}${formatted}`
}

export function TransactionsTable({
  error,
  hasNextPage,
  loading,
  onNextPage,
  onPreviousPage,
  onRetry,
  pageIndex,
  totalCount,
  transactions,
}: {
  readonly error: boolean
  readonly hasNextPage: boolean
  readonly loading: boolean
  readonly onNextPage: () => void
  readonly onPreviousPage: () => void
  readonly onRetry: () => void
  readonly pageIndex: number
  readonly totalCount: number
  readonly transactions: ReadonlyArray<TransactionListItem>
}) {
  const visibleStart = transactions.length === 0 ? 0 : pageIndex * TRANSACTION_PAGE_SIZE + 1
  const visibleEnd = Math.min(pageIndex * TRANSACTION_PAGE_SIZE + transactions.length, totalCount)
  const totalLabel = `${totalCount} ${totalCount === 1 ? "transaction" : "transactions"}`
  const pageLabel =
    error && totalCount === 0
      ? "Page unavailable"
      : `${visibleStart}–${visibleEnd} of ${totalCount}`

  return (
    <section aria-busy={loading} className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Transaction activity
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Transactions</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Imported accounting transactions from all connected sources.
          </p>
        </div>
        <Badge className="w-fit" variant="secondary">
          {totalLabel}
        </Badge>
      </header>

      <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
        {loading && transactions.length === 0 ? (
          <div
            className="flex min-h-48 items-center justify-center px-4 text-sm text-muted-foreground"
            role="status"
          >
            Loading transactions…
          </div>
        ) : error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center">
            <div>
              <p className="font-medium">Transactions could not be loaded.</p>
              <p className="mt-1 text-sm text-muted-foreground">Try the request again.</p>
            </div>
            <Button onClick={onRetry} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : transactions.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center px-4 text-sm text-muted-foreground">
            No transactions yet.
          </div>
        ) : (
          <div className="divide-y">
            {transactions.map((transaction) => (
              <article
                className="grid min-h-20 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 px-3 py-3.5 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(8rem,auto)] sm:px-4"
                key={transaction.transactionId}
              >
                <div>
                  <div className="text-sm font-medium tabular-nums">
                    {dateFormatter.format(new Date(transaction.timestamp))}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {timeFormatter.format(new Date(transaction.timestamp))}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge className="shrink-0" variant="outline">
                      {typeLabel(transaction.transactionType)}
                    </Badge>
                    <span className="truncate font-medium">
                      {transaction.description ?? typeLabel(transaction.transactionType)}
                    </span>
                    {transaction.needsReview ? (
                      <CircleAlert
                        aria-label="Needs review"
                        className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {movementLabel(transaction)}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {transaction.source.kind === "cex" ? (
                      <Landmark className="size-3.5 shrink-0" />
                    ) : (
                      <WalletCards className="size-3.5 shrink-0" />
                    )}
                    {transaction.source.name}
                  </p>
                  <p className="mt-2 text-sm font-semibold tabular-nums sm:hidden">
                    <span className="sr-only">Realized gain/loss: </span>
                    {realizedGainLossLabel(transaction)}
                  </p>
                </div>

                <div className="hidden text-right sm:block">
                  <p className="font-semibold tabular-nums">{realizedGainLossLabel(transaction)}</p>
                  <p className="text-xs text-muted-foreground">Realized gain/loss</p>
                </div>
              </article>
            ))}
          </div>
        )}

        {totalCount > 0 || pageIndex > 0 ? (
          <nav
            aria-label="Transaction pages"
            className="flex items-center justify-between gap-3 border-t bg-muted/20 px-3 py-3 sm:px-4"
          >
            <p className="text-xs tabular-nums text-muted-foreground">{pageLabel}</p>
            <div className="flex items-center gap-2">
              <Button
                aria-label="Previous page"
                disabled={loading || pageIndex === 0}
                onClick={onPreviousPage}
                size="sm"
                variant="outline"
              >
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button
                aria-label="Next page"
                disabled={loading || !hasNextPage}
                onClick={onNextPage}
                size="sm"
                variant="outline"
              >
                Next
                <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          </nav>
        ) : null}
      </div>
    </section>
  )
}
