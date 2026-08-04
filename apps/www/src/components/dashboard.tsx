import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useRouteContext } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
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
  currentBalance: string | null
  unrealizedProfitLoss: string | null
  unrealizedProfitLossPercentage: string | null
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
  const portfolioQuery = useQuery({
    ...queries.portfolioAssets(taxmaxi, selectedSourceId),
    placeholderData: keepPreviousData,
  })
  const activeHoldings = portfolioQuery.data?.assets ?? []
  const isSwitchingPortfolio = portfolioQuery.isFetching && portfolioQuery.isPlaceholderData

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
      currentBalance: portfolioSummary?.totalValue == null ? null : portfolioSummary.totalValue,
      unrealizedProfitLoss:
        portfolioSummary?.profitLoss == null ? null : portfolioSummary.profitLoss,
      unrealizedProfitLossPercentage:
        portfolioSummary?.profitLossPercentage == null
          ? null
          : portfolioSummary.profitLossPercentage,
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
        contentClassName="border border-marketing-border text-marketing-foreground ring-0 [background:var(--app-content-background)] [box-shadow:var(--app-content-shadow)] supports-[backdrop-filter]:backdrop-blur-[48px]"
        onSelectedSourceIdChange={(sourceId) => onAccountScopeChange(sourceId ?? ALL_ACCOUNTS)}
        onSourceSync={onSourceSync}
        selectedSourceId={accountScope === ALL_ACCOUNTS ? undefined : accountScope}
        syncingSourceIds={syncingSourceIds}
        sources={accounts}
      >
        <div aria-busy={isSwitchingPortfolio} className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
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
                loading={portfolioQuery.isPending && portfolioQuery.data === undefined}
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
  const balance = summary.currentBalance === null ? "—" : formatCurrency(summary.currentBalance)
  const profitLoss =
    summary.unrealizedProfitLoss === null ? "—" : formatSignedCurrency(summary.unrealizedProfitLoss)
  const profitLossPercentage =
    summary.unrealizedProfitLossPercentage === null
      ? "—"
      : formatPercent(summary.unrealizedProfitLossPercentage)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <p className="text-3xl sm:text-5xl font-semibold tabular-nums tracking-normal">
          <SlidingValue value={balance} />
        </p>

        <div className="flex flex-col">
          <ValueTone
            tone={
              summary.unrealizedProfitLoss === null
                ? "neutral"
                : summary.unrealizedProfitLoss.startsWith("-")
                  ? "negative"
                  : "positive"
            }
          >
            <SlidingValue value={profitLoss} />
          </ValueTone>

          <ValueTone
            tone={
              summary.unrealizedProfitLossPercentage === null
                ? "neutral"
                : summary.unrealizedProfitLossPercentage.startsWith("-")
                  ? "negative"
                  : "positive"
            }
          >
            <SlidingValue value={profitLossPercentage} />
          </ValueTone>
        </div>
      </div>
    </div>
  )
}

function SlidingValue({ value }: { value: string }) {
  const reduceMotion = useReducedMotion()

  if (reduceMotion) {
    return <>{value}</>
  }

  return (
    <span className="relative inline-grid overflow-hidden align-bottom">
      <span className="invisible col-start-1 row-start-1" aria-hidden="true">
        {value}
      </span>
      <span className="sr-only">{value}</span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          aria-hidden="true"
          className="col-start-1 row-start-1"
          key={value}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: "-45%" }}
          initial={{ opacity: 0, y: "45%" }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
