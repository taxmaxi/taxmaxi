import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { Check, CircleX, RotateCcw, X } from "lucide-react"

import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

export type SourceSyncStatus = "queued" | "running" | "completed" | "failed"
export type SourceSyncPhase = "discovering" | "classifying" | "reconciling" | "completed"

export const SOURCE_SYNC_PROGRESS = {
  classificationStart: 50,
  completed: 100,
  discoveryTarget: 49.5,
  reconciliation: 100,
} as const

export function getSourceSyncDisplayProgress({
  phase,
  progressPercent,
  status,
}: {
  phase: SourceSyncPhase | null
  progressPercent: number | null
  status: SourceSyncStatus
}): number {
  if (status === "completed" || status === "failed") {
    return SOURCE_SYNC_PROGRESS.completed
  }

  if (status === "queued") {
    return 0
  }

  switch (phase) {
    case "discovering":
      return SOURCE_SYNC_PROGRESS.discoveryTarget
    case "classifying": {
      const classificationProgress = Math.min(100, Math.max(0, progressPercent ?? 0))
      return (
        SOURCE_SYNC_PROGRESS.classificationStart +
        (classificationProgress / 100) *
          (SOURCE_SYNC_PROGRESS.completed - SOURCE_SYNC_PROGRESS.classificationStart)
      )
    }
    case "reconciling":
    case "completed":
      return SOURCE_SYNC_PROGRESS.reconciliation
    case null:
      return 0
  }
}

export type SourceSyncIslandItem = {
  id: string
  sourceName: string
  status: SourceSyncStatus
  progress: number
  phase?: SourceSyncPhase
  processedRecords?: number
  totalRecords?: number
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
 * on sync  discovery progress advances clockwise 0% → 49.5% in continuously moving stages
 * on data  classification maps measured progress onto 50% → 100%
 * on done  ring finishes clockwise to 100% before the success state appears
 * +600ms   completed ring fades and the green check settles into place
 * ───────────────────────────────────────────────────────── */

const TIMING = {
  activeReveal: 80, // shell unfolds after the compact orb lands
  failureReveal: 180, // failed sync reveals its recovery details
  detailReveal: 180, // detail content settles into the expanded shell
  progressSettle: 450, // determinate progress catches up to the latest polled value
  discoveryTimeline: 300_000, // discovery keeps visibly creeping toward the classification boundary
  progressCompletion: 600, // terminal data waits for the ring to visibly reach 100%
  successMorph: 180, // completed ring gives way to the success check
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
  radius: 12.5,
  strokeWidth: 4,
  normalizedLength: 100,
  queuedDash: "0.05 0.11",
}

const DISCOVERY_PROGRESS: {
  strokeDashoffsets: Array<number>
  times: Array<number>
} = {
  strokeDashoffsets: [100, 80, 65, 55, 50.5],
  times: [0, 1 / 60, 1 / 12, 7 / 30, 1],
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
  const [mockScenario, setMockScenario] = useState<MockScenario>("live")
  const usingMockScenario = DEV_MOCKS_ENABLED && mockScenario !== "live"
  const rawVisibleItems = usingMockScenario ? MOCK_SCENARIOS[mockScenario] : items
  const rawPrimaryItem = rawVisibleItems[0]
  const [orchestratedPrimaryItem, setOrchestratedPrimaryItem] = useState<
    SourceSyncIslandItem | undefined
  >(rawPrimaryItem)
  const [stage, setStage] = useState<number>(VIEW_STAGE.compact)

  useEffect(() => {
    if (!rawPrimaryItem) {
      setOrchestratedPrimaryItem(undefined)
      return
    }

    if (rawPrimaryItem.status !== "completed") {
      setOrchestratedPrimaryItem(rawPrimaryItem)
      return
    }

    const completingItem: SourceSyncIslandItem = {
      ...rawPrimaryItem,
      phase: "completed",
      progress: SOURCE_SYNC_PROGRESS.completed,
      status: "running",
    }
    setOrchestratedPrimaryItem(completingItem)

    if (reduceMotion) {
      setOrchestratedPrimaryItem(rawPrimaryItem)
      return
    }

    const timerId = window.setTimeout(
      () => setOrchestratedPrimaryItem(rawPrimaryItem),
      TIMING.progressCompletion
    )

    return () => window.clearTimeout(timerId)
  }, [rawPrimaryItem, reduceMotion])

  const orchestratedMatchesPrimary = orchestratedPrimaryItem?.id === rawPrimaryItem?.id
  const awaitingCompletedRing =
    rawPrimaryItem?.status === "completed" &&
    (!orchestratedMatchesPrimary || orchestratedPrimaryItem?.status !== "completed")
  const primaryItem = awaitingCompletedRing
    ? orchestratedMatchesPrimary
      ? orchestratedPrimaryItem
      : {
          ...rawPrimaryItem,
          phase: "completed" as const,
          progress: SOURCE_SYNC_PROGRESS.completed,
          status: "running" as const,
        }
    : orchestratedMatchesPrimary
      ? orchestratedPrimaryItem
      : rawPrimaryItem
  const visibleItems = primaryItem ? [primaryItem, ...rawVisibleItems.slice(1)] : []

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
      <StatusOrb
        phase={item.phase}
        progress={item.progress}
        reduceMotion={reduceMotion}
        status={item.status}
      />
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
      <StatusOrb
        phase={item.phase}
        progress={item.progress}
        reduceMotion={reduceMotion}
        status={item.status}
      />
      <span className="min-w-0 truncate text-[0.8125rem] font-medium tracking-[-0.012em]">
        {getIslandHeadline(items)}
      </span>
    </>
  )
}

function StatusOrb({
  phase,
  progress,
  reduceMotion,
  status,
}: {
  phase: SourceSyncPhase | undefined
  progress: number
  reduceMotion: boolean
  status: SourceSyncStatus
}) {
  const progressVisible = status === "running" || status === "completed"
  const determinate = status === "running"
  const estimated = phase === "discovering"
  const completed = status === "completed"

  return (
    <span
      aria-label={
        determinate ? (estimated ? "Estimated sync progress" : "Sync progress") : undefined
      }
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuenow={determinate && !estimated ? Math.round(progress) : undefined}
      aria-valuetext={estimated ? "Discovering transactions" : undefined}
      className="relative grid size-5 shrink-0 place-items-center rounded-full"
      role={determinate ? "progressbar" : undefined}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
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
        {progressVisible ? (
          <>
            <motion.circle
              animate={{ opacity: completed ? 0 : 1 }}
              className="fill-none stroke-white/20"
              cx={ORB.center}
              cy={ORB.center}
              initial={false}
              r={ORB.radius}
              strokeWidth={ORB.strokeWidth}
              transition={getSuccessTransition(reduceMotion)}
            />
            <motion.circle
              animate={{
                opacity: completed ? 0 : 1,
                strokeDashoffset:
                  estimated && !reduceMotion
                    ? DISCOVERY_PROGRESS.strokeDashoffsets
                    : ORB.normalizedLength - progress,
              }}
              className="fill-none stroke-white"
              cx={ORB.center}
              cy={ORB.center}
              initial={reduceMotion ? false : { strokeDashoffset: ORB.normalizedLength }}
              pathLength={ORB.normalizedLength}
              r={ORB.radius}
              strokeDasharray={`${ORB.normalizedLength} ${ORB.normalizedLength}`}
              strokeLinecap="round"
              strokeWidth={ORB.strokeWidth}
              transform={`rotate(-90 ${ORB.center} ${ORB.center})`}
              transition={
                completed
                  ? getSuccessTransition(reduceMotion)
                  : getOrbTransition({ phase, reduceMotion })
              }
            />
          </>
        ) : null}
      </svg>

      <span className="relative grid size-5 place-items-center rounded-full">
        <motion.span
          animate={completed ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.82 }}
          className="absolute inset-0 grid place-items-center rounded-full bg-green-500"
          initial={false}
          transition={getSuccessTransition(reduceMotion)}
        >
          <Check aria-hidden="true" className="size-3 text-white" strokeWidth={4} />
        </motion.span>
        {status === "failed" ? (
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
  phase,
  reduceMotion,
}: {
  phase: SourceSyncPhase | undefined
  reduceMotion: boolean
}) {
  if (reduceMotion) {
    return ISLAND.reducedTransition
  }

  if (phase === "discovering") {
    return {
      duration: toSeconds(TIMING.discoveryTimeline),
      ease: "linear" as const,
      times: DISCOVERY_PROGRESS.times,
    }
  }

  return { duration: toSeconds(TIMING.progressSettle), ease: CONTENT.easeOut }
}

function getSuccessTransition(reduceMotion: boolean) {
  return reduceMotion
    ? ISLAND.reducedTransition
    : { duration: toSeconds(TIMING.successMorph), ease: CONTENT.easeOut }
}

function getFlashTransition(reduceMotion: boolean) {
  return reduceMotion
    ? ISLAND.reducedTransition
    : { duration: toSeconds(TIMING.detailReveal), ease: CONTENT.easeOut }
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000
}
