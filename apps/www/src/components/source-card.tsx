import type * as React from "react"

import { cn } from "#/lib/utils"

export type SourceKind = "exchange" | "wallet"

export type Source = {
  id: string
  name: string
  kind: SourceKind
  network?: string
  providerKey?: string
  importedTransactions: number
  unresolvedItems: number
  lastSync: string
}

type SourceCardStyle = {
  background: string
  foreground: string
  muted: string
  pattern: "bars" | "grid" | "waves"
}

const KNOWN_SOURCE_CARD_STYLES: Record<string, SourceCardStyle> = {
  arbitrum: {
    background: "#20314f",
    foreground: "#f3f7ff",
    muted: "rgb(243 247 255 / 0.68)",
    pattern: "grid",
  },
  "arbitrum-wallet": {
    background: "#20314f",
    foreground: "#f3f7ff",
    muted: "rgb(243 247 255 / 0.68)",
    pattern: "grid",
  },
  base: {
    background: "#0052ff",
    foreground: "#f7fbff",
    muted: "rgb(247 251 255 / 0.72)",
    pattern: "waves",
  },
  "base-wallet": {
    background: "#0052ff",
    foreground: "#f7fbff",
    muted: "rgb(247 251 255 / 0.72)",
    pattern: "waves",
  },
  binance: {
    background: "#f0b90b",
    foreground: "#2b2100",
    muted: "rgb(43 33 0 / 0.68)",
    pattern: "grid",
  },
  bitcoin: {
    background: "#f7931a",
    foreground: "#2a1300",
    muted: "rgb(42 19 0 / 0.68)",
    pattern: "grid",
  },
  "bitcoin-rpc": {
    background: "#f7931a",
    foreground: "#2a1300",
    muted: "rgb(42 19 0 / 0.68)",
    pattern: "grid",
  },
  bitstamp: {
    background: "#003c32",
    foreground: "#eafff6",
    muted: "rgb(234 255 246 / 0.7)",
    pattern: "bars",
  },
  coinbase: {
    background: "#2962ff",
    foreground: "#f8fbff",
    muted: "rgb(248 251 255 / 0.72)",
    pattern: "waves",
  },
  ethereum: {
    background: "#627eea",
    foreground: "#f8fbff",
    muted: "rgb(248 251 255 / 0.72)",
    pattern: "grid",
  },
  etherscan: {
    background: "#627eea",
    foreground: "#f8fbff",
    muted: "rgb(248 251 255 / 0.72)",
    pattern: "grid",
  },
  evm: {
    background: "#627eea",
    foreground: "#f8fbff",
    muted: "rgb(248 251 255 / 0.72)",
    pattern: "grid",
  },
  kraken: {
    background: "#5841d8",
    foreground: "#f8f6ff",
    muted: "rgb(248 246 255 / 0.7)",
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
  phantom: {
    background: "#ab9ff2",
    foreground: "#17112c",
    muted: "rgb(23 17 44 / 0.66)",
    pattern: "waves",
  },
  rainbow: {
    background: "#ff4000",
    foreground: "#fff7f2",
    muted: "rgb(255 247 242 / 0.72)",
    pattern: "waves",
  },
  solana: {
    background: "#9945ff",
    foreground: "#f9f4ff",
    muted: "rgb(249 244 255 / 0.72)",
    pattern: "bars",
  },
  "helius-solana": {
    background: "#9945ff",
    foreground: "#f9f4ff",
    muted: "rgb(249 244 255 / 0.72)",
    pattern: "bars",
  },
  "solana-wallet": {
    background: "#9945ff",
    foreground: "#f9f4ff",
    muted: "rgb(249 244 255 / 0.72)",
    pattern: "bars",
  },
}

const GENERATED_SOURCE_CARD_STYLES: readonly [SourceCardStyle, ...ReadonlyArray<SourceCardStyle>] =
  [
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

const SOURCE_BAR_PATTERN = [
  62, 72, 82, 92, 68, 56, 46, 38, 48, 58, 66, 74, 82, 88, 76, 64, 52, 44, 56, 70, 84, 94,
] as const

const SOURCE_WAVE_PATTERN = [96, 88, 92, 86, 98, 90, 84, 94, 89, 97, 83, 91, 95, 87] as const

const SOURCE_GRID_PATTERN = [
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

const SOURCE_CHIP_PATTERN = [true, false, true, false, true, false, true, false, true] as const

export function SourceCard({
  action,
  className,
  height = "10.75rem",
  isSyncing = false,
  source,
  width = "17rem",
}: {
  action?: React.ReactNode
  className?: string
  height?: number | string
  isSyncing?: boolean
  source: Source
  width?: number | string
}) {
  const style = getSourceCardStyle(source)

  return (
    <span
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-2xl p-5 text-left shadow-lg ring-1 ring-black/10",
        className
      )}
      style={{
        backgroundColor: style.background,
        color: style.foreground,
        height,
        width,
      }}
    >
      <SourceCardPattern source={source} />
      <span className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/18 via-transparent to-black/18" />
      {isSyncing ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_78%_18%,rgba(255,255,255,0.34),transparent_26%),linear-gradient(90deg,transparent,rgba(255,255,255,0.16),transparent)]"
        />
      ) : null}
      <span className="relative z-10 flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-lg font-semibold tracking-normal">
            {source.name}
          </span>
          <span className="mt-1 block truncate text-xs" style={{ color: style.muted }}>
            {formatSourceKind(source.kind)}
            {source.network ? ` · ${source.network}` : ""}
          </span>
        </span>
        <span className="rounded-full bg-black/10 px-2 py-1 text-xs tabular-nums backdrop-blur-sm">
          {formatInteger(source.importedTransactions)}
        </span>
      </span>

      <span className="relative z-10 flex items-center justify-between">
        <span className="grid h-8 w-11 grid-cols-3 gap-0.5 rounded-md bg-white/45 p-1 shadow-inner ring-1 ring-black/10">
          {SOURCE_CHIP_PATTERN.map((filled, chipIndex) => (
            <span
              className={cn("rounded-[1px]", filled ? "bg-black/35" : "bg-black/15")}
              key={chipIndex}
            />
          ))}
        </span>
      </span>

      <span className="relative z-10 flex items-end justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-mono text-sm tabular-nums tracking-normal">
            •••• •••• {source.id.toString().padStart(4, "0").slice(-4)}
          </span>
          <span className="mt-1 block truncate text-xs" style={{ color: style.muted }}>
            {source.lastSync}
          </span>
        </span>
        {action ? <span className="shrink-0 z-20 flex justify-end">{action}</span> : null}
        {/* <span className="shrink-0 text-right text-xs font-medium">
          {source.unresolvedItems > 0 ? `${source.unresolvedItems} open` : ""}
        </span> */}
      </span>
    </span>
  )
}

function getSourceCardStyle(source: Source) {
  const knownStyle = getKnownSourceCardStyle(source)

  if (knownStyle) {
    return knownStyle
  }

  const styleIndex = hashString(source.id) % GENERATED_SOURCE_CARD_STYLES.length
  return GENERATED_SOURCE_CARD_STYLES[styleIndex] ?? GENERATED_SOURCE_CARD_STYLES[0]
}

function getKnownSourceCardStyle(source: Source): SourceCardStyle | undefined {
  for (const value of [source.providerKey, source.network, source.name, source.id]) {
    const key = normalizeSourceStyleKey(value)

    if (key === undefined) {
      continue
    }

    const style = KNOWN_SOURCE_CARD_STYLES[key]

    if (style) {
      return style
    }
  }

  return undefined
}

function normalizeSourceStyleKey(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")

  return normalized === "" ? undefined : normalized
}

function hashString(value: string) {
  let hash = 0

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }

  return hash
}

function SourceCardPattern({ source }: { source: Source }) {
  const style = getSourceCardStyle(source)

  if (style.pattern === "grid") {
    return (
      <span
        aria-hidden="true"
        className="absolute inset-x-4 top-5 grid grid-cols-7 gap-1 opacity-45"
      >
        {SOURCE_GRID_PATTERN.map((filled, index) => (
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
        {SOURCE_WAVE_PATTERN.map((width, index) => (
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
      {SOURCE_BAR_PATTERN.map((height, index) => (
        <span
          className="w-1 rounded-full bg-current"
          key={index}
          style={{ height: `${height}%` }}
        />
      ))}
    </span>
  )
}

function formatSourceKind(kind: SourceKind): string {
  return kind === "exchange" ? "Exchange" : "Wallet"
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}
