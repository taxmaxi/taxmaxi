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
export const reconcileStripeCatalog = ({
  client,
  catalog = TAXMAXI_STRIPE_CATALOG,
  onChange = () => undefined,
}: {
  readonly client: StripeCatalogClient
  readonly catalog?: ReadonlyArray<TaxMaxiStripeCatalogItem>
  readonly onChange?: (message: string) => void
}): Promise<StripeCatalogSetupResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const catalogLookupKeys = new Set(catalog.map(({ lookupKey }) => lookupKey))
      if (catalogLookupKeys.size !== catalog.length) {
        throw new Error("TaxMaxi Stripe catalog lookup keys must be unique")
      }

      const [loadedProducts, loadedPrices] = yield* Effect.promise(() =>
        Promise.all([client.listProducts(), client.listPrices()])
      )
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
          product = yield* Effect.promise(() =>
            client.createProduct({
              ...desired,
              lookupKey: spec.lookupKey,
              replacedProductId: productSelection.replacedProductId,
            })
          )
          products.push(product)
          productsCreated += 1
          onChange(`Created product: ${spec.name}`)
        } else if (productNeedsUpdate({ product: existingProduct, desired })) {
          product = yield* Effect.promise(() => client.updateProduct(existingProduct.id, desired))
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
            canonicalPrice = yield* Effect.promise(() =>
              client.updatePrice(existingPrice.id, { active: true })
            )
            const index = prices.findIndex(({ id }) => id === canonicalPrice.id)
            if (index >= 0) prices[index] = canonicalPrice
            pricesActivated += 1
            onChange(`Activated price: ${spec.lookupKey}`)
          }
        } else {
          if (existingPrice !== undefined) {
            const markedPrice = yield* Effect.promise(() =>
              client.updatePrice(existingPrice.id, {
                metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: spec.lookupKey },
              })
            )
            const index = prices.findIndex(({ id }) => id === markedPrice.id)
            if (index >= 0) prices[index] = markedPrice
          }

          canonicalPrice = yield* Effect.promise(() =>
            client.createPrice({
              lookupKey: spec.lookupKey,
              productId: product.id,
              currency: spec.currency,
              unitAmount: spec.unitAmount,
              taxBehavior: spec.taxBehavior,
              recurringInterval: spec.recurringInterval,
              transferLookupKey: existingPrice !== undefined,
              replacedPriceId: existingPrice?.id ?? null,
            })
          )
          prices.push(canonicalPrice)
          pricesCreated += 1
          onChange(`Created price: ${spec.lookupKey}`)
        }

        if (canonicalPrice.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] !== spec.lookupKey) {
          canonicalPrice = yield* Effect.promise(() =>
            client.updatePrice(canonicalPrice.id, {
              metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: spec.lookupKey },
            })
          )
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
          const archivedPrice = yield* Effect.promise(() =>
            client.updatePrice(stalePrice.id, { active: false })
          )
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
    })
  )

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
  unit_amount: Schema.NullOr(Schema.Finite),
  tax_behavior: Schema.NullOr(Schema.String),
  recurring: Schema.NullOr(
    Schema.Struct({
      interval: Schema.String,
      interval_count: Schema.Finite,
      usage_type: Schema.String,
      trial_period_days: Schema.NullOr(Schema.Finite),
    })
  ),
  transform_quantity: Schema.NullOr(
    Schema.Struct({
      divide_by: Schema.Finite,
      round: Schema.String,
    })
  ),
  metadata: StripeMetadataSchema,
})

export const decodeStripeProductRecord = (input: unknown): Promise<StripeCatalogProductRecord> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const product = yield* Schema.decodeUnknownEffect(StripeProductPayloadSchema)(input)
      return {
        id: product.id,
        active: product.active,
        name: product.name,
        description: product.description,
        taxCode:
          typeof product.tax_code === "string" ? product.tax_code : (product.tax_code?.id ?? null),
        metadata: product.metadata,
      }
    })
  )

export const decodeStripePriceRecord = (input: unknown): Promise<StripeCatalogPriceRecord> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const price = yield* Schema.decodeUnknownEffect(StripePricePayloadSchema)(input)
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
    })
  )

export const loadAllStripeListItems = <A>(
  page: Pick<Stripe.ApiListPromise<A>, "autoPagingEach">
): Promise<ReadonlyArray<A>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const items: Array<A> = []
      yield* Effect.promise(() =>
        page.autoPagingEach((item) => {
          items.push(item)
        })
      )
      return items
    })
  )

export const makeStripeCatalogClient = (stripe: Stripe): StripeCatalogClient => ({
  listProducts: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const products = yield* Effect.promise(() =>
          loadAllStripeListItems(stripe.products.list({ limit: 100 }))
        )
        return yield* Effect.promise(() => Promise.all(products.map(decodeStripeProductRecord)))
      })
    ),
  listPrices: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const activePrices = yield* Effect.promise(() =>
          loadAllStripeListItems(stripe.prices.list({ active: true, limit: 100 }))
        )
        const inactivePrices = yield* Effect.promise(() =>
          loadAllStripeListItems(stripe.prices.list({ active: false, limit: 100 }))
        )
        return yield* Effect.promise(() =>
          Promise.all([...activePrices, ...inactivePrices].map(decodeStripePriceRecord))
        )
      })
    ),
  createProduct: (input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const product = yield* Effect.promise(() =>
          stripe.products.create(
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
        )
        return yield* Effect.promise(() => decodeStripeProductRecord(product))
      })
    ),
  updateProduct: (id, input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const product = yield* Effect.promise(() =>
          stripe.products.update(id, {
            active: input.active,
            name: input.name,
            description: input.description,
            tax_code: input.taxCode,
            metadata: { ...input.metadata },
          })
        )
        return yield* Effect.promise(() => decodeStripeProductRecord(product))
      })
    ),
  createPrice: (input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const price = yield* Effect.promise(() =>
          stripe.prices.create(
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
        )
        return yield* Effect.promise(() => decodeStripePriceRecord(price))
      })
    ),
  updatePrice: (id, input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const price = yield* Effect.promise(() =>
          stripe.prices.update(id, {
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
          })
        )
        return yield* Effect.promise(() => decodeStripePriceRecord(price))
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

const promptForEnvironment = (
  question: (prompt: string) => Promise<string>,
  onMessage: (message: string) => void
): Promise<StripeEnvironment> =>
  Effect.runPromise(
    Effect.gen(function* () {
      while (true) {
        const answer = (yield* Effect.promise(() =>
          question("Choose Stripe environment: [1] sandbox (default), [2] production: ")
        ))
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
    })
  )

export const loadStripeCatalogRestrictedKey = ({
  environment,
  provider,
}: {
  readonly environment: StripeEnvironment
  readonly provider: ConfigProvider.ConfigProvider
}): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const variableName =
        environment === "production"
          ? "STRIPE_PRODUCTION_CATALOG_KEY"
          : "STRIPE_SANDBOX_CATALOG_KEY"
      const configured = yield* Config.option(Config.redacted(variableName)).pipe(
        Effect.provide(ConfigProvider.layer(provider))
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
    })
  )

const loadRestrictedKey = (environment: StripeEnvironment): Promise<string> =>
  loadStripeCatalogRestrictedKey({
    environment,
    provider: ConfigProvider.fromEnv(),
  })

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

export const runStripeCatalogSetup = ({
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
}): Promise<StripeCatalogInteractiveResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const environment = yield* Effect.promise(() => promptForEnvironment(question, onMessage))
      if (environment === "production") {
        const confirmation = yield* Effect.promise(() =>
          question("This will change the live Stripe catalog. Type production to continue: ")
        )
        if (confirmation.trim() !== "production") {
          onMessage("Cancelled without changing Stripe.")
          return { status: "cancelled" }
        }
      }

      const restrictedKey = yield* Effect.promise(() => loadKey(environment))
      const result = yield* Effect.promise(() => setup({ environment, restrictedKey }))
      return { status: "completed", environment, result }
    })
  )

const logCatalogMessage = (message: string): void => {
  Effect.runSync(Effect.logInfo({ message }, "Stripe catalog update"))
}

const setupStripeCatalog = ({ restrictedKey }: { readonly restrictedKey: string }) => {
  const stripe = new Stripe(restrictedKey, {
    apiVersion: "2026-07-29.dahlia",
    maxNetworkRetries: 2,
    typescript: true,
  })
  return reconcileStripeCatalog({
    client: makeStripeCatalogClient(stripe),
    onChange: logCatalogMessage,
  })
}

const main = Effect.gen(function* () {
  yield* Effect.logInfo(
    { permissions: formatPermissions(STRIPE_CATALOG_SETUP_KEY_PERMISSIONS) },
    "Stripe catalog setup key permissions"
  )
  yield* Effect.logInfo(
    { permissions: formatPermissions(STRIPE_RUNTIME_KEY_PERMISSIONS) },
    "TaxMaxi runtime key permissions"
  )

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const outcome = yield* Effect.promise(() =>
      runStripeCatalogSetup({
        question: (prompt) => terminal.question(prompt),
        loadKey: loadRestrictedKey,
        setup: setupStripeCatalog,
        onMessage: logCatalogMessage,
      })
    )
    if (outcome.status === "completed") {
      yield* Effect.logInfo(
        { environment: outcome.environment, result: outcome.result },
        "Stripe catalog is complete"
      )
    }
  } finally {
    terminal.close()
  }
})

if (import.meta.main) {
  void Effect.runPromise(
    main.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError({ cause }, "Stripe catalog setup failed")
          process.exitCode = 1
        })
      )
    )
  )
}
