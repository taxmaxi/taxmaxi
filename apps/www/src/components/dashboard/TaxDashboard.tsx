import type * as React from "react"
import {
  AlertTriangle,
  ArrowDownToLine,
  CalendarDays,
  CheckCircle2,
  ChevronsUpDown,
  CircleDollarSign,
  Download,
  FileText,
  Landmark,
  RefreshCw,
  Search,
  WalletCards,
} from "lucide-react"
import { useMemo, useState } from "react"

import { ContentContainer } from "#/components/content-container"
import { Logo } from "#/components/logo"
import { SourceCards } from "#/components/source-cards"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "#/components/ui/command"
import CoinbaseLogo from "#/components/ui/logos/coinbase-icon"
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover"
import { cn } from "#/lib/utils"

import { accounts, assetHoldings, taxYearAccountSummaries, taxYears, transactions } from "./data"
import {
  formatCurrency,
  formatInteger,
  formatPercent,
  formatSignedCurrency,
  formatTokenAmount,
} from "./format"
import {
  ALL_ACCOUNTS,
  type Account,
  type AccountId,
  type AccountScope,
  type TaxYear,
  type TransactionMode,
} from "./types"

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

export function TaxDashboard() {
  const [accountScope, setAccountScope] = useState<AccountScope>(ALL_ACCOUNTS)
  const [taxYear, setTaxYear] = useState<TaxYear>(2025)
  const [transactionMode, setTransactionMode] = useState<TransactionMode>("tax")
  const [accountPickerOpen, setAccountPickerOpen] = useState(false)
  const [taxYearPickerOpen, setTaxYearPickerOpen] = useState(false)

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

  const filteredTransactions = useMemo(
    () =>
      transactions
        .filter((transaction) => activeAccountIds.has(transaction.accountId))
        .filter((transaction) => transaction.taxYear === taxYear)
        .filter((transaction) => (transactionMode === "tax" ? transaction.taxRelevant : true))
        .sort((left, right) => right.date.localeCompare(left.date)),
    [activeAccountIds, taxYear, transactionMode]
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

  const selectedAccount =
    accountScope === ALL_ACCOUNTS
      ? undefined
      : accounts.find((account) => account.id === accountScope)

  const accountLabel = selectedAccount ? selectedAccount.name : "All accounts"

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ContentContainer width="2xl" className="flex min-h-screen flex-col gap-5 py-4 sm:py-5">
        <DashboardHeader
          accountLabel={accountLabel}
          importedTransactions={summary.importedTransactions}
          taxYear={taxYear}
        />

        <AccountScopeSection
          accountLabel={accountLabel}
          accountPickerOpen={accountPickerOpen}
          accountScope={accountScope}
          activeAccounts={activeAccounts}
          onAccountPickerOpenChange={setAccountPickerOpen}
          onAccountScopeChange={(nextScope) => {
            setAccountScope(nextScope)
            setAccountPickerOpen(false)
          }}
          onTaxYearChange={(nextYear) => {
            setTaxYear(nextYear)
            setTaxYearPickerOpen(false)
          }}
          onTaxYearPickerOpenChange={setTaxYearPickerOpen}
          summary={summary}
          taxYear={taxYear}
          taxYearPickerOpen={taxYearPickerOpen}
        />

        <section className="grid min-w-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="grid gap-4 lg:grid-cols-2">
              <PortfolioOverview holdings={activeHoldings} summary={summary} />
              <TaxYearOverview summary={summary} taxYear={taxYear} />
            </section>

            <AssetsPanel holdings={activeHoldings} />

            <TransactionsPanel
              accountsById={accountsById}
              mode={transactionMode}
              onModeChange={setTransactionMode}
              taxYear={taxYear}
              transactions={filteredTransactions}
            />
          </div>

          <AccountsPanel
            accountScope={accountScope}
            activeAccounts={activeAccounts}
            summary={summary}
            taxYear={taxYear}
          />
        </section>
      </ContentContainer>
    </div>
  )
}

function DashboardHeader({
  accountLabel,
  importedTransactions,
  taxYear,
}: {
  accountLabel: string
  importedTransactions: number
  taxYear: TaxYear
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Logo size="small" />
        <div className="hidden h-8 w-px bg-border sm:block" />
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-medium">Tax dashboard</p>
          <p className="m-0 truncate text-xs text-muted-foreground">
            {accountLabel} · {formatInteger(importedTransactions)} imported transactions · {taxYear}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11 sm:min-h-9" variant="outline">
          <RefreshCw data-icon="inline-start" />
          Sync now
        </Button>
        <Button className="min-h-11 sm:min-h-9">
          <Download data-icon="inline-start" />
          Export report
        </Button>
      </div>
    </header>
  )
}

function AccountScopeSection({
  accountLabel,
  accountPickerOpen,
  accountScope,
  activeAccounts,
  onAccountPickerOpenChange,
  onAccountScopeChange,
  onTaxYearChange,
  onTaxYearPickerOpenChange,
  summary,
  taxYear,
  taxYearPickerOpen,
}: {
  accountLabel: string
  accountPickerOpen: boolean
  accountScope: AccountScope
  activeAccounts: ReadonlyArray<Account>
  onAccountPickerOpenChange: (open: boolean) => void
  onAccountScopeChange: (scope: AccountScope) => void
  onTaxYearChange: (year: TaxYear) => void
  onTaxYearPickerOpenChange: (open: boolean) => void
  summary: DashboardSummary
  taxYear: TaxYear
  taxYearPickerOpen: boolean
}) {
  return (
    <SourceCards
      onSelectedSourceIdChange={(sourceId) => onAccountScopeChange(sourceId ?? ALL_ACCOUNTS)}
      selectedSourceId={accountScope === ALL_ACCOUNTS ? undefined : accountScope}
      sources={accounts}
    >
      <FilterBar
        accountLabel={accountLabel}
        accountPickerOpen={accountPickerOpen}
        accountScope={accountScope}
        onAccountPickerOpenChange={onAccountPickerOpenChange}
        onAccountScopeChange={onAccountScopeChange}
        onTaxYearChange={onTaxYearChange}
        onTaxYearPickerOpenChange={onTaxYearPickerOpenChange}
        taxYear={taxYear}
        taxYearPickerOpen={taxYearPickerOpen}
      />

      <AccountScopePanel
        accountScope={accountScope}
        activeAccounts={activeAccounts}
        summary={summary}
        onAccountScopeChange={onAccountScopeChange}
      />
    </SourceCards>
  )
}

function FilterBar({
  accountLabel,
  accountPickerOpen,
  accountScope,
  onAccountPickerOpenChange,
  onAccountScopeChange,
  onTaxYearChange,
  onTaxYearPickerOpenChange,
  taxYear,
  taxYearPickerOpen,
}: {
  accountLabel: string
  accountPickerOpen: boolean
  accountScope: AccountScope
  onAccountPickerOpenChange: (open: boolean) => void
  onAccountScopeChange: (scope: AccountScope) => void
  onTaxYearChange: (year: TaxYear) => void
  onTaxYearPickerOpenChange: (open: boolean) => void
  taxYear: TaxYear
  taxYearPickerOpen: boolean
}) {
  return (
    <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
      <Popover open={accountPickerOpen} onOpenChange={onAccountPickerOpenChange}>
        <PopoverTrigger asChild>
          <Button
            className="min-h-11 justify-between rounded-md bg-background px-3"
            role="combobox"
            variant="outline"
          >
            <span className="flex min-w-0 items-center gap-2">
              <WalletCards data-icon="inline-start" />
              <span className="truncate">{accountLabel}</span>
            </span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
          <Command>
            <CommandInput placeholder="Search accounts..." />
            <CommandList>
              <CommandEmpty>No account found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  data-checked={accountScope === ALL_ACCOUNTS}
                  onSelect={() => onAccountScopeChange(ALL_ACCOUNTS)}
                  value="All accounts"
                >
                  <WalletCards />
                  <span className="min-w-0 flex-1 truncate">All accounts</span>
                  <CommandShortcut>{formatInteger(totalImportedTransactions)}</CommandShortcut>
                </CommandItem>
                {accounts.map((account) => (
                  <CommandItem
                    data-checked={accountScope === account.id}
                    key={account.id}
                    onSelect={() => onAccountScopeChange(account.id)}
                    value={account.name}
                  >
                    <AccountMark account={account} />
                    <span className="min-w-0 flex-1 truncate">{account.name}</span>
                    <CommandShortcut>{formatInteger(account.importedTransactions)}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Popover open={taxYearPickerOpen} onOpenChange={onTaxYearPickerOpenChange}>
        <PopoverTrigger asChild>
          <Button
            className="min-h-11 justify-between rounded-md bg-background px-3"
            role="combobox"
            variant="outline"
          >
            <span className="flex min-w-0 items-center gap-2">
              <CalendarDays data-icon="inline-start" />
              <span>{taxYear}</span>
            </span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-0">
          <Command>
            <CommandList>
              <CommandGroup>
                {taxYears.map((year) => (
                  <CommandItem
                    data-checked={taxYear === year}
                    key={year}
                    onSelect={() => onTaxYearChange(year)}
                    value={String(year)}
                  >
                    <CalendarDays />
                    <span>{year}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </section>
  )
}

function PortfolioOverview({
  holdings,
  summary,
}: {
  holdings: ReadonlyArray<AggregatedHolding>
  summary: DashboardSummary
}) {
  const unrealizedPercent =
    summary.currentCostBasis === 0
      ? 0
      : (summary.unrealizedProfitLoss / summary.currentCostBasis) * 100

  return (
    <DashboardCard
      action={<Badge variant="secondary">Current</Badge>}
      description="Not limited by tax year"
      title="Portfolio"
    >
      <div className="flex flex-col gap-4">
        <MetricValue label="Overall balance" value={formatCurrency(summary.currentBalance)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <SmallStat label="Assets" value={formatInteger(holdings.length)} />
          <SmallStat
            label="Unrealized P/L"
            tone={summary.unrealizedProfitLoss >= 0 ? "positive" : "negative"}
            value={formatSignedCurrency(summary.unrealizedProfitLoss)}
          />
          <SmallStat
            label="Return"
            tone={unrealizedPercent >= 0 ? "positive" : "negative"}
            value={formatPercent(unrealizedPercent)}
          />
        </div>
      </div>
    </DashboardCard>
  )
}

function TaxYearOverview({ summary, taxYear }: { summary: DashboardSummary; taxYear: TaxYear }) {
  return (
    <DashboardCard
      action={
        <Badge variant={summary.missingClassifications > 0 ? "destructive" : "secondary"}>
          {taxYear}
        </Badge>
      }
      description="Filtered by selected tax year"
      title="Tax position"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricBlock
          icon={CircleDollarSign}
          label="Realized P/L"
          tone={summary.realizedProfitLoss >= 0 ? "positive" : "negative"}
          value={formatSignedCurrency(summary.realizedProfitLoss)}
        />
        <MetricBlock
          icon={Landmark}
          label="Taxes payable"
          value={formatCurrency(summary.taxesPayable)}
        />
        <MetricBlock
          icon={ArrowDownToLine}
          label="Taxes receivable"
          tone={summary.taxesReceivable > 0 ? "positive" : "neutral"}
          value={formatCurrency(summary.taxesReceivable)}
        />
        <MetricBlock
          icon={summary.missingClassifications > 0 ? AlertTriangle : CheckCircle2}
          label="Needs review"
          tone={summary.missingClassifications > 0 ? "warning" : "neutral"}
          value={formatInteger(summary.missingClassifications)}
        />
      </div>
    </DashboardCard>
  )
}

function AccountScopePanel({
  accountScope,
  activeAccounts,
  onAccountScopeChange,
  summary,
}: {
  accountScope: AccountScope
  activeAccounts: ReadonlyArray<Account>
  onAccountScopeChange: (scope: AccountScope) => void
  summary: DashboardSummary
}) {
  const selectedAccount =
    accountScope === ALL_ACCOUNTS
      ? undefined
      : accounts.find((account) => account.id === accountScope)

  return (
    <section className="grid gap-4 rounded-lg bg-background p-4 shadow-sm ring-1 ring-border/80 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-end">
      <div className="min-w-0">
        <p className="m-0 text-xs font-medium uppercase text-muted-foreground">Account scope</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="m-0 text-2xl font-semibold tracking-normal">
              {selectedAccount ? selectedAccount.name : "All accounts"}
            </h2>
            <p className="m-0 mt-2 max-w-xl text-sm text-muted-foreground">
              {selectedAccount
                ? "This dashboard is scoped to one source. Click the lifted card again to return to the aggregate view."
                : "The dashboard is showing your aggregate position across every connected source."}
            </p>
          </div>
          {selectedAccount ? (
            <Button
              className="min-h-10 shrink-0 rounded-md"
              onClick={() => onAccountScopeChange(ALL_ACCOUNTS)}
              type="button"
              variant="outline"
            >
              <WalletCards data-icon="inline-start" />
              All accounts
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SmallStat label="Active sources" value={formatInteger(activeAccounts.length)} />
        <SmallStat label="Imported" value={`${formatInteger(summary.importedTransactions)} txs`} />
        <SmallStat
          label="Needs review"
          tone={summary.unresolvedItems > 0 ? "warning" : "neutral"}
          value={formatInteger(summary.unresolvedItems)}
        />
      </div>
    </section>
  )
}

function AssetsPanel({ holdings }: { holdings: ReadonlyArray<AggregatedHolding> }) {
  return (
    <DashboardCard
      action={<Badge variant="outline">{formatInteger(holdings.length)} assets</Badge>}
      description="Current assets across the selected account scope"
      title="Assets owned now"
    >
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
              <AssetRow holding={holding} key={holding.asset} />
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}

function AssetRow({ holding }: { holding: AggregatedHolding }) {
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
        <AccountList accountIds={holding.accountIds} />
      </TableCell>
    </tr>
  )
}

function TransactionsPanel({
  accountsById,
  mode,
  onModeChange,
  taxYear,
  transactions: visibleTransactions,
}: {
  accountsById: ReadonlyMap<AccountId, Account>
  mode: TransactionMode
  onModeChange: (mode: TransactionMode) => void
  taxYear: TaxYear
  transactions: typeof transactions
}) {
  return (
    <DashboardCard
      action={
        <div className="flex rounded-md bg-muted p-1">
          <SegmentButton active={mode === "tax"} onClick={() => onModeChange("tax")}>
            Tax relevant
          </SegmentButton>
          <SegmentButton active={mode === "raw"} onClick={() => onModeChange("raw")}>
            Raw
          </SegmentButton>
        </div>
      }
      description={`${taxYear} activity for the selected account scope`}
      title="Transactions"
    >
      <div className="mb-3 flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
        <Search />
        <span className="truncate">Search, asset, type, source, or transaction id</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[58rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <TableHead>Date</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>{mode === "tax" ? "Tax treatment" : "Raw action"}</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead align="right">Amount</TableHead>
              <TableHead align="right">Value</TableHead>
              <TableHead align="right">P/L</TableHead>
              <TableHead align="right">Tax impact</TableHead>
              <TableHead>Reference</TableHead>
            </tr>
          </thead>
          <tbody>
            {visibleTransactions.map((transaction) => {
              const account = accountsById.get(transaction.accountId)
              return (
                <tr className="h-14" key={transaction.id}>
                  <TableCell>{transaction.date}</TableCell>
                  <TableCell>{account ? account.name : transaction.accountId}</TableCell>
                  <TableCell>
                    {mode === "tax" ? transaction.taxTreatment : transaction.rawAction}
                  </TableCell>
                  <TableCell>{transaction.asset}</TableCell>
                  <TableCell align="right">{formatTokenAmount(transaction.amount)}</TableCell>
                  <TableCell align="right">{formatCurrency(transaction.value)}</TableCell>
                  <TableCell align="right">
                    <ValueTone tone={transaction.realizedProfitLoss >= 0 ? "positive" : "negative"}>
                      {formatSignedCurrency(transaction.realizedProfitLoss)}
                    </ValueTone>
                  </TableCell>
                  <TableCell align="right">
                    <ValueTone tone={transaction.taxImpact < 0 ? "positive" : "neutral"}>
                      {formatSignedCurrency(transaction.taxImpact)}
                    </ValueTone>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">
                      {transaction.txId}
                    </span>
                  </TableCell>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {visibleTransactions.length === 0 ? (
        <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <FileText />
          <p className="m-0 text-sm font-medium">No transactions in this view</p>
          <p className="m-0 text-xs text-muted-foreground">
            Change the account scope, tax year, or transaction mode.
          </p>
        </div>
      ) : null}
    </DashboardCard>
  )
}

function AccountsPanel({
  accountScope,
  activeAccounts,
  summary,
  taxYear,
}: {
  accountScope: AccountScope
  activeAccounts: ReadonlyArray<Account>
  summary: DashboardSummary
  taxYear: TaxYear
}) {
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <DashboardCard
        action={
          <Badge variant="secondary">{accountScope === ALL_ACCOUNTS ? "All" : "Filtered"}</Badge>
        }
        description="Current source health and selected-year work"
        title="Accounts"
      >
        <div className="flex flex-col gap-3">
          <ReviewStat
            icon={ArrowDownToLine}
            label="Imported"
            value={`${formatInteger(summary.importedTransactions)} txs`}
          />
          <ReviewStat
            icon={CircleDollarSign}
            label="Taxable events"
            value={formatInteger(summary.taxableEvents)}
          />
          <ReviewStat
            icon={AlertTriangle}
            label="Missing classifications"
            value={formatInteger(summary.missingClassifications)}
          />
          <ReviewStat
            icon={WalletCards}
            label="Active sources"
            value={formatInteger(activeAccounts.length)}
          />
          <ReviewStat icon={CalendarDays} label="Tax year" value={String(taxYear)} />
        </div>
      </DashboardCard>
    </aside>
  )
}

function DashboardCard({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  description?: string
  title: string
}) {
  return (
    <Card className="rounded-lg shadow-none ring-1 ring-border/80" size="sm">
      <CardHeader className="min-h-14 gap-1 rounded-t-lg border-b border-border/70 pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  )
}

function MetricValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="m-0 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="m-0 mt-1 min-h-10 text-3xl font-semibold tabular-nums tracking-normal">
        {value}
      </p>
    </div>
  )
}

function SmallStat({
  label,
  tone = "neutral",
  value,
}: {
  label: string
  tone?: ValueToneName
  value: string
}) {
  return (
    <div className="rounded-md bg-muted/50 p-3">
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <p className="m-0 mt-1 min-h-6 font-medium tabular-nums">
        <ValueTone tone={tone}>{value}</ValueTone>
      </p>
    </div>
  )
}

function MetricBlock({
  icon: Icon,
  label,
  tone = "neutral",
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  tone?: ValueToneName
  value: string
}) {
  return (
    <div className="flex min-h-20 items-start gap-3 rounded-md bg-muted/50 p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border">
        <Icon />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="mt-1 block truncate text-base font-medium tabular-nums">
          <ValueTone tone={tone}>{value}</ValueTone>
        </span>
      </span>
    </div>
  )
}

function SegmentButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "min-h-8 rounded px-3 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function ReviewStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/70 pb-3 last:border-b-0 last:pb-0">
      <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Icon />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-right text-sm font-medium tabular-nums">{value}</span>
    </div>
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

function AccountList({ accountIds }: { accountIds: ReadonlyArray<AccountId> }) {
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

function AccountMark({ account }: { account: Account }) {
  if (account.id === "coinbase") {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#0052ff] text-white">
        <CoinbaseLogo size={14} />
      </span>
    )
  }

  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-1 ring-border">
      {account.name.slice(0, 1)}
    </span>
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

const accountsById = new Map(accounts.map((account) => [account.id, account]))

const totalImportedTransactions = accounts.reduce(
  (total, account) => total + account.importedTransactions,
  0
)
