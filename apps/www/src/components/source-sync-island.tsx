import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { RotateCcw, X } from "lucide-react"
import type { SourceSyncJob } from "taxmaxi"

import { SourceSyncStatusOrb } from "#/components/source-sync-status-orb"
import {
  SOURCE_SYNC_MOCK_SCENARIOS,
  SOURCE_SYNC_MOCKS_ENABLED,
  SourceSyncMockControls,
  type SourceSyncMockScenario,
} from "#/components/source-sync-island-mocks"
import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

export type SourceSyncStatus = SourceSyncJob["status"]
export type SourceSyncPhase = NonNullable<SourceSyncJob["phase"]>

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
  if (status === "completed" || status === "failed" || status === "credit_required") {
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

export type SourceSyncCreditOutcome = {
  reasonCode: string
  availableCredits: number
  creditsConsumed: number
  additionalCreditsRequired: number | null
}

export type SourceSyncIslandItem = {
  id: string
  sourceName: string
  status: SourceSyncStatus
  progress: number
  phase?: SourceSyncPhase
  processedRecords?: number
  totalRecords?: number
  fetchedRecords?: number
  normalizedRecords?: number
  failedRecords?: number
  message?: string
  creditOutcome?: SourceSyncCreditOutcome
}

type SourceSyncIslandProps = {
  items: ReadonlyArray<SourceSyncIslandItem>
  hasActiveSubscription?: boolean
  onBillingAction?: (item: SourceSyncIslandItem) => void
  onDismiss?: (item: SourceSyncIslandItem) => void
  onRetry?: (item: SourceSyncIslandItem) => void
}

/**
 * Copy for a credit-required sync, built only from the structured credit outcome
 * so internal error text never reaches the screen.
 */
export function getCreditRequiredCopy(creditOutcome: SourceSyncCreditOutcome | undefined): string {
  if (!creditOutcome) {
    return "This sync is paused until you add transaction credits."
  }

  const covered =
    creditOutcome.creditsConsumed > 0
      ? `${integerFormatter.format(creditOutcome.creditsConsumed)} ${
          creditOutcome.creditsConsumed === 1
            ? "transaction is already imported and stays yours."
            : "transactions are already imported and stay yours."
        } `
      : ""
  const needed =
    creditOutcome.additionalCreditsRequired === null
      ? "Add credits to finish the sync."
      : `Add ${integerFormatter.format(creditOutcome.additionalCreditsRequired)} more ${
          creditOutcome.additionalCreditsRequired === 1 ? "credit" : "credits"
        } to finish the sync.`

  return `This sync is paused: your transaction credits ran out. ${covered}${needed}`
}

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
  progressCompletion: 600, // terminal data waits for the ring to visibly reach 100%
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
  credit_required: "Needs credits",
}

const statusTone: Record<SourceSyncStatus, string> = {
  queued: "text-sync-island-muted",
  running: "text-sync-island-accent",
  completed: "text-sync-island-complete",
  failed: "text-sync-island-failed",
  credit_required: "text-sync-island-failed",
}

const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

export function SourceSyncIsland({
  items,
  hasActiveSubscription,
  onBillingAction,
  onDismiss,
  onRetry,
}: SourceSyncIslandProps) {
  const reduceMotion = useReducedMotion()
  const [mockScenario, setMockScenario] = useState<SourceSyncMockScenario>("live")
  const usingMockScenario = SOURCE_SYNC_MOCKS_ENABLED && mockScenario !== "live"
  const rawVisibleItems = usingMockScenario ? SOURCE_SYNC_MOCK_SCENARIOS[mockScenario] : items
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
    if (primaryItem?.status !== "failed" && primaryItem?.status !== "credit_required") {
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
                      hasActiveSubscription={hasActiveSubscription}
                      item={primaryItem}
                      items={visibleItems}
                      onBillingAction={onBillingAction}
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

      {SOURCE_SYNC_MOCKS_ENABLED ? (
        <SourceSyncMockControls scenario={mockScenario} onScenarioChange={setMockScenario} />
      ) : null}
    </>
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
      <SourceSyncStatusOrb
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
  hasActiveSubscription,
  item,
  items,
  onBillingAction,
  onDismiss,
  onOpen,
  onRetry,
  reduceMotion,
}: {
  expanded: boolean
  hasActiveSubscription?: boolean
  item: SourceSyncIslandItem
  items: ReadonlyArray<SourceSyncIslandItem>
  onBillingAction?: (item: SourceSyncIslandItem) => void
  onDismiss?: (item: SourceSyncIslandItem) => void
  onOpen: () => void
  onRetry?: (item: SourceSyncIslandItem) => void
  reduceMotion: boolean
}) {
  const headline = getIslandHeadline(items)
  const dismissible =
    item.status === "completed" || item.status === "failed" || item.status === "credit_required"

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
          className="flex min-h-9 min-w-0 flex-1 touch-manipulation items-center gap-2 rounded-[1.5rem] pl-3 pr-4 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-marketing-surface-hover-muted"
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

            {item.status === "credit_required" ? (
              <p className="mt-3 text-xs leading-5 font-medium text-sync-island-failed">
                {getCreditRequiredCopy(item.creditOutcome)}
              </p>
            ) : item.message ? (
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

            {item.status === "failed" ||
            item.status === "completed" ||
            item.status === "credit_required" ? (
              <div className="mt-3 flex items-center justify-end gap-2">
                {item.status === "credit_required" && onBillingAction ? (
                  <Button
                    onClick={() => onBillingAction(item)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {hasActiveSubscription ? "Buy credits" : "Choose a plan"}
                  </Button>
                ) : null}
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
      <SourceSyncStatusOrb
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
    { label: "Fetched", value: item.fetchedRecords },
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
    case "credit_required":
      return `Needs credits to keep syncing ${sourceNames}`
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

  if (primaryItem?.status === "credit_required") {
    return `${getIslandHeadline(items)}. ${getCreditRequiredCopy(primaryItem.creditOutcome)}`
  }

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

function getFlashTransition(reduceMotion: boolean) {
  return reduceMotion
    ? ISLAND.reducedTransition
    : { duration: toSeconds(TIMING.detailReveal), ease: CONTENT.easeOut }
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000
}
