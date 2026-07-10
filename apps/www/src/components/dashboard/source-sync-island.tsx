import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { Check, CircleX, RotateCcw, X } from "lucide-react"

import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

export type SourceSyncStatus = "queued" | "running" | "completed" | "failed"

export type SourceSyncIslandItem = {
  id: string
  sourceName: string
  status: SourceSyncStatus
  progress: number
  importedRecords?: number
  normalizedRecords?: number
  failedRecords?: number
  message?: string
}

type SourceSyncIslandProps = {
  items: ReadonlyArray<SourceSyncIslandItem>
  onDismiss?: (item: SourceSyncIslandItem) => void
  onRetry?: (item: SourceSyncIslandItem) => void
}

type MockScenario = "live" | SourceSyncStatus | "multiple"

const DEV_MOCKS_ENABLED = import.meta.env.DEV && import.meta.env.MODE !== "test"

const MOCK_SCENARIOS: Record<Exclude<MockScenario, "live">, ReadonlyArray<SourceSyncIslandItem>> = {
  queued: [
    {
      id: "mock-coinbase",
      progress: 0,
      sourceName: "Coinbase",
      status: "queued",
    },
  ],
  running: [
    {
      id: "mock-coinbase",
      importedRecords: 24,
      normalizedRecords: 21,
      progress: 18,
      sourceName: "Coinbase",
      status: "running",
    },
  ],
  completed: [
    {
      failedRecords: 0,
      id: "mock-coinbase",
      importedRecords: 284,
      normalizedRecords: 284,
      progress: 100,
      sourceName: "Coinbase",
      status: "completed",
    },
  ],
  failed: [
    {
      failedRecords: 5,
      id: "mock-coinbase",
      importedRecords: 104,
      message: "Coinbase stopped responding. Your imported records are safe.",
      normalizedRecords: 99,
      progress: 100,
      sourceName: "Coinbase",
      status: "failed",
    },
  ],
  multiple: [
    {
      id: "mock-coinbase",
      importedRecords: 24,
      normalizedRecords: 21,
      progress: 18,
      sourceName: "Coinbase",
      status: "running",
    },
    {
      id: "mock-kraken",
      progress: 0,
      sourceName: "Kraken",
      status: "queued",
    },
    {
      id: "mock-phantom",
      importedRecords: 57,
      normalizedRecords: 52,
      progress: 0,
      sourceName: "Phantom",
      status: "running",
    },
  ],
}

const MOCK_SCENARIO_OPTIONS: ReadonlyArray<{ label: string; value: MockScenario }> = [
  { label: "Live", value: "live" },
  { label: "Queued", value: "queued" },
  { label: "Syncing", value: "running" },
  { label: "Synced", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "+2", value: "multiple" },
]

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after the trigger.
 *
 *    0ms   compact activity orb appears, scale 0.9 → 1
 *   80ms   shell unfolds to the content-owned 284px sync view
 *  180ms   a failed sync expands to reveal recovery details
 * on tap   shell morphs while its headline stays mounted and visually stable
 *  +0ms    detail content fades and moves 4px into the expanded shell
 * ───────────────────────────────────────────────────────── */

const TIMING = {
  activeReveal: 80, // shell unfolds after the compact orb lands
  failureReveal: 180, // failed sync reveals its recovery details
  detailReveal: 180, // detail content settles into the expanded shell
  progressCycle: 1400, // indeterminate progress makes one pass
}

const VIEW_STAGE = {
  compact: 0,
  active: 1,
  expanded: 2,
} as const

const ISLAND = {
  enterScale: 0.9,
  exitScale: 0.96,
  enterY: -8,
  exitY: -6,
  tapScale: 0.98,
  elementSpring: { type: "spring" as const, bounce: 0.22 },
  shellSpring: { type: "spring" as const, bounce: 0, visualDuration: 0.24 },
  reducedTransition: { duration: 0 },
}

const CONTENT = {
  offsetY: -4,
  easeOut: [0.22, 1, 0.36, 1] as const,
}

const ORB = {
  center: 16,
  fullRotation: 360,
  radius: 12.5,
  strokeWidth: 4,
  runningDash: "0.3 0.7",
  queuedDash: "0.05 0.11",
}

const PROGRESS = {
  flashOpacity: 0.24,
}

const CONTENT_VARIANTS = {
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: CONTENT.offsetY,
  },
  initial: {
    opacity: 0,
    scale: 0.98,
    y: CONTENT.offsetY,
  },
}

const CONTENT_TRANSITION = {
  duration: toSeconds(TIMING.detailReveal),
  ease: CONTENT.easeOut,
}

const statusLabel: Record<SourceSyncStatus, string> = {
  queued: "Queued",
  running: "Syncing",
  completed: "Synced",
  failed: "Failed",
}

const statusTone: Record<SourceSyncStatus, string> = {
  queued: "text-sync-island-muted",
  running: "text-sync-island-accent",
  completed: "text-sync-island-complete",
  failed: "text-sync-island-failed",
}

const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

export function SourceSyncIsland({ items, onDismiss, onRetry }: SourceSyncIslandProps) {
  const reduceMotion = useReducedMotion()
  const [mockScenario, setMockScenario] = useState<MockScenario>("running")
  const usingMockScenario = DEV_MOCKS_ENABLED && mockScenario !== "live"
  const visibleItems = usingMockScenario ? MOCK_SCENARIOS[mockScenario] : items
  const primaryItem = visibleItems[0]
  const [stage, setStage] = useState<number>(VIEW_STAGE.compact)

  useEffect(() => {
    if (!primaryItem) {
      setStage(VIEW_STAGE.compact)
      return
    }

    if (reduceMotion) {
      setStage(VIEW_STAGE.active)
      return
    }

    setStage(VIEW_STAGE.compact)
    const timerId = window.setTimeout(() => setStage(VIEW_STAGE.active), TIMING.activeReveal)

    return () => window.clearTimeout(timerId)
  }, [primaryItem?.id, reduceMotion])

  useEffect(() => {
    if (primaryItem?.status !== "failed") {
      return
    }

    if (reduceMotion) {
      setStage(VIEW_STAGE.expanded)
      return
    }

    const timerId = window.setTimeout(() => setStage(VIEW_STAGE.expanded), TIMING.failureReveal)

    return () => window.clearTimeout(timerId)
  }, [primaryItem?.status, reduceMotion])

  const expanded = stage === VIEW_STAGE.expanded
  const compact = stage === VIEW_STAGE.compact

  const toggleDetails = () =>
    setStage((currentStage) =>
      currentStage === VIEW_STAGE.expanded ? VIEW_STAGE.active : VIEW_STAGE.expanded
    )

  const effectiveOnDismiss = usingMockScenario ? () => setMockScenario("live") : onDismiss
  const effectiveOnRetry = usingMockScenario ? () => setMockScenario("running") : onRetry

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-[max(1rem,env(safe-area-inset-top))] z-50 flex justify-center px-4">
        <AnimatePresence mode="popLayout">
          {primaryItem ? (
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="pointer-events-auto relative isolate w-fit min-w-14 overflow-hidden rounded-[2rem] bg-sync-island font-interface text-sync-island-foreground will-change-transform [--background:var(--sync-island)] [--border:var(--sync-island-border)] [--foreground:var(--sync-island-foreground)] [--muted:rgb(255_255_255_/_0.08)] [--muted-foreground:var(--sync-island-muted)] [--secondary:rgb(255_255_255_/_0.1)] [--secondary-foreground:var(--sync-island-foreground)]"
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: ISLAND.exitScale, y: ISLAND.exitY }
              }
              initial={
                reduceMotion
                  ? { opacity: 1 }
                  : { opacity: 0, scale: ISLAND.enterScale, y: ISLAND.enterY }
              }
              layout
              transition={getShellTransition(Boolean(reduceMotion))}
            >
              <CompletionGlow reduceMotion={Boolean(reduceMotion)} status={primaryItem.status} />

              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  animate="animate"
                  exit={reduceMotion ? { opacity: 0 } : "exit"}
                  initial={reduceMotion ? false : "initial"}
                  key={`${primaryItem.id}-${compact ? "compact" : "active"}`}
                  transition={reduceMotion ? ISLAND.reducedTransition : CONTENT_TRANSITION}
                  variants={CONTENT_VARIANTS}
                >
                  {compact ? (
                    <CompactIslandContent
                      item={primaryItem}
                      onOpen={toggleDetails}
                      reduceMotion={Boolean(reduceMotion)}
                    />
                  ) : (
                    <ActiveIslandContent
                      expanded={expanded}
                      item={primaryItem}
                      items={visibleItems}
                      onDismiss={effectiveOnDismiss}
                      onOpen={toggleDetails}
                      onRetry={effectiveOnRetry}
                      reduceMotion={Boolean(reduceMotion)}
                    />
                  )}
                </motion.div>
              </AnimatePresence>

              <span aria-live="polite" className="sr-only" role="status">
                {getAnnouncement(visibleItems)}
              </span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {DEV_MOCKS_ENABLED ? (
        <MockScenarioControls scenario={mockScenario} onScenarioChange={setMockScenario} />
      ) : null}
    </>
  )
}

function MockScenarioControls({
  onScenarioChange,
  scenario,
}: {
  onScenarioChange: (scenario: MockScenario) => void
  scenario: MockScenario
}) {
  return (
    <aside className="fixed left-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 rounded-2xl border border-white/10 bg-black/90 p-2 font-interface text-white shadow-2xl backdrop-blur-xl">
      <p className="px-2 pt-1 pb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-white/45">
        Sync island mock
      </p>
      <div aria-label="Sync island mock state" className="flex flex-wrap gap-1" role="group">
        {MOCK_SCENARIO_OPTIONS.map((option) => {
          const selected = option.value === scenario

          return (
            <button
              aria-pressed={selected}
              className={cn(
                "min-h-11 rounded-full px-3 text-xs font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-1 focus-visible:ring-white/70",
                selected
                  ? "bg-white text-black"
                  : "text-white/60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/10 [@media(hover:hover)_and_(pointer:fine)]:hover:text-white"
              )}
              key={option.value}
              onClick={() => onScenarioChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function CompactIslandContent({
  item,
  onOpen,
  reduceMotion,
}: {
  item: SourceSyncIslandItem
  onOpen: () => void
  reduceMotion: boolean
}) {
  return (
    <motion.button
      aria-label={`Show sync details for ${item.sourceName}`}
      className="grid size-11 touch-manipulation place-items-center rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40"
      onClick={onOpen}
      type="button"
      whileTap={reduceMotion ? undefined : { scale: ISLAND.tapScale }}
    >
      <StatusOrb progress={item.progress} reduceMotion={reduceMotion} status={item.status} />
    </motion.button>
  )
}

function ActiveIslandContent({
  expanded,
  item,
  items,
  onDismiss,
  onOpen,
  onRetry,
  reduceMotion,
}: {
  expanded: boolean
  item: SourceSyncIslandItem
  items: ReadonlyArray<SourceSyncIslandItem>
  onDismiss?: (item: SourceSyncIslandItem) => void
  onOpen: () => void
  onRetry?: (item: SourceSyncIslandItem) => void
  reduceMotion: boolean
}) {
  const headline = getIslandHeadline(items)
  const dismissible = item.status === "completed" || item.status === "failed"

  return (
    <div
      className={cn(
        "max-w-[calc(100vw-2rem)]",
        expanded ? "w-[min(21rem,calc(100vw-2rem))]" : "w-fit"
      )}
    >
      <div className={cn("flex items-center gap-2", expanded ? "px-2 pt-2" : "p-0")}>
        <motion.button
          aria-controls={`source-sync-details-${item.id}`}
          aria-expanded={expanded}
          aria-label={
            expanded ? `Hide sync details for ${item.sourceName}` : `Show sync details: ${headline}`
          }
          className="flex min-h-11 min-w-0 flex-1 touch-manipulation items-center gap-2 rounded-[1.5rem] pl-3 pr-4 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-marketing-surface-hover-muted"
          layout="position"
          onClick={onOpen}
          type="button"
          whileTap={reduceMotion ? undefined : { scale: ISLAND.tapScale }}
        >
          <SyncHeadline item={item} items={items} reduceMotion={reduceMotion} />
        </motion.button>
        {expanded && dismissible && onDismiss ? (
          <div className="shrink-0 pr-2">
            <Button
              aria-label={`Dismiss ${item.sourceName} sync status`}
              className="shrink-0"
              onClick={() => onDismiss(item)}
              size="icon-xs"
              type="button"
              variant="secondary"
            >
              <X aria-hidden="true" strokeWidth={4} />
            </Button>
          </div>
        ) : null}
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {expanded ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="px-5 pt-3 pb-4"
            exit={{ opacity: 0, y: CONTENT.offsetY }}
            id={`source-sync-details-${item.id}`}
            initial={reduceMotion ? false : { opacity: 0, y: CONTENT.offsetY }}
            key="details"
            transition={reduceMotion ? ISLAND.reducedTransition : CONTENT_TRANSITION}
          >
            <SyncMetrics item={item} />

            {item.message ? (
              <p
                className={cn(
                  "mt-3 text-xs leading-5 font-medium",
                  item.status === "failed" ? "text-sync-island-failed" : "text-sync-island-muted"
                )}
              >
                {item.message}
              </p>
            ) : null}

            {items.length > 1 ? <SyncQueue items={items.slice(1)} /> : null}

            {item.status === "failed" || item.status === "completed" ? (
              <div className="mt-3 flex items-center justify-end gap-2">
                {item.status === "failed" && onRetry ? (
                  <Button onClick={() => onRetry(item)} size="sm" type="button" variant="secondary">
                    <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function SyncHeadline({
  item,
  items,
  reduceMotion,
}: {
  item: SourceSyncIslandItem
  items: ReadonlyArray<SourceSyncIslandItem>
  reduceMotion: boolean
}) {
  return (
    <>
      <StatusOrb progress={item.progress} reduceMotion={reduceMotion} status={item.status} />
      <span className="min-w-0 truncate text-[0.8125rem] font-medium tracking-[-0.012em]">
        {getIslandHeadline(items)}
      </span>
    </>
  )
}

function StatusOrb({
  progress,
  reduceMotion,
  status,
}: {
  progress: number
  reduceMotion: boolean
  status: SourceSyncStatus
}) {
  const determinate = status === "running" && progress > 0 && progress < 100

  return (
    <span className="relative grid size-5 shrink-0 place-items-center rounded-full">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
        viewBox="0 0 32 32"
      >
        {status === "queued" ? (
          <circle
            className="fill-none stroke-white"
            cx={ORB.center}
            cy={ORB.center}
            pathLength="1"
            r={ORB.radius}
            strokeDasharray={ORB.queuedDash}
            strokeLinecap="round"
            strokeWidth={ORB.strokeWidth}
          />
        ) : null}
        {status === "running" ? (
          <>
            <circle
              className="fill-none stroke-white/20"
              cx={ORB.center}
              cy={ORB.center}
              r={ORB.radius}
              strokeWidth={ORB.strokeWidth}
            />
            <motion.circle
              animate={
                determinate
                  ? { pathLength: progress / 100, rotate: 0 }
                  : reduceMotion
                    ? { rotate: 0 }
                    : { rotate: ORB.fullRotation }
              }
              className="fill-none stroke-white"
              cx={ORB.center}
              cy={ORB.center}
              initial={false}
              pathLength="1"
              r={ORB.radius}
              strokeDasharray={determinate ? "1 1" : ORB.runningDash}
              strokeLinecap="round"
              strokeWidth={ORB.strokeWidth}
              transition={getOrbTransition({ determinate, reduceMotion })}
            />
          </>
        ) : null}
      </svg>

      <span
        className={cn(
          "relative grid size-5 place-items-center rounded-full",
          status === "completed" ? "bg-green-500" : "",
          status === "failed" ? "" : ""
        )}
      >
        {status === "completed" ? (
          <Check aria-hidden="true" className="size-3 text-white" strokeWidth={4} />
        ) : status === "failed" ? (
          <CircleX
            aria-hidden="true"
            className="size-4.5 text-sync-island-failed"
            strokeWidth={3}
          />
        ) : null}
      </span>
    </span>
  )
}

function CompletionGlow({
  reduceMotion,
  status,
}: {
  reduceMotion: boolean
  status: SourceSyncStatus
}) {
  if (status !== "completed") {
    return null
  }

  return (
    <motion.span
      animate={reduceMotion ? { opacity: 0 } : { opacity: [0, PROGRESS.flashOpacity, 0] }}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_50%,var(--sync-island-complete),transparent_42%)]"
      initial={false}
      transition={getFlashTransition(reduceMotion)}
    />
  )
}

function SyncMetrics({ item }: { item: SourceSyncIslandItem }) {
  const metrics = [
    { label: "Imported", value: item.importedRecords },
    { label: "Categorized", value: item.normalizedRecords },
    { label: "Failed", value: item.failedRecords },
  ]

  return (
    <dl className="grid grid-cols-3 gap-2">
      {metrics.map((metric) => (
        <div className="min-w-0" key={metric.label}>
          <dt className="truncate text-[0.625rem] font-medium uppercase tracking-[0.08em] text-sync-island-muted">
            {metric.label}
          </dt>
          <dd className="mt-1 truncate text-sm font-medium tabular-nums text-sync-island-foreground">
            {formatRecordCount(metric.value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SyncQueue({ items }: { items: ReadonlyArray<SourceSyncIslandItem> }) {
  const visibleItems = items.slice(0, 3)
  const hiddenCount = items.length - visibleItems.length

  return (
    <div className="mt-3 border-t border-sync-island-border pt-2.5">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-sync-island-muted">
        Also syncing
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {visibleItems.map((item) => (
          <li className="flex items-center justify-between gap-3 text-xs" key={item.id}>
            <span className="truncate text-sync-island-foreground">{item.sourceName}</span>
            <span className={cn("shrink-0", statusTone[item.status])}>
              {statusLabel[item.status]}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <p className="mt-2 text-xs tabular-nums text-sync-island-muted">
          +{hiddenCount} more {hiddenCount === 1 ? "source" : "sources"}
        </p>
      ) : null}
    </div>
  )
}

function getIslandHeadline(items: ReadonlyArray<SourceSyncIslandItem>): string {
  const primaryItem = items[0]
  const sourceNames = getSourceNames(items)

  switch (primaryItem?.status) {
    case "queued":
      return `Waiting for ${sourceNames}`
    case "running":
      return `Syncing ${sourceNames}`
    case "completed":
      return `Synced ${sourceNames}`
    case "failed":
      return `Couldn't sync ${sourceNames}`
    default:
      return "Syncing"
  }
}

function getSourceNames(items: ReadonlyArray<SourceSyncIslandItem>): string {
  const firstSource = items[0]?.sourceName ?? "source"
  const secondSource = items[1]?.sourceName

  if (!secondSource) {
    return firstSource
  }

  if (items.length === 2) {
    return `${firstSource} and ${secondSource}`
  }

  return `${firstSource}, ${secondSource} + ${items.length - 2} more`
}

function getAnnouncement(items: ReadonlyArray<SourceSyncIslandItem>): string {
  const primaryItem = items[0]

  return primaryItem?.status === "failed"
    ? `${getIslandHeadline(items)}. ${primaryItem.message ?? "Open sync details to retry."}`
    : `${getIslandHeadline(items)}.`
}

function formatRecordCount(value: number | undefined): string {
  return value === undefined ? "—" : integerFormatter.format(value)
}

function getShellTransition(reduceMotion: boolean) {
  return reduceMotion ? ISLAND.reducedTransition : ISLAND.shellSpring
}

function getOrbTransition({
  determinate,
  reduceMotion,
}: {
  determinate: boolean
  reduceMotion: boolean
}) {
  if (reduceMotion) {
    return ISLAND.reducedTransition
  }

  return determinate
    ? ISLAND.elementSpring
    : {
        duration: toSeconds(TIMING.progressCycle),
        ease: "linear" as const,
        repeat: Infinity,
      }
}

function getFlashTransition(reduceMotion: boolean) {
  return reduceMotion
    ? ISLAND.reducedTransition
    : { duration: toSeconds(TIMING.detailReveal), ease: CONTENT.easeOut }
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000
}
