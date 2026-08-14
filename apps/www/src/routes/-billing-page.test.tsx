// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TaxMaxiError,
  type BillingCatalog,
  type BillingPromiseResource,
  type BillingStatus,
} from "taxmaxi"

import { BillingPageContent } from "./app_.billing"

const catalog: BillingCatalog = {
  prices: [
    {
      lookupKey: "taxmaxi_annual_10k_eur",
      amountMinor: 15_900,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: "year",
    },
    {
      lookupKey: "taxmaxi_topup_1k_eur",
      amountMinor: 2_000,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: null,
    },
  ],
}

const status = (subscriptionStatus: BillingStatus["subscriptionStatus"] = null): BillingStatus => ({
  credits: 10_000,
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

const deferred = <A,>() => {
  let resolve: (value: A) => void = () => undefined
  const promise = new Promise<A>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } satisfies Storage,
  })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })
    ),
  })
})

const renderBillingPage = async ({
  annualCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/annual" }),
  assignLocation = vi.fn(),
  checkoutReturnKind = null,
  loadStatus,
  onUnauthorized = vi.fn().mockResolvedValue(undefined),
  portal = vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" }),
  subscriptionStatus = null,
  topUpCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/top-up" }),
}: {
  readonly annualCheckout?: BillingPromiseResource["createAnnualCheckout"]
  readonly assignLocation?: (url: string) => void
  readonly checkoutReturnKind?: "annual" | "topUp" | null
  readonly loadStatus?: BillingPromiseResource["status"]
  readonly onUnauthorized?: () => Promise<void>
  readonly portal?: BillingPromiseResource["createPortalSession"]
  readonly subscriptionStatus?: BillingStatus["subscriptionStatus"]
  readonly topUpCheckout?: BillingPromiseResource["createTopUpCheckout"]
} = {}) => {
  const billing: BillingPromiseResource = {
    catalog: () => Promise.resolve(catalog),
    status: loadStatus ?? (() => Promise.resolve(status(subscriptionStatus))),
    createAnnualCheckout: annualCheckout,
    createTopUpCheckout: topUpCheckout,
    createPortalSession: portal,
  }
  const rootRoute = createRootRoute({
    component: () => (
      <BillingPageContent
        assignLocation={assignLocation}
        billing={billing}
        catalog={catalog}
        checkoutReturnKind={checkoutReturnKind}
        onUnauthorized={onUnauthorized}
        status={status(subscriptionStatus)}
      />
    ),
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return { assignLocation, onUnauthorized }
}

afterEach(cleanup)

describe("BillingPageContent", () => {
  it.each([
    {
      expectedUrl: "https://stripe.test/annual",
      label: /Subscribe for 159,00/,
      method: "annual" as const,
      subscriptionStatus: null,
    },
    {
      expectedUrl: "https://stripe.test/portal",
      label: "Manage subscription",
      method: "portal" as const,
      subscriptionStatus: "active",
    },
    {
      expectedUrl: "https://stripe.test/top-up",
      label: "Buy 1,000 credits",
      method: "topUp" as const,
      subscriptionStatus: "active",
    },
  ] satisfies ReadonlyArray<{
    readonly expectedUrl: string
    readonly label: string | RegExp
    readonly method: "annual" | "portal" | "topUp"
    readonly subscriptionStatus: BillingStatus["subscriptionStatus"]
  }>)(
    "opens Stripe from the $method action",
    async ({ expectedUrl, label, method, subscriptionStatus }) => {
      const annualCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/annual" })
      const portal = vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" })
      const topUpCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/top-up" })
      const { assignLocation } = await renderBillingPage({
        annualCheckout,
        portal,
        subscriptionStatus,
        topUpCheckout,
      })

      fireEvent.click(screen.getByRole("button", { name: label }))

      await waitFor(() => expect(assignLocation).toHaveBeenCalledWith(expectedUrl))
      expect(annualCheckout).toHaveBeenCalledTimes(method === "annual" ? 1 : 0)
      expect(portal).toHaveBeenCalledTimes(method === "portal" ? 1 : 0)
      expect(topUpCheckout).toHaveBeenCalledTimes(method === "topUp" ? 1 : 0)
    }
  )

  it("disables purchase actions while Stripe Checkout is opening", async () => {
    const checkout = deferred<{ readonly url: string }>()
    const { assignLocation } = await renderBillingPage({
      annualCheckout: () => checkout.promise,
    })

    fireEvent.click(screen.getByRole("button", { name: /Subscribe for 159,00/ }))

    expect(screen.getByRole("button", { name: "Opening Stripe…" }).hasAttribute("disabled")).toBe(
      true
    )
    expect(screen.getByRole("button", { name: "Buy 1,000 credits" }).hasAttribute("disabled")).toBe(
      true
    )
    checkout.resolve({ url: "https://stripe.test/annual" })
    await waitFor(() => expect(assignLocation).toHaveBeenCalledWith("https://stripe.test/annual"))
  })

  it("shows a Checkout failure and lets the user try again", async () => {
    const annualCheckout = vi.fn().mockRejectedValue(new Error("Stripe is unavailable"))
    await renderBillingPage({ annualCheckout })
    const subscribe = screen.getByRole("button", { name: /Subscribe for 159,00/ })

    fireEvent.click(subscribe)

    expect((await screen.findByRole("alert")).textContent).toContain("Stripe is unavailable")
    expect(subscribe.hasAttribute("disabled")).toBe(false)
    fireEvent.click(subscribe)
    await waitFor(() => expect(annualCheckout).toHaveBeenCalledTimes(2))
  })

  it.each([
    {
      checkoutReturnKind: "annual" as const,
      initialSubscriptionStatus: null,
      refreshedStatus: { ...status("active"), credits: 20_000 },
    },
    {
      checkoutReturnKind: "topUp" as const,
      initialSubscriptionStatus: "active" as const,
      refreshedStatus: { ...status("active"), credits: 11_000 },
    },
  ])(
    "refreshes the visible status after a $checkoutReturnKind Checkout return",
    async ({ checkoutReturnKind, initialSubscriptionStatus, refreshedStatus }) => {
      vi.useFakeTimers()
      const loadStatus = vi.fn().mockResolvedValue(refreshedStatus)
      try {
        await renderBillingPage({
          checkoutReturnKind,
          loadStatus,
          subscriptionStatus: initialSubscriptionStatus,
        })

        await act(async () => {
          await vi.advanceTimersByTimeAsync(500)
        })

        expect(loadStatus).toHaveBeenCalledTimes(1)
        expect(
          screen.getByText(new Intl.NumberFormat().format(refreshedStatus.credits))
        ).toBeTruthy()
        expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("handles an unauthorized status refresh after Checkout", async () => {
    vi.useFakeTimers()
    const onUnauthorized = vi.fn().mockResolvedValue(undefined)
    const loadStatus = vi.fn().mockRejectedValue(
      new TaxMaxiError({
        message: "Sign in again.",
        status: 401,
      })
    )
    try {
      await renderBillingPage({ checkoutReturnKind: "annual", loadStatus, onUnauthorized })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
