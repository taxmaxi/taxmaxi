import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { ArrowLeft, CreditCard, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type BillingCatalog,
  type BillingPromiseResource,
  type BillingStatus,
} from "taxmaxi"
import { z } from "zod"

import { AppHeader } from "#/components/app-header"
import { PageShell } from "#/components/page-shell"
import { Button } from "#/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card"
import { m } from "#/paraglide/messages"
import { getLocale, type Locale } from "#/paraglide/runtime"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"

const billingSearchSchema = z.object({
  checkout: z.literal("success").optional(),
  top_up: z.literal("success").optional(),
})

type CheckoutReturnKind = "annual" | "topUp"

const CHECKOUT_STATUS_POLL_ATTEMPTS = 15

const checkoutStatusPollDelayMs = (attempt: number): number => Math.min(500 * 2 ** attempt, 30_000)

export const loadBillingPageData = async ({
  loadCatalog,
  loadStatus,
}: {
  readonly loadCatalog: () => Promise<BillingCatalog>
  readonly loadStatus: () => Promise<BillingStatus>
}): Promise<{ readonly catalog: BillingCatalog | null; readonly status: BillingStatus }> => {
  const catalogPromise = loadCatalog().catch((error: unknown) => {
    if (isTaxMaxiUnauthorizedError(error)) throw error
    return null
  })
  const statusPromise = loadStatus()
  const [catalog, status] = await Promise.all([catalogPromise, statusPromise])
  return { catalog, status }
}

export const isTopUpActionDisabled = ({
  hasCatalogPrice,
  pendingAction,
}: {
  readonly hasCatalogPrice: boolean
  readonly pendingAction: boolean
}): boolean => !hasCatalogPrice || pendingAction

export const refreshBillingStatusAfterCheckout = async ({
  initialStatus,
  kind,
  loadStatus,
  shouldContinue = () => true,
  wait,
  attempts = CHECKOUT_STATUS_POLL_ATTEMPTS,
}: {
  readonly initialStatus: BillingStatus
  readonly kind: CheckoutReturnKind
  readonly loadStatus: () => Promise<BillingStatus>
  readonly shouldContinue?: () => boolean
  readonly wait: (delayMs: number) => Promise<void>
  readonly attempts?: number
}): Promise<BillingStatus> => {
  let latest = initialStatus
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!shouldContinue()) return latest
    await wait(checkoutStatusPollDelayMs(attempt))
    if (!shouldContinue()) return latest
    try {
      latest = await loadStatus()
    } catch (error) {
      if (isTaxMaxiUnauthorizedError(error)) throw error
      continue
    }
    if (
      (kind === "annual" &&
        (latest.subscriptionStatus === "active" || latest.subscriptionStatus === "trialing") &&
        latest.credits > initialStatus.credits) ||
      (kind === "topUp" && latest.credits > initialStatus.credits)
    ) {
      return latest
    }
  }
  return latest
}

export const Route = createFileRoute("/app_/billing")({
  validateSearch: billingSearchSchema,
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()
    if (!isAuthenticated) throw redirect({ to: "/login" })
  },
  loader: async ({ context }) => {
    try {
      const client = context.taxmaxi()
      return await loadBillingPageData({
        loadCatalog: client.billing.catalog,
        loadStatus: client.billing.status,
      })
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) throw error
      await clearAuthSessionCookie()
      throw redirect({ to: "/login" })
    }
  },
  component: BillingPage,
})

function BillingPage() {
  const { catalog, status } = Route.useLoaderData()
  const search = Route.useSearch()
  const { taxmaxi } = Route.useRouteContext()
  const navigate = Route.useNavigate()
  const [checkoutReturnKind] = useState<CheckoutReturnKind | null>(() =>
    search.checkout === "success" ? "annual" : search.top_up === "success" ? "topUp" : null
  )

  useEffect(() => {
    if (checkoutReturnKind === null) return
    void navigate({ to: "/app/billing", search: {}, replace: true })
  }, [checkoutReturnKind, navigate])

  return (
    <BillingPageContent
      assignLocation={(url) => window.location.assign(url)}
      billing={taxmaxi().billing}
      catalog={catalog}
      checkoutReturnKind={checkoutReturnKind}
      onUnauthorized={async () => {
        await clearAuthSessionCookie()
        await navigate({ to: "/login", replace: true })
      }}
      status={status}
    />
  )
}

export function BillingPageContent({
  assignLocation,
  billing,
  catalog,
  checkoutReturnKind,
  onUnauthorized,
  status,
}: {
  readonly assignLocation: (url: string) => void
  readonly billing: BillingPromiseResource
  readonly catalog: BillingCatalog | null
  readonly checkoutReturnKind: CheckoutReturnKind | null
  readonly onUnauthorized: () => Promise<void>
  readonly status: BillingStatus
}) {
  const locale = getLocale()
  const [liveStatus, setLiveStatus] = useState(status)
  const [pendingAction, setPendingAction] = useState<"annual" | "portal" | "topUp" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const subscribed =
    liveStatus.subscriptionStatus !== null &&
    liveStatus.subscriptionStatus !== "canceled" &&
    liveStatus.subscriptionStatus !== "incomplete_expired"
  const topUpEligible =
    liveStatus.subscriptionStatus === "active" || liveStatus.subscriptionStatus === "trialing"

  useEffect(() => {
    if (checkoutReturnKind === null) return
    let active = true

    const handleRefreshError = async (cause: unknown) => {
      if (!active || !isTaxMaxiUnauthorizedError(cause)) return
      await onUnauthorized()
    }

    const refreshOnce = async () => {
      try {
        const refreshed = await billing.status()
        if (active) setLiveStatus(refreshed)
      } catch (cause) {
        await handleRefreshError(cause)
      }
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOnce()
    }

    window.addEventListener("focus", refreshOnce)
    document.addEventListener("visibilitychange", refreshWhenVisible)

    void refreshBillingStatusAfterCheckout({
      initialStatus: status,
      kind: checkoutReturnKind,
      loadStatus: billing.status,
      shouldContinue: () => active,
      wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    })
      .then((refreshed) => {
        if (active) setLiveStatus(refreshed)
      })
      .catch(handleRefreshError)
    return () => {
      active = false
      window.removeEventListener("focus", refreshOnce)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [billing, checkoutReturnKind, onUnauthorized, status])

  const redirectToStripe = async (action: "annual" | "portal" | "topUp") => {
    setPendingAction(action)
    setError(null)
    try {
      const response =
        action === "annual"
          ? await billing.createAnnualCheckout()
          : action === "topUp"
            ? await billing.createTopUpCheckout()
            : await billing.createPortalSession()
      assignLocation(response.url)
    } catch (cause) {
      if (isTaxMaxiUnauthorizedError(cause)) {
        await onUnauthorized()
        return
      }
      setError(cause instanceof Error ? cause.message : m["app.billing.errors.unavailable"]())
      setPendingAction(null)
    }
  }

  return (
    <PageShell
      as="main"
      tone="marketing"
      className="relative isolate min-h-screen w-full overflow-x-clip bg-[var(--app-page-fallback)] text-marketing-text"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 [background:var(--app-page-background)]"
      />
      <div className="relative">
        <AppHeader>
          <Button asChild size="sm" variant="outline">
            <Link preload="intent" to="/app">
              <ArrowLeft data-icon="inline-start" />
              {m["app.billing.dashboard"]()}
            </Link>
          </Button>
        </AppHeader>

        <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-32 pb-16 sm:px-8">
          <header className="flex max-w-2xl flex-col gap-3">
            <p className="text-sm font-medium text-marketing-accent">
              {m["app.billing.eyebrow"]()}
            </p>
            <h1 className="font-display text-4xl tracking-[-0.045em] sm:text-5xl">
              {m["app.billing.title"]()}
            </h1>
            <p className="leading-7 text-marketing-muted">{m["app.billing.description"]()}</p>
          </header>

          {error === null ? null : (
            <p
              role="alert"
              className="rounded-xl border border-destructive/30 p-4 text-destructive"
            >
              {error}
            </p>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <AnnualBillingCard
              catalog={catalog}
              disabled={pendingAction !== null}
              onAction={() => void redirectToStripe(subscribed ? "portal" : "annual")}
              pending={pendingAction === (subscribed ? "portal" : "annual")}
              locale={locale}
              status={liveStatus}
              subscribed={subscribed}
            />
            <TopUpCard
              catalog={catalog}
              disabled={pendingAction !== null}
              onAction={() => void redirectToStripe("topUp")}
              pending={pendingAction === "topUp"}
              locale={locale}
              subscribed={topUpEligible}
            />
          </div>
        </section>
      </div>
    </PageShell>
  )
}

function AnnualBillingCard({
  catalog,
  disabled,
  onAction,
  pending,
  locale,
  status,
  subscribed,
}: {
  readonly catalog: BillingCatalog | null
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly locale: Locale
  readonly status: BillingStatus
  readonly subscribed: boolean
}) {
  const price = catalog?.prices.find((item) => item.lookupKey === "taxmaxi_annual_10k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price, locale)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m["app.billing.annual.title"]()}</CardTitle>
        <CardDescription>{m["app.billing.annual.description"]()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-4xl font-semibold tabular-nums">
          {displayedPrice ?? m["app.billing.priceUnavailable"]()}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {m["app.billing.annual.priceSuffix"]({
              taxLabel: taxLabel(price?.taxBehavior),
            })}
          </span>
        </p>
        <div className="rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{m["app.billing.availableCredits"]()}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {new Intl.NumberFormat(locale).format(status.credits)}
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled={disabled || (!subscribed && displayedPrice === null)} onClick={onAction}>
          <CreditCard data-icon="inline-start" />
          {pending
            ? m["app.billing.openingStripe"]()
            : subscribed
              ? m["app.billing.annual.manage"]()
              : displayedPrice === null
                ? m["app.billing.priceUnavailable"]()
                : m["app.billing.annual.subscribe"]({ price: displayedPrice })}
        </Button>
      </CardFooter>
    </Card>
  )
}

function TopUpCard({
  catalog,
  disabled,
  onAction,
  pending,
  locale,
  subscribed,
}: {
  readonly catalog: BillingCatalog | null
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly locale: Locale
  readonly subscribed: boolean
}) {
  const price = catalog?.prices.find((item) => item.lookupKey === "taxmaxi_topup_1k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price, locale)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m["app.billing.topUp.title"]()}</CardTitle>
        <CardDescription>{m["app.billing.topUp.description"]()}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-4xl font-semibold tabular-nums">
          {displayedPrice ?? m["app.billing.priceUnavailable"]()}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {taxLabel(price?.taxBehavior)}
          </span>
        </p>
      </CardContent>
      <CardFooter className="flex-col items-start gap-3">
        <Button
          disabled={isTopUpActionDisabled({
            hasCatalogPrice: displayedPrice !== null,
            pendingAction: disabled,
          })}
          onClick={onAction}
          variant="outline"
        >
          <Plus data-icon="inline-start" />
          {pending ? m["app.billing.openingStripe"]() : m["app.billing.topUp.buy"]()}
        </Button>
        {subscribed ? null : (
          <p className="text-xs text-muted-foreground">{m["app.billing.topUp.eligibility"]()}</p>
        )}
      </CardFooter>
    </Card>
  )
}

export function formatCatalogPrice(
  price: {
    readonly amountMinor: number
    readonly currency: string
  },
  locale: Locale = getLocale()
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.amountMinor / 100)
}

function taxLabel(taxBehavior: "exclusive" | "inclusive" | "unspecified" | undefined): string {
  switch (taxBehavior) {
    case "inclusive":
      return m["app.billing.tax.included"]()
    case "exclusive":
      return m["app.billing.tax.exclusive"]()
    default:
      return m["app.billing.tax.checkout"]()
  }
}
