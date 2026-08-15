import { Link, createFileRoute, redirect } from "@tanstack/react-router"
import { useSuspenseQueries, useSuspenseQuery } from "@tanstack/react-query"
import { CreditCard, LibraryBig } from "lucide-react"
import { useCallback, useMemo } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type Source as TaxMaxiSource,
  type SourceOverview,
} from "taxmaxi"

import { AppHeader } from "#/components/app-header"
import { Dashboard } from "#/components/dashboard"
import { PageShell } from "#/components/page-shell"
import { Button } from "#/components/ui/button"
import { ASSET_CATALOG_OPENER_ID } from "#/lib/asset-catalog-focus"
import type { Account } from "#/lib/dashboard-types"
import { m } from "#/paraglide/messages"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"
import { queries, queryKeys } from "#/integrations/taxmaxi/queries"

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()

    if (!isAuthenticated) {
      throw redirect({
        to: "/login",
      })
    }
  },
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    try {
      const sourceList = await taxmaxi.sources.list()
      context.queryClient.setQueryData(queryKeys.sourceList(), sourceList)
      await Promise.all(
        sourceList.sources.map((source) =>
          context.queryClient.ensureQueryData(queries.sourceOverview(taxmaxi, source.id))
        )
      )
      return sourceList
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) {
        throw error
      }

      await clearAuthSessionCookie()
      throw redirect({
        to: "/login",
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { queryClient, taxmaxi } = Route.useRouteContext()

  const navigate = Route.useNavigate()

  const {
    data: { sources },
  } = useSuspenseQuery(queries.sourceList(taxmaxi()))

  const sourceOverviews = useSuspenseQueries({
    queries: sources.map((source) => queries.sourceOverview(taxmaxi(), source.id)),
    combine: (results) => results.map((result) => result.data),
  })

  const sourceAccounts = useMemo(() => {
    const overviewsBySourceId = new Map(
      sourceOverviews.map((overview) => [overview.source.id, overview])
    )
    return sources.map((source) => toDashboardAccount(source, overviewsBySourceId.get(source.id)))
  }, [sourceOverviews, sources])

  const startSourceSync = useCallback(
    async (sourceId: string) => taxmaxi().sources.startSync({ sourceId }),
    [taxmaxi]
  )

  const getSourceSyncJob = useCallback(
    async ({ jobId, sourceId }: { sourceId: string; jobId: string }) =>
      taxmaxi().sources.getSyncJob({ jobId, sourceId }),
    [taxmaxi]
  )

  const onUnauthorized = useCallback(async () => {
    queryClient.removeQueries({ queryKey: queryKeys.all })
    await clearAuthSessionCookie()
    await navigate({ to: "/login", replace: true })
  }, [navigate, queryClient])

  const onSourceSyncCompleted = useCallback(
    async (sourceId: string) => {
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: queryKeys.sourceOverview(sourceId),
      })
      await queryClient.invalidateQueries({ queryKey: ["taxmaxi", "portfolio"] })
    },
    [queryClient]
  )

  return (
    <PageShell
      as="main"
      tone="marketing"
      data-page="app"
      className="relative isolate w-full overflow-x-clip bg-[var(--app-page-fallback)] text-marketing-text"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 [background:var(--app-page-background)]"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: `linear-gradient(var(--app-grid-line) 1px, transparent 1px),
                           linear-gradient(90deg, var(--app-grid-line) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative z-10">
        <AppHeader>
          <Button asChild size="sm" variant="outline">
            <Link aria-label="Billing" preload="intent" title="Billing" to="/app/billing">
              <CreditCard data-icon="inline-start" />
              <span className="hidden sm:inline">Billing</span>
            </Link>
          </Button>
          <Button
            asChild
            className="relative size-11 gap-0 px-0 before:absolute before:-inset-0.5 sm:h-9 sm:w-auto sm:gap-1.5 sm:px-3 sm:has-data-[icon=inline-start]:pl-2.5"
            size="icon-lg"
            variant="outline"
          >
            <Link
              aria-label={m["assetCatalog.open"]()}
              id={ASSET_CATALOG_OPENER_ID}
              preload="intent"
              title={m["assetCatalog.open"]()}
              to="/assets"
            >
              <LibraryBig data-icon="inline-start" />
              <span className="hidden sm:inline">{m["assetCatalog.open"]()}</span>
            </Link>
          </Button>
        </AppHeader>
        <Dashboard
          accounts={sourceAccounts}
          getSourceSyncJob={getSourceSyncJob}
          onSourceSyncCompleted={onSourceSyncCompleted}
          onUnauthorized={onUnauthorized}
          startSourceSync={startSourceSync}
        />
      </div>
    </PageShell>
  )
}

function toDashboardAccount(source: TaxMaxiSource, overview: SourceOverview | undefined): Account {
  const network = source.sourceRef._tag === "cex" ? undefined : formatProviderNetwork(source)

  return {
    id: source.id,
    name: source.name,
    kind: source.sourceRef._tag === "cex" ? "exchange" : "wallet",
    ...(network === undefined ? {} : { network }),
    ...(source.providerKey === null ? {} : { providerKey: source.providerKey }),
    importedTransactions: overview?.totals.transactionCount ?? 0,
    unresolvedItems: overview?.review.needsReviewCount ?? 0,
    lastSync: formatLastSync(overview?.latestSync.lastSyncedAt ?? null),
  }
}

function formatProviderNetwork(source: TaxMaxiSource): string | undefined {
  switch (source.providerKey) {
    case "helius-solana":
      return "Solana"
    case "bitcoin":
    case "bitcoin-rpc":
      return "Bitcoin"
    case "evm":
    case "etherscan":
      return "EVM"
    default:
      return source.providerKey ?? undefined
  }
}

function formatLastSync(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) {
    return "Never synced"
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(lastSyncedAt))
}
