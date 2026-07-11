import { createFileRoute, redirect } from "@tanstack/react-router"
import { useSuspenseQuery } from "@tanstack/react-query"
import { startTransition, useCallback, useEffect, useRef, useState } from "react"
import { isTaxMaxiUnauthorizedError, type Source as TaxMaxiSource } from "taxmaxi"

import { Dashboard } from "#/components/dashboard"
import { Logo } from "#/components/logo"
import { PageShell } from "#/components/page-shell"
import type { Account } from "#/lib/dashboard-types"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"
import { queries } from "#/integrations/taxmaxi/queries"
import { cn } from "#/lib/utils"

const COMPACT_SCROLL_THRESHOLD = 72

const headerWidthClasses = {
  compact: "max-w-[var(--content-width-xl)]",
  expanded: "max-w-[var(--content-width-2xl)]",
} as const

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
      return await context.queryClient.ensureQueryData(queries.sourceList(taxmaxi))
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
  const { taxmaxi } = Route.useRouteContext()
  const {
    data: { sources },
  } = useSuspenseQuery(queries.sourceList(taxmaxi()))
  const sourceAccounts = sources.map(toDashboardAccount)
  const startSourceSync = useCallback(
    async (sourceId: string) => taxmaxi().sources.startSync({ sourceId }),
    [taxmaxi]
  )
  const getSourceSyncJob = useCallback(
    async ({ jobId, sourceId }: { sourceId: string; jobId: string }) =>
      taxmaxi().sources.getSyncJob({ jobId, sourceId }),
    [taxmaxi]
  )

  return (
    <PageShell
      as="main"
      tone="marketing"
      data-page="app"
      className="relative isolate w-full overflow-x-clip"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-linear-to-b from-[#26352f] via-[#1c2b25] to-[#22312b]"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(rgba(163, 196, 181, 0.5) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(163, 196, 181, 0.5) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative z-10">
        <AppHeader />
        <Dashboard
          accounts={sourceAccounts}
          getSourceSyncJob={getSourceSyncJob}
          startSourceSync={startSourceSync}
        />
      </div>
    </PageShell>
  )
}

function toDashboardAccount(source: TaxMaxiSource): Account {
  const network = source.sourceRef._tag === "cex" ? undefined : formatProviderNetwork(source)

  return {
    id: source.id,
    name: source.name,
    kind: source.sourceRef._tag === "cex" ? "exchange" : "wallet",
    ...(network === undefined ? {} : { network }),
    ...(source.providerKey === null ? {} : { providerKey: source.providerKey }),
    importedTransactions: 0,
    unresolvedItems: 0,
    lastSync: formatSourceCreatedAt(source.createdAt.epochMillis),
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

function formatSourceCreatedAt(epochMillis: number): string {
  return `Added ${new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(epochMillis))}`
}

function AppHeader() {
  const [isCompact, setIsCompact] = useState(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const syncHeaderState = () => {
      const nextIsCompact = window.scrollY > COMPACT_SCROLL_THRESHOLD

      startTransition(() => {
        setIsCompact((currentIsCompact) =>
          currentIsCompact === nextIsCompact ? currentIsCompact : nextIsCompact
        )
      })
    }

    const scheduleSync = () => {
      if (frameRef.current !== null) {
        return
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        syncHeaderState()
      })
    }

    syncHeaderState()

    window.addEventListener("scroll", scheduleSync, { passive: true })
    window.addEventListener("resize", scheduleSync)

    return () => {
      window.removeEventListener("scroll", scheduleSync)
      window.removeEventListener("resize", scheduleSync)

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
      <div
        className={cn(
          "w-[calc(100vw-3rem)] transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:w-[calc(100vw-4rem)]",
          isCompact ? headerWidthClasses.compact : headerWidthClasses.expanded
        )}
      >
        <div
          className={cn(
            "relative flex flex-col overflow-hidden rounded-[1.75rem] border py-0 text-marketing-foreground transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            isCompact
              ? "border-marketing-border bg-[linear-gradient(180deg,rgba(38,53,47,0.58),rgba(28,43,37,0.46))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_70px_rgba(0,0,0,0.22)] supports-[backdrop-filter]:backdrop-blur-[48px]"
              : "border-transparent bg-transparent shadow-none max-md:border-marketing-border max-md:bg-[linear-gradient(180deg,rgba(38,53,47,0.58),rgba(28,43,37,0.46))] max-md:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_70px_rgba(0,0,0,0.22)] max-md:supports-[backdrop-filter]:backdrop-blur-[48px]"
          )}
        >
          <div
            className={cn(
              "relative z-10 flex h-16 items-center",
              isCompact ? "px-4" : "px-4 md:px-0"
            )}
          >
            <Logo theme="dark" size="small" />
          </div>
        </div>
      </div>
    </header>
  )
}
