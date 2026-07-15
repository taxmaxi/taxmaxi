import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouteContext } from "@tanstack/react-router"
import {
  isTaxMaxiUnauthorizedError,
  type SourceSyncJob,
  type SourceSyncJobInput,
  type SourceSyncStart,
} from "taxmaxi"

import { AssetsTable } from "#/components/assets-table"
import { SourceCards } from "#/components/source-cards"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { ValueTone } from "#/components/value-tone"
import { useSourceSyncs } from "#/hooks/use-source-syncs"

import { accounts as mockAccounts, taxYearAccountSummaries } from "#/fixtures/dashboard-data"
import { formatCurrency, formatPercent, formatSignedCurrency } from "#/lib/dashboard-format"
import {
  ALL_ACCOUNTS,
  type Account,
  type AccountId,
  type AccountScope,
  type TaxYear,
} from "#/lib/dashboard-types"
import { queries } from "#/integrations/taxmaxi/queries"
import { TransactionsTable } from "./transactions-table"
import { SourceSyncIsland } from "./source-sync-island"

type DashboardSummary = {
  currentBalance: number | null
  unrealizedProfitLoss: number | null
  unrealizedProfitLossPercentage: number | null
  realizedProfitLoss: number
  taxesPayable: number
  taxesReceivable: number
  taxableEvents: number
  missingClassifications: number
  importedTransactions: number
  unresolvedItems: number
}

export function Dashboard({
  accounts = mockAccounts,
  getSourceSyncJob,
  onSourceSyncCompleted,
  onUnauthorized,
  startSourceSync,
}: {
  accounts?: ReadonlyArray<Account>
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  onSourceSyncCompleted?: (sourceId: AccountId) => void | Promise<void>
  onUnauthorized?: () => void | Promise<void>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
}) {
  const taxmaxi = useRouteContext({
    from: "/app",
    select: (context) => context.taxmaxi(),
  })

  const [accountScope, setAccountScope] = useState<AccountScope>(ALL_ACCOUNTS)
  const [taxYear] = useState<TaxYear>(2025)

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )

  const activeAccounts = useMemo(
    () =>
      accountScope === ALL_ACCOUNTS
        ? accounts
        : accounts.filter((account) => account.id === accountScope),
    [accountScope, accounts]
  )

  const activeAccountIds = useMemo(
    () => new Set(activeAccounts.map((account) => account.id)),
    [activeAccounts]
  )

  const selectedSourceId = accountScope === ALL_ACCOUNTS ? undefined : accountScope
  const portfolioQuery = useQuery(queries.portfolioAssets(taxmaxi, selectedSourceId))
  const activeHoldings = portfolioQuery.data?.assets ?? []

  useEffect(() => {
    if (isTaxMaxiUnauthorizedError(portfolioQuery.error)) {
      void onUnauthorized?.()
    }
  }, [onUnauthorized, portfolioQuery.error])

  const summary = useMemo<DashboardSummary>(() => {
    const taxSummaries = taxYearAccountSummaries.filter(
      (yearSummary) =>
        yearSummary.taxYear === taxYear && activeAccountIds.has(yearSummary.accountId)
    )

    const portfolioSummary = portfolioQuery.data?.summary

    return {
      currentBalance:
        portfolioSummary?.totalValue == null ? null : Number(portfolioSummary.totalValue),
      unrealizedProfitLoss:
        portfolioSummary?.profitLoss == null ? null : Number(portfolioSummary.profitLoss),
      unrealizedProfitLossPercentage:
        portfolioSummary?.profitLossPercentage == null
          ? null
          : Number(portfolioSummary.profitLossPercentage),
      realizedProfitLoss: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.realizedProfitLoss,
        0
      ),
      taxesPayable: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxesPayable,
        0
      ),
      taxesReceivable: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxesReceivable,
        0
      ),
      taxableEvents: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxableEvents,
        0
      ),
      missingClassifications: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.missingClassifications,
        0
      ),
      importedTransactions: activeAccounts.reduce(
        (total, account) => total + account.importedTransactions,
        0
      ),
      unresolvedItems: activeAccounts.reduce(
        (total, account) => total + account.unresolvedItems,
        0
      ),
    }
  }, [activeAccountIds, activeAccounts, portfolioQuery.data?.summary, taxYear])

  const onAccountScopeChange = (scope: AccountScope) => {
    setAccountScope(scope)
  }

  const { activeSyncs, onDismissSync, onRetrySync, onSourceSync, syncingSourceIds } =
    useSourceSyncs({
      accountsById,
      getSourceSyncJob,
      onCompleted: onSourceSyncCompleted,
      onUnauthorized,
      startSourceSync,
    })

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <SourceSyncIsland items={activeSyncs} onDismiss={onDismissSync} onRetry={onRetrySync} />
      <SourceCards
        contentClassName="border border-marketing-border bg-[linear-gradient(180deg,rgba(17,28,23,0.78),rgba(9,15,12,0.62))] text-marketing-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_24px_70px_rgba(0,0,0,0.26)] ring-0 supports-[backdrop-filter]:backdrop-blur-[48px] [--accent:rgb(255_255_255_/_0.1)] [--accent-foreground:var(--marketing-foreground)] [--border:var(--marketing-border-muted)] [--card:rgb(255_255_255_/_0.06)] [--card-foreground:var(--marketing-foreground)] [--foreground:var(--marketing-foreground)] [--input:rgb(255_255_255_/_0.12)] [--muted:rgb(255_255_255_/_0.08)] [--muted-foreground:var(--marketing-muted)] [--popover:rgb(17_28_23_/_0.95)] [--popover-foreground:var(--marketing-foreground)]"
        onSelectedSourceIdChange={(sourceId) => onAccountScopeChange(sourceId ?? ALL_ACCOUNTS)}
        onSourceSync={onSourceSync}
        selectedSourceId={accountScope === ALL_ACCOUNTS ? undefined : accountScope}
        syncingSourceIds={syncingSourceIds}
        sources={accounts}
      >
        <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
          <PortfolioOverview summary={summary} />

          <Tabs defaultValue="assets" className="gap-y-8">
            <TabsList>
              <TabsTrigger value="assets">Assets</TabsTrigger>
              <TabsTrigger value="transactions">Transactions</TabsTrigger>
              <TabsTrigger value="taxes">Taxes</TabsTrigger>
            </TabsList>
            <TabsContent value="assets">
              <AssetsTable
                currency={portfolioQuery.data?.currency ?? "EUR"}
                error={portfolioQuery.isError}
                holdings={activeHoldings}
                loading={portfolioQuery.isPending}
              />
            </TabsContent>
            <TabsContent value="transactions">
              <TransactionsTable />
            </TabsContent>
            <TabsContent value="taxes"></TabsContent>
          </Tabs>
        </div>
      </SourceCards>
    </div>
  )
}

function PortfolioOverview({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <p className="text-3xl sm:text-5xl font-semibold tabular-nums tracking-normal">
          {summary.currentBalance === null ? "—" : formatCurrency(summary.currentBalance)}
        </p>

        <div className="flex flex-col">
          {summary.unrealizedProfitLoss === null ? (
            <ValueTone tone="neutral">—</ValueTone>
          ) : (
            <ValueTone tone={summary.unrealizedProfitLoss >= 0 ? "positive" : "negative"}>
              {formatSignedCurrency(summary.unrealizedProfitLoss)}
            </ValueTone>
          )}

          {summary.unrealizedProfitLossPercentage === null ? (
            <ValueTone tone="neutral">—</ValueTone>
          ) : (
            <ValueTone tone={summary.unrealizedProfitLossPercentage >= 0 ? "positive" : "negative"}>
              {formatPercent(summary.unrealizedProfitLossPercentage)}
            </ValueTone>
          )}
        </div>
      </div>
    </div>
  )
}
