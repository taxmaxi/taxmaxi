import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { ArrowLeft, CreditCard, Plus } from "lucide-react"
import { useState } from "react"
import { isTaxMaxiUnauthorizedError, type BillingCatalog, type BillingStatus } from "taxmaxi"

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
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"

export const Route = createFileRoute("/app_/billing")({
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()
    if (!isAuthenticated) throw redirect({ to: "/login" })
  },
  loader: async ({ context }) => {
    try {
      const client = context.taxmaxi()
      const [catalog, status] = await Promise.all([
        client.billing.catalog(),
        client.billing.status(),
      ])
      return { catalog, status }
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
  const { taxmaxi } = Route.useRouteContext()
  const navigate = Route.useNavigate()
  const [pendingAction, setPendingAction] = useState<"annual" | "portal" | "topUp" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const subscribed =
    status.subscriptionStatus !== null &&
    status.subscriptionStatus !== "canceled" &&
    status.subscriptionStatus !== "incomplete_expired"
  const topUpEligible =
    status.subscriptionStatus === "active" || status.subscriptionStatus === "trialing"

  const redirectToStripe = async (action: "annual" | "portal" | "topUp") => {
    setPendingAction(action)
    setError(null)
    try {
      const billing = taxmaxi().billing
      const response =
        action === "annual"
          ? await billing.createAnnualCheckout()
          : action === "topUp"
            ? await billing.createTopUpCheckout()
            : await billing.createPortalSession()
      window.location.assign(response.url)
    } catch (cause) {
      if (isTaxMaxiUnauthorizedError(cause)) {
        await clearAuthSessionCookie()
        await navigate({ to: "/login", replace: true })
        return
      }
      setError(cause instanceof Error ? cause.message : "Billing is temporarily unavailable.")
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
              Dashboard
            </Link>
          </Button>
        </AppHeader>

        <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-32 pb-16 sm:px-8">
          <header className="flex max-w-2xl flex-col gap-3">
            <p className="text-sm font-medium text-marketing-accent">Billing</p>
            <h1 className="font-display text-4xl tracking-[-0.045em] sm:text-5xl">
              Plan and transaction credits
            </h1>
            <p className="leading-7 text-marketing-muted">
              Stripe handles payments and invoices. TaxMaxi tracks the credits available to your
              account.
            </p>
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
              status={status}
              subscribed={subscribed}
            />
            <TopUpCard
              catalog={catalog}
              disabled={!topUpEligible || pendingAction !== null}
              onAction={() => void redirectToStripe("topUp")}
              pending={pendingAction === "topUp"}
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
  status,
  subscribed,
}: {
  readonly catalog: BillingCatalog
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly status: BillingStatus
  readonly subscribed: boolean
}) {
  const price = catalog.prices.find((item) => item.lookupKey === "taxmaxi_annual_10k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price)
  return (
    <Card>
      <CardHeader>
        <CardTitle>TaxMaxi Annual</CardTitle>
        <CardDescription>10,000 transaction credits with annual renewal.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-4xl font-semibold tabular-nums">
          {displayedPrice ?? "Price unavailable"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            / year, {taxLabel(price?.taxBehavior)}
          </span>
        </p>
        <div className="rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">Available credits</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {new Intl.NumberFormat().format(status.credits)}
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled={disabled || (!subscribed && displayedPrice === null)} onClick={onAction}>
          <CreditCard data-icon="inline-start" />
          {pending
            ? "Opening Stripe…"
            : subscribed
              ? "Manage subscription"
              : displayedPrice === null
                ? "Price unavailable"
                : `Subscribe for ${displayedPrice}`}
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
  subscribed,
}: {
  readonly catalog: BillingCatalog
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly subscribed: boolean
}) {
  const price = catalog.prices.find((item) => item.lookupKey === "taxmaxi_topup_1k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Extra transaction pack</CardTitle>
        <CardDescription>1,000 additional credits. Never purchased automatically.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-4xl font-semibold tabular-nums">
          {displayedPrice ?? "Price unavailable"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {taxLabel(price?.taxBehavior)}
          </span>
        </p>
      </CardContent>
      <CardFooter className="flex-col items-start gap-3">
        <Button disabled={disabled || displayedPrice === null} onClick={onAction} variant="outline">
          <Plus data-icon="inline-start" />
          {pending ? "Opening Stripe…" : "Buy 1,000 credits"}
        </Button>
        {subscribed ? null : (
          <p className="text-xs text-muted-foreground">
            An active annual subscription is required.
          </p>
        )}
      </CardFooter>
    </Card>
  )
}

function formatCatalogPrice(price: { readonly amount: number; readonly currency: string }): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.amount / 100)
}

function taxLabel(taxBehavior: "exclusive" | "inclusive" | "unspecified" | undefined): string {
  switch (taxBehavior) {
    case "inclusive":
      return "tax included"
    case "exclusive":
      return "plus applicable tax"
    default:
      return "tax shown at checkout"
  }
}
