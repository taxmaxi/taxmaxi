import type * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useRef, useState } from "react"

import { cn } from "#/lib/utils"

import { SourceCard, type Source } from "./source-card"

/* ---------------------------------------------------------
 * SOURCE STACK STORYBOARD
 *
 *   0ms   resting cards sit half behind the content section
 * 120ms   hovered card peeks 90% above the section
 * 220ms   selected card peeks fully above the section
 * --------------------------------------------------------- */

const SOURCE_STACK = {
  height: "21.5rem", // 2x card height; selection never shifts layout
  sectionOffset: "14rem", // where the shared content section starts covering cards
  hoverY: 70, // leaves roughly 90% of the card visible above the section
  cardWidth: "17rem",
  cardWidthPx: 272,
  cardHeight: "10.75rem",
  fan: {
    startX: 24,
    minStepX: 54,
    maxStepX: 190,
    sidePadding: 24,
    restY: 138,
    inactiveY: 176,
    selectedY: 20,
  },
  hoverScale: 1.045,
  tapScale: 0.98,
  spring: { type: "spring" as const, stiffness: 230, damping: 28, mass: 0.9 },
  reducedTransition: { duration: 0 },
}

const stressSourceNetworks = ["Ethereum", "Solana", "Base", "Arbitrum", "Optimism"] as const

const stressSources: ReadonlyArray<Source> = Array.from({ length: 23 }, (_, index) => {
  const displayIndex = index + 1
  const kind: Source["kind"] = index % 4 === 0 ? "exchange" : "wallet"
  const source = {
    id: `stress-source-${displayIndex.toString().padStart(2, "0")}`,
    name: kind === "exchange" ? `Exchange ${displayIndex}` : `Wallet ${displayIndex}`,
    kind,
    importedTransactions: 24 + displayIndex * 11,
    unresolvedItems: displayIndex % 5,
    lastSync: displayIndex % 2 === 0 ? "Today, 11:02" : "Yesterday, 17:45",
  }

  return kind === "wallet"
    ? { ...source, network: stressSourceNetworks[index % stressSourceNetworks.length] }
    : source
})

const sourceFixtures: ReadonlyArray<Source> = [
  {
    id: "coinbase",
    name: "Coinbase",
    kind: "exchange",
    importedTransactions: 418,
    unresolvedItems: 2,
    lastSync: "Today, 09:41",
  },
  {
    id: "kraken",
    name: "Kraken",
    kind: "exchange",
    importedTransactions: 126,
    unresolvedItems: 0,
    lastSync: "Yesterday, 18:22",
  },
  {
    id: "solana-wallet",
    name: "Solana wallet",
    kind: "wallet",
    network: "Solana",
    importedTransactions: 87,
    unresolvedItems: 4,
    lastSync: "Today, 08:13",
  },
  {
    id: "binance",
    name: "Binance",
    kind: "exchange",
    importedTransactions: 302,
    unresolvedItems: 1,
    lastSync: "Today, 07:58",
  },
  {
    id: "ledger",
    name: "Ledger vault",
    kind: "wallet",
    network: "Ethereum",
    importedTransactions: 41,
    unresolvedItems: 0,
    lastSync: "Mon, 16:08",
  },
  {
    id: "metamask",
    name: "MetaMask",
    kind: "wallet",
    network: "Ethereum",
    importedTransactions: 156,
    unresolvedItems: 3,
    lastSync: "Today, 10:12",
  },
  {
    id: "base-wallet",
    name: "Base wallet",
    kind: "wallet",
    network: "Base",
    importedTransactions: 64,
    unresolvedItems: 2,
    lastSync: "Yesterday, 21:34",
  },
  {
    id: "arbitrum-wallet",
    name: "Arbitrum",
    kind: "wallet",
    network: "Arbitrum",
    importedTransactions: 93,
    unresolvedItems: 1,
    lastSync: "Today, 06:25",
  },
  ...stressSources,
]

export const mockSources: ReadonlyArray<Source> = sourceFixtures.slice(0, 2)

export function SourceCards({
  children,
  className,
  contentClassName,
  onSelectedSourceIdChange,
  selectedSourceId,
  sources = mockSources,
}: {
  children?: React.ReactNode
  className?: string
  contentClassName?: string
  onSelectedSourceIdChange?: (sourceId: Source["id"] | undefined) => void
  selectedSourceId?: Source["id"]
  sources?: ReadonlyArray<Source>
}) {
  return (
    <section
      className={cn("relative", className)}
      style={{ paddingTop: SOURCE_STACK.sectionOffset }}
    >
      <SourceCardRail
        onSelectedSourceIdChange={onSelectedSourceIdChange}
        selectedSourceId={selectedSourceId}
        sources={sources}
      />

      {children ? (
        <div
          className={cn(
            "relative z-20 grid gap-2 rounded-lg bg-card p-2 shadow-sm ring-1 ring-border/80",
            contentClassName
          )}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

function SourceCardRail({
  onSelectedSourceIdChange,
  selectedSourceId,
  sources,
}: {
  onSelectedSourceIdChange?: (sourceId: Source["id"] | undefined) => void
  selectedSourceId?: Source["id"]
  sources: ReadonlyArray<Source>
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const stackLayout = useMemo(
    () => getStackLayout({ containerWidth, total: sources.length }),
    [containerWidth, sources.length]
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
      className="absolute inset-x-0 top-0 z-0 overflow-clip"
      style={{ height: SOURCE_STACK.height }}
    >
      <div
        className="relative h-[21.5rem] overflow-x-auto overflow-y-clip overscroll-x-contain"
        ref={scrollerRef}
      >
        <SourceCardStack
          layout={stackLayout}
          onSelectedSourceIdChange={onSelectedSourceIdChange}
          selectedSourceId={selectedSourceId}
          sources={sources}
        />
      </div>
    </div>
  )
}

function SourceCardStack({
  layout,
  onSelectedSourceIdChange,
  selectedSourceId,
  sources,
}: {
  layout: SourceStackLayout
  onSelectedSourceIdChange?: (sourceId: Source["id"] | undefined) => void
  selectedSourceId?: Source["id"]
  sources: ReadonlyArray<Source>
}) {
  const reduceMotion = useReducedMotion()
  const selectedIndex =
    selectedSourceId === undefined
      ? -1
      : sources.findIndex((source) => source.id === selectedSourceId)

  return (
    <div className="absolute top-0 left-0" style={{ left: layout.left, width: layout.stackWidth }}>
      <div className="relative isolate overflow-visible" style={{ height: SOURCE_STACK.height }}>
        {sources.map((source, index) => {
          const active = selectedSourceId === source.id
          const resting = getCardPlacement({
            index,
            layout,
            selectedIndex,
            total: sources.length,
          })

          return (
            <motion.button
              aria-label={`${active ? "Show all sources" : `Show ${source.name}`}`}
              aria-pressed={active}
              animate={{
                opacity: 1,
                rotate: resting.rotate,
                scale: resting.scale,
                x: resting.x,
                y: resting.y,
              }}
              className="absolute left-0 top-0 outline-none will-change-transform focus-visible:ring-3 focus-visible:ring-ring/40"
              initial={false}
              key={source.id}
              onClick={() => onSelectedSourceIdChange?.(active ? undefined : source.id)}
              style={{ zIndex: resting.zIndex }}
              transition={reduceMotion ? SOURCE_STACK.reducedTransition : SOURCE_STACK.spring}
              type="button"
              whileHover={
                reduceMotion
                  ? undefined
                  : {
                      scale: resting.scale * SOURCE_STACK.hoverScale,
                      y: active ? resting.y : SOURCE_STACK.hoverY,
                    }
              }
              whileTap={reduceMotion ? undefined : { scale: resting.scale * SOURCE_STACK.tapScale }}
            >
              <SourceCard
                height={SOURCE_STACK.cardHeight}
                source={source}
                width={SOURCE_STACK.cardWidth}
              />
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

type SourceStackLayout = {
  left: number
  stackWidth: number
  startX: number
  stepX: number
}

type CardPlacement = {
  rotate: number
  scale: number
  x: number
  y: number
  zIndex: number
}

function getCardPlacement({
  index,
  layout,
  selectedIndex,
  total,
}: {
  index: number
  layout: SourceStackLayout
  selectedIndex: number
  total: number
}): CardPlacement {
  const basePlacement = getRestingPlacement({ index, layout, total })

  if (selectedIndex < 0) {
    return basePlacement
  }

  if (index === selectedIndex) {
    return {
      ...basePlacement,
      rotate: 0,
      scale: 1.05,
      y: SOURCE_STACK.fan.selectedY,
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
    y: SOURCE_STACK.fan.inactiveY,
    zIndex: Math.max(1, total - Math.abs(distance)),
  }
}

function getRestingPlacement({
  index,
  layout,
  total,
}: {
  index: number
  layout: SourceStackLayout
  total: number
}): CardPlacement {
  const center = (total - 1) / 2
  const distanceFromCenter = index - center
  const normalizedDistance = center === 0 ? 0 : distanceFromCenter / center

  return {
    x: layout.startX + index * layout.stepX,
    y: SOURCE_STACK.fan.restY + Math.abs(normalizedDistance) * 10,
    rotate: normalizedDistance * 9,
    scale: 1 - Math.abs(normalizedDistance) * 0.06,
    zIndex: index + 1,
  }
}

function getStackLayout({
  containerWidth,
  total,
}: {
  containerWidth: number
  total: number
}): SourceStackLayout {
  const cardWidth = SOURCE_STACK.cardWidthPx
  const sidePadding = SOURCE_STACK.fan.sidePadding
  const startX = SOURCE_STACK.fan.startX
  const maxStackWidth = Math.max(0, containerWidth)
  const availableStepWidth = maxStackWidth - startX - sidePadding - cardWidth
  const maxStep = SOURCE_STACK.fan.maxStepX
  const minStep = SOURCE_STACK.fan.minStepX
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
