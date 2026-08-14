import type { BillingStatus } from "taxmaxi"
import { describe, expect, it } from "vitest"

import { catalogPriceSuffix } from "#/components/pricing-section"
import { refreshBillingStatusAfterCheckout } from "./app_.billing"

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
          amount: 15_950,
          currency: "eur",
          taxBehavior: "exclusive",
          recurringInterval: "year",
        },
        "per year, including VAT"
      )
    ).toBe("per year, plus applicable tax")
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
})
