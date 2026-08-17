// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BillingCatalog } from "taxmaxi"

import { loadPublicBillingCatalog } from "#/routes/index"
import { PricingSection, STRIPE_PRICE_LOOKUP_KEYS } from "#/components/pricing-section"

const catalog: BillingCatalog = {
  prices: [
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.individualAnnual,
      amountMinor: 10_101,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: "year",
    },
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.individualTopUp,
      amountMinor: 20_202,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: null,
    },
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.professionalAnnual,
      amountMinor: 30_303,
      currency: "eur",
      taxBehavior: "exclusive",
      recurringInterval: "year",
    },
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.professionalMatter,
      amountMinor: 40_404,
      currency: "eur",
      taxBehavior: "exclusive",
      recurringInterval: "year",
    },
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.professionalTopUp,
      amountMinor: 50_505,
      currency: "eur",
      taxBehavior: "exclusive",
      recurringInterval: null,
    },
    {
      lookupKey: STRIPE_PRICE_LOOKUP_KEYS.enterprisePilot,
      amountMinor: 60_606,
      currency: "eur",
      taxBehavior: "exclusive",
      recurringInterval: null,
    },
  ],
}

afterEach(cleanup)

describe("PricingSection", () => {
  it("renders every Stripe catalog price in its matching offer", () => {
    const { container } = render(<PricingSection catalog={catalog} />)
    const expectedPrices = new Map([
      [STRIPE_PRICE_LOOKUP_KEYS.individualAnnual, "€101.01"],
      [STRIPE_PRICE_LOOKUP_KEYS.individualTopUp, "€202.02"],
      [STRIPE_PRICE_LOOKUP_KEYS.professionalAnnual, "€303.03"],
      [STRIPE_PRICE_LOOKUP_KEYS.professionalMatter, "€404.04"],
      [STRIPE_PRICE_LOOKUP_KEYS.professionalTopUp, "€505.05"],
      [STRIPE_PRICE_LOOKUP_KEYS.enterprisePilot, "€606.06"],
    ])

    for (const [lookupKey, expectedPrice] of expectedPrices) {
      const offer = container.querySelector(`[data-stripe-lookup-key="${lookupKey}"]`)
      expect(offer?.textContent).toContain(expectedPrice)
    }
    expect(container.textContent).toContain(
      "Taxes are shown for each price above and confirmed at checkout."
    )
  })

  it("renders the published fallback prices when the catalog is unavailable", () => {
    const { container } = render(<PricingSection catalog={null} />)

    for (const expectedPrice of ["€159", "€1,590", "€5,000", "€20", "€149", "€200"]) {
      expect(container.textContent).toContain(expectedPrice)
    }
    expect(container.textContent).toContain(
      "Individual prices include VAT. Business prices are net and exclude VAT."
    )
  })
})

describe("public pricing catalog loader", () => {
  it("returns the SDK catalog for the index route", async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog)

    await expect(loadPublicBillingCatalog(loadCatalog)).resolves.toEqual(catalog)
    expect(loadCatalog).toHaveBeenCalledOnce()
  })

  it("keeps the index route available when the SDK catalog fails", async () => {
    const loadCatalog = vi.fn().mockRejectedValue(new Error("catalog unavailable"))

    await expect(loadPublicBillingCatalog(loadCatalog)).resolves.toBeNull()
    expect(loadCatalog).toHaveBeenCalledOnce()
  })

  it("uses fallback pricing when the SDK catalog does not settle in time", async () => {
    const loadCatalog = vi.fn(() => new Promise<BillingCatalog>(() => undefined))

    await expect(loadPublicBillingCatalog(loadCatalog, 0)).resolves.toBeNull()
    expect(loadCatalog).toHaveBeenCalledOnce()
  })
})
