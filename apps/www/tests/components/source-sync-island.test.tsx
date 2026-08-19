// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ComponentProps, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BillingStatus } from "taxmaxi"

import {
  SourceSyncIsland,
  getCreditRequiredCopy,
  type SourceSyncIslandItem,
} from "#/components/source-sync-island"

const navigateMock = vi.fn()

let billingStatusResult: () => Promise<BillingStatus>

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouteContext: ({ select }: { readonly select: (context: unknown) => unknown }) =>
    select({ taxmaxi: () => ({ billing: { status: () => billingStatusResult() } }) }),
}))

vi.mock("motion/react", () => {
  const stripMotionProps = ({
    animate: _animate,
    exit: _exit,
    initial: _initial,
    layout: _layout,
    transition: _transition,
    variants: _variants,
    whileTap: _whileTap,
    ...rest
  }: Record<string, unknown>) => rest
  const passthrough = (tag: string) => (props: Record<string, unknown>) =>
    createElement(tag, stripMotionProps(props))

  return {
    AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
    motion: {
      button: passthrough("button"),
      div: passthrough("div"),
      span: passthrough("span"),
    },
    useReducedMotion: () => true,
  }
})

const makeBillingStatus = (subscriptionStatus: string | null): BillingStatus => ({
  credits: 0,
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

const creditRequiredItem: SourceSyncIslandItem = {
  id: "source-1",
  sourceName: "Coinbase",
  status: "credit_required",
  progress: 100,
  fetchedRecords: 104,
  normalizedRecords: 82,
  failedRecords: 0,
  // A raw server message must never be what the user sees for credit outcomes.
  message:
    "SyncEngineStorageError during sourceNormalizationRepository.consumeTransactionCredit.exhausted",
  creditOutcome: {
    reasonCode: "no_usable_credits",
    availableCredits: 0,
    creditsConsumed: 82,
    additionalCreditsRequired: 22,
  },
}

const failedItem: SourceSyncIslandItem = {
  id: "source-2",
  sourceName: "Kraken",
  status: "failed",
  progress: 100,
  message: "Provider unavailable. Try again in a few minutes.",
}

const renderIsland = (props: Partial<ComponentProps<typeof SourceSyncIsland>> = {}) =>
  render(
    <SourceSyncIsland
      items={[creditRequiredItem]}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
      {...props}
    />
  )

describe("SourceSyncIsland credit-required recovery", () => {
  beforeEach(() => {
    navigateMock.mockReset()
    billingStatusResult = () => Promise.resolve(makeBillingStatus(null))
  })

  afterEach(() => {
    cleanup()
  })

  it("shows safe copy from the credit outcome and never the raw server message", () => {
    renderIsland()

    expect(
      screen.getByText(
        "This sync is paused: your transaction credits ran out. 82 transactions are already imported and stay yours. Add 22 more credits to finish the sync."
      )
    ).toBeDefined()
    expect(document.body.textContent).not.toContain("SyncEngineStorageError")
    expect(document.body.textContent).not.toContain("consumeTransactionCredit")
  })

  it("offers no retry action for a credit-required sync", () => {
    renderIsland()

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("navigates to billing from the plan action for a user without an active subscription", async () => {
    renderIsland()

    const action = await screen.findByRole("button", { name: "Choose a plan" })
    fireEvent.click(action)

    expect(navigateMock).toHaveBeenCalledWith({ to: "/app/billing" })
  })

  it("offers the credit purchase action to an exhausted active subscriber", async () => {
    billingStatusResult = () => Promise.resolve(makeBillingStatus("active"))
    renderIsland()

    expect(await screen.findByRole("button", { name: "Buy credits" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Choose a plan" })).toBeNull()
  })

  it("falls back to the plan action when billing status cannot load", async () => {
    billingStatusResult = () => Promise.reject(new Error("billing unavailable"))
    renderIsland()

    expect(await screen.findByRole("button", { name: "Choose a plan" })).toBeDefined()
  })

  it("keeps the retry action for ordinary failures", () => {
    const onRetry = vi.fn()
    renderIsland({ items: [failedItem], onRetry })

    const retry = screen.getByRole("button", { name: /Retry/ })
    fireEvent.click(retry)

    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "source-2" }))
    expect(screen.queryByRole("button", { name: "Choose a plan" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Buy credits" })).toBeNull()
  })
})

describe("getCreditRequiredCopy", () => {
  it("explains the pause without counts when no outcome is available", () => {
    expect(getCreditRequiredCopy(undefined)).toBe(
      "This sync is paused until you add transaction credits."
    )
  })

  it("leaves the shortfall open while the billable total is unknown", () => {
    expect(
      getCreditRequiredCopy({
        reasonCode: "no_usable_credits",
        availableCredits: 0,
        creditsConsumed: 1,
        additionalCreditsRequired: null,
      })
    ).toBe(
      "This sync is paused: your transaction credits ran out. 1 transaction is already imported and stays yours. Add credits to finish the sync."
    )
  })

  it("tells a refused start it needs credits to begin, not that credits ran out", () => {
    expect(
      getCreditRequiredCopy({
        reasonCode: "no_usable_credits",
        availableCredits: 0,
        creditsConsumed: 0,
        additionalCreditsRequired: null,
      })
    ).toBe("This sync needs transaction credits before it can start. Add credits and run it again.")
  })

  it("uses singular wording for a shortfall of one credit", () => {
    expect(
      getCreditRequiredCopy({
        reasonCode: "no_usable_credits",
        availableCredits: 0,
        creditsConsumed: 0,
        additionalCreditsRequired: 1,
      })
    ).toBe(
      "This sync is paused: your transaction credits ran out. Add 1 more credit to finish the sync."
    )
  })
})
