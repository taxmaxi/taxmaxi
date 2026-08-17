import { createInterface } from "node:readline/promises"

import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import Stripe from "stripe"

import {
  STRIPE_CATALOG_PRODUCT_METADATA_KEY,
  STRIPE_CATALOG_SETUP_KEY_PERMISSIONS,
  STRIPE_RUNTIME_KEY_PERMISSIONS,
  TAXMAXI_STRIPE_CATALOG,
  TAXMAXI_STRIPE_TAX_CODE,
  type TaxMaxiStripeCatalogItem,
} from "../src/services/StripeCatalog.ts"

export type StripeEnvironment = "sandbox" | "production"

export interface StripeCatalogProductRecord {
  readonly id: string
  readonly active: boolean
  readonly name: string
  readonly description: string | null
  readonly taxCode: string | null
  readonly metadata: Readonly<Record<string, string>>
}

export interface StripeCatalogPriceRecord {
  readonly id: string
  readonly active: boolean
  readonly billingScheme: string
  readonly lookupKey: string | null
  readonly productId: string
  readonly currency: string
  readonly unitAmount: number | null
  readonly taxBehavior: string | null
  readonly recurringInterval: string | null
  readonly recurringIntervalCount: number | null
  readonly recurringUsageType: string | null
  readonly recurringTrialPeriodDays: number | null
  readonly transformQuantity: { readonly divideBy: number; readonly round: string } | null
  readonly metadata: Readonly<Record<string, string>>
}

export interface StripeCatalogProductInput {
  readonly active: true
  readonly name: string
  readonly description: string
  readonly taxCode: string
  readonly metadata: Readonly<Record<string, string>>
}

export interface StripeCatalogProductCreateInput extends StripeCatalogProductInput {
  readonly lookupKey: string
  readonly replacedProductId: string | null
}

export interface StripeCatalogPriceInput {
  readonly lookupKey: string
  readonly productId: string
  readonly currency: string
  readonly unitAmount: number
  readonly taxBehavior: "inclusive" | "exclusive"
  readonly recurringInterval: "year" | null
  readonly transferLookupKey: boolean
  readonly replacedPriceId: string | null
}

export interface StripeCatalogClient {
  readonly listProducts: () => Promise<ReadonlyArray<StripeCatalogProductRecord>>
  readonly listPrices: () => Promise<ReadonlyArray<StripeCatalogPriceRecord>>
  readonly createProduct: (
    input: StripeCatalogProductCreateInput
  ) => Promise<StripeCatalogProductRecord>
  readonly updateProduct: (
    id: string,
    input: StripeCatalogProductInput
  ) => Promise<StripeCatalogProductRecord>
  readonly createPrice: (input: StripeCatalogPriceInput) => Promise<StripeCatalogPriceRecord>
  readonly updatePrice: (
    id: string,
    input: {
      readonly active?: boolean
      readonly metadata?: Readonly<Record<string, string>>
    }
  ) => Promise<StripeCatalogPriceRecord>
}

export interface StripeCatalogSetupResult {
  readonly productsCreated: number
  readonly productsUpdated: number
  readonly pricesCreated: number
  readonly pricesActivated: number
  readonly pricesMetadataUpdated: number
  readonly pricesArchived: number
  readonly pricesUnchanged: number
}

const desiredProduct = (spec: TaxMaxiStripeCatalogItem): StripeCatalogProductInput => ({
  active: true,
  name: spec.name,
  description: spec.description,
  taxCode: TAXMAXI_STRIPE_TAX_CODE,
  metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: spec.lookupKey },
})

const productNeedsUpdate = ({
  product,
  desired,
}: {
  readonly product: StripeCatalogProductRecord
  readonly desired: StripeCatalogProductInput
}): boolean =>
  !product.active ||
  product.name !== desired.name ||
  product.description !== desired.description ||
  product.taxCode !== desired.taxCode ||
  product.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] !==
    desired.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY]

const priceMatches = ({
  price,
  productId,
  spec,
}: {
  readonly price: StripeCatalogPriceRecord
  readonly productId: string
  readonly spec: TaxMaxiStripeCatalogItem
}): boolean =>
  price.productId === productId &&
  price.billingScheme === "per_unit" &&
  price.currency === spec.currency &&
  price.unitAmount === spec.unitAmount &&
  price.taxBehavior === spec.taxBehavior &&
  price.transformQuantity === null &&
  price.recurringInterval === spec.recurringInterval &&
  price.recurringIntervalCount === (spec.recurringInterval === null ? null : 1) &&
  price.recurringUsageType === (spec.recurringInterval === null ? null : "licensed") &&
  price.recurringTrialPeriodDays === null

const onlyCandidate = ({
  candidates,
  description,
}: {
  readonly candidates: ReadonlyArray<StripeCatalogProductRecord>
  readonly description: string
}): StripeCatalogProductRecord | undefined => {
  if (candidates.length > 1) {
    throw new Error(
      `Found multiple Stripe products matching ${description}; resolve the duplicate first`
    )
  }
  return candidates[0]
}

const findProduct = ({
  products,
  prices,
  existingPrice,
  spec,
}: {
  readonly products: ReadonlyArray<StripeCatalogProductRecord>
  readonly prices: ReadonlyArray<StripeCatalogPriceRecord>
  readonly existingPrice: StripeCatalogPriceRecord | undefined
  readonly spec: TaxMaxiStripeCatalogItem
}): {
  readonly product: StripeCatalogProductRecord | undefined
  readonly replacedProductId: string | null
} => {
  let excludedProductId: string | undefined

  const isLinkedToAnotherCatalogItem = (productId: string): boolean =>
    prices.some((price) => {
      if (price.productId !== productId) return false
      const associatedLookupKey =
        price.lookupKey ?? price.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY]
      return associatedLookupKey !== undefined && associatedLookupKey !== spec.lookupKey
    })

  if (existingPrice !== undefined) {
    const linkedProduct = products.find(({ id }) => id === existingPrice.productId)
    if (linkedProduct === undefined) {
      throw new Error(
        `Price ${existingPrice.id} points to product ${existingPrice.productId}, which could not be loaded`
      )
    }

    if (!isLinkedToAnotherCatalogItem(linkedProduct.id)) {
      return { product: linkedProduct, replacedProductId: null }
    }
    excludedProductId = linkedProduct.id
  }

  const metadataMatch = onlyCandidate({
    candidates: products.filter(
      ({ id, metadata }) =>
        id !== excludedProductId &&
        !isLinkedToAnotherCatalogItem(id) &&
        metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] === spec.lookupKey
    ),
    description: `metadata ${STRIPE_CATALOG_PRODUCT_METADATA_KEY}=${spec.lookupKey}`,
  })
  if (metadataMatch !== undefined) return { product: metadataMatch, replacedProductId: null }
  return { product: undefined, replacedProductId: excludedProductId ?? null }
}

/** Creates missing catalog objects and replaces immutable price mismatches. */
export const reconcileStripeCatalog = async ({
  client,
  catalog = TAXMAXI_STRIPE_CATALOG,
  onChange = () => undefined,
}: {
  readonly client: StripeCatalogClient
  readonly catalog?: ReadonlyArray<TaxMaxiStripeCatalogItem>
  readonly onChange?: (message: string) => void
}): Promise<StripeCatalogSetupResult> => {
  const catalogLookupKeys = new Set(catalog.map(({ lookupKey }) => lookupKey))
  if (catalogLookupKeys.size !== catalog.length) {
    throw new Error("TaxMaxi Stripe catalog lookup keys must be unique")
  }

  const [loadedProducts, loadedPrices] = await Promise.all([
    client.listProducts(),
    client.listPrices(),
  ])
  const products = [...loadedProducts]
  const prices = [...loadedPrices]
  let productsCreated = 0
  let productsUpdated = 0
  let pricesCreated = 0
  let pricesActivated = 0
  let pricesMetadataUpdated = 0
  let pricesArchived = 0
  let pricesUnchanged = 0

  for (const spec of catalog) {
    const existingPrice = prices.find(({ lookupKey }) => lookupKey === spec.lookupKey)
    const desired = desiredProduct(spec)
    const productSelection = findProduct({
      products,
      prices,
      existingPrice,
      spec,
    })
    const existingProduct = productSelection.product
    let product: StripeCatalogProductRecord

    if (existingProduct === undefined) {
      product = await client.createProduct({
        ...desired,
        lookupKey: spec.lookupKey,
        replacedProductId: productSelection.replacedProductId,
      })
      products.push(product)
      productsCreated += 1
      onChange(`Created product: ${spec.name}`)
    } else if (productNeedsUpdate({ product: existingProduct, desired })) {
      product = await client.updateProduct(existingProduct.id, desired)
      const index = products.findIndex(({ id }) => id === product.id)
      if (index >= 0) products[index] = product
      productsUpdated += 1
      onChange(`Updated product: ${spec.name}`)
    } else {
      product = existingProduct
    }

    let canonicalPrice: StripeCatalogPriceRecord

    if (
      existingPrice !== undefined &&
      priceMatches({ price: existingPrice, productId: product.id, spec })
    ) {
      if (existingPrice.active) {
        pricesUnchanged += 1
        onChange(`Kept price: ${spec.lookupKey}`)
        canonicalPrice = existingPrice
      } else {
        canonicalPrice = await client.updatePrice(existingPrice.id, { active: true })
        const index = prices.findIndex(({ id }) => id === canonicalPrice.id)
        if (index >= 0) prices[index] = canonicalPrice
        pricesActivated += 1
        onChange(`Activated price: ${spec.lookupKey}`)
      }
    } else {
      if (existingPrice !== undefined) {
        const markedPrice = await client.updatePrice(existingPrice.id, {
          metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: spec.lookupKey },
        })
        const index = prices.findIndex(({ id }) => id === markedPrice.id)
        if (index >= 0) prices[index] = markedPrice
      }

      canonicalPrice = await client.createPrice({
        lookupKey: spec.lookupKey,
        productId: product.id,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        taxBehavior: spec.taxBehavior,
        recurringInterval: spec.recurringInterval,
        transferLookupKey: existingPrice !== undefined,
        replacedPriceId: existingPrice?.id ?? null,
      })
      prices.push(canonicalPrice)
      pricesCreated += 1
      onChange(`Created price: ${spec.lookupKey}`)
    }

    if (canonicalPrice.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] !== spec.lookupKey) {
      canonicalPrice = await client.updatePrice(canonicalPrice.id, {
        metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: spec.lookupKey },
      })
      const index = prices.findIndex(({ id }) => id === canonicalPrice.id)
      if (index >= 0) prices[index] = canonicalPrice
      pricesMetadataUpdated += 1
      onChange(`Updated price metadata: ${spec.lookupKey}`)
    }

    const stalePrices = prices.filter(
      (price) =>
        price.id !== canonicalPrice.id &&
        price.active &&
        (price.lookupKey === null || price.id === existingPrice?.id) &&
        price.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] === spec.lookupKey
    )
    for (const stalePrice of stalePrices) {
      const archivedPrice = await client.updatePrice(stalePrice.id, { active: false })
      const index = prices.findIndex(({ id }) => id === archivedPrice.id)
      if (index >= 0) prices[index] = archivedPrice
      pricesArchived += 1
      onChange(`Archived replaced price: ${stalePrice.id}`)
    }
  }

  return {
    productsCreated,
    productsUpdated,
    pricesCreated,
    pricesActivated,
    pricesMetadataUpdated,
    pricesArchived,
    pricesUnchanged,
  }
}

const StripeReferenceSchema = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])
const StripeMetadataSchema = Schema.Record(Schema.String, Schema.String)
const StripeProductPayloadSchema = Schema.Struct({
  id: Schema.String,
  active: Schema.Boolean,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  tax_code: Schema.NullOr(StripeReferenceSchema),
  metadata: StripeMetadataSchema,
})
const StripePricePayloadSchema = Schema.Struct({
  id: Schema.String,
  active: Schema.Boolean,
  billing_scheme: Schema.String,
  lookup_key: Schema.NullOr(Schema.String),
  product: StripeReferenceSchema,
  currency: Schema.String,
  unit_amount: Schema.NullOr(Schema.Number),
  tax_behavior: Schema.NullOr(Schema.String),
  recurring: Schema.NullOr(
    Schema.Struct({
      interval: Schema.String,
      interval_count: Schema.Number,
      usage_type: Schema.String,
      trial_period_days: Schema.NullOr(Schema.Number),
    })
  ),
  transform_quantity: Schema.NullOr(
    Schema.Struct({
      divide_by: Schema.Number,
      round: Schema.String,
    })
  ),
  metadata: StripeMetadataSchema,
})

export const decodeStripeProductRecord = async (
  input: unknown
): Promise<StripeCatalogProductRecord> => {
  const product = await Effect.runPromise(
    Schema.decodeUnknownEffect(StripeProductPayloadSchema)(input)
  )
  return {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description,
    taxCode:
      typeof product.tax_code === "string" ? product.tax_code : (product.tax_code?.id ?? null),
    metadata: product.metadata,
  }
}

export const decodeStripePriceRecord = async (
  input: unknown
): Promise<StripeCatalogPriceRecord> => {
  const price = await Effect.runPromise(Schema.decodeUnknownEffect(StripePricePayloadSchema)(input))
  return {
    id: price.id,
    active: price.active,
    billingScheme: price.billing_scheme,
    lookupKey: price.lookup_key,
    productId: typeof price.product === "string" ? price.product : price.product.id,
    currency: price.currency,
    unitAmount: price.unit_amount,
    taxBehavior: price.tax_behavior,
    recurringInterval: price.recurring?.interval ?? null,
    recurringIntervalCount: price.recurring?.interval_count ?? null,
    recurringUsageType: price.recurring?.usage_type ?? null,
    recurringTrialPeriodDays: price.recurring?.trial_period_days ?? null,
    transformQuantity:
      price.transform_quantity === null
        ? null
        : {
            divideBy: price.transform_quantity.divide_by,
            round: price.transform_quantity.round,
          },
    metadata: price.metadata,
  }
}

export const loadAllStripeListItems = async <A>(
  page: Pick<Stripe.ApiListPromise<A>, "autoPagingEach">
): Promise<ReadonlyArray<A>> => {
  const items: Array<A> = []
  await page.autoPagingEach((item) => {
    items.push(item)
  })
  return items
}

export const makeStripeCatalogClient = (stripe: Stripe): StripeCatalogClient => ({
  listProducts: async () => {
    const products = await loadAllStripeListItems(stripe.products.list({ limit: 100 }))
    return Promise.all(products.map(decodeStripeProductRecord))
  },
  listPrices: async () => {
    const activePrices = await loadAllStripeListItems(
      stripe.prices.list({ active: true, limit: 100 })
    )
    const inactivePrices = await loadAllStripeListItems(
      stripe.prices.list({ active: false, limit: 100 })
    )
    return Promise.all([...activePrices, ...inactivePrices].map(decodeStripePriceRecord))
  },
  createProduct: async (input) => {
    const product = await stripe.products.create(
      {
        active: input.active,
        name: input.name,
        description: input.description,
        tax_code: input.taxCode,
        metadata: { ...input.metadata },
      },
      {
        idempotencyKey: stripeCatalogProductIdempotencyKey(input),
      }
    )
    return decodeStripeProductRecord(product)
  },
  updateProduct: async (id, input) => {
    const product = await stripe.products.update(id, {
      active: input.active,
      name: input.name,
      description: input.description,
      tax_code: input.taxCode,
      metadata: { ...input.metadata },
    })
    return decodeStripeProductRecord(product)
  },
  createPrice: async (input) => {
    const price = await stripe.prices.create(
      {
        billing_scheme: "per_unit",
        currency: input.currency,
        lookup_key: input.lookupKey,
        nickname: input.lookupKey,
        product: input.productId,
        tax_behavior: input.taxBehavior,
        transfer_lookup_key: input.transferLookupKey,
        unit_amount: input.unitAmount,
        metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: input.lookupKey },
        ...(input.recurringInterval === null
          ? {}
          : {
              recurring: {
                interval: input.recurringInterval,
                interval_count: 1,
                usage_type: "licensed",
              },
            }),
      },
      {
        idempotencyKey: stripeCatalogPriceIdempotencyKey(input),
      }
    )
    return decodeStripePriceRecord(price)
  },
  updatePrice: async (id, input) =>
    decodeStripePriceRecord(
      await stripe.prices.update(id, {
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
      })
    ),
})

export const stripeCatalogProductIdempotencyKey = (
  input: Pick<StripeCatalogProductCreateInput, "lookupKey" | "replacedProductId">
): string =>
  ["taxmaxi-catalog-product", input.lookupKey, input.replacedProductId ?? "initial"].join("-")

export const stripeCatalogPriceIdempotencyKey = (input: StripeCatalogPriceInput): string =>
  [
    "taxmaxi-catalog-price",
    input.lookupKey,
    input.productId,
    input.currency,
    input.unitAmount,
    input.taxBehavior,
    input.recurringInterval ?? "once",
    input.replacedPriceId ?? "initial",
  ].join("-")

export const assertKeyMatchesEnvironment = (
  environment: StripeEnvironment,
  restrictedKey: string
): void => {
  const expectedPrefix = environment === "production" ? "rk_live_" : "rk_test_"
  if (!restrictedKey.startsWith(expectedPrefix)) {
    throw new Error(
      environment === "production"
        ? "Production requires a production restricted key with the rk_live_ prefix"
        : "Sandbox requires a sandbox restricted key with the rk_test_ prefix"
    )
  }
}

const promptForEnvironment = async (
  question: (prompt: string) => Promise<string>,
  onMessage: (message: string) => void
): Promise<StripeEnvironment> => {
  while (true) {
    const answer = (
      await question("Choose Stripe environment: [1] sandbox (default), [2] production: ")
    )
      .trim()
      .toLowerCase()
    if (answer === "" || answer === "1" || answer === "s" || answer === "sandbox") {
      return "sandbox"
    }
    if (answer === "2" || answer === "p" || answer === "production" || answer === "prod") {
      return "production"
    }
    onMessage("Enter 1 for sandbox or 2 for production.")
  }
}

export const loadStripeCatalogRestrictedKey = async ({
  environment,
  provider,
}: {
  readonly environment: StripeEnvironment
  readonly provider: ConfigProvider.ConfigProvider
}): Promise<string> => {
  const variableName =
    environment === "production" ? "STRIPE_PRODUCTION_CATALOG_KEY" : "STRIPE_SANDBOX_CATALOG_KEY"
  const configured = await Effect.runPromise(
    Config.option(Config.redacted(variableName)).pipe(
      Effect.provide(ConfigProvider.layer(provider))
    )
  )
  if (Option.isNone(configured)) {
    throw new Error(`Set ${variableName} to the restricted key before running this command`)
  }

  const restrictedKey = Redacted.value(configured.value).trim()
  if (restrictedKey === "") {
    throw new Error(`${variableName} must not be empty`)
  }
  assertKeyMatchesEnvironment(environment, restrictedKey)
  return restrictedKey
}

const loadRestrictedKey = async (environment: StripeEnvironment): Promise<string> => {
  return loadStripeCatalogRestrictedKey({
    environment,
    provider: ConfigProvider.fromEnv(),
  })
}

const formatPermissions = (
  permissions: ReadonlyArray<{ readonly resource: string; readonly access: "read" | "write" }>
): string => permissions.map(({ resource, access }) => `${resource}: ${access}`).join(", ")

export type StripeCatalogInteractiveResult =
  | { readonly status: "cancelled" }
  | {
      readonly status: "completed"
      readonly environment: StripeEnvironment
      readonly result: StripeCatalogSetupResult
    }

export const runStripeCatalogSetup = async ({
  question,
  loadKey,
  setup,
  onMessage = () => undefined,
}: {
  readonly question: (prompt: string) => Promise<string>
  readonly loadKey: (environment: StripeEnvironment) => Promise<string>
  readonly setup: (input: {
    readonly environment: StripeEnvironment
    readonly restrictedKey: string
  }) => Promise<StripeCatalogSetupResult>
  readonly onMessage?: (message: string) => void
}): Promise<StripeCatalogInteractiveResult> => {
  const environment = await promptForEnvironment(question, onMessage)
  if (environment === "production") {
    const confirmation = await question(
      "This will change the live Stripe catalog. Type production to continue: "
    )
    if (confirmation.trim() !== "production") {
      onMessage("Cancelled without changing Stripe.")
      return { status: "cancelled" }
    }
  }

  const restrictedKey = await loadKey(environment)
  const result = await setup({ environment, restrictedKey })
  return { status: "completed", environment, result }
}

const main = async (): Promise<void> => {
  console.log(
    `Catalog setup key permissions: ${formatPermissions(STRIPE_CATALOG_SETUP_KEY_PERMISSIONS)}; everything else: none.`
  )
  console.log(
    `TaxMaxi runtime key permissions: ${formatPermissions(STRIPE_RUNTIME_KEY_PERMISSIONS)}.`
  )

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const outcome = await runStripeCatalogSetup({
      question: (prompt) => terminal.question(prompt),
      loadKey: loadRestrictedKey,
      setup: async ({ restrictedKey }) => {
        const stripe = new Stripe(restrictedKey, {
          apiVersion: "2026-07-29.dahlia",
          maxNetworkRetries: 2,
          typescript: true,
        })
        return reconcileStripeCatalog({
          client: makeStripeCatalogClient(stripe),
          onChange: (message) => console.log(message),
        })
      },
      onMessage: (message) => console.log(message),
    })
    if (outcome.status === "completed") {
      console.log(`Stripe ${outcome.environment} catalog is complete.`)
      console.log(outcome.result)
    }
  } finally {
    terminal.close()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Stripe catalog setup failed")
    process.exitCode = 1
  })
}
