import { useState } from "react"
import type * as React from "react"
import type { PortfolioAssets } from "taxmaxi"

import { Card, CardContent } from "#/components/ui/card"
import { ValueTone } from "#/components/value-tone"
import {
  formatCurrency,
  formatSignedCurrency,
  formatTokenAmount,
  formatTokenPrice,
} from "#/lib/dashboard-format"
import { cn } from "#/lib/utils"

type PortfolioAsset = PortfolioAssets["assets"][number]

export function AssetsTable({
  currency,
  error = false,
  holdings,
  loading = false,
}: {
  currency: string
  error?: boolean
  holdings: PortfolioAssets["assets"]
  loading?: boolean
}) {
  return (
    <Card
      className="rounded-lg border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-1 ring-marketing-border-muted supports-[backdrop-filter]:backdrop-blur-md"
      size="sm"
    >
      <CardContent className="pt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <TableHead>Asset</TableHead>
                <TableHead align="right">Amount</TableHead>
                <TableHead align="right">Price</TableHead>
                <TableHead align="right">Total value</TableHead>
                <TableHead align="right">Unrealized P/L</TableHead>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows />
              ) : error ? (
                <tr>
                  <td className="h-28 text-center text-muted-foreground" colSpan={5}>
                    Asset values could not be loaded. Try again in a moment.
                  </td>
                </tr>
              ) : holdings.length === 0 ? (
                <tr>
                  <td className="h-28 text-center text-muted-foreground" colSpan={5}>
                    No assets with an open balance yet.
                  </td>
                </tr>
              ) : (
                holdings.map((holding) => (
                  <AssetRow currency={currency} holding={holding} key={holding.assetId} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function AssetRow({ currency, holding }: { currency: string; holding: PortfolioAsset }) {
  return (
    <tr className="h-14 border-b border-border">
      <TableCell>
        <div className="flex items-center gap-3">
          <AssetMark logoUrl={holding.logoUrl} name={holding.name} symbol={holding.symbol} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{holding.symbol}</span>
            <span className="block truncate text-xs text-muted-foreground">{holding.name}</span>
          </span>
        </div>
      </TableCell>
      <TableCell align="right">{formatTokenAmount(holding.amount)}</TableCell>
      <TableCell align="right">{formatNullablePrice(holding.currentPrice, currency)}</TableCell>
      <TableCell align="right">{formatNullableCurrency(holding.totalValue, currency)}</TableCell>
      <TableCell align="right">
        {holding.profitLoss === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ValueTone tone={holding.profitLoss.startsWith("-") ? "negative" : "positive"}>
            {formatSignedCurrency(holding.profitLoss, currency)}
          </ValueTone>
        )}
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

function AssetMark({
  logoUrl,
  name,
  symbol,
}: {
  logoUrl: string | null
  name: string
  symbol: string
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const usableLogoUrl = logoUrl === failedLogoUrl ? null : logoUrl

  if (usableLogoUrl === null) {
    return (
      <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-mono text-xs font-medium ring-1 ring-border">
        {symbol.slice(0, 1)}
      </span>
    )
  }
  return (
    <span className="relative size-8">
      <img
        alt={`${name} logo`}
        className="absolute inset-0 size-full object-cover"
        loading="lazy"
        onError={() => setFailedLogoUrl(usableLogoUrl)}
        src={usableLogoUrl}
        title={name}
      />
    </span>
  )
}

function formatNullableCurrency(value: string | null, currency: string) {
  return value === null ? "—" : formatCurrency(value, currency)
}

function formatNullablePrice(value: string | null, currency: string) {
  return value === null ? "—" : formatTokenPrice(value, currency)
}

function LoadingRows() {
  return Array.from({ length: 3 }, (_, index) => (
    <tr aria-hidden="true" key={index}>
      {Array.from({ length: 5 }, (_cell, cellIndex) => (
        <TableCell align={cellIndex === 0 ? "left" : "right"} key={cellIndex}>
          <span className="inline-block h-4 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </TableCell>
      ))}
    </tr>
  ))
}
