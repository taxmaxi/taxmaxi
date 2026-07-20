import { createFileRoute, notFound, redirect } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowDown,
  Check,
  ChevronRight,
  Copy,
  Link2,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { isTaxMaxiUnauthorizedError } from "taxmaxi"
import type {
  ProviderAssetCandidates,
  ProviderAssetDecision,
  ProviderAssetReview,
} from "taxmaxi/internal"
import { z } from "zod"

import { Logo } from "#/components/logo"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog"
import { Input } from "#/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { Textarea } from "#/components/ui/textarea"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"
import { cn } from "#/lib/utils"
import {
  appendUniqueProviderAssetReviews,
  formatProviderAssetReviewDate,
  isCurrentExistingAssetSearchRequest,
  loadSettledProviderAssetReplayUpdates,
  mergeProviderAssetReplayUpdates,
  nextProviderAssetSelection,
  providerAssetReviewFilterKey,
  providerAssetReviewLoaderDeps,
} from "#/lib/provider-asset-review"

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after page mount.
 *
 *   80ms   workbench enters, opacity 0 → 1
 *  140ms   visible queue rows settle, y 8 → 0
 *  220ms   selected marker lands, scale 0.96 → 1
 *  280ms   evidence panel appears, y 6 → 0
 *
 * Keyboard navigation and reduced-motion users skip every stage.
 * ───────────────────────────────────────────────────────── */
const TIMING = {
  workbench: 80,
  queueRows: 140,
  selectedMarker: 220,
  evidence: 280,
} as const

const WORKBENCH = {
  offsetY: 8,
  spring: { type: "spring" as const, stiffness: 360, damping: 34 },
} as const

const EVIDENCE = {
  offsetY: 6,
  spring: { type: "spring" as const, stiffness: 420, damping: 38 },
} as const

const AdminProviderAssetSearch = z.object({
  asset: z.uuid().optional(),
  cursor: z.uuid().optional(),
  provider: z.string().optional(),
  q: z.string().optional(),
  status: z.enum(["pending_review", "approved", "rejected"]).optional(),
})

type AdminProviderAssetSearch = z.infer<typeof AdminProviderAssetSearch>
type ReplayView = {
  readonly providerAssetId: string
  readonly sourceId: string
  readonly jobId: string | null
  readonly status: "completed" | "failed" | "failed_to_queue" | "queued" | "running"
  readonly message: string | null
}

export const Route = createFileRoute("/admin/provider-assets")({
  validateSearch: (search): AdminProviderAssetSearch => AdminProviderAssetSearch.parse(search),
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()
    if (!isAuthenticated) throw redirect({ to: "/login" })
  },
  loaderDeps: ({ search }) => providerAssetReviewLoaderDeps(search),
  loader: async ({ context, deps }) => {
    try {
      const currentUser = await context.taxmaxi().auth.me()
      if (currentUser.user.role !== "admin") throw notFound()

      return context.internalTaxmaxi().assets.listProviderAssetReviews({
        provider: deps.provider,
        query: deps.q,
        status: deps.status ?? "pending_review",
        cursor: deps.cursor,
        limit: 40,
      })
    } catch (error) {
      if (isTaxMaxiUnauthorizedError(error)) {
        await clearAuthSessionCookie()
        throw redirect({ to: "/login" })
      }
      throw error
    }
  },
  notFoundComponent: AdminAccessRequired,
  component: ProviderAssetWorkbench,
})

function AdminAccessRequired() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Admin access required</CardTitle>
          <CardDescription>
            This provider-asset review workbench is only available to TaxMaxi administrators.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}

function ProviderAssetWorkbench() {
  const initial = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { internalTaxmaxi, taxmaxi } = Route.useRouteContext()
  const reduceMotion = useReducedMotion()
  const [rows, setRows] = useState<ReadonlyArray<ProviderAssetReview>>(initial.providerAssets)
  const [totalCount, setTotalCount] = useState(initial.totalCount)
  const [nextCursor, setNextCursor] = useState(initial.page.nextCursor)
  const [selectedId, setSelectedId] = useState<string | null>(search.asset ?? null)
  const [queryDraft, setQueryDraft] = useState(search.q ?? "")
  const [stage, setStage] = useState(reduceMotion ? 4 : 0)
  const [candidates, setCandidates] = useState<ProviderAssetCandidates["candidates"]>([])
  const [selectedCoinId, setSelectedCoinId] = useState<string | null>(null)
  const [reviewerNotes, setReviewerNotes] = useState("")
  const [existingQuery, setExistingQuery] = useState("")
  const [existingAssets, setExistingAssets] = useState<
    Awaited<ReturnType<ReturnType<typeof taxmaxi>["assets"]["list"]>>["assets"]
  >([])
  const activeExistingQueryRef = useRef(existingQuery)
  activeExistingQueryRef.current = existingQuery
  const [selectedExistingId, setSelectedExistingId] = useState<string | null>(null)
  const [rejectionOpen, setRejectionOpen] = useState(false)
  const [rejectionReason, setRejectionReason] = useState("")
  const [submitting, setSubmitting] = useState<"create" | "map" | "reject" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [replays, setReplays] = useState<ReadonlyArray<ReplayView>>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const loadingPageRequestRef = useRef<{
    readonly cursor: string
    readonly filterKey: string
  } | null>(null)

  const selected = rows.find((row) => row.id === selectedId) ?? null
  const selectedCurrencyCode = selected?.currencyCode ?? null
  const activeFilterKey = providerAssetReviewFilterKey({
    provider: search.provider,
    query: search.q,
    status: search.status ?? "pending_review",
  })
  const activeFilterKeyRef = useRef(activeFilterKey)
  activeFilterKeyRef.current = activeFilterKey

  const invalidatePageRequest = useCallback(() => {
    loadingPageRequestRef.current = null
    setLoadingMore(false)
  }, [])

  const resetDecisionState = useCallback(() => {
    setCandidates([])
    setSelectedCoinId(null)
    setSelectedExistingId(null)
    activeExistingQueryRef.current = ""
    setExistingQuery("")
    setExistingAssets([])
    setReviewerNotes("")
    setActionError(null)
  }, [])

  useEffect(() => {
    if (reduceMotion) {
      setStage(4)
      return
    }
    const timers = [
      window.setTimeout(() => setStage(1), TIMING.workbench),
      window.setTimeout(() => setStage(2), TIMING.queueRows),
      window.setTimeout(() => setStage(3), TIMING.selectedMarker),
      window.setTimeout(() => setStage(4), TIMING.evidence),
    ]
    return () => timers.forEach(window.clearTimeout)
  }, [reduceMotion])

  useEffect(() => {
    setRows(initial.providerAssets)
    setTotalCount(initial.totalCount)
    setNextCursor(initial.page.nextCursor)
  }, [initial])

  useEffect(() => {
    setSelectedId(search.asset ?? null)
  }, [search.asset])

  useEffect(() => {
    resetDecisionState()

    if (selectedId === null) {
      return
    }
    if (selectedCurrencyCode !== null) {
      activeExistingQueryRef.current = selectedCurrencyCode
      setExistingQuery(selectedCurrencyCode)
    }
    let active = true
    internalTaxmaxi()
      .assets.listProviderAssetCandidates({ id: selectedId })
      .then((result) => {
        if (!active) return
        setCandidates(result.candidates)
        setSelectedCoinId(null)
      })
      .catch((error: unknown) => {
        if (active) setActionError(messageFor(error))
      })
    return () => {
      active = false
    }
  }, [internalTaxmaxi, resetDecisionState, selectedCurrencyCode, selectedId])

  useEffect(() => {
    if (existingQuery.trim().length < 2) {
      setExistingAssets([])
      return
    }
    const timer = window.setTimeout(() => {
      const requestQuery = existingQuery
      taxmaxi()
        .assets.list({ query: requestQuery, limit: 12 })
        .then((result) => {
          if (
            isCurrentExistingAssetSearchRequest({
              currentQuery: activeExistingQueryRef.current,
              requestQuery,
            })
          ) {
            setExistingAssets(result.assets)
          }
        })
        .catch((error: unknown) => {
          if (
            isCurrentExistingAssetSearchRequest({
              currentQuery: activeExistingQueryRef.current,
              requestQuery,
            })
          ) {
            setActionError(messageFor(error))
          }
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [existingQuery, taxmaxi])

  useEffect(() => {
    const activeReplays = replays.filter(
      (replay) =>
        replay.jobId !== null && (replay.status === "queued" || replay.status === "running")
    )
    if (activeReplays.length === 0) return
    const timer = window.setInterval(() => {
      void loadSettledProviderAssetReplayUpdates({
        replays: activeReplays,
        load: async (replay) => {
          if (replay.jobId === null) return replay
          const job = await internalTaxmaxi().assets.getProviderAssetReplay({
            id: replay.providerAssetId,
            sourceId: replay.sourceId,
            jobId: replay.jobId,
          })
          return { ...replay, jobId: job.jobId, status: job.status, message: job.message }
        },
      }).then((updates) =>
        setReplays((current) => mergeProviderAssetReplayUpdates({ current, updates }))
      )
    }, 2000)
    return () => window.clearInterval(timer)
  }, [internalTaxmaxi, replays])

  const choose = useCallback(
    (id: string, keyboard = false) => {
      resetDecisionState()
      setSelectedId(id)
      void navigate({ search: (previous) => ({ ...previous, asset: id }), replace: keyboard })
      rowRefs.current
        .get(id)
        ?.scrollIntoView({ block: "nearest", behavior: keyboard ? "instant" : "smooth" })
    },
    [navigate, resetDecisionState]
  )

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      const index = rows.findIndex((row) => row.id === selectedId)
      const target = rows[Math.max(0, Math.min(rows.length - 1, index + direction))]
      if (target !== undefined) choose(target.id, true)
    },
    [choose, rows, selectedId]
  )

  const closeMobileReview = useCallback(() => {
    const previousId = selectedId
    setSelectedId(null)
    void navigate({
      search: (previous) => ({ ...previous, asset: undefined }),
      replace: true,
    }).then(() => {
      if (previousId !== null) rowRefs.current.get(previousId)?.focus()
    })
  }, [navigate, selectedId])

  const applyDecision = useCallback(
    (decision: ProviderAssetDecision) => {
      setReplays(
        decision.replays.map((replay) => ({
          ...replay,
          providerAssetId: decision.providerAsset.id,
        }))
      )
      resetDecisionState()
      if ((search.status ?? "pending_review") === "pending_review") {
        const progression = nextProviderAssetSelection({
          reviewedId: decision.providerAsset.id,
          rowIds: rows.map((row) => row.id),
        })
        const remaining = rows.filter((row) => progression.remainingIds.includes(row.id))
        const next = remaining.find((row) => row.id === progression.selectedId) ?? null
        setRows(remaining)
        setTotalCount((count) => Math.max(0, count - 1))
        setSelectedId(next?.id ?? null)
        void navigate({
          search: (previous) => ({ ...previous, asset: next?.id }),
          replace: true,
        })
      } else {
        setRows((current) =>
          current.map((row) =>
            row.id === decision.providerAsset.id ? decision.providerAsset : row
          )
        )
      }
    },
    [navigate, resetDecisionState, rows, search.status]
  )

  const runAction = useCallback(
    async (action: "create" | "map" | "reject") => {
      if (selected === null) return
      setSubmitting(action)
      setActionError(null)
      try {
        if (action === "create") {
          if (selectedCoinId === null) throw new Error("Select a CoinGecko candidate first.")
          const result = await internalTaxmaxi().assets.canonicalizeProviderAsset({
            id: selected.id,
            coinId: selectedCoinId,
            reviewerNotes: reviewerNotes || null,
          })
          applyDecision(result)
        } else if (action === "map") {
          if (selectedExistingId === null)
            throw new Error("Select an existing TaxMaxi asset first.")
          const result = await internalTaxmaxi().assets.mapProviderAsset({
            id: selected.id,
            canonicalAssetId: selectedExistingId,
            reviewerNotes: reviewerNotes || null,
          })
          applyDecision(result)
        } else {
          const result = await internalTaxmaxi().assets.rejectProviderAsset({
            id: selected.id,
            rejectionReason,
          })
          applyDecision(result)
          setRejectionOpen(false)
          setRejectionReason("")
        }
      } catch (error) {
        setActionError(messageFor(error))
      } finally {
        setSubmitting(null)
      }
    },
    [
      applyDecision,
      internalTaxmaxi,
      rejectionReason,
      reviewerNotes,
      selected,
      selectedCoinId,
      selectedExistingId,
    ]
  )

  const loadMore = async () => {
    if (
      nextCursor === null ||
      (loadingPageRequestRef.current?.cursor === nextCursor &&
        loadingPageRequestRef.current.filterKey === activeFilterKey)
    )
      return
    const request = { cursor: nextCursor, filterKey: activeFilterKey }
    loadingPageRequestRef.current = request
    setLoadingMore(true)
    try {
      const page = await internalTaxmaxi().assets.listProviderAssetReviews({
        provider: search.provider,
        query: search.q,
        status: search.status ?? "pending_review",
        cursor: nextCursor,
        limit: 40,
      })
      if (activeFilterKeyRef.current !== request.filterKey) return
      setRows((current) =>
        appendUniqueProviderAssetReviews({ current, incoming: page.providerAssets })
      )
      setNextCursor(page.page.nextCursor)
    } catch (error) {
      if (activeFilterKeyRef.current === request.filterKey) setActionError(messageFor(error))
    } finally {
      if (loadingPageRequestRef.current === request) {
        loadingPageRequestRef.current = null
        setLoadingMore(false)
      }
    }
  }

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top,rgba(80,120,98,0.18),transparent_45%)]"
      />
      <motion.div
        animate={{ opacity: stage >= 1 ? 1 : 0, y: stage >= 1 ? 0 : WORKBENCH.offsetY }}
        className="relative mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 md:p-6"
        initial={false}
        transition={reduceMotion ? { duration: 0 } : WORKBENCH.spring}
      >
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-3xl border bg-card/80 px-4 shadow-sm backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <Logo size="small" />
            <div>
              <p className="text-sm font-medium">Provider asset review</p>
              <p className="text-xs text-muted-foreground">Identity evidence and source replay</p>
            </div>
          </div>
          <Badge variant="secondary" className="font-mono tabular-nums">
            {totalCount} {search.status ?? "pending_review"}
          </Badge>
        </header>

        <form
          className="grid gap-3 rounded-3xl border bg-card/80 p-3 shadow-sm md:grid-cols-[minmax(14rem,1fr)_12rem_12rem_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            invalidatePageRequest()
            void navigate({
              search: (previous) => ({
                ...previous,
                q: queryDraft || undefined,
                cursor: undefined,
              }),
            })
          }}
          role="search"
        >
          <label className="relative">
            <span className="sr-only">Search provider assets</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            />
            <Input
              autoComplete="off"
              className="h-11 pl-10"
              onChange={(event) => setQueryDraft(event.currentTarget.value)}
              placeholder="Symbol, name, identifier, or contract"
              spellCheck={false}
              type="search"
              value={queryDraft}
            />
          </label>
          <Select
            onValueChange={(value) => {
              invalidatePageRequest()
              void navigate({
                search: (previous) => ({
                  ...previous,
                  provider: value === "all" ? undefined : value,
                  cursor: undefined,
                }),
              })
            }}
            value={search.provider ?? "all"}
          >
            <SelectTrigger className="h-11 w-full">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All providers</SelectItem>
                <SelectItem value="coinbase">Coinbase</SelectItem>
                <SelectItem value="helius-solana">Helius Solana</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value: "approved" | "pending_review" | "rejected") => {
              invalidatePageRequest()
              void navigate({
                search: (previous) => ({ ...previous, status: value, cursor: undefined }),
              })
            }}
            value={search.status ?? "pending_review"}
          >
            <SelectTrigger className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="pending_review">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button className="h-11" type="submit">
            <Search data-icon="inline-start" />
            Search
          </Button>
        </form>

        <div className="grid min-h-[calc(100vh-12rem)] gap-4 lg:grid-cols-[minmax(19rem,0.78fr)_minmax(34rem,1.5fr)]">
          <Card className="min-h-[36rem] overflow-hidden py-0">
            <CardHeader className="border-b py-4">
              <CardTitle>Review queue</CardTitle>
              <CardDescription>Use ↑ and ↓ to move through evidence.</CardDescription>
            </CardHeader>
            <CardContent
              className="max-h-[calc(100vh-17rem)] overflow-y-auto p-2"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  moveSelection(1)
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  moveSelection(-1)
                }
              }}
              role="listbox"
              aria-label="Provider assets"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {rows.map((row) => {
                  const active = row.id === selectedId
                  return (
                    <motion.button
                      animate={{
                        opacity: stage >= 2 ? 1 : 0,
                        y: stage >= 2 ? 0 : WORKBENCH.offsetY,
                        scale: active && stage >= 3 ? 1 : active ? 0.96 : 1,
                      }}
                      aria-selected={active}
                      className={cn(
                        "relative flex min-h-20 w-full items-center gap-3 rounded-2xl px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active && "bg-accent"
                      )}
                      exit={{ opacity: 0, x: reduceMotion ? 0 : -12 }}
                      key={row.id}
                      layout={!reduceMotion}
                      onClick={() => choose(row.id)}
                      ref={(element) => {
                        if (element === null) rowRefs.current.delete(row.id)
                        else rowRefs.current.set(row.id, element)
                      }}
                      role="option"
                      transition={reduceMotion ? { duration: 0 } : WORKBENCH.spring}
                      type="button"
                    >
                      <StatusIcon status={row.mappingStatus} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {row.currencyCode} · {row.name ?? "Unnamed asset"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.provider} · {row.providerType ?? "unknown type"}
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </motion.button>
                  )
                })}
              </AnimatePresence>
              {rows.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No provider assets match these filters.
                </p>
              ) : null}
              {nextCursor !== null ? (
                <Button
                  className="mt-2 min-h-11 w-full"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  type="button"
                  variant="outline"
                >
                  <ArrowDown data-icon="inline-start" />
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <motion.section
            animate={{ opacity: stage >= 4 ? 1 : 0, y: stage >= 4 ? 0 : EVIDENCE.offsetY }}
            aria-live="polite"
            className={cn(
              selected === null && "max-lg:hidden",
              selected !== null &&
                "fixed inset-0 overflow-y-auto bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:static lg:overflow-visible lg:bg-transparent lg:p-0"
            )}
            transition={reduceMotion ? { duration: 0 } : EVIDENCE.spring}
          >
            {selected === null ? (
              <Card className="min-h-[36rem]">
                <CardHeader>
                  <CardTitle>Select an asset</CardTitle>
                  <CardDescription>
                    Provider evidence and review actions appear here.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex justify-end lg:hidden">
                  <Button
                    onClick={closeMobileReview}
                    size="icon-lg"
                    type="button"
                    variant="outline"
                  >
                    <X />
                    <span className="sr-only">Close review details</span>
                  </Button>
                </div>
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardDescription>Provider evidence · {selected.provider}</CardDescription>
                        <CardTitle>
                          {selected.currencyCode} · {selected.name ?? "Unnamed asset"}
                        </CardTitle>
                      </div>
                      <Badge variant="outline">{formatStatus(selected.mappingStatus)}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <dl className="grid gap-4 md:grid-cols-2">
                      <Evidence
                        label="Asset classification"
                        value={formatProviderAssetType(selected)}
                      />
                      <Evidence label="Decimals" value={selected.exponent?.toString() ?? null} />
                    </dl>

                    <section className="rounded-2xl border p-4" aria-labelledby="evidence-source">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium" id="evidence-source">
                            {selected.evidenceSource.apiName}
                          </h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {selected.evidenceSource.endpoint ?? "TaxMaxi built-in reference data"}{" "}
                            · {formatPayloadKind(selected.evidenceSource.payloadKind)}
                          </p>
                        </div>
                        {selected.evidenceSource.documentationUrl === null ? null : (
                          <Button asChild size="sm" type="button" variant="outline">
                            <a
                              href={selected.evidenceSource.documentationUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              API documentation
                            </a>
                          </Button>
                        )}
                      </div>
                      <p className="mt-3 text-sm">{selected.evidenceSource.typeExplanation}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Retrieved {formatProviderAssetReviewDate(selected.retrievedAt)}
                      </p>
                    </section>

                    <details className="rounded-2xl border p-4">
                      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
                        Raw payload from {selected.evidenceSource.providerName}
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        This is the evidence TaxMaxi stored from the source shown above.
                      </p>
                      <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs">
                        {JSON.stringify(selected.rawProviderPayload, null, 2)}
                      </pre>
                    </details>

                    <details className="rounded-2xl border p-4">
                      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
                        Technical details
                      </summary>
                      <dl className="mt-3 grid gap-3 md:grid-cols-2">
                        <Evidence
                          label="Provider identifier"
                          value={selected.providerAssetId}
                          copy
                        />
                        <Evidence
                          label="TaxMaxi fallback identity"
                          value={selected.naturalKey}
                          copy
                        />
                        <Evidence label="Raw observed type" value={selected.providerType} />
                        <Evidence
                          label="First discovered"
                          value={formatProviderAssetReviewDate(selected.discoveredAt)}
                        />
                      </dl>
                    </details>
                  </CardContent>
                </Card>

                {selected.mappingStatus === "pending_review" ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Review decision</CardTitle>
                      <CardDescription>
                        Choose one outcome using the provider and identity evidence above.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                      <section className="flex flex-col gap-2">
                        <div>
                          <h3 className="text-sm font-medium">
                            Add a new TaxMaxi asset using CoinGecko
                          </h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            TaxMaxi searches CoinGecko, loads each matching coin, and separates its
                            native asset from token or bridged representations.
                          </p>
                        </div>
                        {candidates.filter((candidate) => candidate.availability === "actionable")
                          .length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            CoinGecko did not provide enough evidence to safely create an asset.
                          </p>
                        ) : (
                          candidates
                            .filter((candidate) => candidate.availability === "actionable")
                            .map((candidate) => (
                              <div className="rounded-2xl border" key={candidate.coinId}>
                                <button
                                  aria-pressed={selectedCoinId === candidate.coinId}
                                  className={cn(
                                    "flex min-h-16 w-full items-center gap-3 rounded-2xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    selectedCoinId === candidate.coinId && "bg-accent"
                                  )}
                                  onClick={() => setSelectedCoinId(candidate.coinId)}
                                  type="button"
                                >
                                  <Badge
                                    variant={candidate.exactContractMatch ? "default" : "secondary"}
                                  >
                                    {formatCandidateEvidence(candidate.evidenceStrength)}
                                  </Badge>
                                  <span className="min-w-0 flex-1">
                                    <span className="block font-medium">
                                      {candidate.coinName} ({candidate.coinSymbol})
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                      {candidate.platformName ?? "Unresolved platform"} ·{" "}
                                      {candidate.contractAddress ?? "native asset"}
                                    </span>
                                  </span>
                                  {selectedCoinId === candidate.coinId ? (
                                    <Check aria-hidden="true" />
                                  ) : null}
                                </button>
                                <div className="space-y-2 px-3 pb-3 text-xs text-muted-foreground">
                                  <ul className="list-disc space-y-1 pl-4">
                                    {candidate.matchReasons.map((reason) => (
                                      <li key={reason}>{reason}</li>
                                    ))}
                                    {candidate.warnings.map((warning) => (
                                      <li className="text-foreground" key={warning}>
                                        {warning}
                                      </li>
                                    ))}
                                  </ul>
                                  {candidate.proposedAsset === null ? null : (
                                    <p>
                                      Creates {candidate.proposedAsset.type}{" "}
                                      <span className="font-medium text-foreground">
                                        {candidate.proposedAsset.symbol}
                                      </span>{" "}
                                      on {candidate.proposedAsset.blockchainName}.
                                    </p>
                                  )}
                                  <a
                                    className="inline-flex min-h-11 items-center underline underline-offset-4"
                                    href={`https://www.coingecko.com/en/coins/${candidate.coinId}`}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    Open CoinGecko record
                                  </a>
                                </div>
                              </div>
                            ))
                        )}
                        {candidates.some(
                          (candidate) => candidate.availability === "unavailable"
                        ) ? (
                          <details className="rounded-2xl border p-3">
                            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
                              Other CoinGecko results
                            </summary>
                            <div className="mt-2 flex flex-col gap-2">
                              {candidates
                                .filter((candidate) => candidate.availability === "unavailable")
                                .map((candidate) => (
                                  <div className="rounded-xl bg-muted p-3" key={candidate.coinId}>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="outline">
                                        {formatCandidateEvidence(candidate.evidenceStrength)}
                                      </Badge>
                                      <span className="font-medium">
                                        {candidate.coinName} ({candidate.coinSymbol})
                                      </span>
                                    </div>
                                    <p className="mt-2 text-sm text-muted-foreground">
                                      {candidate.unavailableReason ??
                                        "TaxMaxi could not safely use this result."}
                                    </p>
                                    <a
                                      className="mt-1 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                                      href={`https://www.coingecko.com/en/coins/${candidate.coinId}`}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      Open CoinGecko record
                                    </a>
                                  </div>
                                ))}
                            </div>
                          </details>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                          Before creation, TaxMaxi reloads the selected CoinGecko record and
                          verifies its coin identity, native blockchain or exact token contract, and
                          decimals.
                        </p>
                      </section>
                      <section className="flex flex-col gap-2">
                        <div>
                          <label className="text-sm font-medium" htmlFor="existing-asset-search">
                            Use an existing TaxMaxi asset
                          </label>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Exact Solana mint matches are approved automatically during provider
                            sync. Choose a target here only when the remaining evidence requires an
                            admin decision.
                          </p>
                        </div>
                        <Input
                          id="existing-asset-search"
                          onChange={(event) => {
                            const query = event.currentTarget.value
                            activeExistingQueryRef.current = query
                            setExistingQuery(query)
                            setSelectedExistingId(null)
                          }}
                          placeholder="Search canonical assets"
                          type="search"
                          value={existingQuery}
                        />
                        {existingAssets.map((asset) => (
                          <button
                            aria-pressed={selectedExistingId === asset.id}
                            className={cn(
                              "flex min-h-14 items-center gap-3 rounded-2xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selectedExistingId === asset.id && "bg-accent"
                            )}
                            key={asset.id}
                            onClick={() => setSelectedExistingId(asset.id)}
                            type="button"
                          >
                            <Link2 aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">
                                {asset.symbol} · {asset.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {asset.blockchainName} · {asset.contractAddress ?? "native asset"} ·{" "}
                                {asset.type}
                              </span>
                            </span>
                          </button>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          Before mapping, TaxMaxi verifies that the target still exists, is not
                          marked as spam, and does not conflict with an observed token contract.
                        </p>
                      </section>
                      <label
                        className="flex flex-col gap-2 text-sm font-medium"
                        htmlFor="reviewer-notes"
                      >
                        Reviewer notes{" "}
                        <span className="font-normal text-muted-foreground">
                          Optional for approvals
                        </span>
                        <Textarea
                          id="reviewer-notes"
                          onChange={(event) => setReviewerNotes(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (
                              (event.metaKey || event.ctrlKey) &&
                              event.key === "Enter" &&
                              selectedCoinId !== null
                            )
                              void runAction("create")
                          }}
                          value={reviewerNotes}
                        />
                      </label>
                      {actionError !== null ? (
                        <p className="text-sm text-destructive" role="alert">
                          {actionError}
                        </p>
                      ) : null}
                      <div className="grid gap-2 sm:grid-cols-3">
                        <Button
                          className="min-h-11 active:scale-[0.97] motion-reduce:transition-none"
                          disabled={submitting !== null || selectedCoinId === null}
                          onClick={() => void runAction("create")}
                          type="button"
                        >
                          <Check data-icon="inline-start" />
                          {submitting === "create" ? "Approving…" : "Create & approve"}
                        </Button>
                        <Button
                          className="min-h-11 active:scale-[0.97] motion-reduce:transition-none"
                          disabled={submitting !== null || selectedExistingId === null}
                          onClick={() => void runAction("map")}
                          type="button"
                          variant="secondary"
                        >
                          <Link2 data-icon="inline-start" />
                          {submitting === "map" ? "Mapping…" : "Map existing"}
                        </Button>
                        <Button
                          className="min-h-11 active:scale-[0.97] motion-reduce:transition-none"
                          disabled={submitting !== null}
                          onClick={() => setRejectionOpen(true)}
                          type="button"
                          variant="destructive"
                        >
                          <ShieldAlert data-icon="inline-start" />
                          Reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardHeader>
                      <CardTitle>Completed review</CardTitle>
                      <CardDescription>
                        Reviewed by {selected.reviewedBy ?? "an administrator"}{" "}
                        {selected.reviewedAt === null
                          ? ""
                          : `on ${formatProviderAssetReviewDate(selected.reviewedAt)}`}
                        .
                      </CardDescription>
                    </CardHeader>
                    <CardContent>{selected.reviewerNotes ?? "No reviewer notes."}</CardContent>
                  </Card>
                )}
              </div>
            )}
          </motion.section>
        </div>
      </motion.div>

      {replays.length > 0 ? (
        <aside
          aria-live="polite"
          className="fixed bottom-4 right-4 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 rounded-3xl border bg-card p-4 shadow-xl"
        >
          <h2 className="text-sm font-medium">Source replay</h2>
          {replays.map((replay) => (
            <div className="flex min-h-11 items-center gap-3 text-sm" key={replay.sourceId}>
              <RefreshCw
                aria-hidden="true"
                className={cn(
                  (replay.status === "queued" || replay.status === "running") &&
                    "animate-spin motion-reduce:animate-none"
                )}
              />
              <span className="min-w-0 flex-1 truncate">{replay.sourceId}</span>
              <Badge variant="secondary">{replay.status}</Badge>
              {replay.status === "failed" || replay.status === "failed_to_queue" ? (
                <Button
                  aria-label={`Retry replay for source ${replay.sourceId}`}
                  onClick={() =>
                    void internalTaxmaxi()
                      .assets.retryProviderAssetReplay({
                        id: replay.providerAssetId,
                        sourceId: replay.sourceId,
                      })
                      .then((job) =>
                        setReplays((current) =>
                          current.map((item) =>
                            item.sourceId === replay.sourceId
                              ? {
                                  ...item,
                                  jobId: job.jobId,
                                  status: job.status,
                                  message: job.message,
                                }
                              : item
                          )
                        )
                      )
                  }
                  size="icon-lg"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw />
                </Button>
              ) : null}
            </div>
          ))}
        </aside>
      ) : null}

      <Dialog open={rejectionOpen} onOpenChange={setRejectionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject provider asset?</DialogTitle>
            <DialogDescription>
              Rejection prevents this observation from entering canonical tax processing. This
              decision cannot be reopened in V1.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="rejection-reason">
            Rejection reason
            <Textarea
              autoFocus
              id="rejection-reason"
              aria-invalid={actionError !== null}
              onChange={(event) => setRejectionReason(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter" &&
                  rejectionReason.trim() !== ""
                )
                  void runAction("reject")
              }}
              value={rejectionReason}
            />
          </label>
          {actionError !== null ? (
            <p className="text-sm text-destructive" role="alert">
              {actionError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                <X data-icon="inline-start" />
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={submitting !== null || rejectionReason.trim() === ""}
              onClick={() => void runAction("reject")}
              type="button"
              variant="destructive"
            >
              <ShieldAlert data-icon="inline-start" />
              {submitting === "reject" ? "Rejecting…" : "Confirm rejection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function StatusIcon({ status }: { readonly status: ProviderAssetReview["mappingStatus"] }) {
  if (status === "approved") return <Check aria-label="Approved" />
  if (status === "rejected") return <X aria-label="Rejected" />
  return <ShieldAlert aria-label="Pending review" />
}

function Evidence({
  copy = false,
  label,
  value,
}: {
  readonly copy?: boolean
  readonly label: string
  readonly value: string | null
}) {
  return (
    <div className="min-w-0 rounded-2xl border p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-h-7 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{value ?? "Not reported"}</span>
        {copy && value !== null ? (
          <Button
            aria-label={`Copy ${label}`}
            onClick={() => void navigator.clipboard.writeText(value)}
            size="icon-lg"
            type="button"
            variant="ghost"
          >
            <Copy />
          </Button>
        ) : null}
      </dd>
    </div>
  )
}

function formatStatus(status: ProviderAssetReview["mappingStatus"]): string {
  if (status === "approved") return "Approved"
  if (status === "rejected") return "Rejected"
  return "Pending review"
}

function formatProviderAssetType(providerAsset: ProviderAssetReview): string {
  const providerType = providerAsset.providerType?.trim().toLowerCase()
  const classification = (() => {
    switch (providerType) {
      case "crypto":
        return "Crypto asset"
      case "fiat":
        return "Fiat currency"
      case "native":
        return "Native coin"
      case "nft":
        return "NFT"
      case "spl-token":
        return "Solana fungible token"
      case "spl-token-2022":
        return "Solana Token-2022 token"
      default:
        return providerType === undefined || providerType === ""
          ? "Not classified"
          : (providerAsset.providerType ?? "Not classified")
    }
  })()
  const source =
    providerAsset.evidenceSource.typeSource === "provider"
      ? "reported by provider"
      : "inferred by TaxMaxi"
  return `${classification} · ${source}`
}

function formatPayloadKind(kind: ProviderAssetReview["evidenceSource"]["payloadKind"]): string {
  if (kind === "direct_response") return "direct provider response"
  if (kind === "fallback") return "TaxMaxi fallback evidence"
  return "derived from a provider observation"
}

function formatCandidateEvidence(
  evidence: ProviderAssetCandidates["candidates"][number]["evidenceStrength"]
): string {
  if (evidence === "exact_contract") return "Exact chain and contract"
  if (evidence === "exact_name_and_symbol") return "Exact name and symbol"
  return "Symbol only"
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The review action failed. Try again."
}
