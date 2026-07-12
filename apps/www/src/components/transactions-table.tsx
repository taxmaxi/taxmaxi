import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import {
  ArrowUpDown,
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  MoreHorizontal,
  Search,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Checkbox } from "#/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import { Input } from "#/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table"
import { cn } from "#/lib/utils"

type TransactionKind = "buy" | "sell" | "swap" | "transfer" | "income" | "fee" | "bridge"
type ReviewStatus = "auto_applied" | "needs_review" | "approved" | "changed"
type TaxableTreatment = "taxable" | "tax_free" | "deductible" | "non_taxable" | "unknown" | "mixed"

/*
 * This UI is shaped as a table-ready projection over the existing report model.
 * The base row maps to `transactions` and `/v1/sources/:sourceId/transactions`:
 * timestamp, transaction type, provider status, provider description, external id,
 * and normalized movements from `transaction_legs` joined to `assets`.
 *
 * The remaining columns can be added to that endpoint without changing storage:
 * source label comes from `sources`; network and hash come from
 * `transaction_onchain_context`; venue/counterparty labels can come from
 * `transaction_venue_context` or provider metadata; review status comes from
 * `transaction_reviews`; proceeds, cost basis, gain/loss, and taxable treatment
 * are transaction-level aggregates over `disposal_matches`, FIFO lots, and
 * tax-event logic already used by `/v1/sources/:sourceId/tax-events`.
 */
type TransactionMovement = {
  legId: string
  kind: "acquisition" | "disposal" | "income" | "fee"
  asset: {
    assetId: string
    symbol: string
    name: string
  }
  amount: string
  fiatAmount: string | null
  fiatCurrency: string | null
}

type Transaction = {
  transactionId: string
  timestamp: string
  externalId: string | null
  transactionType: TransactionKind
  providerTransactionType: string | null
  providerStatus: string | null
  providerDescription: string | null
  sourceName: string
  sourceProviderKey: string | null
  blockchainName: string | null
  chainTxId: string | null
  counterpartyLabel: string | null
  reviewStatus: ReviewStatus
  taxableTreatment: TaxableTreatment
  movements: ReadonlyArray<TransactionMovement>
  fiatValue: string | null
  proceeds: string | null
  costBasis: string | null
  realizedGainLoss: string | null
}

const transactions: Transaction[] = [
  {
    transactionId: "8bd2f1f8-42db-401e-8a15-f78c52b94562",
    timestamp: "2025-12-18T13:32:08.000Z",
    externalId: "5muv2h6xwH9tR1qXK4xDqvEw8pQe7sLz2fYjA9B3cT6",
    transactionType: "swap",
    providerTransactionType: "SWAP",
    providerStatus: "completed",
    providerDescription: "Jupiter routed swap",
    sourceName: "Phantom wallet",
    sourceProviderKey: "helius-solana",
    blockchainName: "Solana",
    chainTxId: "5muv2h6xwH9tR1qXK4xDqvEw8pQe7sLz2fYjA9B3cT6",
    counterpartyLabel: "Jupiter",
    reviewStatus: "auto_applied",
    taxableTreatment: "taxable",
    fiatValue: "1159.44",
    proceeds: "1159.44",
    costBasis: "917.26",
    realizedGainLoss: "242.18",
    movements: [
      {
        legId: "leg_01",
        kind: "disposal",
        asset: { assetId: "asset_sol", symbol: "SOL", name: "Solana" },
        amount: "-8.42",
        fiatAmount: "1159.44",
        fiatCurrency: "EUR",
      },
      {
        legId: "leg_02",
        kind: "acquisition",
        asset: { assetId: "asset_usdc", symbol: "USDC", name: "USD Coin" },
        amount: "1258.30",
        fiatAmount: "1159.44",
        fiatCurrency: "EUR",
      },
      {
        legId: "leg_03",
        kind: "fee",
        asset: { assetId: "asset_sol", symbol: "SOL", name: "Solana" },
        amount: "-0.000015",
        fiatAmount: "0.0021",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "20cb7403-adcb-4019-85ec-fd55dba38bf9",
    timestamp: "2025-11-04T08:12:41.000Z",
    externalId: "3Jcvdk6uN2xWzYp8Rt9dY1EtX5xvMbkL3wA7qP2hS4nR",
    transactionType: "income",
    providerTransactionType: "STAKING_REWARD",
    providerStatus: "completed",
    providerDescription: "Staking reward",
    sourceName: "Ledger Solana",
    sourceProviderKey: "helius-solana",
    blockchainName: "Solana",
    chainTxId: "3Jcvdk6uN2xWzYp8Rt9dY1EtX5xvMbkL3wA7qP2hS4nR",
    counterpartyLabel: "Stake account",
    reviewStatus: "approved",
    taxableTreatment: "taxable",
    fiatValue: "12.91",
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_04",
        kind: "income",
        asset: { assetId: "asset_sol", symbol: "SOL", name: "Solana" },
        amount: "0.084",
        fiatAmount: "12.91",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "e706f5cc-2626-40b2-a618-3518351884ac",
    timestamp: "2025-10-26T20:45:17.000Z",
    externalId: "2kmJQ7uEq5KkPhc3S1rmQwAzRvBkT8uD9bH6yP4zXvLp",
    transactionType: "transfer",
    providerTransactionType: "TRANSFER",
    providerStatus: "completed",
    providerDescription: "Transfer to Coinbase",
    sourceName: "Phantom wallet",
    sourceProviderKey: "helius-solana",
    blockchainName: "Solana",
    chainTxId: "2kmJQ7uEq5KkPhc3S1rmQwAzRvBkT8uD9bH6yP4zXvLp",
    counterpartyLabel: "Coinbase",
    reviewStatus: "auto_applied",
    taxableTreatment: "non_taxable",
    fiatValue: "462.33",
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_05",
        kind: "disposal",
        asset: { assetId: "asset_usdc", symbol: "USDC", name: "USD Coin" },
        amount: "-500.00",
        fiatAmount: "462.33",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "7b3dcd19-3f4a-4265-81bc-0cc1d758a9d4",
    timestamp: "2025-09-15T16:03:29.000Z",
    externalId: "kraken-ledger-932187",
    transactionType: "sell",
    providerTransactionType: "trade",
    providerStatus: "closed",
    providerDescription: "Sell 0.35 ETH for EUR",
    sourceName: "Kraken",
    sourceProviderKey: "coinbase",
    blockchainName: null,
    chainTxId: null,
    counterpartyLabel: "ETH-EUR",
    reviewStatus: "needs_review",
    taxableTreatment: "taxable",
    fiatValue: "1038.72",
    proceeds: "1038.72",
    costBasis: "1125.26",
    realizedGainLoss: "-86.54",
    movements: [
      {
        legId: "leg_06",
        kind: "disposal",
        asset: { assetId: "asset_eth", symbol: "ETH", name: "Ether" },
        amount: "-0.35",
        fiatAmount: "1038.72",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "6fa7a8e3-6828-494a-8acf-a3fe68e447ec",
    timestamp: "2025-08-07T09:28:03.000Z",
    externalId: "4Q31BWkNsV8cR8MxW24nqAk3ySiNmhR1E7qPdUyKzT19",
    transactionType: "income",
    providerTransactionType: "AIRDROP",
    providerStatus: "completed",
    providerDescription: "JTO airdrop allocation",
    sourceName: "Solana wallet",
    sourceProviderKey: "helius-solana",
    blockchainName: "Solana",
    chainTxId: "4Q31BWkNsV8cR8MxW24nqAk3ySiNmhR1E7qPdUyKzT19",
    counterpartyLabel: "Jito",
    reviewStatus: "needs_review",
    taxableTreatment: "unknown",
    fiatValue: null,
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_07",
        kind: "income",
        asset: { assetId: "asset_jto", symbol: "JTO", name: "Jito" },
        amount: "42.00",
        fiatAmount: null,
        fiatCurrency: null,
      },
    ],
  },
  {
    transactionId: "ce1bd2f6-991a-4056-a19e-493bf4e2300b",
    timestamp: "2025-06-30T14:17:52.000Z",
    externalId: "0x17c2adbd638542aeb965b14ce1d4e4a9a9e313784c21e6f9ff3ca7c60e6d4432",
    transactionType: "bridge",
    providerTransactionType: "BRIDGE",
    providerStatus: "completed",
    providerDescription: "Bridge USDC from Ethereum to Solana",
    sourceName: "MetaMask",
    sourceProviderKey: "etherscan",
    blockchainName: "Ethereum",
    chainTxId: "0x17c2adbd638542aeb965b14ce1d4e4a9a9e313784c21e6f9ff3ca7c60e6d4432",
    counterpartyLabel: "Wormhole",
    reviewStatus: "changed",
    taxableTreatment: "non_taxable",
    fiatValue: "1868.44",
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_08",
        kind: "disposal",
        asset: { assetId: "asset_usdc_eth", symbol: "USDC", name: "USD Coin" },
        amount: "-2000.00",
        fiatAmount: "1868.44",
        fiatCurrency: "EUR",
      },
      {
        legId: "leg_09",
        kind: "fee",
        asset: { assetId: "asset_eth", symbol: "ETH", name: "Ether" },
        amount: "-0.0042",
        fiatAmount: "12.61",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "16ebf729-d678-4f59-bff4-0286c4cde1e9",
    timestamp: "2025-03-11T06:54:36.000Z",
    externalId: "bitstamp-trade-8817234",
    transactionType: "buy",
    providerTransactionType: "trade",
    providerStatus: "finished",
    providerDescription: "Bought 1.85 BTC with EUR",
    sourceName: "Bitstamp",
    sourceProviderKey: "bitstamp",
    blockchainName: null,
    chainTxId: null,
    counterpartyLabel: "BTC-EUR",
    reviewStatus: "auto_applied",
    taxableTreatment: "non_taxable",
    fiatValue: "119842.10",
    proceeds: null,
    costBasis: "119842.10",
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_10",
        kind: "acquisition",
        asset: { assetId: "asset_btc", symbol: "BTC", name: "Bitcoin" },
        amount: "1.85",
        fiatAmount: "119842.10",
        fiatCurrency: "EUR",
      },
    ],
  },
  {
    transactionId: "b8326028-c7f7-441c-9fb8-9152e4ac7a7d",
    timestamp: "2024-12-22T22:08:14.000Z",
    externalId: "7Gcxtb21eQkSX2f6pYmtvgDx7Lb7sgjHpSnTmwN5aRz8",
    transactionType: "fee",
    providerTransactionType: "CLOSE_ACCOUNT",
    providerStatus: "completed",
    providerDescription: "Network fee for token account close",
    sourceName: "Phantom wallet",
    sourceProviderKey: "helius-solana",
    blockchainName: "Solana",
    chainTxId: "7Gcxtb21eQkSX2f6pYmtvgDx7Lb7sgjHpSnTmwN5aRz8",
    counterpartyLabel: "System program",
    reviewStatus: "auto_applied",
    taxableTreatment: "deductible",
    fiatValue: "0.004",
    proceeds: null,
    costBasis: null,
    realizedGainLoss: null,
    movements: [
      {
        legId: "leg_11",
        kind: "fee",
        asset: { assetId: "asset_sol", symbol: "SOL", name: "Solana" },
        amount: "-0.000022",
        fiatAmount: "0.004",
        fiatCurrency: "EUR",
      },
    ],
  },
]

const columnLabels: Record<string, string> = {
  timestamp: "Date",
  transactionType: "Type",
  providerDescription: "Summary",
  fiatValue: "Value",
  realizedGainLoss: "Gain/loss",
  taxableTreatment: "Tax treatment",
  reviewStatus: "Status",
  sourceName: "Source",
  counterpartyLabel: "Counterparty",
  blockchainName: "Network",
  chainTxId: "Hash",
  costBasis: "Cost basis",
  proceeds: "Proceeds",
}

const currencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
})

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

const timeFormatter = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
})

function formatCurrency(value: string | null) {
  if (value === null) {
    return "Missing"
  }

  return currencyFormatter.format(Number(value))
}

function formatSignedCurrency(value: string | null) {
  if (value === null) {
    return "n/a"
  }

  const numericValue = Number(value)
  const formatted = currencyFormatter.format(Math.abs(numericValue))
  return numericValue < 0 ? `-${formatted}` : `+${formatted}`
}

function formatHash(hash: string | null) {
  if (hash === null) {
    return "n/a"
  }

  if (hash.startsWith("0x")) {
    return `${hash.slice(0, 8)}...${hash.slice(-6)}`
  }

  return `${hash.slice(0, 6)}...${hash.slice(-6)}`
}

function transactionLabel(type: TransactionKind) {
  switch (type) {
    case "buy":
      return "Buy"
    case "sell":
      return "Sell"
    case "swap":
      return "Swap"
    case "transfer":
      return "Transfer"
    case "income":
      return "Income"
    case "fee":
      return "Fee"
    case "bridge":
      return "Bridge"
  }
}

function treatmentLabel(treatment: TaxableTreatment) {
  switch (treatment) {
    case "taxable":
      return "Taxable"
    case "tax_free":
      return "Tax-free"
    case "deductible":
      return "Deductible"
    case "non_taxable":
      return "Non-taxable"
    case "unknown":
      return "Unknown"
    case "mixed":
      return "Mixed"
  }
}

function reviewLabel(transaction: Transaction) {
  if (transaction.movements.some((movement) => movement.fiatAmount === null)) {
    return "Missing price"
  }

  switch (transaction.reviewStatus) {
    case "needs_review":
      return "Needs review"
    case "approved":
      return "Approved"
    case "changed":
      return "Changed"
    case "auto_applied":
      return "Classified"
  }
}

function movementSummary(movements: ReadonlyArray<TransactionMovement>) {
  return movements
    .filter((movement) => movement.kind !== "fee")
    .map((movement) => `${movement.amount} ${movement.asset.symbol}`)
    .join(" -> ")
}

function badgeVariantForTreatment(treatment: TaxableTreatment) {
  switch (treatment) {
    case "taxable":
    case "unknown":
    case "mixed":
      return "secondary"
    case "deductible":
    case "non_taxable":
    case "tax_free":
      return "outline"
  }
}

function badgeVariantForStatus(transaction: Transaction) {
  if (transaction.movements.some((movement) => movement.fiatAmount === null)) {
    return "destructive"
  }

  switch (transaction.reviewStatus) {
    case "needs_review":
      return "secondary"
    case "approved":
    case "changed":
    case "auto_applied":
      return "outline"
  }
}

function sortableHeader(
  column: {
    getIsSorted: () => false | "asc" | "desc"
    toggleSorting: (desc?: boolean) => void
  },
  label: string,
  className?: string
) {
  return (
    <Button
      className={cn("h-8 px-2 text-xs font-medium", className)}
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      size="sm"
      variant="ghost"
    >
      {label}
      <ArrowUpDown data-icon="inline-end" />
    </Button>
  )
}

const columns: ColumnDef<Transaction>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all transactions"
        checked={
          table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(Boolean(value))}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select ${row.original.providerDescription ?? row.original.transactionId}`}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
      />
    ),
    enableHiding: false,
    enableSorting: false,
  },
  {
    accessorKey: "timestamp",
    header: ({ column }) => sortableHeader(column, "Date"),
    cell: ({ row }) => {
      const date = new Date(row.original.timestamp)

      return (
        <div className="min-w-28">
          <div className="font-medium tabular-nums">{dateFormatter.format(date)}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {timeFormatter.format(date)}
          </div>
        </div>
      )
    },
  },
  {
    accessorKey: "transactionType",
    header: "Type",
    cell: ({ row }) => (
      <Badge variant="outline">{transactionLabel(row.original.transactionType)}</Badge>
    ),
  },
  {
    accessorKey: "providerDescription",
    header: "Summary",
    cell: ({ row }) => (
      <div className="min-w-72">
        <div className="font-medium">{row.original.providerDescription ?? "Transaction"}</div>
        <div className="text-xs text-muted-foreground">
          {movementSummary(row.original.movements)}
        </div>
      </div>
    ),
  },
  {
    accessorKey: "fiatValue",
    header: ({ column }) => sortableHeader(column, "Value", "ml-auto"),
    cell: ({ row }) => (
      <div
        className={cn(
          "text-right font-medium tabular-nums",
          row.original.fiatValue === null && "text-muted-foreground"
        )}
      >
        {formatCurrency(row.original.fiatValue)}
      </div>
    ),
    sortingFn: (left, right) =>
      Number(left.original.fiatValue ?? Number.NEGATIVE_INFINITY) -
      Number(right.original.fiatValue ?? Number.NEGATIVE_INFINITY),
  },
  {
    accessorKey: "realizedGainLoss",
    header: ({ column }) => sortableHeader(column, "Gain/loss", "ml-auto"),
    cell: ({ row }) => {
      const gainLoss = row.original.realizedGainLoss

      return (
        <div
          className={cn(
            "text-right font-medium tabular-nums",
            gainLoss === null && "text-muted-foreground",
            gainLoss !== null && Number(gainLoss) < 0 && "text-destructive"
          )}
        >
          {formatSignedCurrency(gainLoss)}
        </div>
      )
    },
    sortingFn: (left, right) =>
      Number(left.original.realizedGainLoss ?? Number.NEGATIVE_INFINITY) -
      Number(right.original.realizedGainLoss ?? Number.NEGATIVE_INFINITY),
  },
  {
    accessorKey: "taxableTreatment",
    header: "Tax treatment",
    cell: ({ row }) => (
      <Badge variant={badgeVariantForTreatment(row.original.taxableTreatment)}>
        {treatmentLabel(row.original.taxableTreatment)}
      </Badge>
    ),
  },
  {
    accessorKey: "reviewStatus",
    header: "Status",
    cell: ({ row }) => {
      const status = reviewLabel(row.original)
      const Icon =
        status === "Missing price" || status === "Needs review" ? CircleAlert : CheckCircle2

      return (
        <Badge variant={badgeVariantForStatus(row.original)}>
          <Icon />
          {status}
        </Badge>
      )
    },
  },
  {
    accessorKey: "sourceName",
    header: "Source",
    cell: ({ row }) => (
      <div className="min-w-36">
        <div className="font-medium">{row.original.sourceName}</div>
        <div className="text-xs text-muted-foreground">
          {row.original.blockchainName ?? row.original.sourceProviderKey ?? "CEX"}
        </div>
      </div>
    ),
  },
  {
    accessorKey: "counterpartyLabel",
    header: "Counterparty",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.counterpartyLabel ?? "n/a"}</span>
    ),
  },
  {
    accessorKey: "blockchainName",
    header: "Network",
    cell: ({ row }) => <span>{row.original.blockchainName ?? "n/a"}</span>,
  },
  {
    accessorKey: "chainTxId",
    header: "Hash",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {formatHash(row.original.chainTxId)}
      </span>
    ),
  },
  {
    accessorKey: "costBasis",
    header: "Cost basis",
    cell: ({ row }) => (
      <div className="text-right tabular-nums text-muted-foreground">
        {row.original.costBasis === null ? "n/a" : formatCurrency(row.original.costBasis)}
      </div>
    ),
    sortingFn: (left, right) =>
      Number(left.original.costBasis ?? Number.NEGATIVE_INFINITY) -
      Number(right.original.costBasis ?? Number.NEGATIVE_INFINITY),
  },
  {
    accessorKey: "proceeds",
    header: "Proceeds",
    cell: ({ row }) => (
      <div className="text-right tabular-nums text-muted-foreground">
        {row.original.proceeds === null ? "n/a" : formatCurrency(row.original.proceeds)}
      </div>
    ),
    sortingFn: (left, right) =>
      Number(left.original.proceeds ?? Number.NEGATIVE_INFINITY) -
      Number(right.original.proceeds ?? Number.NEGATIVE_INFINITY),
  },
  {
    id: "actions",
    enableHiding: false,
    cell: ({ row }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Open actions for ${row.original.providerDescription ?? row.original.transactionId}`}
            size="icon-sm"
            variant="ghost"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem>
            <Eye />
            Open details
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={row.original.chainTxId === null}
            onClick={() => {
              if (row.original.chainTxId !== null) {
                void navigator.clipboard.writeText(row.original.chainTxId)
              }
            }}
          >
            <Copy />
            Copy hash
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={row.original.chainTxId === null}>
            <ExternalLink />
            View on explorer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
]

export function TransactionsTable() {
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    counterpartyLabel: false,
    blockchainName: false,
    chainTxId: false,
    costBasis: false,
    proceeds: false,
  })
  const [globalFilter, setGlobalFilter] = useState("")
  const [rowSelection, setRowSelection] = useState({})

  const table = useReactTable({
    columns,
    data: transactions,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    state: {
      columnVisibility,
      globalFilter,
      rowSelection,
      sorting,
    },
  })

  const selectedRows = table.getFilteredSelectedRowModel().rows.length
  const filteredRows = table.getFilteredRowModel().rows.length

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder="Search transactions"
            value={globalFilter}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="sm:ml-auto" variant="outline">
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  checked={column.getIsVisible()}
                  key={column.id}
                  onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
                >
                  {columnLabels[column.id] ?? column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="overflow-hidden rounded-md border bg-background">
        <Table className="min-w-[76rem]">
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow className="hover:bg-transparent" key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead className="text-xs" key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow data-state={row.getIsSelected() ? "selected" : undefined} key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  className="h-24 text-center text-muted-foreground"
                  colSpan={columns.length}
                >
                  No transactions match your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="tabular-nums">
          {selectedRows > 0
            ? `${selectedRows} of ${filteredRows} selected`
            : `${filteredRows} transactions`}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            size="sm"
            variant="outline"
          >
            Previous
          </Button>
          <Button
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            size="sm"
            variant="outline"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
