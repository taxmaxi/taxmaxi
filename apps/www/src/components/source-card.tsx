import { cn } from "#/lib/utils"

export type SourceKind = "exchange" | "wallet"

export type Source = {
  id: string
  name: string
  kind: SourceKind
  network?: string
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

const SOURCE_CARD_STYLES: Partial<Record<string, SourceCardStyle>> = {
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
  className,
  height = "10.75rem",
  source,
  width = "17rem",
}: {
  className?: string
  height?: number | string
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
        <span className="font-mono text-xs tabular-nums opacity-75">
          {source.kind === "exchange" ? "API" : "WALLET"}
        </span>
      </span>

      <span className="relative z-10 flex items-end justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-mono text-sm tabular-nums tracking-normal">
            •••• {source.importedTransactions.toString().padStart(4, "0").slice(-4)}
          </span>
          <span className="mt-1 block truncate text-xs" style={{ color: style.muted }}>
            {source.lastSync}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs font-medium">
          {source.unresolvedItems > 0 ? `${source.unresolvedItems} open` : "Clean"}
        </span>
      </span>
    </span>
  )
}

function getSourceCardStyle(source: Source) {
  const bespokeStyle = SOURCE_CARD_STYLES[source.id]

  if (bespokeStyle) {
    return bespokeStyle
  }

  const styleIndex = hashString(source.id) % GENERATED_SOURCE_CARD_STYLES.length
  return GENERATED_SOURCE_CARD_STYLES[styleIndex] ?? GENERATED_SOURCE_CARD_STYLES[0]
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
