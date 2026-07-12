import type * as React from "react"

import { Badge } from "#/components/ui/badge"
import { Card, CardContent } from "#/components/ui/card"
import { ValueTone } from "#/components/value-tone"
import { formatCurrency, formatSignedCurrency, formatTokenAmount } from "#/lib/dashboard-format"
import type { Account, AccountId } from "#/lib/dashboard-types"
import { cn } from "#/lib/utils"

export type AggregatedHolding = {
  asset: string
  name: string
  amount: number
  value: number
  costBasis: number
  accountIds: ReadonlyArray<AccountId>
}

export function AssetsTable({
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
