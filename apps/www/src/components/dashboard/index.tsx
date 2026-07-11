import type * as React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { SourceSyncJob, SourceSyncStart } from "taxmaxi"

import { SourceCards } from "#/components/source-cards"
import { Badge } from "#/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { Card, CardContent } from "#/components/ui/card"
import { cn } from "#/lib/utils"

import { accounts as mockAccounts, assetHoldings, taxYearAccountSummaries } from "./data"
import { formatCurrency, formatPercent, formatSignedCurrency, formatTokenAmount } from "./format"
import {
  ALL_ACCOUNTS,
  type Account,
  type AccountId,
  type AccountScope,
  type TaxYear,
} from "./types"
import { TransactionsTable } from "../transactions-table"
import {
  SourceSyncIsland,
  getSourceSyncDisplayProgress,
  type SourceSyncIslandItem,
  type SourceSyncStatus,
} from "./source-sync-island"

type AggregatedHolding = {
  asset: string
  name: string
  amount: number
  value: number
  costBasis: number
  accountIds: ReadonlyArray<AccountId>
}

type DashboardSummary = {
  currentBalance: number
  currentCostBasis: number
  unrealizedProfitLoss: number
  realizedProfitLoss: number
  taxesPayable: number
  taxesReceivable: number
  taxableEvents: number
  missingClassifications: number
  importedTransactions: number
  unresolvedItems: number
}

type SourceSyncJobInput = {
  sourceId: string
  jobId: string
}

type ActiveSourceSync = SourceSyncIslandItem & {
  sourceId: AccountId
  jobId?: string
}

const SOURCE_SYNC_POLL_INTERVAL_MS = 500

export function Dashboard({
  accounts = mockAccounts,
  getSourceSyncJob,
  startSourceSync,
}: {
  accounts?: ReadonlyArray<Account>
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
}) {
  const [accountScope, setAccountScope] = useState<AccountScope>(ALL_ACCOUNTS)
  const [activeSyncs, setActiveSyncs] = useState<ReadonlyArray<ActiveSourceSync>>([])
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
    [accountScope]
  )

  const activeAccountIds = useMemo(
    () => new Set(activeAccounts.map((account) => account.id)),
    [activeAccounts]
  )

  const activeHoldings = useMemo(
    () =>
      assetHoldings
        .map((holding) => {
          const activeLots = holding.lots.filter((lot) => activeAccountIds.has(lot.accountId))
          const accountIds = activeLots.map((lot) => lot.accountId)

          return {
            asset: holding.asset,
            name: holding.name,
            amount: activeLots.reduce((total, lot) => total + lot.amount, 0),
            value: activeLots.reduce((total, lot) => total + lot.value, 0),
            costBasis: activeLots.reduce((total, lot) => total + lot.costBasis, 0),
            accountIds,
          }
        })
        .filter((holding) => holding.accountIds.length > 0)
        .sort((left, right) => right.value - left.value),
    [activeAccountIds]
  )

  const summary = useMemo<DashboardSummary>(() => {
    const taxSummaries = taxYearAccountSummaries.filter(
      (yearSummary) =>
        yearSummary.taxYear === taxYear && activeAccountIds.has(yearSummary.accountId)
    )

    const currentBalance = activeHoldings.reduce((total, holding) => total + holding.value, 0)
    const currentCostBasis = activeHoldings.reduce((total, holding) => total + holding.costBasis, 0)

    return {
      currentBalance,
      currentCostBasis,
      unrealizedProfitLoss: currentBalance - currentCostBasis,
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
  }, [activeAccountIds, activeAccounts, activeHoldings, taxYear])

  const onAccountScopeChange = (scope: AccountScope) => {
    setAccountScope(scope)
  }

  const syncingSourceIds = useMemo(
    () =>
      new Set(
        activeSyncs
          .filter((sync) => sync.status === "queued" || sync.status === "running")
          .map((sync) => sync.sourceId)
      ),
    [activeSyncs]
  )

  const onSourceSync = useCallback(
    (source: Account) => {
      if (!startSourceSync || syncingSourceIds.has(source.id)) {
        return
      }

      setActiveSyncs((syncs) => upsertSourceSync(syncs, makePendingSourceSync(source)))

      startSourceSync(source.id).then(
        (started) => {
          setActiveSyncs((syncs) =>
            upsertSourceSync(syncs, {
              id: source.id,
              jobId: started.jobId,
              progress: getProgressForStatus(started.status),
              sourceId: source.id,
              sourceName: source.name,
              status: started.status,
              ...(started.message === null ? {} : { message: started.message }),
            })
          )
        },
        (error: unknown) => {
          setActiveSyncs((syncs) =>
            upsertSourceSync(syncs, {
              id: source.id,
              progress: 100,
              sourceId: source.id,
              sourceName: source.name,
              status: "failed",
              message: getErrorMessage(error),
            })
          )
        }
      )
    },
    [startSourceSync, syncingSourceIds]
  )

  useEffect(() => {
    if (!getSourceSyncJob) {
      return
    }

    const pollableSyncs = activeSyncs.filter(
      (sync) => sync.jobId !== undefined && (sync.status === "queued" || sync.status === "running")
    )

    if (pollableSyncs.length === 0) {
      return
    }

    const intervalId = window.setInterval(() => {
      for (const sync of pollableSyncs) {
        if (sync.jobId === undefined) {
          continue
        }

        void getSourceSyncJob({ sourceId: sync.sourceId, jobId: sync.jobId }).then(
          (job) =>
            setActiveSyncs((syncs) => upsertSourceSync(syncs, toActiveSourceSync(job, sync))),
          () => undefined
        )
      }
    }, SOURCE_SYNC_POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [activeSyncs, getSourceSyncJob])

  useEffect(() => {
    const terminalSyncs = activeSyncs.filter((sync) => sync.status === "completed")

    if (terminalSyncs.length === 0) {
      return
    }

    const timeoutIds = terminalSyncs.map((sync) =>
      window.setTimeout(() => {
        setActiveSyncs((syncs) => syncs.filter((candidate) => candidate.id !== sync.id))
      }, 2800)
    )

    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [activeSyncs])

  const onDismissSync = useCallback((item: SourceSyncIslandItem) => {
    setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
  }, [])

  const onRetrySync = useCallback(
    (item: SourceSyncIslandItem) => {
      const source = accountsById.get(item.id)

      if (!source) {
        return
      }

      setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
      onSourceSync(source)
    },
    [accountsById, onSourceSync]
  )

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
              <AssetsPanel accountsById={accountsById} holdings={activeHoldings} />
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

function makePendingSourceSync(source: Account): ActiveSourceSync {
  return {
    id: source.id,
    progress: 0,
    sourceId: source.id,
    sourceName: source.name,
    status: "queued",
  }
}

function toActiveSourceSync(job: SourceSyncJob, current: ActiveSourceSync): ActiveSourceSync {
  return {
    ...current,
    id: job.sourceId,
    jobId: job.jobId,
    progress: getSourceSyncDisplayProgress({
      phase: job.phase,
      progressPercent: job.progressPercent,
      status: job.status,
    }),
    sourceId: job.sourceId,
    status: job.status,
    ...(job.phase === null ? {} : { phase: job.phase }),
    ...(job.processedRecords === null ? {} : { processedRecords: job.processedRecords }),
    ...(job.totalRecords === null ? {} : { totalRecords: job.totalRecords }),
    ...(job.importedRecords === null ? {} : { importedRecords: job.importedRecords }),
    ...(job.normalizedRecords === null ? {} : { normalizedRecords: job.normalizedRecords }),
    ...(job.failedRecords === null ? {} : { failedRecords: job.failedRecords }),
    ...(job.message === null ? {} : { message: job.message }),
  }
}

function upsertSourceSync(
  syncs: ReadonlyArray<ActiveSourceSync>,
  nextSync: ActiveSourceSync
): ReadonlyArray<ActiveSourceSync> {
  const found = syncs.some((sync) => sync.id === nextSync.id)

  if (!found) {
    return [nextSync, ...syncs]
  }

  return syncs.map((sync) => (sync.id === nextSync.id ? nextSync : sync))
}

function getProgressForStatus(status: SourceSyncStatus): number {
  switch (status) {
    case "queued":
      return 0
    case "running":
      return 0
    case "completed":
      return 100
    case "failed":
      return 100
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to start sync."
}

function PortfolioOverview({ summary }: { summary: DashboardSummary }) {
  const unrealizedPercent =
    summary.currentCostBasis === 0
      ? 0
      : (summary.unrealizedProfitLoss / summary.currentCostBasis) * 100

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <p className="text-3xl sm:text-5xl font-semibold tabular-nums tracking-normal">
          {formatCurrency(summary.currentBalance)}
        </p>

        <div className="flex flex-col">
          <ValueTone tone={summary.unrealizedProfitLoss >= 0 ? "positive" : "negative"}>
            {formatSignedCurrency(summary.unrealizedProfitLoss)}
          </ValueTone>

          <ValueTone tone={unrealizedPercent >= 0 ? "positive" : "negative"}>
            {formatPercent(unrealizedPercent)}
          </ValueTone>
        </div>
      </div>
    </div>
  )
}

function AssetsPanel({
  accountsById,
  holdings,
}: {
  accountsById: ReadonlyMap<AccountId, Account>
  holdings: ReadonlyArray<AggregatedHolding>
}) {
  return (
    <Card
      className="rounded-lg border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-1 ring-marketing-border-muted supports-[backdrop-filter]:backdrop-blur-md"
      size="sm"
    >
      <CardContent className="pt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <TableHead>Asset</TableHead>
                <TableHead align="right">Amount</TableHead>
                <TableHead align="right">Value</TableHead>
                <TableHead align="right">Cost basis</TableHead>
                <TableHead align="right">Unrealized P/L</TableHead>
                <TableHead>Accounts</TableHead>
              </tr>
            </thead>
            <tbody>
              {holdings.map((holding) => (
                <AssetRow accountsById={accountsById} holding={holding} key={holding.asset} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function AssetRow({
  accountsById,
  holding,
}: {
  accountsById: ReadonlyMap<AccountId, Account>
  holding: AggregatedHolding
}) {
  const unrealizedProfitLoss = holding.value - holding.costBasis

  return (
    <tr className="h-14 border-b border-border">
      <TableCell>
        <div className="flex items-center gap-3">
          <AssetMark asset={holding.asset} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{holding.asset}</span>
            <span className="block truncate text-xs text-muted-foreground">{holding.name}</span>
          </span>
        </div>
      </TableCell>
      <TableCell align="right">{formatTokenAmount(holding.amount)}</TableCell>
      <TableCell align="right">{formatCurrency(holding.value)}</TableCell>
      <TableCell align="right">{formatCurrency(holding.costBasis)}</TableCell>
      <TableCell align="right">
        <ValueTone tone={unrealizedProfitLoss >= 0 ? "positive" : "negative"}>
          {formatSignedCurrency(unrealizedProfitLoss)}
        </ValueTone>
      </TableCell>
      <TableCell>
        <AccountList accountsById={accountsById} accountIds={holding.accountIds} />
      </TableCell>
    </tr>
  )
}

function TableHead({
  align = "left",
  children,
}: {
  align?: "left" | "right"
  children: React.ReactNode
}) {
  return (
    <th
      className={cn(
        "h-9 border-b border-border px-3 font-medium first:pl-0 last:pr-0",
        align === "right" && "text-right"
      )}
      scope="col"
    >
      {children}
    </th>
  )
}

function TableCell({
  align = "left",
  children,
}: {
  align?: "left" | "right"
  children: React.ReactNode
}) {
  return (
    <td
      className={cn(
        "border-b border-border/70 px-3 py-3 align-middle tabular-nums first:pl-0 last:pr-0",
        align === "right" && "text-right"
      )}
    >
      {children}
    </td>
  )
}

function AccountList({
  accountsById,
  accountIds,
}: {
  accountsById: ReadonlyMap<AccountId, Account>
  accountIds: ReadonlyArray<AccountId>
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {accountIds.map((accountId) => {
        const account = accountsById.get(accountId)
        return (
          <Badge key={accountId} variant="outline">
            {account ? account.name : accountId}
          </Badge>
        )
      })}
    </div>
  )
}

function AssetMark({ asset }: { asset: string }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-medium ring-1 ring-border">
      {asset.slice(0, 1)}
    </span>
  )
}

type ValueToneName = "neutral" | "positive" | "negative" | "warning"

function ValueTone({ children, tone }: { children: React.ReactNode; tone: ValueToneName }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        tone === "positive" && "text-emerald-700 dark:text-emerald-300",
        tone === "negative" && "text-red-700 dark:text-red-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300"
      )}
    >
      {children}
    </span>
  )
}
