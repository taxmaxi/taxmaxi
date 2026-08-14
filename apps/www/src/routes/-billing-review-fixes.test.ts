import type { BillingStatus } from "taxmaxi"
import { describe, expect, it } from "vitest"

import { catalogPriceSuffix, catalogTaxNote } from "#/components/pricing-section"
import {
  isTopUpActionDisabled,
  loadBillingPageData,
  refreshBillingStatusAfterCheckout,
} from "./app_.billing"

const status = (
  credits: number,
  subscriptionStatus: BillingStatus["subscriptionStatus"] = null
) => ({ credits, subscriptionStatus, currentPeriodEnd: null, cancelAtPeriodEnd: false })

describe("billing review fixes", () => {
  it("keeps the product unit when the live tax behavior changes", () => {
    expect(
      catalogPriceSuffix(
        {
          lookupKey: "taxmaxi_annual_10k_eur",
          amountMinor: 15_950,
          currency: "eur",
          taxBehavior: "exclusive",
          recurringInterval: "year",
        },
        "per year, including VAT"
      )
    ).toBe("per year, plus applicable tax")
  })

  it("uses the live tax disclosure when catalog prices are loaded", () => {
    expect(
      catalogTaxNote(
        {
          prices: [
            {
              lookupKey: "taxmaxi_annual_10k_eur",
              amountMinor: 15_950,
              currency: "eur",
              taxBehavior: "exclusive",
              recurringInterval: "year",
            },
          ],
        },
        {
          fallback: "Individual prices include VAT.",
          live: "Taxes are shown for each price above and confirmed at checkout.",
        }
      )
    ).toBe("Taxes are shown for each price above and confirmed at checkout.")
    expect(
      catalogTaxNote(null, {
        fallback: "Individual prices include VAT.",
        live: "Taxes are shown for each price above and confirmed at checkout.",
      })
    ).toBe("Individual prices include VAT.")
  })

  it("polls Checkout returns until annual or top-up fulfillment is visible", async () => {
    const annualStatuses = [status(0, "incomplete"), status(0, "active"), status(10_000, "active")]
    const topUpStatuses = [status(10_000, "active"), status(11_000, "active")]
    const annual = await refreshBillingStatusAfterCheckout({
      initialStatus: status(0),
      kind: "annual",
      loadStatus: () => Promise.resolve(annualStatuses.shift() ?? status(10_000, "active")),
      wait: () => Promise.resolve(),
    })
    const topUp = await refreshBillingStatusAfterCheckout({
      initialStatus: status(10_000, "active"),
      kind: "topUp",
      loadStatus: () => Promise.resolve(topUpStatuses.shift() ?? status(11_000, "active")),
      wait: () => Promise.resolve(),
    })

    expect(annual).toMatchObject({ credits: 10_000, subscriptionStatus: "active" })
    expect(topUp).toMatchObject({ credits: 11_000, subscriptionStatus: "active" })
  })

  it("keeps polling after a transient Checkout status failure", async () => {
    const statuses: Array<BillingStatus | Error> = [
      new Error("temporary API failure"),
      status(10_000, "active"),
    ]
    const refreshed = await refreshBillingStatusAfterCheckout({
      initialStatus: status(0),
      kind: "annual",
      loadStatus: () => {
        const next = statuses.shift() ?? status(10_000, "active")
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      },
      wait: () => Promise.resolve(),
      attempts: 2,
    })

    expect(refreshed).toMatchObject({ credits: 10_000, subscriptionStatus: "active" })
  })

  it("keeps the last known status when every Checkout poll fails", async () => {
    const initialStatus = status(4_200, "active")
    const refreshed = await refreshBillingStatusAfterCheckout({
      initialStatus,
      kind: "topUp",
      loadStatus: () => Promise.reject(new Error("temporary API failure")),
      wait: () => Promise.resolve(),
      attempts: 2,
    })

    expect(refreshed).toEqual(initialStatus)
  })

  it("keeps local billing status available when catalog loading fails", async () => {
    const result = await loadBillingPageData({
      loadCatalog: () => Promise.reject(new Error("Stripe catalog unavailable")),
      loadStatus: () => Promise.resolve(status(4_200, "active")),
    })

    expect(result).toEqual({ catalog: null, status: status(4_200, "active") })
  })

  it("lets the server verify top-up eligibility when local status is stale", () => {
    expect(isTopUpActionDisabled({ hasCatalogPrice: true, pendingAction: false })).toBe(false)
    expect(isTopUpActionDisabled({ hasCatalogPrice: false, pendingAction: false })).toBe(true)
    expect(isTopUpActionDisabled({ hasCatalogPrice: true, pendingAction: true })).toBe(true)
  })
})
