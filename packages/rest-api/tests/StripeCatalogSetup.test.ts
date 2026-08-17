import * as ConfigProvider from "effect/ConfigProvider"
import { describe, expect, it } from "vitest"

import {
  STRIPE_RUNTIME_KEY_PERMISSIONS,
  TAXMAXI_STRIPE_CATALOG,
} from "../src/services/StripeCatalog.ts"
import {
  assertKeyMatchesEnvironment,
  decodeStripePriceRecord,
  decodeStripeProductRecord,
  loadStripeCatalogRestrictedKey,
  reconcileStripeCatalog,
  runStripeCatalogSetup,
  stripeCatalogPriceIdempotencyKey,
  type StripeCatalogClient,
  type StripeCatalogPriceInput,
  type StripeCatalogPriceRecord,
  type StripeCatalogProductRecord,
} from "../scripts/setupStripeCatalog.ts"

const firstCatalogItem = () => {
  const item = TAXMAXI_STRIPE_CATALOG[0]
  if (item === undefined) throw new Error("TaxMaxi Stripe catalog is empty")
  return item
}

const productRecord = ({
  id,
  lookupKey,
  name,
}: {
  readonly id: string
  readonly lookupKey: string
  readonly name: string
}): StripeCatalogProductRecord => ({
  id,
  active: true,
  name,
  description: null,
  taxCode: null,
  metadata: { taxmaxi_catalog_lookup_key: lookupKey },
})

class FakeStripeCatalogClient implements StripeCatalogClient {
  readonly products: Array<StripeCatalogProductRecord> = []
  readonly prices: Array<StripeCatalogPriceRecord> = []
  createdProducts = 0
  updatedProducts = 0
  createdPrices = 0
  updatedPrices = 0
  readonly createdPriceInputs: Array<StripeCatalogPriceInput> = []
  failNextArchive = false

  listProducts = () => Promise.resolve(this.products)

  listPrices = () => Promise.resolve(this.prices)

  createProduct: StripeCatalogClient["createProduct"] = (input) => {
    this.createdProducts += 1
    const product: StripeCatalogProductRecord = {
      id: `prod_${this.products.length + 1}`,
      active: input.active,
      name: input.name,
      description: input.description,
      taxCode: input.taxCode,
      metadata: input.metadata,
    }
    this.products.push(product)
    return Promise.resolve(product)
  }

  updateProduct: StripeCatalogClient["updateProduct"] = (id, input) => {
    this.updatedProducts += 1
    const index = this.products.findIndex((product) => product.id === id)
    const current = this.products[index]
    if (current === undefined) return Promise.reject(new Error(`Unknown product ${id}`))

    const updated: StripeCatalogProductRecord = {
      ...current,
      ...input,
      metadata: { ...current.metadata, ...input.metadata },
    }
    this.products[index] = updated
    return Promise.resolve(updated)
  }

  createPrice: StripeCatalogClient["createPrice"] = (input) => {
    this.createdPrices += 1
    this.createdPriceInputs.push(input)
    if (input.transferLookupKey) {
      for (let index = 0; index < this.prices.length; index += 1) {
        const price = this.prices[index]
        if (price?.lookupKey === input.lookupKey) {
          this.prices[index] = { ...price, lookupKey: null }
        }
      }
    }

    const price: StripeCatalogPriceRecord = {
      id: `price_${this.prices.length + 1}`,
      active: true,
      lookupKey: input.lookupKey,
      productId: input.productId,
      currency: input.currency,
      unitAmount: input.unitAmount,
      taxBehavior: input.taxBehavior,
      recurringInterval: input.recurringInterval,
      recurringIntervalCount: input.recurringInterval === null ? null : 1,
      metadata: { taxmaxi_catalog_lookup_key: input.lookupKey },
    }
    this.prices.push(price)
    return Promise.resolve(price)
  }

  updatePrice: StripeCatalogClient["updatePrice"] = (id, input) => {
    this.updatedPrices += 1
    if (input.active === false && this.failNextArchive) {
      this.failNextArchive = false
      return Promise.reject(new Error("Injected price archival failure"))
    }
    const index = this.prices.findIndex((price) => price.id === id)
    const current = this.prices[index]
    if (current === undefined) return Promise.reject(new Error(`Unknown price ${id}`))

    const updated: StripeCatalogPriceRecord = {
      ...current,
      ...(input.active === undefined ? {} : { active: input.active }),
      metadata:
        input.metadata === undefined
          ? current.metadata
          : { ...current.metadata, ...input.metadata },
    }
    this.prices[index] = updated
    return Promise.resolve(updated)
  }
}

describe("Stripe catalog setup", () => {
  it("loads the sandbox key from the runtime environment provider", async () => {
    const provider = ConfigProvider.fromEnv({
      env: { STRIPE_SANDBOX_CATALOG_KEY: "rk_test_catalog_from_environment" },
    })
    await expect(
      loadStripeCatalogRestrictedKey({ environment: "sandbox", provider })
    ).resolves.toBe("rk_test_catalog_from_environment")
  })

  it("uses the current Stripe Dashboard labels for runtime key permissions", () => {
    expect(STRIPE_RUNTIME_KEY_PERMISSIONS).toEqual([
      { resource: "Customers", access: "write" },
      { resource: "Checkout Sessions", access: "write" },
      { resource: "Customer Portal", access: "write" },
      { resource: "Prices", access: "read" },
      { resource: "Subscriptions", access: "read" },
      { resource: "Invoices", access: "read" },
      { resource: "Charges and Refunds", access: "read" },
      { resource: "Payment Disputes", access: "read" },
      { resource: "Payment Records", access: "read" },
    ])
  })

  it("creates the complete catalog once and then leaves it unchanged", async () => {
    const client = new FakeStripeCatalogClient()

    const firstRun = await reconcileStripeCatalog({ client })
    const secondRun = await reconcileStripeCatalog({ client })

    expect(firstRun).toEqual({
      productsCreated: 6,
      productsUpdated: 0,
      pricesCreated: 6,
      pricesActivated: 0,
      pricesArchived: 0,
      pricesUnchanged: 0,
    })
    expect(secondRun).toEqual({
      productsCreated: 0,
      productsUpdated: 0,
      pricesCreated: 0,
      pricesActivated: 0,
      pricesArchived: 0,
      pricesUnchanged: 6,
    })
    expect(client.createdProducts).toBe(6)
    expect(client.createdPrices).toBe(6)
  })

  it("replaces an immutable price mismatch and archives the old price", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product: StripeCatalogProductRecord = {
      ...productRecord({
        id: "prod_existing",
        lookupKey: spec.lookupKey,
        name: spec.name,
      }),
      active: false,
      name: "Legacy product name",
    }
    client.products.push(product)
    client.prices.push({
      id: "price_old",
      active: true,
      lookupKey: spec.lookupKey,
      productId: product.id,
      currency: spec.currency,
      unitAmount: spec.unitAmount - 100,
      taxBehavior: spec.taxBehavior,
      recurringInterval: spec.recurringInterval,
      recurringIntervalCount: 1,
      metadata: {},
    })

    const result = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(result.pricesCreated).toBe(1)
    expect(result.pricesArchived).toBe(1)
    expect(client.prices.find((price) => price.id === "price_old")?.active).toBe(false)
    expect(client.prices.find((price) => price.lookupKey === spec.lookupKey)?.unitAmount).toBe(
      spec.unitAmount
    )
    expect(client.createdPriceInputs).toHaveLength(1)
    expect(client.createdPriceInputs[0]?.replacedPriceId).toBe("price_old")
    expect(client.products[0]).toEqual({
      id: product.id,
      active: true,
      name: spec.name,
      description: spec.description,
      taxCode: "txcd_10000000",
      metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
    })
  })

  it("recovers when archiving a replaced price fails after lookup transfer", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_existing",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push({
      id: "price_old",
      active: true,
      lookupKey: spec.lookupKey,
      productId: product.id,
      currency: spec.currency,
      unitAmount: spec.unitAmount - 100,
      taxBehavior: spec.taxBehavior,
      recurringInterval: spec.recurringInterval,
      recurringIntervalCount: 1,
      metadata: {},
    })
    client.failNextArchive = true

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "Injected price archival failure"
    )
    const rerun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(rerun.pricesCreated).toBe(0)
    expect(rerun.pricesArchived).toBe(1)
    expect(
      client.prices.filter(
        (price) => price.active && price.metadata.taxmaxi_catalog_lookup_key === spec.lookupKey
      )
    ).toHaveLength(1)
    expect(client.prices.find(({ id }) => id === "price_old")?.active).toBe(false)
  })

  it("keeps catalog items on separate products when existing prices share one", async () => {
    const client = new FakeStripeCatalogClient()
    const catalog = TAXMAXI_STRIPE_CATALOG.slice(0, 2)
    const firstSpec = catalog[0]
    const secondSpec = catalog[1]
    if (firstSpec === undefined || secondSpec === undefined) {
      throw new Error("TaxMaxi Stripe catalog needs at least two items")
    }

    const sharedProduct = productRecord({
      id: "prod_shared",
      lookupKey: firstSpec.lookupKey,
      name: firstSpec.name,
    })
    client.products.push(sharedProduct)
    client.prices.push(
      {
        id: "price_first",
        active: true,
        lookupKey: firstSpec.lookupKey,
        productId: sharedProduct.id,
        currency: firstSpec.currency,
        unitAmount: firstSpec.unitAmount,
        taxBehavior: firstSpec.taxBehavior,
        recurringInterval: firstSpec.recurringInterval,
        recurringIntervalCount: firstSpec.recurringInterval === null ? null : 1,
        metadata: {},
      },
      {
        id: "price_second",
        active: true,
        lookupKey: secondSpec.lookupKey,
        productId: sharedProduct.id,
        currency: secondSpec.currency,
        unitAmount: secondSpec.unitAmount,
        taxBehavior: secondSpec.taxBehavior,
        recurringInterval: secondSpec.recurringInterval,
        recurringIntervalCount: secondSpec.recurringInterval === null ? null : 1,
        metadata: {},
      }
    )

    const result = await reconcileStripeCatalog({ client, catalog })

    const firstPrice = client.prices.find(({ lookupKey }) => lookupKey === firstSpec.lookupKey)
    const secondPrice = client.prices.find(({ lookupKey }) => lookupKey === secondSpec.lookupKey)
    expect(result.productsCreated).toBe(2)
    expect(result.productsUpdated).toBe(0)
    expect(firstPrice?.productId).not.toBe(sharedProduct.id)
    expect(secondPrice?.productId).not.toBe(sharedProduct.id)
    expect(firstPrice?.productId).not.toBe(secondPrice?.productId)
    expect(client.products.find(({ id }) => id === sharedProduct.id)).toEqual(sharedProduct)
  })

  it("uses the replaced price as the idempotency generation", () => {
    const input: StripeCatalogPriceInput = {
      lookupKey: "taxmaxi_example",
      productId: "prod_example",
      currency: "eur",
      unitAmount: 12_500,
      taxBehavior: "inclusive",
      recurringInterval: "year",
      transferLookupKey: true,
      replacedPriceId: "price_generation_one",
    }

    expect(stripeCatalogPriceIdempotencyKey(input)).toBe(
      stripeCatalogPriceIdempotencyKey({ ...input })
    )
    expect(stripeCatalogPriceIdempotencyKey(input)).not.toBe(
      stripeCatalogPriceIdempotencyKey({
        ...input,
        replacedPriceId: "price_generation_two",
      })
    )
  })

  it("activates an inactive exact-match price", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_existing",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push({
      id: "price_inactive",
      active: false,
      lookupKey: spec.lookupKey,
      productId: product.id,
      currency: spec.currency,
      unitAmount: spec.unitAmount,
      taxBehavior: spec.taxBehavior,
      recurringInterval: spec.recurringInterval,
      recurringIntervalCount: spec.recurringInterval === null ? null : 1,
      metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
    })

    const result = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(result.pricesActivated).toBe(1)
    expect(client.prices[0]?.active).toBe(true)
  })

  it("cancels production before loading a key or creating a client", async () => {
    const answers = ["production", "no"]
    let keyLoads = 0
    let setupCalls = 0

    const result = await runStripeCatalogSetup({
      question: () => Promise.resolve(answers.shift() ?? ""),
      loadKey: () => {
        keyLoads += 1
        return Promise.resolve("rk_live_unused")
      },
      setup: () => {
        setupCalls += 1
        return Promise.reject(new Error("Setup must not run"))
      },
    })

    expect(result).toEqual({ status: "cancelled" })
    expect(keyLoads).toBe(0)
    expect(setupCalls).toBe(0)
  })

  it("rejects malformed Stripe product and price payloads", async () => {
    await expect(decodeStripeProductRecord({ id: 123 })).rejects.toBeDefined()
    await expect(decodeStripePriceRecord({ id: "price_bad", active: "yes" })).rejects.toBeDefined()
  })

  it("rejects keys from the wrong Stripe mode", () => {
    expect(() => assertKeyMatchesEnvironment("production", "rk_test_example")).toThrow(
      "production restricted key"
    )
    expect(() => assertKeyMatchesEnvironment("sandbox", "rk_live_example")).toThrow(
      "sandbox restricted key"
    )
    expect(() => assertKeyMatchesEnvironment("production", "rk_live_example")).not.toThrow()
    expect(() => assertKeyMatchesEnvironment("sandbox", "rk_test_example")).not.toThrow()
  })
})
