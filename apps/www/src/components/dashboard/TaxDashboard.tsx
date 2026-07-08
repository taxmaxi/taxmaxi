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
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useRef, useState } from "react"

import { ContentContainer } from "#/components/content-container"
import { Logo } from "#/components/logo"
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
  type AccountKind,
  type AccountId,
  type AccountScope,
  type TaxYear,
  type TransactionMode,
} from "./types"

/* ---------------------------------------------------------
 * ACCOUNT STACK STORYBOARD
 *
 * Read top-to-bottom. Each `at` value is ms after selection.
 *
 *   0ms   resting cards sit half behind the account section
 * 120ms   hovered card peeks 90% above the section
 * 220ms   selected card peeks fully above the section
 * --------------------------------------------------------- */

const ACCOUNT_STACK = {
  height: "11.5rem", // reserved panel height to prevent layout shift
  prominentHeight: "21.5rem", // 2x prominent card height; selection never shifts layout
  prominentSectionOffset: "14rem", // where the shared account section starts covering cards
  prominentHoverY: 70, // leaves roughly 90% of the prominent card visible above the section
  prominentCardWidthPx: 272,
  prominentFan: {
    startX: 24,
    minStepX: 54,
    maxStepX: 190,
    selectedMinX: 78,
    selectedMaxX: 306,
    sidePadding: 24,
    restY: 138,
    inactiveY: 176,
    selectedY: 20,
  },
  cardWidth: "12.5rem", // stable card width
  cardHeight: "7.875rem", // credit-card ratio
  prominentCardWidth: "17rem", // top band card width
  prominentCardHeight: "10.75rem", // credit-card ratio
  hoverScale: 1.045, // forward motion without changing stacking order
  tapScale: 0.98, // pressed state scale
  spring: { type: "spring" as const, stiffness: 230, damping: 28, mass: 0.9 },
  reducedTransition: { duration: 0 },
  all: [
    { x: -14, y: 32, rotate: -8, scale: 0.98, zIndex: 1 },
    { x: 44, y: 20, rotate: 1.5, scale: 1, zIndex: 2 },
    { x: 102, y: 34, rotate: 8, scale: 0.98, zIndex: 3 },
  ],
  selected: [
    { x: -24, y: 74, rotate: -9, scale: 0.86, zIndex: 1 },
    { x: 46, y: 0, rotate: 0, scale: 1.05, zIndex: 4 },
    { x: 128, y: 74, rotate: 9, scale: 0.86, zIndex: 1 },
  ],
  prominentAll: [
    { x: 24, y: 138, rotate: -8, scale: 0.98, zIndex: 1 },
    { x: 176, y: 138, rotate: 1, scale: 1, zIndex: 2 },
    { x: 320, y: 138, rotate: 8, scale: 0.98, zIndex: 3 },
  ],
  prominentSelected: [
    { x: 54, y: 176, rotate: -9, scale: 0.82, zIndex: 1 },
    { x: 176, y: 20, rotate: 0, scale: 1.05, zIndex: 4 },
    { x: 364, y: 176, rotate: 9, scale: 0.82, zIndex: 1 },
  ],
  prominentSelectedByIndex: [
    [
      { x: 78, y: 20, rotate: 0, scale: 1.05, zIndex: 4 },
      { x: 246, y: 160, rotate: 2.5, scale: 0.84, zIndex: 2 },
      { x: 380, y: 176, rotate: 9, scale: 0.8, zIndex: 1 },
    ],
    [
      { x: 54, y: 176, rotate: -9, scale: 0.82, zIndex: 1 },
      { x: 176, y: 20, rotate: 0, scale: 1.05, zIndex: 4 },
      { x: 364, y: 176, rotate: 9, scale: 0.82, zIndex: 1 },
    ],
    [
      { x: 48, y: 176, rotate: -9, scale: 0.8, zIndex: 1 },
      { x: 206, y: 160, rotate: -2.5, scale: 0.84, zIndex: 2 },
      { x: 306, y: 20, rotate: 0, scale: 1.05, zIndex: 4 },
    ],
  ],
}

type AccountCardStyle = {
  background: string
  foreground: string
  muted: string
  pattern: "bars" | "grid" | "waves"
}

const ACCOUNT_CARD_STYLES: Partial<Record<AccountId, AccountCardStyle>> = {
  coinbase: {
    background: "#1458f5",
    foreground: "#f8fbff",
    muted: "rgb(248 251 255 / 0.72)",
    pattern: "waves",
  },
  kraken: {
    background: "#171514",
    foreground: "#f6efe2",
    muted: "rgb(246 239 226 / 0.7)",
    pattern: "grid",
  },
  "solana-wallet": {
    background: "#4ee987",
    foreground: "#082715",
    muted: "rgb(8 39 21 / 0.68)",
    pattern: "bars",
  },
  binance: {
    background: "#f0b90b",
    foreground: "#2b2100",
    muted: "rgb(43 33 0 / 0.68)",
    pattern: "grid",
  },
  ledger: {
    background: "#f4efe4",
    foreground: "#332d22",
    muted: "rgb(51 45 34 / 0.64)",
    pattern: "bars",
  },
  metamask: {
    background: "#f6851b",
    foreground: "#2a1204",
    muted: "rgb(42 18 4 / 0.66)",
    pattern: "waves",
  },
  "base-wallet": {
    background: "#0052ff",
    foreground: "#f7fbff",
    muted: "rgb(247 251 255 / 0.72)",
    pattern: "waves",
  },
  "arbitrum-wallet": {
    background: "#20314f",
    foreground: "#f3f7ff",
    muted: "rgb(243 247 255 / 0.68)",
    pattern: "grid",
  },
}

const GENERATED_ACCOUNT_CARD_STYLES: readonly [
  AccountCardStyle,
  ...ReadonlyArray<AccountCardStyle>,
] = [
  {
    background: "#7c3aed",
    foreground: "#fbf7ff",
    muted: "rgb(251 247 255 / 0.72)",
    pattern: "waves",
  },
  {
    background: "#0f766e",
    foreground: "#effdf9",
    muted: "rgb(239 253 249 / 0.72)",
    pattern: "bars",
  },
  {
    background: "#be123c",
    foreground: "#fff7f8",
    muted: "rgb(255 247 248 / 0.7)",
    pattern: "grid",
  },
  {
    background: "#4338ca",
    foreground: "#f7f7ff",
    muted: "rgb(247 247 255 / 0.72)",
    pattern: "waves",
  },
  {
    background: "#166534",
    foreground: "#f0fdf4",
    muted: "rgb(240 253 244 / 0.72)",
    pattern: "bars",
  },
  {
    background: "#92400e",
    foreground: "#fff7ed",
    muted: "rgb(255 247 237 / 0.7)",
    pattern: "grid",
  },
]

const ACCOUNT_BAR_PATTERN = [
  62, 72, 82, 92, 68, 56, 46, 38, 48, 58, 66, 74, 82, 88, 76, 64, 52, 44, 56, 70, 84, 94,
] as const

const ACCOUNT_WAVE_PATTERN = [96, 88, 92, 86, 98, 90, 84, 94, 89, 97, 83, 91, 95, 87] as const

const ACCOUNT_GRID_PATTERN = [
  true,
  true,
  false,
  true,
  true,
  false,
  true,
  false,
  true,
  true,
  true,
  false,
  true,
  true,
  true,
  false,
  true,
  true,
  false,
  true,
  false,
  true,
  true,
  true,
  false,
  true,
  true,
  true,
] as const

const ACCOUNT_CHIP_PATTERN = [true, false, true, false, true, false, true, false, true] as const

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
    <section className="relative" style={{ paddingTop: ACCOUNT_STACK.prominentSectionOffset }}>
      <div
        className="absolute inset-x-0 top-0 z-0 overflow-clip"
        style={{ height: ACCOUNT_STACK.prominentHeight }}
      >
        <AccountCardPeeker
          accountScope={accountScope}
          onAccountScopeChange={onAccountScopeChange}
        />
      </div>

      <div className="relative z-20 grid gap-2 rounded-lg bg-card p-2 shadow-sm ring-1 ring-border/80">
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
      </div>
    </section>
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

function AccountCardPeeker({
  accountScope,
  onAccountScopeChange,
}: {
  accountScope: AccountScope
  onAccountScopeChange: (scope: AccountScope) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const stackLayout = useMemo(
    () => getProminentStackLayout({ containerWidth, total: accounts.length }),
    [containerWidth]
  )

  useEffect(() => {
    const scroller = scrollerRef.current

    if (scroller) {
      scroller.scrollLeft = 0
    }
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current

    if (!scroller) {
      return
    }

    const updateWidth = () => {
      setContainerWidth(Math.round(scroller.getBoundingClientRect().width))
    }

    updateWidth()

    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(scroller)

    return () => resizeObserver.disconnect()
  }, [])

  return (
    <div
      className="relative h-[21.5rem] overflow-x-auto overflow-y-clip overscroll-x-contain"
      ref={scrollerRef}
    >
      <div
        className="absolute top-0 left-0"
        style={{ left: stackLayout.left, width: stackLayout.stackWidth }}
      >
        <AccountCardStack
          accountScope={accountScope}
          prominentLayout={stackLayout}
          onAccountScopeChange={onAccountScopeChange}
          size="prominent"
        />
      </div>
    </div>
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

function AccountCardStack({
  accountScope,
  onAccountScopeChange,
  prominentLayout,
  size = "compact",
}: {
  accountScope: AccountScope
  onAccountScopeChange: (scope: AccountScope) => void
  prominentLayout?: ProminentAccountStackLayout
  size?: "compact" | "prominent"
}) {
  const reduceMotion = useReducedMotion()
  const selectedIndex =
    accountScope === ALL_ACCOUNTS
      ? -1
      : accounts.findIndex((account) => account.id === accountScope)
  const prominent = size === "prominent"
  const stackHeight = prominent ? ACCOUNT_STACK.prominentHeight : ACCOUNT_STACK.height
  const cardWidth = prominent ? ACCOUNT_STACK.prominentCardWidth : ACCOUNT_STACK.cardWidth
  const cardHeight = prominent ? ACCOUNT_STACK.prominentCardHeight : ACCOUNT_STACK.cardHeight
  const resolvedProminentLayout =
    prominentLayout ?? getProminentStackLayout({ containerWidth: 0, total: accounts.length })

  return (
    <div className="flex flex-col gap-3">
      {prominent ? null : (
        <button
          aria-pressed={accountScope === ALL_ACCOUNTS}
          className={cn(
            "flex min-h-10 items-center justify-between gap-3 rounded-md border px-3 text-left text-sm transition-colors",
            accountScope === ALL_ACCOUNTS
              ? "border-foreground/20 bg-muted text-foreground"
              : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={() => onAccountScopeChange(ALL_ACCOUNTS)}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            <WalletCards />
            <span className="truncate font-medium">All accounts</span>
          </span>
          <span className="shrink-0 tabular-nums">{formatInteger(totalImportedTransactions)}</span>
        </button>
      )}

      <div
        className={cn(
          "relative isolate overflow-visible rounded-lg bg-muted/40",
          prominent && "w-full bg-transparent"
        )}
        style={{ height: stackHeight }}
      >
        {accounts.map((account, index) => {
          const active = accountScope === account.id
          const style = getAccountCardStyle(account)
          const resting = getAccountCardPlacement({
            accountScope,
            index,
            prominentLayout: resolvedProminentLayout,
            selectedIndex,
            size,
            total: accounts.length,
          })

          return (
            <motion.button
              aria-label={`${active ? "Show all accounts" : `Show ${account.name}`}`}
              aria-pressed={active}
              animate={{
                opacity: 1,
                rotate: resting.rotate,
                scale: resting.scale,
                x: resting.x,
                y: resting.y,
              }}
              className={cn(
                "absolute left-0 top-0 flex flex-col justify-between overflow-hidden rounded-2xl p-4 text-left shadow-lg outline-none ring-1 ring-black/10 will-change-transform focus-visible:ring-3 focus-visible:ring-ring/40",
                prominent && "p-5"
              )}
              initial={false}
              key={account.id}
              onClick={() => onAccountScopeChange(active ? ALL_ACCOUNTS : account.id)}
              style={{
                backgroundColor: style.background,
                color: style.foreground,
                height: cardHeight,
                width: cardWidth,
                zIndex: resting.zIndex,
              }}
              transition={reduceMotion ? ACCOUNT_STACK.reducedTransition : ACCOUNT_STACK.spring}
              type="button"
              whileHover={
                reduceMotion
                  ? undefined
                  : {
                      scale: resting.scale * ACCOUNT_STACK.hoverScale,
                      y: prominent && !active ? ACCOUNT_STACK.prominentHoverY : resting.y,
                    }
              }
              whileTap={
                reduceMotion ? undefined : { scale: resting.scale * ACCOUNT_STACK.tapScale }
              }
            >
              <AccountCardPattern account={account} />
              <span className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/18 via-transparent to-black/18" />
              <span className="relative z-10 flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-lg font-semibold tracking-normal">
                    {account.name}
                  </span>
                  <span className="mt-1 block truncate text-xs" style={{ color: style.muted }}>
                    {formatKind(account.kind)}
                    {account.network ? ` · ${account.network}` : ""}
                  </span>
                </span>
                <span className="rounded-full bg-black/10 px-2 py-1 text-xs tabular-nums backdrop-blur-sm">
                  {formatInteger(account.importedTransactions)}
                </span>
              </span>

              <span className="relative z-10 flex items-center justify-between">
                <span className="grid h-8 w-11 grid-cols-3 gap-0.5 rounded-md bg-white/45 p-1 shadow-inner ring-1 ring-black/10">
                  {ACCOUNT_CHIP_PATTERN.map((filled, chipIndex) => (
                    <span
                      className={cn("rounded-[1px]", filled ? "bg-black/35" : "bg-black/15")}
                      key={chipIndex}
                    />
                  ))}
                </span>
                <span className="font-mono text-xs tabular-nums opacity-75">
                  {account.kind === "exchange" ? "API" : "WALLET"}
                </span>
              </span>

              <span className="relative z-10 flex items-end justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-mono text-sm tabular-nums tracking-normal">
                    •••• {account.importedTransactions.toString().padStart(4, "0").slice(-4)}
                  </span>
                  <span className="mt-1 block truncate text-xs" style={{ color: style.muted }}>
                    {account.lastSync}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs font-medium">
                  {account.unresolvedItems > 0 ? `${account.unresolvedItems} open` : "Clean"}
                </span>
              </span>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function getAccountCardPlacement({
  accountScope,
  index,
  prominentLayout,
  selectedIndex,
  size,
  total,
}: {
  accountScope: AccountScope
  index: number
  prominentLayout: ProminentAccountStackLayout
  selectedIndex: number
  size: "compact" | "prominent"
  total: number
}) {
  if (size === "prominent") {
    return getProminentAccountCardPlacement({
      accountScope,
      index,
      layout: prominentLayout,
      selectedIndex,
      total,
    })
  }

  const allPlacements = ACCOUNT_STACK.all
  const selectedPlacements = ACCOUNT_STACK.selected

  if (accountScope === ALL_ACCOUNTS) {
    return allPlacements[index] ?? allPlacements[0]
  }

  if (index === selectedIndex) {
    return selectedPlacements[1]
  }

  return index < selectedIndex ? selectedPlacements[0] : selectedPlacements[2]
}

function getProminentAccountCardPlacement({
  accountScope,
  index,
  layout,
  selectedIndex,
  total,
}: {
  accountScope: AccountScope
  index: number
  layout: ProminentAccountStackLayout
  selectedIndex: number
  total: number
}) {
  const basePlacement = getProminentRestingPlacement({ index, layout, total })

  if (accountScope === ALL_ACCOUNTS || selectedIndex < 0) {
    return basePlacement
  }

  if (index === selectedIndex) {
    return {
      ...basePlacement,
      rotate: 0,
      scale: 1.05,
      x: basePlacement.x,
      y: ACCOUNT_STACK.prominentFan.selectedY,
      zIndex: total + 4,
    }
  }

  const distance = index - selectedIndex
  const direction = distance < 0 ? -1 : 1
  const nearSelectedNudge = Math.max(0, 4 - Math.abs(distance)) * 7

  return {
    ...basePlacement,
    rotate: basePlacement.rotate + direction * 1.5,
    scale: Math.max(0.76, 0.86 - Math.min(Math.abs(distance), 4) * 0.025),
    x: basePlacement.x + direction * (18 + nearSelectedNudge),
    y: ACCOUNT_STACK.prominentFan.inactiveY,
    zIndex: Math.max(1, total - Math.abs(distance)),
  }
}

function getProminentRestingPlacement({
  index,
  layout,
  total,
}: {
  index: number
  layout: ProminentAccountStackLayout
  total: number
}) {
  const center = (total - 1) / 2
  const distanceFromCenter = index - center
  const normalizedDistance = center === 0 ? 0 : distanceFromCenter / center

  return {
    x: layout.startX + index * layout.stepX,
    y: ACCOUNT_STACK.prominentFan.restY + Math.abs(normalizedDistance) * 10,
    rotate: normalizedDistance * 9,
    scale: 1 - Math.abs(normalizedDistance) * 0.06,
    zIndex: index + 1,
  }
}

type ProminentAccountStackLayout = {
  left: number
  stackWidth: number
  startX: number
  stepX: number
}

function getProminentStackLayout({
  containerWidth,
  total,
}: {
  containerWidth: number
  total: number
}): ProminentAccountStackLayout {
  const cardWidth = ACCOUNT_STACK.prominentCardWidthPx
  const sidePadding = ACCOUNT_STACK.prominentFan.sidePadding
  const startX = ACCOUNT_STACK.prominentFan.startX
  const maxStackWidth = Math.max(0, containerWidth)
  const availableStepWidth = maxStackWidth - startX - sidePadding - cardWidth
  const maxStep = ACCOUNT_STACK.prominentFan.maxStepX
  const minStep = ACCOUNT_STACK.prominentFan.minStepX
  const stepX =
    total <= 1
      ? maxStep
      : Math.min(maxStep, Math.max(minStep, availableStepWidth / Math.max(1, total - 1)))
  const stackWidth = startX + Math.max(0, total - 1) * stepX + cardWidth + sidePadding

  return {
    left: Math.max(0, (maxStackWidth - stackWidth) / 2),
    stackWidth,
    startX,
    stepX,
  }
}

function getAccountCardStyle(account: Account) {
  const bespokeStyle = ACCOUNT_CARD_STYLES[account.id]

  if (bespokeStyle) {
    return bespokeStyle
  }

  const styleIndex = hashString(account.id) % GENERATED_ACCOUNT_CARD_STYLES.length
  return GENERATED_ACCOUNT_CARD_STYLES[styleIndex] ?? GENERATED_ACCOUNT_CARD_STYLES[0]
}

function hashString(value: string) {
  let hash = 0

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }

  return hash
}

function AccountCardPattern({ account }: { account: Account }) {
  const style = getAccountCardStyle(account)

  if (style.pattern === "grid") {
    return (
      <span
        aria-hidden="true"
        className="absolute inset-x-4 top-5 grid grid-cols-7 gap-1 opacity-45"
      >
        {ACCOUNT_GRID_PATTERN.map((filled, index) => (
          <span
            className={cn("h-3 rounded-[2px]", filled ? "bg-current" : "bg-current/20")}
            key={index}
          />
        ))}
      </span>
    )
  }

  if (style.pattern === "waves") {
    return (
      <span
        aria-hidden="true"
        className="absolute inset-x-4 top-6 flex flex-col gap-1.5 opacity-45"
      >
        {ACCOUNT_WAVE_PATTERN.map((width, index) => (
          <span
            className="h-px rounded-full bg-current"
            key={index}
            style={{ width: `${width}%` }}
          />
        ))}
      </span>
    )
  }

  return (
    <span aria-hidden="true" className="absolute inset-x-4 top-6 flex items-end gap-1 opacity-45">
      {ACCOUNT_BAR_PATTERN.map((height, index) => (
        <span
          className="w-1 rounded-full bg-current"
          key={index}
          style={{ height: `${height}%` }}
        />
      ))}
    </span>
  )
}

function formatKind(kind: AccountKind): string {
  return kind === "exchange" ? "Exchange" : "Wallet"
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
