import * as ConfigProvider from "effect/ConfigProvider"
import Stripe from "stripe"
import { describe, expect, it, vi } from "vitest"

interface StripeSdkMockState {
  readonly calls: Array<ReadonlyArray<unknown>>
}

const stripeSdkMockState = vi.hoisted<StripeSdkMockState>(() => ({ calls: [] }))

vi.mock("stripe", () => ({
  default: class StripeMock {
    readonly products = {
      list: (params: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["products.list", params])
        const product = {
          id: "prod_listed",
          active: true,
          name: "Listed product",
          description: null,
          tax_code: null,
          metadata: {},
        }
        return {
          autoPagingEach: async (
            handler: (item: typeof product) => boolean | void | Promise<boolean | void>
          ) => {
            stripeSdkMockState.calls.push(["products.autoPagingEach"])
            await handler(product)
          },
        }
      },
      create: (params: Record<string, unknown>, options: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["products.create", params, options])
        return Promise.resolve({ id: "prod_created", ...params })
      },
      update: (id: string, params: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["products.update", id, params])
        return Promise.resolve({ id, ...params })
      },
    }

    readonly prices = {
      list: (params: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["prices.list", params])
        const price = {
          id: params.active === false ? "price_inactive" : "price_active",
          active: params.active !== false,
          billing_scheme: "per_unit",
          lookup_key: params.active === false ? "inactive_price" : "active_price",
          product: "prod_listed",
          currency: "eur",
          unit_amount: 1_000,
          tax_behavior: "inclusive",
          recurring: null,
          transform_quantity: null,
          metadata: {},
        }
        return {
          autoPagingEach: async (
            handler: (item: typeof price) => boolean | void | Promise<boolean | void>
          ) => {
            stripeSdkMockState.calls.push(["prices.autoPagingEach"])
            await handler(price)
          },
        }
      },
      create: (params: Record<string, unknown>, options: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["prices.create", params, options])
        return Promise.resolve({
          id: "price_created",
          active: true,
          transform_quantity: null,
          ...params,
          recurring:
            params.recurring === undefined
              ? null
              : {
                  interval: "year",
                  interval_count: 1,
                  usage_type: "licensed",
                  trial_period_days: null,
                },
        })
      },
      update: (id: string, params: Record<string, unknown>) => {
        stripeSdkMockState.calls.push(["prices.update", id, params])
        return Promise.resolve({
          id,
          active: params.active ?? true,
          billing_scheme: "per_unit",
          lookup_key: "updated_price",
          product: "prod_created",
          currency: "eur",
          unit_amount: 2_000,
          tax_behavior: "inclusive",
          recurring: null,
          transform_quantity: null,
          metadata: params.metadata ?? {},
        })
      },
    }
  },
}))

import {
  STRIPE_RUNTIME_KEY_PERMISSIONS,
  TAXMAXI_STRIPE_CATALOG,
  type TaxMaxiStripeCatalogItem,
} from "../src/services/StripeCatalog.ts"
import {
  assertKeyMatchesEnvironment,
  decodeStripePriceRecord,
  decodeStripeProductRecord,
  loadAllStripeListItems,
  loadStripeCatalogRestrictedKey,
  makeStripeCatalogClient,
  reconcileStripeCatalog,
  runStripeCatalogSetup,
  stripeCatalogProductIdempotencyKey,
  stripeCatalogPriceIdempotencyKey,
  type StripeCatalogClient,
  type StripeCatalogPriceInput,
  type StripeCatalogPriceRecord,
  type StripeCatalogProductCreateInput,
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

const priceRecordDefinition = (spec: Pick<TaxMaxiStripeCatalogItem, "recurringInterval">) => ({
  billingScheme: "per_unit",
  recurringUsageType: spec.recurringInterval === null ? null : "licensed",
  recurringTrialPeriodDays: null,
  transformQuantity: null,
})

class FakeStripeCatalogClient implements StripeCatalogClient {
  readonly products: Array<StripeCatalogProductRecord> = []
  readonly prices: Array<StripeCatalogPriceRecord> = []
  createdProducts = 0
  updatedProducts = 0
  createdPrices = 0
  updatedPrices = 0
  readonly createdPriceInputs: Array<StripeCatalogPriceInput> = []
  readonly createdProductInputs: Array<StripeCatalogProductCreateInput> = []
  failNextArchive = false
  failAfterNextProductCreation = false
  failAfterNextPriceCreation = false
  failAfterPriceMetadataUpdateId: string | null = null

  listProducts = () => Promise.resolve(this.products)

  listPrices = () => Promise.resolve(this.prices)

  createProduct: StripeCatalogClient["createProduct"] = (input) => {
    this.createdProducts += 1
    this.createdProductInputs.push(input)
    const product: StripeCatalogProductRecord = {
      id: `prod_${this.products.length + 1}`,
      active: input.active,
      name: input.name,
      description: input.description,
      taxCode: input.taxCode,
      metadata: input.metadata,
    }
    this.products.push(product)
    if (this.failAfterNextProductCreation) {
      this.failAfterNextProductCreation = false
      return Promise.reject(new Error("Injected accepted product creation failure"))
    }
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
      billingScheme: "per_unit",
      lookupKey: input.lookupKey,
      productId: input.productId,
      currency: input.currency,
      unitAmount: input.unitAmount,
      taxBehavior: input.taxBehavior,
      recurringInterval: input.recurringInterval,
      recurringIntervalCount: input.recurringInterval === null ? null : 1,
      recurringUsageType: input.recurringInterval === null ? null : "licensed",
      recurringTrialPeriodDays: null,
      transformQuantity: null,
      metadata: { taxmaxi_catalog_lookup_key: input.lookupKey },
    }
    this.prices.push(price)
    if (this.failAfterNextPriceCreation) {
      this.failAfterNextPriceCreation = false
      return Promise.reject(new Error("Injected accepted price creation failure"))
    }
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
    if (input.metadata !== undefined && this.failAfterPriceMetadataUpdateId === id) {
      this.failAfterPriceMetadataUpdateId = null
      return Promise.reject(new Error("Injected accepted price metadata failure"))
    }
    return Promise.resolve(updated)
  }
}

describe("Stripe catalog setup", () => {
  it("maps the production Stripe SDK calls to the catalog client contract", async () => {
    stripeSdkMockState.calls.length = 0
    const client = makeStripeCatalogClient(new Stripe("rk_test_catalog"))
    const productInput: StripeCatalogProductCreateInput = {
      active: true,
      name: "TaxMaxi annual",
      description: "Annual tax calculation plan",
      taxCode: "txcd_10000000",
      metadata: { taxmaxi_catalog_lookup_key: "taxmaxi_annual_test" },
      lookupKey: "taxmaxi_annual_test",
      replacedProductId: null,
    }
    const priceInput: StripeCatalogPriceInput = {
      lookupKey: "taxmaxi_annual_test",
      productId: "prod_created",
      currency: "eur",
      unitAmount: 15_900,
      taxBehavior: "inclusive",
      recurringInterval: "year",
      transferLookupKey: true,
      replacedPriceId: "price_replaced",
    }
    const oneTimePriceInput: StripeCatalogPriceInput = {
      lookupKey: "taxmaxi_topup_test",
      productId: "prod_created",
      currency: "eur",
      unitAmount: 2_900,
      taxBehavior: "inclusive",
      recurringInterval: null,
      transferLookupKey: false,
      replacedPriceId: null,
    }

    await client.listProducts()
    const listedPrices = await client.listPrices()
    await client.createProduct(productInput)
    await client.updateProduct("prod_created", productInput)
    await client.createPrice(priceInput)
    await client.createPrice(oneTimePriceInput)
    await client.updatePrice("price_created", {
      active: false,
      metadata: { taxmaxi_catalog_lookup_key: priceInput.lookupKey },
    })

    expect(listedPrices.map(({ id, active }) => ({ id, active }))).toEqual([
      { id: "price_active", active: true },
      { id: "price_inactive", active: false },
    ])

    expect(stripeSdkMockState.calls).toEqual([
      ["products.list", { limit: 100 }],
      ["products.autoPagingEach"],
      ["prices.list", { active: true, limit: 100 }],
      ["prices.autoPagingEach"],
      ["prices.list", { active: false, limit: 100 }],
      ["prices.autoPagingEach"],
      [
        "products.create",
        {
          active: true,
          name: productInput.name,
          description: productInput.description,
          tax_code: productInput.taxCode,
          metadata: productInput.metadata,
        },
        { idempotencyKey: "taxmaxi-catalog-product-taxmaxi_annual_test-initial" },
      ],
      [
        "products.update",
        "prod_created",
        {
          active: true,
          name: productInput.name,
          description: productInput.description,
          tax_code: productInput.taxCode,
          metadata: productInput.metadata,
        },
      ],
      [
        "prices.create",
        {
          billing_scheme: "per_unit",
          currency: "eur",
          lookup_key: priceInput.lookupKey,
          nickname: priceInput.lookupKey,
          product: priceInput.productId,
          tax_behavior: "inclusive",
          transfer_lookup_key: true,
          unit_amount: 15_900,
          metadata: { taxmaxi_catalog_lookup_key: priceInput.lookupKey },
          recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
        },
        { idempotencyKey: stripeCatalogPriceIdempotencyKey(priceInput) },
      ],
      [
        "prices.create",
        {
          billing_scheme: "per_unit",
          currency: "eur",
          lookup_key: oneTimePriceInput.lookupKey,
          nickname: oneTimePriceInput.lookupKey,
          product: oneTimePriceInput.productId,
          tax_behavior: "inclusive",
          transfer_lookup_key: false,
          unit_amount: 2_900,
          metadata: { taxmaxi_catalog_lookup_key: oneTimePriceInput.lookupKey },
        },
        { idempotencyKey: stripeCatalogPriceIdempotencyKey(oneTimePriceInput) },
      ],
      [
        "prices.update",
        "price_created",
        {
          active: false,
          metadata: { taxmaxi_catalog_lookup_key: priceInput.lookupKey },
        },
      ],
    ])
  })

  it("loads the sandbox key from the runtime environment provider", async () => {
    const provider = ConfigProvider.fromEnv({
      env: { STRIPE_SANDBOX_CATALOG_KEY: "rk_test_catalog_from_environment" },
    })
    await expect(
      loadStripeCatalogRestrictedKey({ environment: "sandbox", provider })
    ).resolves.toBe("rk_test_catalog_from_environment")
  })

  it("loads the production key from its separate runtime environment variable", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        STRIPE_SANDBOX_CATALOG_KEY: "rk_test_catalog_from_environment",
        STRIPE_PRODUCTION_CATALOG_KEY: "rk_live_catalog_from_environment",
      },
    })

    await expect(
      loadStripeCatalogRestrictedKey({ environment: "production", provider })
    ).resolves.toBe("rk_live_catalog_from_environment")
  })

  it("uses the current Stripe Dashboard labels for runtime key permissions", () => {
    expect(STRIPE_RUNTIME_KEY_PERMISSIONS).toEqual([
      { resource: "Customers", access: "write" },
      { resource: "Checkout Sessions", access: "write" },
      { resource: "Customer Portal", access: "write" },
      { resource: "Prices", access: "read" },
      { resource: "Products", access: "read" },
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
      pricesMetadataUpdated: 0,
      pricesArchived: 0,
      pricesUnchanged: 0,
    })
    expect(secondRun).toEqual({
      productsCreated: 0,
      productsUpdated: 0,
      pricesCreated: 0,
      pricesActivated: 0,
      pricesMetadataUpdated: 0,
      pricesArchived: 0,
      pricesUnchanged: 6,
    })
    expect(client.createdProducts).toBe(6)
    expect(client.createdPrices).toBe(6)
  })

  it("rejects duplicate catalog lookup keys before changing Stripe", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()

    await expect(
      reconcileStripeCatalog({
        client,
        catalog: [spec, { ...spec, name: "Conflicting duplicate offer" }],
      })
    ).rejects.toThrow("lookup keys must be unique")

    expect(client.createdProducts).toBe(0)
    expect(client.updatedProducts).toBe(0)
    expect(client.createdPrices).toBe(0)
    expect(client.updatedPrices).toBe(0)
  })

  it("does not adopt an unrelated product by display name", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const unrelatedProduct: StripeCatalogProductRecord = {
      id: "prod_unrelated",
      active: true,
      name: spec.name,
      description: "Another offer with the same display name.",
      taxCode: "txcd_unrelated",
      metadata: {},
    }
    client.products.push(unrelatedProduct)

    const result = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(result.productsCreated).toBe(1)
    expect(result.productsUpdated).toBe(0)
    expect(client.products.find(({ id }) => id === unrelatedProduct.id)).toEqual(unrelatedProduct)
    expect(client.prices[0]?.productId).not.toBe(unrelatedProduct.id)
  })

  it("rejects duplicate Stripe product ownership before changing Stripe", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    client.products.push(
      productRecord({ id: "prod_duplicate_one", lookupKey: spec.lookupKey, name: spec.name }),
      productRecord({ id: "prod_duplicate_two", lookupKey: spec.lookupKey, name: spec.name })
    )

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "resolve the duplicate first"
    )

    expect(client.createdProducts).toBe(0)
    expect(client.updatedProducts).toBe(0)
    expect(client.createdPrices).toBe(0)
    expect(client.updatedPrices).toBe(0)
  })

  it.each([
    ["inactive state", { active: false }],
    ["name", { name: "Changed name" }],
    ["description", { description: "Changed description" }],
    ["tax code", { taxCode: "txcd_changed" }],
    ["ownership metadata", { metadata: {} }],
  ] satisfies ReadonlyArray<readonly [string, Partial<StripeCatalogProductRecord>]>)(
    "repairs Product drift in %s",
    async (_, override) => {
      const client = new FakeStripeCatalogClient()
      const spec = firstCatalogItem()
      const product: StripeCatalogProductRecord = {
        id: "prod_drifted",
        active: true,
        name: spec.name,
        description: spec.description,
        taxCode: "txcd_10000000",
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
        ...override,
      }
      client.products.push(product)
      client.prices.push({
        ...priceRecordDefinition(spec),
        id: "price_current",
        active: true,
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

      expect(result.productsUpdated).toBe(1)
      expect(result.pricesCreated).toBe(0)
      expect(result.pricesUnchanged).toBe(1)
    }
  )

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
      ...priceRecordDefinition(spec),
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

  it.each([
    ["billing scheme", { billingScheme: "tiered" }],
    ["currency", { currency: "usd" }],
    ["amount", { unitAmount: 1 }],
    ["tax behavior", { taxBehavior: "exclusive" }],
    ["recurring interval", { recurringInterval: "month" }],
    ["recurring interval count", { recurringIntervalCount: 2 }],
    ["metered usage", { recurringUsageType: "metered" }],
    ["trial period", { recurringTrialPeriodDays: 14 }],
    ["quantity transformation", { transformQuantity: { divideBy: 10, round: "up" } }],
  ] satisfies ReadonlyArray<readonly [string, Partial<StripeCatalogPriceRecord>]>)(
    "replaces a price with drift in %s",
    async (_, override) => {
      const client = new FakeStripeCatalogClient()
      const spec = firstCatalogItem()
      const product = productRecord({
        id: "prod_existing",
        lookupKey: spec.lookupKey,
        name: spec.name,
      })
      client.products.push(product)
      client.prices.push({
        ...priceRecordDefinition(spec),
        id: "price_drifted",
        active: true,
        lookupKey: spec.lookupKey,
        productId: product.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
        ...override,
      })

      const result = await reconcileStripeCatalog({ client, catalog: [spec] })

      expect(result.pricesCreated).toBe(1)
      expect(result.pricesArchived).toBe(1)
      expect(client.prices.find(({ id }) => id === "price_drifted")?.active).toBe(false)
    }
  )

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
      ...priceRecordDefinition(spec),
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

  it("recovers when Product creation succeeds but its response is lost", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    client.failAfterNextProductCreation = true

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "accepted product creation failure"
    )
    const rerun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(client.createdProducts).toBe(1)
    expect(rerun.productsCreated).toBe(0)
    expect(rerun.pricesCreated).toBe(1)
  })

  it("recovers when a shared-Product replacement succeeds but its response is lost", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const sharedProduct = productRecord({
      id: "prod_shared",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(sharedProduct)
    client.prices.push(
      {
        ...priceRecordDefinition(spec),
        id: "price_current",
        active: true,
        lookupKey: spec.lookupKey,
        productId: sharedProduct.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      },
      {
        ...priceRecordDefinition({ recurringInterval: null }),
        id: "price_other_offer",
        active: true,
        lookupKey: "taxmaxi_other_offer",
        productId: sharedProduct.id,
        currency: "eur",
        unitAmount: 9_900,
        taxBehavior: "exclusive",
        recurringInterval: null,
        recurringIntervalCount: null,
        metadata: { taxmaxi_catalog_lookup_key: "taxmaxi_other_offer" },
      }
    )
    client.failAfterNextProductCreation = true

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "accepted product creation failure"
    )
    const rerun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(client.createdProducts).toBe(1)
    expect(client.createdProductInputs[0]?.replacedProductId).toBe(sharedProduct.id)
    expect(rerun.productsCreated).toBe(0)
    expect(rerun.pricesCreated).toBe(1)
    expect(client.prices.find(({ lookupKey }) => lookupKey === spec.lookupKey)?.productId).not.toBe(
      sharedProduct.id
    )
  })

  it("recovers when Price creation and lookup transfer succeed but the response is lost", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_existing",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push({
      ...priceRecordDefinition(spec),
      id: "price_old",
      active: true,
      lookupKey: spec.lookupKey,
      productId: product.id,
      currency: spec.currency,
      unitAmount: spec.unitAmount - 100,
      taxBehavior: spec.taxBehavior,
      recurringInterval: spec.recurringInterval,
      recurringIntervalCount: spec.recurringInterval === null ? null : 1,
      metadata: {},
    })
    client.failAfterNextPriceCreation = true

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "accepted price creation failure"
    )
    const rerun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(client.createdPrices).toBe(1)
    expect(rerun.pricesCreated).toBe(0)
    expect(rerun.pricesArchived).toBe(1)
    expect(client.prices.filter(({ active }) => active)).toHaveLength(1)
    expect(client.prices.find(({ lookupKey }) => lookupKey === spec.lookupKey)).toMatchObject({
      active: true,
      unitAmount: spec.unitAmount,
    })
  })

  it("recovers when canonical metadata repair succeeds but its response is lost", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_existing",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push({
      ...priceRecordDefinition(spec),
      id: "price_current",
      active: true,
      lookupKey: spec.lookupKey,
      productId: product.id,
      currency: spec.currency,
      unitAmount: spec.unitAmount,
      taxBehavior: spec.taxBehavior,
      recurringInterval: spec.recurringInterval,
      recurringIntervalCount: spec.recurringInterval === null ? null : 1,
      metadata: {},
    })
    client.failAfterPriceMetadataUpdateId = "price_current"

    await expect(reconcileStripeCatalog({ client, catalog: [spec] })).rejects.toThrow(
      "accepted price metadata failure"
    )
    const rerun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(client.updatedPrices).toBe(1)
    expect(rerun.pricesMetadataUpdated).toBe(0)
    expect(rerun.pricesUnchanged).toBe(1)
    expect(client.prices[0]?.metadata).toEqual({
      taxmaxi_catalog_lookup_key: spec.lookupKey,
    })
  })

  it("archives a lookup-less replaced price and leaves the canonical price active", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_existing",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push(
      {
        ...priceRecordDefinition(spec),
        id: "price_current",
        active: true,
        lookupKey: spec.lookupKey,
        productId: product.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      },
      {
        ...priceRecordDefinition(spec),
        id: "price_replaced",
        active: true,
        lookupKey: null,
        productId: product.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount - 100,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      }
    )

    const firstRun = await reconcileStripeCatalog({ client, catalog: [spec] })
    const secondRun = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(firstRun.pricesArchived).toBe(1)
    expect(secondRun.pricesArchived).toBe(0)
    expect(secondRun.pricesUnchanged).toBe(1)
    expect(client.prices.find(({ id }) => id === "price_current")?.active).toBe(true)
    expect(client.prices.find(({ id }) => id === "price_replaced")?.active).toBe(false)
  })

  it("repairs canonical metadata without archiving another catalog price", async () => {
    const client = new FakeStripeCatalogClient()
    const catalog = TAXMAXI_STRIPE_CATALOG.slice(0, 2)
    const firstSpec = catalog[0]
    const secondSpec = catalog[1]
    if (firstSpec === undefined || secondSpec === undefined) {
      throw new Error("TaxMaxi Stripe catalog needs at least two items")
    }

    const firstProduct = productRecord({
      id: "prod_first",
      lookupKey: firstSpec.lookupKey,
      name: firstSpec.name,
    })
    const secondProduct = productRecord({
      id: "prod_second",
      lookupKey: secondSpec.lookupKey,
      name: secondSpec.name,
    })
    client.products.push(firstProduct, secondProduct)
    client.prices.push(
      {
        ...priceRecordDefinition(firstSpec),
        id: "price_first",
        active: true,
        lookupKey: firstSpec.lookupKey,
        productId: firstProduct.id,
        currency: firstSpec.currency,
        unitAmount: firstSpec.unitAmount,
        taxBehavior: firstSpec.taxBehavior,
        recurringInterval: firstSpec.recurringInterval,
        recurringIntervalCount: firstSpec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: secondSpec.lookupKey },
      },
      {
        ...priceRecordDefinition(secondSpec),
        id: "price_second",
        active: true,
        lookupKey: secondSpec.lookupKey,
        productId: secondProduct.id,
        currency: secondSpec.currency,
        unitAmount: secondSpec.unitAmount,
        taxBehavior: secondSpec.taxBehavior,
        recurringInterval: secondSpec.recurringInterval,
        recurringIntervalCount: secondSpec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: secondSpec.lookupKey },
      }
    )

    const result = await reconcileStripeCatalog({ client, catalog })

    expect(result.pricesArchived).toBe(0)
    expect(result.pricesMetadataUpdated).toBe(1)
    expect(client.prices.find(({ id }) => id === "price_first")).toMatchObject({
      active: true,
      metadata: { taxmaxi_catalog_lookup_key: firstSpec.lookupKey },
    })
    expect(client.prices.find(({ id }) => id === "price_second")?.active).toBe(true)
  })

  it("does not archive a removed offer that still has a lookup key", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const product = productRecord({
      id: "prod_current",
      lookupKey: spec.lookupKey,
      name: spec.name,
    })
    client.products.push(product)
    client.prices.push(
      {
        ...priceRecordDefinition(spec),
        id: "price_current",
        active: true,
        lookupKey: spec.lookupKey,
        productId: product.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      },
      {
        ...priceRecordDefinition({ recurringInterval: null }),
        id: "price_removed_offer",
        active: true,
        lookupKey: "taxmaxi_removed_offer",
        productId: "prod_removed_offer",
        currency: "eur",
        unitAmount: 9_900,
        taxBehavior: "exclusive",
        recurringInterval: null,
        recurringIntervalCount: null,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      }
    )

    const result = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(result.pricesArchived).toBe(0)
    expect(client.prices.find(({ id }) => id === "price_removed_offer")?.active).toBe(true)
  })

  it("does not mutate a product shared with a removed offer", async () => {
    const client = new FakeStripeCatalogClient()
    const spec = firstCatalogItem()
    const sharedProduct = productRecord({
      id: "prod_shared_with_removed_offer",
      lookupKey: spec.lookupKey,
      name: "Outdated catalog name",
    })
    client.products.push(sharedProduct)
    client.prices.push(
      {
        ...priceRecordDefinition(spec),
        id: "price_current",
        active: true,
        lookupKey: spec.lookupKey,
        productId: sharedProduct.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        recurringIntervalCount: spec.recurringInterval === null ? null : 1,
        metadata: { taxmaxi_catalog_lookup_key: spec.lookupKey },
      },
      {
        ...priceRecordDefinition({ recurringInterval: null }),
        id: "price_removed_offer",
        active: true,
        lookupKey: "taxmaxi_removed_offer",
        productId: sharedProduct.id,
        currency: "eur",
        unitAmount: 9_900,
        taxBehavior: "exclusive",
        recurringInterval: null,
        recurringIntervalCount: null,
        metadata: { taxmaxi_catalog_lookup_key: "taxmaxi_removed_offer" },
      }
    )

    const result = await reconcileStripeCatalog({ client, catalog: [spec] })

    expect(result.productsCreated).toBe(1)
    expect(result.productsUpdated).toBe(0)
    expect(client.createdProductInputs[0]?.replacedProductId).toBe(sharedProduct.id)
    expect(client.products.find(({ id }) => id === sharedProduct.id)).toEqual(sharedProduct)
    expect(client.prices.find(({ id }) => id === "price_removed_offer")?.active).toBe(true)
    expect(client.prices.find(({ id }) => id === "price_current")?.active).toBe(false)
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
        ...priceRecordDefinition(firstSpec),
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
        ...priceRecordDefinition(secondSpec),
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
    expect(client.createdProductInputs.map(({ replacedProductId }) => replacedProductId)).toEqual([
      sharedProduct.id,
      sharedProduct.id,
    ])
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

  it("uses the replaced Product as the idempotency generation", () => {
    const initial = { lookupKey: "taxmaxi_example", replacedProductId: null }
    const firstReplacement = {
      lookupKey: "taxmaxi_example",
      replacedProductId: "prod_shared_one",
    }

    expect(stripeCatalogProductIdempotencyKey(firstReplacement)).toBe(
      stripeCatalogProductIdempotencyKey({ ...firstReplacement })
    )
    expect(stripeCatalogProductIdempotencyKey(initial)).not.toBe(
      stripeCatalogProductIdempotencyKey(firstReplacement)
    )
    expect(stripeCatalogProductIdempotencyKey(firstReplacement)).not.toBe(
      stripeCatalogProductIdempotencyKey({
        ...firstReplacement,
        replacedProductId: "prod_shared_two",
      })
    )
  })

  it("loads Stripe lists beyond the autoPagingToArray cap", async () => {
    const page = {
      autoPagingEach: async (
        handler: (item: number) => boolean | void | Promise<boolean | void>
      ) => {
        for (let item = 0; item <= 10_000; item += 1) {
          if ((await handler(item)) === false) return
        }
      },
    }

    const items = await loadAllStripeListItems(page)

    expect(items).toHaveLength(10_001)
    expect(items[10_000]).toBe(10_000)
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
      ...priceRecordDefinition(spec),
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

  it("runs production setup only after the exact confirmation", async () => {
    const answers = ["production", "production"]
    const setupInputs: Array<{ readonly environment: string; readonly restrictedKey: string }> = []

    const result = await runStripeCatalogSetup({
      question: () => Promise.resolve(answers.shift() ?? ""),
      loadKey: (environment) =>
        Promise.resolve(environment === "production" ? "rk_live_catalog" : "rk_test_catalog"),
      setup: (input) => {
        setupInputs.push(input)
        return Promise.resolve({
          productsCreated: 0,
          productsUpdated: 0,
          pricesCreated: 0,
          pricesActivated: 0,
          pricesMetadataUpdated: 0,
          pricesArchived: 0,
          pricesUnchanged: TAXMAXI_STRIPE_CATALOG.length,
        })
      },
    })

    expect(result).toMatchObject({ status: "completed", environment: "production" })
    expect(setupInputs).toEqual([{ environment: "production", restrictedKey: "rk_live_catalog" }])
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
