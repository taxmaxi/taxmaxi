/**
 * StripeBillingServiceLive - Stripe Checkout, Portal, and signed webhook integration.
 *
 * @module StripeBillingServiceLive
 */

import { AuthUserId } from "@my/core/authentication"
import { BillingRepository, UserRepository } from "@my/persistence/services"
import type {
  BillingAccount,
  BillingRepositoryService,
  BillingSubscriptionStatus,
} from "@my/persistence/services"
import * as BigDecimal from "effect/BigDecimal"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import Stripe from "stripe"

import {
  STRIPE_CATALOG_PRODUCT_METADATA_KEY,
  TAXMAXI_STRIPE_CATALOG,
  TAXMAXI_STRIPE_TAX_CODE,
} from "../services/StripeCatalog.ts"
import {
  StripeBillingError,
  StripeBillingService,
  TAXMAXI_ANNUAL_LOOKUP_KEY,
  TAXMAXI_TOP_UP_LOOKUP_KEY,
  type BillingCatalogPrice,
  type StripeBillingServiceShape,
} from "../services/StripeBillingService.ts"

const ANNUAL_CREDITS = 10_000
const TOP_UP_CREDITS = 1_000
const INTEGRATION_IDENTIFIER = "taxmaxi_direct_q7m4w2kp"
const CATALOG_LOOKUP_KEYS = TAXMAXI_STRIPE_CATALOG.map(({ lookupKey }) => lookupKey)

export const STRIPE_CHECKOUT_TAX_OPTIONS = {
  automatic_tax: { enabled: true },
  tax_id_collection: { enabled: true },
}

export const buildAnnualCheckoutParams = ({
  customer,
  price,
  userId,
  frontendUrl,
  expiresAt,
  generation,
}: {
  readonly customer: string
  readonly price: Pick<Stripe.Price, "id" | "product">
  readonly userId: AuthUserId
  readonly frontendUrl: string
  readonly expiresAt: Date
  readonly generation: number
}): Stripe.Checkout.SessionCreateParams => ({
  mode: "subscription",
  customer,
  line_items: [{ price: price.id, quantity: 1 }],
  billing_address_collection: "required",
  ...STRIPE_CHECKOUT_TAX_OPTIONS,
  customer_update: { address: "auto", name: "auto" },
  success_url: `${frontendUrl}/app/billing?checkout=success`,
  cancel_url: `${frontendUrl}/app/billing`,
  expires_at: Math.floor(expiresAt.getTime() / 1_000),
  integration_identifier: INTEGRATION_IDENTIFIER,
  metadata: {
    purchase_kind: "annual",
    taxmaxi_user_id: userId,
    annual_checkout_generation: String(generation),
  },
  subscription_data: {
    metadata: {
      taxmaxi_user_id: userId,
      plan_lookup_key: TAXMAXI_ANNUAL_LOOKUP_KEY,
      plan_product_id: productId(price.product),
      annual_checkout_generation: String(generation),
    },
  },
})

export const annualCheckoutIdempotencyKey = ({
  userId,
  customer,
  generation,
}: {
  readonly userId: AuthUserId
  readonly customer: string
  readonly generation: number
}): string => `taxmaxi-annual-checkout-${userId}-${customer}-${generation}`

export const resolveReservedAnnualCheckoutPrice = <Price extends { readonly id: string }, E>({
  currentPrice,
  reservedPriceId,
  loadPrice,
}: {
  readonly currentPrice: Price
  readonly reservedPriceId: string
  readonly loadPrice: (priceId: string) => Effect.Effect<Price, E>
}): Effect.Effect<Price, E> =>
  currentPrice.id === reservedPriceId ? Effect.succeed(currentPrice) : loadPrice(reservedPriceId)

export const createReservedAnnualCheckoutSession = <
  Price extends Pick<Stripe.Price, "id" | "product">,
  Session,
  E,
>({
  currentPrice,
  reservation,
  customer,
  userId,
  frontendUrl,
  loadPrice,
  createSession,
}: {
  readonly currentPrice: Price
  readonly reservation: {
    readonly generation: number
    readonly expiresAt: Date
    readonly priceId: string
  }
  readonly customer: string
  readonly userId: AuthUserId
  readonly frontendUrl: string
  readonly loadPrice: (priceId: string) => Effect.Effect<Price, E>
  readonly createSession: (input: {
    readonly params: Stripe.Checkout.SessionCreateParams
    readonly idempotencyKey: string
  }) => Effect.Effect<Session, E>
}): Effect.Effect<Session, E> =>
  Effect.gen(function* () {
    const checkoutPrice = yield* resolveReservedAnnualCheckoutPrice({
      currentPrice,
      reservedPriceId: reservation.priceId,
      loadPrice,
    })
    return yield* createSession({
      params: buildAnnualCheckoutParams({
        customer,
        price: checkoutPrice,
        userId,
        frontendUrl,
        expiresAt: reservation.expiresAt,
        generation: reservation.generation,
      }),
      idempotencyKey: annualCheckoutIdempotencyKey({
        userId,
        customer,
        generation: reservation.generation,
      }),
    })
  })

export const isDefinitiveAnnualCheckoutCreationFailure = (cause: unknown): boolean =>
  Option.match(Schema.decodeUnknownOption(StripeErrorLogSchema)(cause), {
    onNone: () => false,
    onSome: ({ type }) =>
      type === "StripeInvalidRequestError" ||
      type === "StripeAuthenticationError" ||
      type === "StripePermissionError" ||
      type === "StripeCardError",
  })

export const buildTopUpCheckoutParams = ({
  customer,
  price,
  userId,
  frontendUrl,
}: {
  readonly customer: string
  readonly price: Pick<Stripe.Price, "id" | "product">
  readonly userId: AuthUserId
  readonly frontendUrl: string
}): Stripe.Checkout.SessionCreateParams => ({
  mode: "payment",
  customer,
  line_items: [{ price: price.id, quantity: 1 }],
  billing_address_collection: "required",
  ...STRIPE_CHECKOUT_TAX_OPTIONS,
  customer_update: { address: "auto", name: "auto" },
  success_url: `${frontendUrl}/app/billing?top_up=success`,
  cancel_url: `${frontendUrl}/app/billing`,
  integration_identifier: INTEGRATION_IDENTIFIER,
  metadata: { purchase_kind: "top_up", taxmaxi_user_id: userId },
  payment_intent_data: {
    metadata: { purchase_kind: "top_up", taxmaxi_user_id: userId },
  },
})

const stripeError = (message: string) => new StripeBillingError({ message })

class StripeRequestError extends Data.TaggedError("StripeRequestError")<{
  readonly cause: unknown
}> {}

const StripeErrorLogSchema = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Finite),
})

const ErrorLogSchema = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
})

const sanitizeStripeLogMessage = (message: string): string =>
  message
    .replace(/\b(?:rk|sk)_(?:live|test)_[A-Za-z0-9_*]+\b/giu, "[REDACTED_STRIPE_KEY]")
    .replace(/\bwhsec_[A-Za-z0-9]+\b/giu, "[REDACTED_STRIPE_WEBHOOK_SECRET]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 1_000)

const stripeRequestLogAttributes = (cause: unknown) => {
  const stripeError = Schema.decodeUnknownOption(StripeErrorLogSchema)(cause)
  if (Option.isSome(stripeError)) {
    return {
      provider: "stripe",
      stripeErrorType: stripeError.value.type,
      stripeErrorCode: stripeError.value.code,
      stripeErrorMessage: sanitizeStripeLogMessage(stripeError.value.message),
      stripeRequestId: stripeError.value.requestId,
      stripeStatusCode: stripeError.value.statusCode,
    }
  }

  const error = Schema.decodeUnknownOption(ErrorLogSchema)(cause)
  if (Option.isSome(error)) {
    return {
      provider: "stripe",
      errorName: error.value.name,
      errorMessage: sanitizeStripeLogMessage(error.value.message),
    }
  }

  return {
    provider: "stripe",
  }
}

const customerId = (
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): string | null => {
  if (customer === null) return null
  return typeof customer === "string" ? customer : customer.id
}

const subscriptionId = (subscription: string | Stripe.Subscription | null): string | null => {
  if (subscription === null) return null
  return typeof subscription === "string" ? subscription : subscription.id
}

const paymentIntentId = (
  paymentIntent: string | Pick<Stripe.PaymentIntent, "id"> | null
): string | null => {
  if (paymentIntent === null) return null
  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id
}

const priceId = (price: string | Stripe.Price): string =>
  typeof price === "string" ? price : price.id

const productId = (product: string | Stripe.Product | Stripe.DeletedProduct): string =>
  typeof product === "string" ? product : product.id

const subscriptionPeriodEnd = (subscription: Stripe.Subscription): Date | null => {
  const end = subscription.items.data.reduce(
    (latest, item) => Math.max(latest, item.current_period_end),
    0
  )
  return end === 0 ? null : DateTime.toDateUtc(DateTime.makeUnsafe(end * 1_000))
}

const isTopUpEligibleSubscription = (status: string | null): boolean =>
  status === "active" || status === "trialing"

const isExistingSubscription = (status: string | null): boolean =>
  status !== null && status !== "canceled" && status !== "incomplete_expired"

export const isTaxMaxiAnnualSubscription = ({
  subscription,
  currentProductId,
}: {
  readonly subscription: {
    readonly metadata: Readonly<Record<string, string>>
    readonly items: {
      readonly data: ReadonlyArray<{
        readonly price: {
          readonly lookup_key: string | null
          readonly product: string | Stripe.Product | Stripe.DeletedProduct
          readonly recurring: {
            readonly interval: string
            readonly interval_count: number
          } | null
        }
      }>
    }
  }
  readonly currentProductId?: string | undefined
}): boolean =>
  subscription.items.data.some(
    (item) =>
      isValidAnnualPrice(item.price) &&
      (item.price.lookup_key === TAXMAXI_ANNUAL_LOOKUP_KEY ||
        (subscription.metadata.plan_lookup_key === TAXMAXI_ANNUAL_LOOKUP_KEY &&
          (subscription.metadata.plan_product_id === undefined ||
            productId(item.price.product) === subscription.metadata.plan_product_id)) ||
        (currentProductId !== undefined && productId(item.price.product) === currentProductId))
  )

export const hasExistingTaxMaxiAnnualSubscription = ({
  subscriptions,
  currentProductId,
}: {
  readonly subscriptions: ReadonlyArray<
    Parameters<typeof isTaxMaxiAnnualSubscription>[0]["subscription"] & {
      readonly status: string
    }
  >
  readonly currentProductId: string
}): boolean =>
  subscriptions.some(
    (subscription) =>
      isTaxMaxiAnnualSubscription({ subscription, currentProductId }) &&
      isExistingSubscription(subscription.status)
  )

export const loadAllStripeItems = <Item>({
  page,
}: {
  readonly page: {
    readonly autoPagingToArray: (options: { readonly limit: number }) => Promise<Array<Item>>
  }
}): Promise<Array<Item>> => page.autoPagingToArray({ limit: 10_000 })

export const currentExistingAnnualSubscription = <
  Subscription extends {
    readonly status: string
  },
>(
  subscriptions: ReadonlyArray<
    Subscription & Parameters<typeof isTaxMaxiAnnualSubscription>[0]["subscription"]
  >,
  currentProductId?: string
): Subscription | undefined =>
  subscriptions.find(
    (subscription) =>
      isTaxMaxiAnnualSubscription({ subscription, currentProductId }) &&
      isExistingSubscription(subscription.status)
  )

export const shouldReconcileAnnualSubscription = ({
  subscription,
  trackedSubscriptionId,
  currentProductId,
}: {
  readonly subscription: Parameters<typeof isTaxMaxiAnnualSubscription>[0]["subscription"] & {
    readonly id: string
  }
  readonly trackedSubscriptionId: string | null
  readonly currentProductId?: string | undefined
}): boolean =>
  isTaxMaxiAnnualSubscription({ subscription, currentProductId }) ||
  subscription.id === trackedSubscriptionId

export const subscriptionIdToClearAfterConfirmation = ({
  currentSubscriptionId,
  confirmedSubscriptionId,
}: {
  readonly currentSubscriptionId: string | null
  readonly confirmedSubscriptionId: string | null
}): string | null => (confirmedSubscriptionId === null ? currentSubscriptionId : null)

export const completeInvoiceLines = <Line, E>({
  embeddedLines,
  hasMore,
  loadAll,
}: {
  readonly embeddedLines: ReadonlyArray<Line>
  readonly hasMore: boolean
  readonly loadAll: () => Effect.Effect<ReadonlyArray<Line>, E>
}): Effect.Effect<ReadonlyArray<Line>, E> => (hasMore ? loadAll() : Effect.succeed(embeddedLines))

export const isAnnualInvoiceEligible = ({
  billingReason,
  planLookupKey,
}: {
  readonly billingReason: string | null
  readonly planLookupKey: string | undefined
}): boolean =>
  (billingReason === "subscription_create" || billingReason === "subscription_cycle") &&
  (planLookupKey === undefined || planLookupKey === TAXMAXI_ANNUAL_LOOKUP_KEY)

export const annualInvoiceProductIds = ({
  planLookupKey,
  planProductId,
  currentProductId,
}: {
  readonly planLookupKey: string | undefined
  readonly planProductId: string | undefined
  readonly currentProductId: string | undefined
}): ReadonlyArray<string> | null | undefined => {
  if (planLookupKey !== undefined && planLookupKey !== TAXMAXI_ANNUAL_LOOKUP_KEY) return null

  const productIds = [
    ...new Set([planProductId, currentProductId].filter((id) => id !== undefined)),
  ]
  if (productIds.length > 0) return productIds
  return planLookupKey === undefined ? null : undefined
}

export const isAnnualInvoiceLineEligible = ({
  proration,
  periodStart,
  periodEnd,
  interval,
  intervalCount,
  productId,
  allowedProductIds,
}: {
  readonly proration: boolean
  readonly periodStart: number
  readonly periodEnd: number
  readonly interval: string | undefined
  readonly intervalCount: number | undefined
  readonly productId: string
  readonly allowedProductIds: ReadonlyArray<string> | undefined
}): boolean =>
  !proration &&
  periodEnd > periodStart &&
  interval === "year" &&
  intervalCount === 1 &&
  (allowedProductIds === undefined || allowedProductIds.includes(productId))

export const isPaidTopUpSessionEligible = ({
  purchaseKind,
  paymentStatus,
}: {
  readonly purchaseKind: string | undefined
  readonly paymentStatus: string
}): boolean => purchaseKind === "top_up" && paymentStatus === "paid"

export const findEligibleAnnualInvoiceLine = <Line>(
  candidates: ReadonlyArray<{
    readonly line: Line
    readonly proration: boolean
    readonly periodStart: number
    readonly periodEnd: number
    readonly interval: string | undefined
    readonly intervalCount: number | undefined
    readonly productId: string
    readonly allowedProductIds: ReadonlyArray<string> | undefined
  }>
): Line | undefined => {
  const eligible = candidates.filter(isAnnualInvoiceLineEligible)
  if (eligible.length === 0) return undefined
  if (eligible[0]?.allowedProductIds === undefined && eligible.length !== 1) return undefined
  return eligible[0]?.line
}

export const resolvePaidFulfillmentUserId = ({
  metadataUserId,
  stripeCustomerId,
  findByUserId,
  findByStripeCustomerId,
}: {
  readonly metadataUserId: string | undefined
  readonly stripeCustomerId: string
  readonly findByUserId: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<BillingAccount>, StripeBillingError>
  readonly findByStripeCustomerId: (
    customerId: string
  ) => Effect.Effect<Option.Option<BillingAccount>, StripeBillingError>
}) =>
  Effect.gen(function* () {
    if (metadataUserId === undefined) {
      const account = yield* findByStripeCustomerId(stripeCustomerId)
      return Option.isSome(account) ? account.value.userId : null
    }

    const userId = yield* Schema.decodeEffect(AuthUserId)(metadataUserId).pipe(
      Effect.mapError(() => stripeError("Invalid TaxMaxi user metadata on paid Stripe object"))
    )
    const account = yield* findByUserId(userId)
    if (Option.isNone(account)) {
      return yield* stripeError("TaxMaxi billing account not found")
    }
    return userId
  })

export const verifiedTopUpCustomer = ({
  account,
  userId,
  getOrCreateCustomer,
  findByUserId,
  hasCurrentAnnualSubscription,
}: {
  readonly account: Option.Option<BillingAccount>
  readonly userId: AuthUserId
  readonly getOrCreateCustomer: (userId: AuthUserId) => Effect.Effect<string, StripeBillingError>
  readonly findByUserId: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<BillingAccount>, StripeBillingError>
  readonly hasCurrentAnnualSubscription: (
    stripeCustomerId: string
  ) => Effect.Effect<boolean, StripeBillingError>
}) =>
  Effect.gen(function* () {
    if (Option.isNone(account) || account.value.stripeCustomerId === null) {
      return yield* stripeError("An active annual subscription is required")
    }

    const stripeCustomerId = yield* getOrCreateCustomer(userId)
    const refreshedAccount = yield* findByUserId(userId)
    if (
      Option.isNone(refreshedAccount) ||
      refreshedAccount.value.stripeCustomerId !== stripeCustomerId
    ) {
      return yield* stripeError("An active annual subscription is required")
    }
    if (!(yield* hasCurrentAnnualSubscription(stripeCustomerId))) {
      return yield* stripeError("An active annual subscription is required")
    }
    return stripeCustomerId
  })

export const isValidAnnualPrice = (price: {
  readonly recurring: { readonly interval: string; readonly interval_count: number } | null
}): boolean => price.recurring?.interval === "year" && price.recurring.interval_count === 1

export const isValidTopUpPrice = (price: { readonly recurring: unknown }): boolean =>
  price.recurring === null

export const isCatalogPriceCadenceValid = ({
  lookupKey,
  price,
}: {
  readonly lookupKey: string | null
  readonly price: {
    readonly recurring: { readonly interval: string; readonly interval_count: number } | null
  }
}): boolean => {
  const catalogItem = TAXMAXI_STRIPE_CATALOG.find((item) => item.lookupKey === lookupKey)
  if (catalogItem === undefined) return false
  return catalogItem.recurringInterval === null
    ? isValidTopUpPrice(price)
    : isValidAnnualPrice(price)
}

type CatalogPriceDefinitionInput = {
  readonly billing_scheme: Stripe.Price.BillingScheme
  readonly lookup_key: string | null
  readonly currency: string
  readonly unit_amount: number | null
  readonly tax_behavior: Stripe.Price.TaxBehavior | null
  readonly recurring: {
    readonly interval: string
    readonly interval_count: number
    readonly usage_type: string
    readonly trial_period_days: number | null
  } | null
  readonly transform_quantity: Stripe.Price.TransformQuantity | null
  readonly product:
    | string
    | Pick<Stripe.DeletedProduct, "id" | "deleted">
    | Pick<Stripe.Product, "active" | "name" | "description" | "tax_code" | "metadata">
}

export const catalogPriceDefinitionMismatch = (
  price: CatalogPriceDefinitionInput
): string | undefined => {
  const catalogItem = TAXMAXI_STRIPE_CATALOG.find((item) => item.lookupKey === price.lookup_key)
  if (catalogItem === undefined) return "lookup_key_unknown"
  if (price.billing_scheme !== "per_unit") return "billing_scheme_mismatch"
  if (price.transform_quantity !== null) return "transform_quantity_present"

  const product = price.product
  if (typeof product === "string") return "product_not_expanded"
  if (!("active" in product)) return "product_deleted"
  if (!product.active) return "product_inactive"
  if (product.name !== catalogItem.name) return "product_name_mismatch"
  if (product.description !== catalogItem.description) return "product_description_mismatch"

  const productTaxCode =
    typeof product.tax_code === "string" ? product.tax_code : (product.tax_code?.id ?? null)
  if (productTaxCode !== TAXMAXI_STRIPE_TAX_CODE) return "product_tax_code_mismatch"
  if (product.metadata[STRIPE_CATALOG_PRODUCT_METADATA_KEY] !== catalogItem.lookupKey) {
    return "product_metadata_mismatch"
  }
  if (price.currency !== catalogItem.currency) return "currency_mismatch"
  if (price.unit_amount !== catalogItem.unitAmount) return "unit_amount_mismatch"
  if (price.tax_behavior !== catalogItem.taxBehavior) return "tax_behavior_mismatch"
  if (!isCatalogPriceCadenceValid({ lookupKey: price.lookup_key, price })) {
    return "cadence_mismatch"
  }
  if (
    price.recurring?.usage_type !==
    (catalogItem.recurringInterval === null ? undefined : "licensed")
  ) {
    return "recurring_usage_type_mismatch"
  }
  if (
    price.recurring?.trial_period_days !==
    (catalogItem.recurringInterval === null ? undefined : null)
  ) {
    return "recurring_trial_period_mismatch"
  }
  return undefined
}

export const isCatalogPriceDefinitionValid = (price: CatalogPriceDefinitionInput): boolean =>
  catalogPriceDefinitionMismatch(price) === undefined

export const hasCompleteCatalogLookupKeys = (
  prices: ReadonlyArray<{ readonly lookup_key: string | null }>
): boolean =>
  prices.length === CATALOG_LOOKUP_KEYS.length &&
  CATALOG_LOOKUP_KEYS.every(
    (lookupKey) => prices.filter((price) => price.lookup_key === lookupKey).length === 1
  )

export const isSupportedCatalogCurrency = (currency: string): boolean => currency === "eur"

export const chargePaymentReference = (
  charge: Pick<Stripe.Charge, "id" | "payment_intent">
): string => paymentIntentId(charge.payment_intent) ?? charge.id

export const disputeCreditReversal = ({
  status,
  amount,
}: {
  readonly status: Stripe.Dispute.Status
  readonly amount: number
}): { readonly reversedAmount: number; readonly terminal: boolean } => {
  const paymentKept = status === "won" || status === "warning_closed" || status === "prevented"
  return {
    reversedAmount: paymentKept ? 0 : amount,
    terminal: paymentKept || status === "lost",
  }
}

type InvoicePaymentReferenceInput = {
  readonly payment: {
    readonly type: Stripe.InvoicePayment.Payment.Type
    readonly payment_intent?: string | Pick<Stripe.PaymentIntent, "id">
    readonly charge?: string | Pick<Stripe.Charge, "id" | "payment_intent">
    readonly payment_record?: string | Pick<Stripe.PaymentRecord, "id">
  }
}

export const invoicePaymentReference = (payment: InvoicePaymentReferenceInput): string | null => {
  switch (payment.payment.type) {
    case "payment_intent":
      return paymentIntentId(payment.payment.payment_intent ?? null)
    case "charge": {
      const charge = payment.payment.charge
      return charge === undefined
        ? null
        : typeof charge === "string"
          ? charge
          : chargePaymentReference(charge)
    }
    case "payment_record": {
      const paymentRecord = payment.payment.payment_record
      return paymentRecord === undefined
        ? null
        : typeof paymentRecord === "string"
          ? paymentRecord
          : paymentRecord.id
    }
  }
}

interface AnnualCreditPaymentAllocation {
  readonly paymentReference: string
  readonly paymentAmount: number
  readonly credits: number
}

const ensurePositivePaymentCreditLinks = (
  allocations: ReadonlyArray<AnnualCreditPaymentAllocation>
): ReadonlyArray<AnnualCreditPaymentAllocation> => {
  const result = allocations.map((allocation) => ({ ...allocation }))
  const zeroIndexes = result.flatMap((allocation, index) =>
    allocation.credits === 0 ? [index] : []
  )
  if (zeroIndexes.length === 0) return allocations

  // The ledger cannot store zero-credit grants, so borrow from the largest grants to retain
  // a reversible link for every positive payment without changing the total allowance.
  const donorIndexes = result
    .flatMap((allocation, index) => (allocation.credits > 1 ? [index] : []))
    .sort((leftIndex, rightIndex) => {
      const left = result[leftIndex]
      const right = result[rightIndex]
      if (left === undefined || right === undefined) return leftIndex - rightIndex
      return (
        right.credits - left.credits ||
        left.paymentReference.localeCompare(right.paymentReference) ||
        leftIndex - rightIndex
      )
    })

  let zeroCursor = 0
  for (const donorIndex of donorIndexes) {
    const donor = result[donorIndex]
    if (donor === undefined) continue
    const transferCount = Math.min(donor.credits - 1, zeroIndexes.length - zeroCursor)
    result[donorIndex] = { ...donor, credits: donor.credits - transferCount }
    for (let transfer = 0; transfer < transferCount; transfer += 1) {
      const recipientIndex = zeroIndexes[zeroCursor]
      zeroCursor += 1
      if (recipientIndex === undefined) break
      const recipient = result[recipientIndex]
      if (recipient !== undefined) result[recipientIndex] = { ...recipient, credits: 1 }
    }
    if (zeroCursor === zeroIndexes.length) break
  }

  return result
}

export const allocateAnnualCreditsAcrossPayments = (
  payments: ReadonlyArray<{ readonly paymentReference: string; readonly amountPaid: number }>
): ReadonlyArray<AnnualCreditPaymentAllocation> => {
  const positive = payments.filter((payment) => payment.amountPaid > 0)
  const totalPaid = positive.reduce((total, payment) => total + payment.amountPaid, 0)
  if (totalPaid === 0 || positive.length > ANNUAL_CREDITS) return []

  let allocated = 0
  return ensurePositivePaymentCreditLinks(
    positive.map((payment, index) => {
      const credits =
        index === positive.length - 1
          ? ANNUAL_CREDITS - allocated
          : BigDecimal.toNumberUnsafe(
              BigDecimal.floor(
                Option.getOrElse(
                  BigDecimal.divide(
                    BigDecimal.multiply(
                      BigDecimal.fromNumberUnsafe(ANNUAL_CREDITS),
                      BigDecimal.fromNumberUnsafe(payment.amountPaid)
                    ),
                    BigDecimal.fromNumberUnsafe(totalPaid)
                  ),
                  () => BigDecimal.fromNumberUnsafe(0)
                )
              )
            )
      allocated += credits
      return {
        paymentReference: payment.paymentReference,
        paymentAmount: payment.amountPaid,
        credits,
      }
    })
  )
}

export const annualPaymentAllocationsFromInvoicePayments = (
  payments: ReadonlyArray<InvoicePaymentReferenceInput & { readonly amount_paid: number | null }>
): ReadonlyArray<{
  readonly paymentReference: string
  readonly paymentAmount: number
  readonly credits: number
}> =>
  allocateAnnualCreditsAcrossPayments(
    payments.flatMap((payment) => {
      const reference = invoicePaymentReference(payment)
      return reference === null || payment.amount_paid === null
        ? []
        : [{ paymentReference: reference, amountPaid: payment.amount_paid }]
    })
  )

export const allocateCreditNoteReversalAcrossPayments = ({
  reversedAmount,
  payments,
}: {
  readonly reversedAmount: number
  readonly payments: ReadonlyArray<{
    readonly paymentReference: string
    readonly paymentAmount: number
  }>
}): ReadonlyArray<{
  readonly paymentReference: string
  readonly paymentAmount: number
  readonly reversedAmount: number
}> | null => {
  if (
    !Number.isInteger(reversedAmount) ||
    reversedAmount < 0 ||
    payments.some(({ paymentAmount }) => !Number.isInteger(paymentAmount) || paymentAmount < 0)
  ) {
    return null
  }

  const sortedPayments = [...payments]
    .filter(({ paymentAmount }) => paymentAmount > 0)
    .sort((left, right) => left.paymentReference.localeCompare(right.paymentReference))
  const totalPaymentAmount = sortedPayments.reduce(
    (total, payment) => total + payment.paymentAmount,
    0
  )
  if (reversedAmount > totalPaymentAmount) return null

  let remainingAmount = reversedAmount
  return sortedPayments.flatMap((payment) => {
    const allocatedAmount = Math.min(payment.paymentAmount, remainingAmount)
    remainingAmount -= allocatedAmount
    return allocatedAmount === 0 ? [] : [{ ...payment, reversedAmount: allocatedAmount }]
  })
}

export const annualInvoiceCreditAllocations = ({
  invoiceId,
  amountDue,
  paymentAllocations,
}: {
  readonly invoiceId: string
  readonly amountDue: number
  readonly paymentAllocations: ReadonlyArray<{
    readonly paymentReference: string
    readonly paymentAmount: number
    readonly credits: number
  }>
}): ReadonlyArray<{
  readonly paymentReference: string | null
  readonly paymentAmount: number | null
  readonly stripeInvoiceId: string | null
  readonly referenceSuffix: string
  readonly credits: number
}> => {
  if (paymentAllocations.length > 0) {
    return paymentAllocations.map((allocation) => ({
      ...allocation,
      stripeInvoiceId: invoiceId,
      referenceSuffix: allocation.paymentReference,
    }))
  }
  return amountDue === 0
    ? [
        {
          paymentReference: null,
          paymentAmount: null,
          stripeInvoiceId: invoiceId,
          referenceSuffix: `invoice:${invoiceId}`,
          credits: ANNUAL_CREDITS,
        },
      ]
    : []
}

export const persistAnnualCreditAllocations = <E>({
  userId,
  subscriptionId,
  periodStart,
  periodEnd,
  allocations,
  grantCredits,
  reconcilePaymentCreditReversals,
}: {
  readonly userId: AuthUserId
  readonly subscriptionId: string
  readonly periodStart: number
  readonly periodEnd: number
  readonly allocations: ReturnType<typeof annualInvoiceCreditAllocations>
  readonly grantCredits: (
    input: Parameters<BillingRepositoryService["grantCredits"]>[0]
  ) => Effect.Effect<boolean, E>
  readonly reconcilePaymentCreditReversals: (paymentReference: string) => Effect.Effect<boolean, E>
}): Effect.Effect<void, E> =>
  Effect.forEach(
    allocations.filter(({ credits }) => credits > 0),
    ({ paymentReference, paymentAmount, stripeInvoiceId, referenceSuffix, credits }) =>
      Effect.gen(function* () {
        yield* grantCredits({
          userId,
          amount: credits,
          kind: "annual_grant",
          reference: `stripe:annual:${subscriptionId}:${periodStart}:${periodEnd}:${referenceSuffix}`,
          paymentReference,
          paymentAmount,
          stripeInvoiceId,
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(periodEnd * 1_000)),
        })
        if (paymentReference !== null) {
          yield* reconcilePaymentCreditReversals(paymentReference)
        }
      }),
    { discard: true }
  )

export const hasFixedUnitAmount = <Price extends Pick<Stripe.Price, "unit_amount">>(
  price: Price
): price is Price & { readonly unit_amount: number } => price.unit_amount !== null

const StripeReferenceSchema = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])
const NullableStripeReferenceSchema = Schema.NullOr(StripeReferenceSchema)
const StripeMetadataSchema = Schema.Record(Schema.String, Schema.String)
const StripeCatalogProductPayloadSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ id: Schema.String, deleted: Schema.Literal(true) }),
  Schema.Struct({
    id: Schema.String,
    active: Schema.Boolean,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    tax_code: Schema.NullOr(StripeReferenceSchema),
    metadata: StripeMetadataSchema,
  }),
])
const StripeCatalogPricePayloadSchema = Schema.Struct({
  id: Schema.String,
  billing_scheme: Schema.String,
  lookup_key: Schema.NullOr(Schema.String),
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
  product: StripeCatalogProductPayloadSchema,
})
const StripeCatalogPriceListPayloadSchema = Schema.Struct({
  data: Schema.Array(StripeCatalogPricePayloadSchema),
})
const AnnualCheckoutMetadataSchema = Schema.Struct({
  annual_checkout_generation: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
})

const annualCheckoutGenerationFromMetadata = (
  metadata: Readonly<Record<string, string>>
): number | null => {
  const decoded = Schema.decodeOption(AnnualCheckoutMetadataSchema)(metadata)
  return Option.isSome(decoded) ? (decoded.value.annual_checkout_generation ?? null) : null
}

const StripeSubscriptionWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  customer: StripeReferenceSchema,
})
const StripeDeletedSubscriptionWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  customer: StripeReferenceSchema,
  status: Schema.String,
  cancel_at_period_end: Schema.Boolean,
  metadata: StripeMetadataSchema,
  items: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        current_period_end: Schema.Finite,
        price: Schema.Struct({
          lookup_key: Schema.NullOr(Schema.String),
          product: StripeReferenceSchema,
          recurring: Schema.NullOr(
            Schema.Struct({ interval: Schema.String, interval_count: Schema.Finite })
          ),
        }),
      })
    ),
  }),
})
const StripeCheckoutWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  customer: NullableStripeReferenceSchema,
  payment_intent: NullableStripeReferenceSchema,
  payment_status: Schema.String,
  metadata: Schema.NullOr(StripeMetadataSchema),
})
const StripeInvoiceLineSchema = Schema.Struct({
  parent: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        subscription_item_details: Schema.optional(
          Schema.NullOr(Schema.Struct({ proration: Schema.Boolean }))
        ),
      })
    )
  ),
  pricing: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        price_details: Schema.optional(
          Schema.NullOr(Schema.Struct({ price: StripeReferenceSchema }))
        ),
      })
    )
  ),
  period: Schema.Struct({ start: Schema.Finite, end: Schema.Finite }),
})
const StripeInvoiceWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  amount_due: Schema.Finite,
  billing_reason: Schema.NullOr(Schema.String),
  customer: NullableStripeReferenceSchema,
  parent: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        subscription_details: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              subscription: NullableStripeReferenceSchema,
              metadata: Schema.optional(Schema.NullOr(StripeMetadataSchema)),
            })
          )
        ),
      })
    )
  ),
  lines: Schema.Struct({ data: Schema.Array(StripeInvoiceLineSchema), has_more: Schema.Boolean }),
})
const StripeChargeWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  amount: Schema.Finite,
  amount_refunded: Schema.Finite,
  payment_intent: NullableStripeReferenceSchema,
})
const StripeRefundWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  amount: Schema.Finite,
  charge: NullableStripeReferenceSchema,
  payment_intent: NullableStripeReferenceSchema,
  status: Schema.NullOr(Schema.String),
})
const StripeCreditNoteWebhookObjectSchema = Schema.Struct({
  id: Schema.String,
  currency: Schema.String,
  invoice: StripeReferenceSchema,
  post_payment_amount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.String,
  refunds: Schema.Array(
    Schema.Struct({
      amount_refunded: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      payment_record_refund: Schema.NullOr(
        Schema.Struct({ payment_record: Schema.String, refund_group: Schema.String })
      ),
      refund: Schema.optional(NullableStripeReferenceSchema),
      type: Schema.NullOr(Schema.String),
    })
  ),
})
const StripeIdWebhookObjectSchema = Schema.Struct({ id: Schema.String })
const StripeWebhookEnvelopeSchema = Schema.Struct({
  id: Schema.String,
  created: Schema.Finite,
  type: Schema.String,
  data: Schema.Struct({ object: Schema.Unknown }),
})

export const validateStripeWebhookEvent = (input: unknown) =>
  Schema.decodeUnknownEffect(StripeWebhookEnvelopeSchema)(input).pipe(
    Effect.flatMap((event) => {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.paused":
        case "customer.subscription.resumed":
          return Schema.decodeUnknownEffect(StripeSubscriptionWebhookObjectSchema)(
            event.data.object
          )
        case "customer.subscription.deleted":
          return Schema.decodeUnknownEffect(StripeDeletedSubscriptionWebhookObjectSchema)(
            event.data.object
          )
        case "customer.deleted":
        case "charge.dispute.created":
        case "charge.dispute.closed":
          return Schema.decodeUnknownEffect(StripeIdWebhookObjectSchema)(event.data.object)
        case "invoice.paid":
          return Schema.decodeUnknownEffect(StripeInvoiceWebhookObjectSchema)(event.data.object)
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          return Schema.decodeUnknownEffect(StripeCheckoutWebhookObjectSchema)(event.data.object)
        case "charge.refunded":
          return Schema.decodeUnknownEffect(StripeChargeWebhookObjectSchema)(event.data.object)
        case "refund.updated":
          return Schema.decodeUnknownEffect(StripeRefundWebhookObjectSchema)(event.data.object)
        case "credit_note.created":
          return Schema.decodeUnknownEffect(StripeCreditNoteWebhookObjectSchema)(event.data.object)
        default:
          return Effect.succeed({ id: event.id })
      }
    }),
    Effect.asVoid,
    Effect.mapError(() => stripeError("Invalid Stripe webhook event payload"))
  )

const toBillingSubscriptionStatus = (
  status: Stripe.Subscription.Status
): Effect.Effect<BillingSubscriptionStatus, StripeBillingError> => {
  switch (status) {
    case "incomplete":
      return Effect.succeed("incomplete")
    case "incomplete_expired":
      return Effect.succeed("incomplete_expired")
    case "trialing":
      return Effect.succeed("trialing")
    case "active":
      return Effect.succeed("active")
    case "past_due":
      return Effect.succeed("past_due")
    case "canceled":
      return Effect.succeed("canceled")
    case "unpaid":
      return Effect.succeed("unpaid")
    case "paused":
      return Effect.succeed("paused")
    default:
      return Effect.fail(stripeError(`Unsupported Stripe subscription status: ${status}`))
  }
}

const make = Effect.gen(function* () {
  const configuredSecretKey = yield* Config.option(Config.redacted("STRIPE_SECRET_KEY"))
  const configuredWebhookSecret = yield* Config.option(Config.redacted("STRIPE_WEBHOOK_SECRET"))
  const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
    Config.withDefault("http://localhost:3000"),
    Config.map((url) => url.replace(/\/$/, ""))
  )
  const billingRepository = yield* BillingRepository
  const userRepository = yield* UserRepository

  const stripe = Option.flatMap(configuredSecretKey, (secretKey) => {
    const value = Redacted.value(secretKey).trim()
    return value === ""
      ? Option.none<Stripe>()
      : Option.some(
          new Stripe(value, {
            apiVersion: "2026-07-29.dahlia",
            typescript: true,
          })
        )
  })

  const stripeClient: Effect.Effect<Stripe, StripeBillingError> = Option.isSome(stripe)
    ? Effect.succeed(stripe.value)
    : Effect.fail(stripeError("Stripe billing is not configured"))

  const logStripeRequestFailure = (operation: string, cause: unknown) =>
    Effect.logError(
      {
        ...stripeRequestLogAttributes(cause),
        operation,
      },
      "Stripe request failed"
    )

  const stripeCatalogValidationFailure = ({
    operation,
    validationReason,
    message,
    lookupKey,
    priceId,
    receivedPriceCount,
  }: {
    readonly operation: string
    readonly validationReason: string
    readonly message: string
    readonly lookupKey?: string
    readonly priceId?: string
    readonly receivedPriceCount?: number
  }) =>
    Effect.logError(
      {
        provider: "stripe",
        operation,
        validationReason,
        lookupKey,
        priceId,
        receivedPriceCount,
        expectedPriceCount:
          receivedPriceCount === undefined ? undefined : CATALOG_LOOKUP_KEYS.length,
      },
      "Stripe catalog validation failed"
    ).pipe(Effect.andThen(Effect.fail(stripeError(message))))

  const validateStripeCatalogPriceListResponse = <A>({
    operation,
    response,
  }: {
    readonly operation: string
    readonly response: A
  }): Effect.Effect<A, StripeBillingError> =>
    Schema.decodeUnknownEffect(StripeCatalogPriceListPayloadSchema)(response).pipe(
      Effect.as(response),
      Effect.catch(() =>
        stripeCatalogValidationFailure({
          operation,
          validationReason: "response_shape_invalid",
          message: "Stripe returned an invalid catalog price response",
        })
      )
    )

  const stripePromise = <A>(operation: string, run: (client: Stripe) => Promise<A>) =>
    stripeClient.pipe(
      Effect.flatMap((client) =>
        Effect.tryPromise({
          try: () => run(client),
          catch: (cause) => new StripeRequestError({ cause }),
        })
      ),
      Effect.tapError((error) =>
        error._tag === "StripeRequestError"
          ? logStripeRequestFailure(operation, error.cause)
          : Effect.logError(
              {
                provider: "stripe",
                operation,
                configurationError: error.message,
              },
              "Stripe request failed"
            )
      ),
      Effect.mapError((error) =>
        error._tag === "StripeRequestError"
          ? stripeError(
              error.cause instanceof Error
                ? `${operation}: ${error.cause.message}`
                : `${operation}: Stripe request failed`
            )
          : error
      )
    )

  const webhookSecret = Option.flatMap(configuredWebhookSecret, (secret) => {
    const value = Redacted.value(secret).trim()
    return value === "" ? Option.none<string>() : Option.some(value)
  })

  const findActivePrice = (lookupKey: string) =>
    stripePromise("Could not load Stripe price", (client) =>
      client.prices.list({
        active: true,
        lookup_keys: [lookupKey],
        limit: 1,
        expand: ["data.product"],
      })
    ).pipe(
      Effect.flatMap((response) =>
        validateStripeCatalogPriceListResponse({
          operation: "Load Checkout price",
          response,
        })
      ),
      Effect.flatMap((prices) => {
        const price = prices.data[0]
        if (price === undefined) return Effect.as(Effect.void, undefined)
        if (lookupKey === TAXMAXI_ANNUAL_LOOKUP_KEY && !isValidAnnualPrice(price)) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: "annual_cadence_mismatch",
            message: "The TaxMaxi annual Stripe price must recur yearly",
            lookupKey,
            priceId: price.id,
          })
        }
        if (lookupKey === TAXMAXI_TOP_UP_LOOKUP_KEY && !isValidTopUpPrice(price)) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: "top_up_cadence_mismatch",
            message: "The TaxMaxi top-up Stripe price must be one-time",
            lookupKey,
            priceId: price.id,
          })
        }
        return Effect.succeed(price)
      })
    )

  const findPrice = (lookupKey: string): Effect.Effect<Stripe.Price, StripeBillingError> =>
    findActivePrice(lookupKey).pipe(
      Effect.flatMap((price) => {
        if (price === undefined) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: "active_price_missing",
            message: `No active Stripe price found for ${lookupKey}`,
            lookupKey,
          })
        }
        if (price.unit_amount === null) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: "unit_amount_missing",
            message: "Stripe Checkout prices must have a fixed unit amount",
            lookupKey,
            priceId: price.id,
          })
        }
        if (!isSupportedCatalogCurrency(price.currency)) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: "currency_mismatch",
            message: "Stripe Checkout prices must use EUR",
            lookupKey,
            priceId: price.id,
          })
        }
        const definitionMismatch = catalogPriceDefinitionMismatch(price)
        if (definitionMismatch !== undefined) {
          return stripeCatalogValidationFailure({
            operation: "Load Checkout price",
            validationReason: definitionMismatch,
            message: "Stripe Checkout price does not match the TaxMaxi catalog definition",
            lookupKey,
            priceId: price.id,
          })
        }
        return Effect.succeed<Stripe.Price>(price)
      })
    )

  const findCurrentAnnualProductId = findActivePrice(TAXMAXI_ANNUAL_LOOKUP_KEY).pipe(
    Effect.map((price) => (price === undefined ? undefined : productId(price.product)))
  )

  const createCustomer = ({
    userId,
    generation,
  }: {
    readonly userId: AuthUserId
    readonly generation: string
  }) =>
    Effect.gen(function* () {
      const maybeUser = yield* userRepository
        .findById(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load account details")))
      if (Option.isNone(maybeUser)) {
        return yield* stripeError("TaxMaxi account not found")
      }

      const customer = yield* stripePromise("Could not create Stripe customer", (client) =>
        client.customers.create(
          {
            email: maybeUser.value.email,
            name: maybeUser.value.displayName,
            metadata: { taxmaxi_user_id: userId },
          },
          { idempotencyKey: `taxmaxi-customer-${userId}-${generation}` }
        )
      )
      yield* billingRepository
        .saveCustomer({ userId, stripeCustomerId: customer.id })
        .pipe(Effect.mapError(() => stripeError("Could not save billing account")))
      return customer.id
    })

  const getOrCreateCustomer = (userId: AuthUserId) =>
    Effect.gen(function* () {
      const existing = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      const existingCustomerId = Option.isSome(existing) ? existing.value.stripeCustomerId : null
      const existingCustomerGeneration = Option.isSome(existing)
        ? existing.value.stripeCustomerGeneration
        : 0
      if (existingCustomerId === null) {
        return yield* createCustomer({ userId, generation: String(existingCustomerGeneration) })
      }

      const customer = yield* stripePromise("Could not verify Stripe customer", (client) =>
        client.customers.retrieve(existingCustomerId)
      )
      if (!customer.deleted) return existingCustomerId

      yield* billingRepository
        .clearCustomer(existingCustomerId)
        .pipe(Effect.mapError(() => stripeError("Could not clear deleted Stripe customer")))
      return yield* createCustomer({
        userId,
        generation: String(existingCustomerGeneration + 1),
      })
    })

  const catalog: StripeBillingServiceShape["catalog"] = stripePromise(
    "Could not load Stripe prices",
    (client) =>
      client.prices.list({
        active: true,
        lookup_keys: [...CATALOG_LOOKUP_KEYS],
        limit: CATALOG_LOOKUP_KEYS.length,
        expand: ["data.product"],
      })
  ).pipe(
    Effect.flatMap((response) =>
      validateStripeCatalogPriceListResponse({
        operation: "Load billing catalog",
        response,
      })
    ),
    Effect.flatMap((prices) => {
      if (
        !prices.data.every((price) =>
          isCatalogPriceCadenceValid({ lookupKey: price.lookup_key, price })
        )
      ) {
        return stripeCatalogValidationFailure({
          operation: "Load billing catalog",
          validationReason: "cadence_mismatch",
          message: "Stripe catalog price cadence does not match its lookup key",
          receivedPriceCount: prices.data.length,
        })
      }
      const fixedPrices = prices.data.filter(hasFixedUnitAmount)
      if (fixedPrices.length !== prices.data.length) {
        return stripeCatalogValidationFailure({
          operation: "Load billing catalog",
          validationReason: "unit_amount_missing",
          message: "Stripe catalog prices must have a fixed unit amount",
          receivedPriceCount: prices.data.length,
        })
      }
      if (!fixedPrices.every((price) => isSupportedCatalogCurrency(price.currency))) {
        return stripeCatalogValidationFailure({
          operation: "Load billing catalog",
          validationReason: "currency_mismatch",
          message: "Stripe catalog prices must use EUR",
          receivedPriceCount: prices.data.length,
        })
      }
      if (!hasCompleteCatalogLookupKeys(fixedPrices)) {
        return stripeCatalogValidationFailure({
          operation: "Load billing catalog",
          validationReason: "lookup_keys_incomplete",
          message: "Stripe catalog must include every supported lookup key exactly once",
          receivedPriceCount: prices.data.length,
        })
      }
      const invalidPrice = fixedPrices.find(
        (price) => catalogPriceDefinitionMismatch(price) !== undefined
      )
      if (invalidPrice !== undefined) {
        return stripeCatalogValidationFailure({
          operation: "Load billing catalog",
          validationReason: catalogPriceDefinitionMismatch(invalidPrice) ?? "definition_mismatch",
          message: "Stripe catalog prices do not match the TaxMaxi catalog definition",
          ...(invalidPrice.lookup_key === null ? {} : { lookupKey: invalidPrice.lookup_key }),
          priceId: invalidPrice.id,
          receivedPriceCount: prices.data.length,
        })
      }
      return Effect.succeed(
        fixedPrices.map(
          (price): BillingCatalogPrice => ({
            lookupKey: price.lookup_key ?? "",
            amountMinor: price.unit_amount,
            currency: price.currency,
            taxBehavior: price.tax_behavior ?? "unspecified",
            recurringInterval: price.recurring?.interval === "year" ? "year" : null,
          })
        )
      )
    })
  )

  const status: StripeBillingServiceShape["status"] = (userId) =>
    Effect.gen(function* () {
      const [account, credits] = yield* Effect.all(
        [billingRepository.findByUserId(userId), billingRepository.availableCredits(userId)],
        { concurrency: "unbounded" }
      ).pipe(Effect.mapError(() => stripeError("Could not load billing status")))

      return {
        credits,
        subscriptionStatus: Option.isSome(account) ? account.value.subscriptionStatus : null,
        currentPeriodEnd: Option.isSome(account) ? account.value.currentPeriodEnd : null,
        cancelAtPeriodEnd: Option.isSome(account) ? account.value.cancelAtPeriodEnd : false,
      }
    })

  const createAnnualCheckout: StripeBillingServiceShape["createAnnualCheckout"] = (userId) =>
    Effect.gen(function* () {
      const [customer, price] = yield* Effect.all(
        [getOrCreateCustomer(userId), findPrice(TAXMAXI_ANNUAL_LOOKUP_KEY)],
        { concurrency: "unbounded" }
      )
      const subscriptions = yield* stripePromise(
        "Could not verify existing Stripe subscriptions",
        (client) =>
          loadAllStripeItems({
            page: client.subscriptions.list({ customer, status: "all", limit: 100 }),
          })
      )
      const currentAnnualProductId = productId(price.product)
      if (
        hasExistingTaxMaxiAnnualSubscription({
          subscriptions,
          currentProductId: currentAnnualProductId,
        })
      ) {
        return yield* stripeError("This account already has a subscription")
      }
      const checkoutReservation = yield* billingRepository
        .reserveAnnualCheckout({ userId, priceId: price.id })
        .pipe(Effect.mapError(() => stripeError("Could not reserve annual Checkout")))
      const session = yield* createReservedAnnualCheckoutSession({
        currentPrice: price,
        reservation: checkoutReservation,
        customer,
        userId,
        frontendUrl,
        loadPrice: (priceId) =>
          stripePromise("Could not load reserved annual Stripe price", (client) =>
            client.prices.retrieve(priceId)
          ),
        createSession: ({ params, idempotencyKey }) =>
          stripeClient.pipe(
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: () => client.checkout.sessions.create(params, { idempotencyKey }),
                catch: (cause) => new StripeRequestError({ cause }),
              }).pipe(
                Effect.tapError((error) =>
                  logStripeRequestFailure("Could not create annual Checkout", error.cause)
                ),
                Effect.catch((error) => {
                  const checkoutError = stripeError(
                    error.cause instanceof Error
                      ? `Could not create annual Checkout: ${error.cause.message}`
                      : "Could not create annual Checkout: Stripe request failed"
                  )
                  return isDefinitiveAnnualCheckoutCreationFailure(error.cause)
                    ? billingRepository
                        .clearAnnualCheckoutReservation({
                          userId,
                          generation: checkoutReservation.generation,
                        })
                        .pipe(
                          Effect.mapError(() =>
                            stripeError("Could not clear failed annual Checkout reservation")
                          ),
                          Effect.andThen(Effect.fail(checkoutError))
                        )
                    : Effect.fail(checkoutError)
                })
              )
            )
          ),
      })
      if (session.url === null) {
        return yield* stripeError("Stripe did not return a Checkout URL")
      }
      return session.url
    })

  const createTopUpCheckout: StripeBillingServiceShape["createTopUpCheckout"] = (userId) =>
    Effect.gen(function* () {
      const account = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      const stripeCustomerId = yield* verifiedTopUpCustomer({
        account,
        userId,
        getOrCreateCustomer,
        findByUserId: (id) =>
          billingRepository
            .findByUserId(id)
            .pipe(Effect.mapError(() => stripeError("Could not refresh billing account"))),
        hasCurrentAnnualSubscription: (customerId) =>
          Effect.gen(function* () {
            const subscriptions = yield* stripePromise(
              "Could not verify current annual subscription",
              (client) =>
                loadAllStripeItems({
                  page: client.subscriptions.list({
                    customer: customerId,
                    status: "all",
                    limit: 100,
                  }),
                })
            )
            const taggedSubscriptionIsEligible = subscriptions.some(
              (subscription) =>
                isTaxMaxiAnnualSubscription({ subscription }) &&
                isTopUpEligibleSubscription(subscription.status)
            )
            if (taggedSubscriptionIsEligible) return true

            const currentProductId = yield* findCurrentAnnualProductId
            return subscriptions.some(
              (subscription) =>
                isTaxMaxiAnnualSubscription({
                  subscription,
                  currentProductId,
                }) && isTopUpEligibleSubscription(subscription.status)
            )
          }),
      })
      const price = yield* findPrice(TAXMAXI_TOP_UP_LOOKUP_KEY)
      const session = yield* stripePromise("Could not create top-up Checkout", (client) =>
        client.checkout.sessions.create(
          buildTopUpCheckoutParams({
            customer: stripeCustomerId,
            price,
            userId,
            frontendUrl,
          })
        )
      )
      if (session.url === null) {
        return yield* stripeError("Stripe did not return a Checkout URL")
      }
      return session.url
    })

  const createPortalSession: StripeBillingServiceShape["createPortalSession"] = (userId) =>
    Effect.gen(function* () {
      const account = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isNone(account) || account.value.stripeCustomerId === null) {
        return yield* stripeError("No Stripe customer exists for this account")
      }
      const stripeCustomerId = yield* getOrCreateCustomer(userId)
      const session = yield* stripePromise("Could not create Customer Portal session", (client) =>
        client.billingPortal.sessions.create({
          customer: stripeCustomerId,
          return_url: `${frontendUrl}/app/billing`,
        })
      )
      return session.url
    })

  const syncSubscription = ({
    subscription,
    eventCreatedAt,
    syncGeneration,
    currentProductId,
  }: {
    readonly subscription: Stripe.Subscription
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
    readonly currentProductId: string | undefined
  }) =>
    Effect.gen(function* () {
      if (!isTaxMaxiAnnualSubscription({ subscription, currentProductId })) return

      const customer = customerId(subscription.customer)
      if (customer === null) return
      const mappedStatus = yield* toBillingSubscriptionStatus(subscription.status)
      yield* billingRepository
        .saveSubscription({
          stripeCustomerId: customer,
          stripeSubscriptionId: subscription.id,
          status: mappedStatus,
          currentPeriodEnd: subscriptionPeriodEnd(subscription),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          eventCreatedAt,
          syncGeneration,
          annualCheckoutGeneration: annualCheckoutGenerationFromMetadata(subscription.metadata),
        })
        .pipe(Effect.mapError(() => stripeError("Could not save subscription state")))
    })

  const loadCurrentAnnualSubscription = (customer: string) =>
    Effect.gen(function* () {
      const subscriptions = yield* stripePromise(
        "Could not load current customer subscriptions",
        (client) =>
          loadAllStripeItems({
            page: client.subscriptions.list({ customer, status: "all", limit: 100 }),
          })
      )
      const taggedSubscription = currentExistingAnnualSubscription(subscriptions)
      if (taggedSubscription !== undefined) {
        return { subscription: taggedSubscription, currentProductId: undefined }
      }

      const currentProductId = yield* findCurrentAnnualProductId
      const legacySubscription = currentExistingAnnualSubscription(subscriptions, currentProductId)
      return legacySubscription === undefined
        ? undefined
        : { subscription: legacySubscription, currentProductId }
    })

  const reconcileTrackedAnnualSubscription = ({
    customer,
    trackedSubscriptionId,
    eventCreatedAt,
    syncGeneration,
  }: {
    readonly customer: string
    readonly trackedSubscriptionId: string
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
  }) =>
    Effect.gen(function* () {
      const current = yield* loadCurrentAnnualSubscription(customer)
      if (current === undefined) {
        yield* billingRepository
          .clearSubscription({
            stripeCustomerId: customer,
            stripeSubscriptionId: trackedSubscriptionId,
            eventCreatedAt,
            syncGeneration,
          })
          .pipe(Effect.mapError(() => stripeError("Could not clear annual subscription state")))
      } else {
        yield* syncSubscription({
          subscription: current.subscription,
          eventCreatedAt,
          syncGeneration,
          currentProductId: current.currentProductId,
        })
      }

      const confirmed = yield* loadCurrentAnnualSubscription(customer)
      if (confirmed !== undefined) {
        yield* syncSubscription({
          subscription: confirmed.subscription,
          eventCreatedAt,
          syncGeneration,
          currentProductId: confirmed.currentProductId,
        })
      }
      const subscriptionIdToClear = subscriptionIdToClearAfterConfirmation({
        currentSubscriptionId: current?.subscription.id ?? null,
        confirmedSubscriptionId: confirmed?.subscription.id ?? null,
      })
      if (subscriptionIdToClear !== null) {
        yield* billingRepository
          .clearSubscription({
            stripeCustomerId: customer,
            stripeSubscriptionId: subscriptionIdToClear,
            eventCreatedAt,
            syncGeneration,
          })
          .pipe(Effect.mapError(() => stripeError("Could not clear annual subscription state")))
      }
    })

  const paidInvoicePaymentAllocations = (invoiceId: string) =>
    stripePromise("Could not load paid invoice payments", (client) =>
      loadAllStripeItems({
        page: client.invoicePayments.list({
          invoice: invoiceId,
          status: "paid",
          limit: 100,
          expand: ["data.payment.charge.payment_intent"],
        }),
      })
    ).pipe(Effect.map(annualPaymentAllocationsFromInvoicePayments))

  const grantAnnualCredits = (invoice: Stripe.Invoice) =>
    Effect.gen(function* () {
      const details = invoice.parent?.subscription_details
      if (details === null || details === undefined) return
      if (
        !isAnnualInvoiceEligible({
          billingReason: invoice.billing_reason,
          planLookupKey: details.metadata?.plan_lookup_key,
        })
      ) {
        return
      }
      const currentAnnualPrice = yield* findActivePrice(TAXMAXI_ANNUAL_LOOKUP_KEY)
      const currentProductId =
        currentAnnualPrice === undefined ? undefined : productId(currentAnnualPrice.product)
      const allowedAnnualProductIds = annualInvoiceProductIds({
        planLookupKey: details.metadata?.plan_lookup_key,
        planProductId: details.metadata?.plan_product_id,
        currentProductId,
      })
      if (allowedAnnualProductIds === null) return
      const id = subscriptionId(details.subscription)
      const customer = customerId(invoice.customer)
      if (id === null || customer === null) return

      const invoiceLines = yield* completeInvoiceLines({
        embeddedLines: invoice.lines.data,
        hasMore: invoice.lines.has_more,
        loadAll: () =>
          stripePromise("Could not load complete invoice lines", (client) =>
            client.invoices
              .listLineItems(invoice.id, { limit: 100 })
              .autoPagingToArray({ limit: 10_000 })
          ),
      })
      const candidateLines = invoiceLines.filter((line) => {
        const subscriptionItem = line.parent?.subscription_item_details
        return subscriptionItem !== null && subscriptionItem !== undefined
      })
      const enrichedLines = yield* Effect.forEach(candidateLines, (line) => {
        const invoicePrice = line.pricing?.price_details?.price
        if (invoicePrice === undefined) return Effect.succeed(null)

        return stripePromise("Could not load invoice line price", (client) =>
          client.prices.retrieve(priceId(invoicePrice))
        ).pipe(
          Effect.map((price) => ({
            line,
            proration: line.parent?.subscription_item_details?.proration ?? true,
            periodStart: line.period.start,
            periodEnd: line.period.end,
            interval: price.recurring?.interval,
            intervalCount: price.recurring?.interval_count,
            productId: productId(price.product),
            allowedProductIds: allowedAnnualProductIds,
          }))
        )
      })
      const annualLine = findEligibleAnnualInvoiceLine(
        enrichedLines.filter((candidate) => candidate !== null)
      )
      if (annualLine === undefined) return

      const userId = yield* resolvePaidFulfillmentUserId({
        metadataUserId: details.metadata?.taxmaxi_user_id,
        stripeCustomerId: customer,
        findByUserId: (lookupUserId) =>
          billingRepository
            .findByUserId(lookupUserId)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account"))),
        findByStripeCustomerId: (customerId) =>
          billingRepository
            .findByStripeCustomerId(customerId)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account"))),
      })
      if (userId === null) return
      const paymentAllocations = annualInvoiceCreditAllocations({
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        paymentAllocations: yield* paidInvoicePaymentAllocations(invoice.id),
      })
      if (paymentAllocations.length === 0) {
        return yield* stripeError("Paid annual invoice has no supported payment")
      }
      yield* persistAnnualCreditAllocations({
        userId,
        subscriptionId: id,
        periodStart: annualLine.period.start,
        periodEnd: annualLine.period.end,
        allocations: paymentAllocations,
        grantCredits: billingRepository.grantCredits,
        reconcilePaymentCreditReversals: billingRepository.reconcilePaymentCreditReversals,
      }).pipe(Effect.mapError(() => stripeError("Could not grant annual credits")))
    })

  const grantTopUpCredits = (session: Stripe.Checkout.Session) =>
    Effect.gen(function* () {
      if (
        !isPaidTopUpSessionEligible({
          purchaseKind: session.metadata?.purchase_kind,
          paymentStatus: session.payment_status,
        })
      ) {
        return
      }
      const customer = customerId(session.customer)
      const paymentReference = paymentIntentId(session.payment_intent)
      if (customer === null || paymentReference === null) return
      const userId = yield* resolvePaidFulfillmentUserId({
        metadataUserId: session.metadata?.taxmaxi_user_id,
        stripeCustomerId: customer,
        findByUserId: (lookupUserId) =>
          billingRepository
            .findByUserId(lookupUserId)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account"))),
        findByStripeCustomerId: (customerId) =>
          billingRepository
            .findByStripeCustomerId(customerId)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account"))),
      })
      if (userId === null) return

      yield* billingRepository
        .grantCredits({
          userId,
          amount: TOP_UP_CREDITS,
          kind: "top_up",
          reference: `stripe:checkout:${session.id}`,
          paymentReference,
          paymentAmount: null,
          stripeInvoiceId: null,
          expiresAt: null,
        })
        .pipe(Effect.mapError(() => stripeError("Could not grant top-up credits")))
      yield* billingRepository
        .reconcilePaymentCreditReversals(paymentReference)
        .pipe(Effect.mapError(() => stripeError("Could not reconcile top-up credit reversals")))
    })

  const applyChargeReversal = ({
    charge,
    reversedAmount,
    reversalGroup,
    lossReference,
    reference,
    eventCreatedAt,
    stripeInvoiceId,
    monotonic,
    terminal,
  }: {
    readonly charge: Stripe.Charge
    readonly reversedAmount: number
    readonly reversalGroup: string
    readonly lossReference: string
    readonly reference: string
    readonly eventCreatedAt: Date
    readonly stripeInvoiceId: string | null
    readonly monotonic: boolean
    readonly terminal: boolean
  }) =>
    Effect.gen(function* () {
      const paymentReference = chargePaymentReference(charge)
      yield* billingRepository
        .setPaymentCreditReversal({
          paymentReference,
          reversalGroup,
          lossReference,
          reversedAmount,
          paymentAmount: charge.amount,
          reference,
          eventCreatedAt,
          stripeInvoiceId,
          monotonic,
          terminal,
        })
        .pipe(Effect.mapError(() => stripeError("Could not reverse payment credits")))
    })

  const applyDisputeReversal = ({
    dispute,
    eventId,
    eventCreatedAt,
  }: {
    readonly dispute: Stripe.Dispute
    readonly eventId: string
    readonly eventCreatedAt: Date
  }) =>
    Effect.gen(function* () {
      const currentDispute = yield* stripePromise("Could not load current dispute", (client) =>
        client.disputes.retrieve(dispute.id)
      )
      const disputeCharge = currentDispute.charge
      const charge =
        typeof disputeCharge === "string"
          ? yield* stripePromise("Could not load disputed charge", (client) =>
              client.charges.retrieve(disputeCharge)
            )
          : disputeCharge
      const reversal = disputeCreditReversal(currentDispute)
      yield* applyChargeReversal({
        charge,
        reversedAmount: reversal.reversedAmount,
        reversalGroup: `stripe:dispute:${dispute.id}`,
        lossReference: `stripe:dispute:${dispute.id}`,
        reference: `stripe:dispute:${dispute.id}:${eventId}`,
        eventCreatedAt,
        stripeInvoiceId: null,
        monotonic: false,
        terminal: reversal.terminal,
      })
    })

  const applyCreditNoteReversals = ({
    creditNote,
    eventId,
    eventCreatedAt,
  }: {
    readonly creditNote: Stripe.CreditNote
    readonly eventId: string
    readonly eventCreatedAt: Date
  }) =>
    Effect.gen(function* () {
      if (creditNote.status !== "issued") return

      const invoiceId =
        typeof creditNote.invoice === "string" ? creditNote.invoice : creditNote.invoice.id

      yield* Effect.forEach(
        creditNote.refunds,
        (refund) =>
          Effect.gen(function* () {
            const paymentRecordRefund = refund.payment_record_refund
            if (refund.amount_refunded <= 0) return

            if (refund.type === "refund") {
              const refundReference = refund.refund
              const creditNoteRefund =
                typeof refundReference === "string"
                  ? yield* stripePromise("Could not load credited refund", (client) =>
                      client.refunds.retrieve(refundReference)
                    )
                  : refundReference
              if (creditNoteRefund === null || creditNoteRefund.status !== "succeeded") return
              const refundCharge = creditNoteRefund.charge
              const paymentReference =
                paymentIntentId(creditNoteRefund.payment_intent) ??
                (refundCharge === null
                  ? null
                  : typeof refundCharge === "string"
                    ? refundCharge
                    : refundCharge.id)
              if (paymentReference === null || creditNoteRefund.amount <= 0) return

              yield* billingRepository
                .setPaymentCreditReversal({
                  paymentReference,
                  reversalGroup: `stripe:credit-note:${creditNote.id}:refund:${creditNoteRefund.id}`,
                  lossReference: `stripe:refund:${creditNoteRefund.id}`,
                  reversedAmount: refund.amount_refunded,
                  paymentAmount: creditNoteRefund.amount,
                  reference: `stripe:credit-note:${creditNote.id}:${eventId}`,
                  eventCreatedAt,
                  stripeInvoiceId: invoiceId,
                  monotonic: true,
                  terminal: true,
                })
                .pipe(Effect.mapError(() => stripeError("Could not attribute refunded credits")))
              return
            }

            if (refund.type !== "payment_record_refund" || paymentRecordRefund === null) return

            const paymentRecord = yield* stripePromise(
              "Could not load refunded payment record",
              (client) => client.paymentRecords.retrieve(paymentRecordRefund.payment_record)
            )
            if (
              paymentRecord.amount.value <= 0 ||
              paymentRecord.amount.currency !== creditNote.currency
            ) {
              return yield* stripeError("Invalid refunded payment record amount")
            }

            yield* billingRepository
              .setPaymentCreditReversal({
                paymentReference: paymentRecord.id,
                reversalGroup: `stripe:credit-note:${creditNote.id}:payment-record-refund:${paymentRecordRefund.refund_group}`,
                lossReference: `stripe:payment-record-refund:${paymentRecordRefund.refund_group}`,
                reversedAmount: refund.amount_refunded,
                paymentAmount: paymentRecord.amount.value,
                reference: `stripe:credit-note:${creditNote.id}:${eventId}`,
                eventCreatedAt,
                stripeInvoiceId: invoiceId,
                monotonic: true,
                terminal: true,
              })
              .pipe(Effect.mapError(() => stripeError("Could not reverse payment record credits")))
          }),
        { discard: true }
      )

      const refundedAmount = creditNote.refunds.reduce(
        (total, refund) => total + refund.amount_refunded,
        0
      )
      const nonRefundAmount = creditNote.post_payment_amount - refundedAmount
      if (nonRefundAmount < 0) {
        return yield* stripeError("Invalid credit note post-payment amount")
      }
      if (nonRefundAmount === 0) return

      const paymentAllocations = yield* paidInvoicePaymentAllocations(invoiceId)
      const reversalAllocations = allocateCreditNoteReversalAcrossPayments({
        reversedAmount: nonRefundAmount,
        payments: paymentAllocations,
      })
      if (reversalAllocations === null || reversalAllocations.length === 0) {
        return yield* stripeError("Could not attribute non-refund credit note value")
      }

      yield* Effect.forEach(
        reversalAllocations,
        (allocation) =>
          billingRepository
            .setPaymentCreditReversal({
              paymentReference: allocation.paymentReference,
              reversalGroup: `stripe:credit-note:${creditNote.id}:non-refund:${allocation.paymentReference}`,
              lossReference: `stripe:credit-note:${creditNote.id}:non-refund`,
              reversedAmount: allocation.reversedAmount,
              paymentAmount: allocation.paymentAmount,
              reference: `stripe:credit-note:${creditNote.id}:${eventId}`,
              eventCreatedAt,
              stripeInvoiceId: invoiceId,
              monotonic: true,
              terminal: true,
            })
            .pipe(Effect.mapError(() => stripeError("Could not reverse credited invoice value"))),
        { discard: true }
      )
    })

  const applyChargeRefunds = ({
    charge,
    eventId,
    eventCreatedAt,
  }: {
    readonly charge: Stripe.Charge
    readonly eventId: string
    readonly eventCreatedAt: Date
  }) =>
    Effect.gen(function* () {
      const refunds = yield* stripePromise("Could not load charge refunds", (client) =>
        loadAllStripeItems({ page: client.refunds.list({ charge: charge.id }) })
      )
      yield* Effect.forEach(
        refunds.filter((refund) => refund.status === "succeeded"),
        (refund) =>
          applyChargeReversal({
            charge,
            reversedAmount: refund.amount,
            reversalGroup: `stripe:refund:${refund.id}:payment`,
            lossReference: `stripe:refund:${refund.id}`,
            reference: `stripe:refund:${refund.id}:${eventId}`,
            eventCreatedAt,
            stripeInvoiceId: null,
            monotonic: true,
            terminal: true,
          }),
        { discard: true }
      )
    })

  const applyRefundUpdate = ({
    refund,
    eventId,
    eventCreatedAt,
  }: {
    readonly refund: Stripe.Refund
    readonly eventId: string
    readonly eventCreatedAt: Date
  }) =>
    Effect.gen(function* () {
      const refundCharge = refund.charge
      if (refund.status !== "succeeded" || refundCharge === null) return

      const charge =
        typeof refundCharge === "string"
          ? yield* stripePromise("Could not load refunded charge", (client) =>
              client.charges.retrieve(refundCharge)
            )
          : refundCharge
      yield* applyChargeReversal({
        charge,
        reversedAmount: refund.amount,
        reversalGroup: `stripe:refund:${refund.id}:payment`,
        lossReference: `stripe:refund:${refund.id}`,
        reference: `stripe:refund:${refund.id}:${eventId}`,
        eventCreatedAt,
        stripeInvoiceId: null,
        monotonic: true,
        terminal: true,
      })
    })

  const processWebhook: StripeBillingServiceShape["processWebhook"] = (input) =>
    Effect.gen(function* () {
      const secret = Option.getOrNull(webhookSecret)
      if (secret === null) {
        return yield* Effect.failSync(() => stripeError("Stripe webhook is not configured"))
      }
      const event = yield* stripePromise("Invalid Stripe webhook signature", (client) =>
        client.webhooks.constructEventAsync(input.payload, input.signature, secret)
      )
      yield* validateStripeWebhookEvent(event)
      const processed = yield* billingRepository
        .hasProcessedEvent(event.id)
        .pipe(Effect.mapError(() => stripeError("Could not check Stripe event")))
      if (processed) return

      const eventCreatedAt = DateTime.toDateUtc(DateTime.makeUnsafe(event.created * 1_000))
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.paused":
        case "customer.subscription.resumed": {
          const customer = customerId(event.data.object.customer)
          if (customer === null) break
          const subscription = yield* stripePromise(
            "Could not load current subscription state",
            (client) => client.subscriptions.retrieve(event.data.object.id)
          )
          const account = yield* billingRepository
            .findByStripeCustomerId(customer)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
          const trackedSubscriptionId = Option.isSome(account)
            ? account.value.stripeSubscriptionId
            : null
          const taggedAnnualSubscription = isTaxMaxiAnnualSubscription({ subscription })
          const currentProductId =
            taggedAnnualSubscription || subscription.id === trackedSubscriptionId
              ? undefined
              : yield* findCurrentAnnualProductId
          if (
            !shouldReconcileAnnualSubscription({
              subscription,
              trackedSubscriptionId,
              currentProductId,
            })
          ) {
            break
          }
          if (!isTaxMaxiAnnualSubscription({ subscription, currentProductId })) {
            const syncGeneration = yield* billingRepository
              .reserveSubscriptionSync({ stripeCustomerId: customer, eventCreatedAt })
              .pipe(Effect.mapError(() => stripeError("Could not reserve subscription sync")))
            yield* reconcileTrackedAnnualSubscription({
              customer,
              trackedSubscriptionId: subscription.id,
              eventCreatedAt,
              syncGeneration,
            })
            break
          }
          const syncGeneration = yield* billingRepository
            .reserveSubscriptionSync({ stripeCustomerId: customer, eventCreatedAt })
            .pipe(Effect.mapError(() => stripeError("Could not reserve subscription sync")))
          yield* syncSubscription({
            subscription,
            eventCreatedAt,
            syncGeneration,
            currentProductId,
          })
          const confirmedSubscription = yield* stripePromise(
            "Could not confirm current subscription state",
            (client) => client.subscriptions.retrieve(event.data.object.id)
          )
          if (
            isTaxMaxiAnnualSubscription({
              subscription: confirmedSubscription,
              currentProductId,
            })
          ) {
            yield* syncSubscription({
              subscription: confirmedSubscription,
              eventCreatedAt,
              syncGeneration,
              currentProductId,
            })
            if (!isExistingSubscription(confirmedSubscription.status)) {
              yield* reconcileTrackedAnnualSubscription({
                customer,
                trackedSubscriptionId: confirmedSubscription.id,
                eventCreatedAt,
                syncGeneration,
              })
            }
          } else {
            yield* reconcileTrackedAnnualSubscription({
              customer,
              trackedSubscriptionId: subscription.id,
              eventCreatedAt,
              syncGeneration,
            })
          }
          break
        }
        case "customer.subscription.deleted": {
          const customer = customerId(event.data.object.customer)
          if (customer === null) break
          const account = yield* billingRepository
            .findByStripeCustomerId(customer)
            .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
          if (Option.isNone(account)) break
          const currentProductId = yield* findCurrentAnnualProductId
          const isTrackedSubscription = account.value.stripeSubscriptionId === event.data.object.id
          if (
            !isTrackedSubscription &&
            !isTaxMaxiAnnualSubscription({
              subscription: event.data.object,
              currentProductId,
            })
          ) {
            break
          }
          const syncGeneration = yield* billingRepository
            .reserveSubscriptionSync({ stripeCustomerId: customer, eventCreatedAt })
            .pipe(Effect.mapError(() => stripeError("Could not reserve subscription sync")))
          yield* syncSubscription({
            subscription: event.data.object,
            eventCreatedAt,
            syncGeneration,
            currentProductId,
          })
          yield* reconcileTrackedAnnualSubscription({
            customer,
            trackedSubscriptionId: event.data.object.id,
            eventCreatedAt,
            syncGeneration,
          })
          break
        }
        case "customer.deleted":
          yield* billingRepository
            .clearCustomer(event.data.object.id)
            .pipe(Effect.mapError(() => stripeError("Could not clear deleted Stripe customer")))
          break
        case "invoice.paid":
          yield* grantAnnualCredits(event.data.object)
          break
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          yield* grantTopUpCredits(event.data.object)
          break
        case "charge.refunded":
          yield* applyChargeRefunds({
            charge: event.data.object,
            eventId: event.id,
            eventCreatedAt,
          })
          break
        case "refund.updated":
          yield* applyRefundUpdate({
            refund: event.data.object,
            eventId: event.id,
            eventCreatedAt,
          })
          break
        case "credit_note.created":
          yield* applyCreditNoteReversals({
            creditNote: event.data.object,
            eventId: event.id,
            eventCreatedAt,
          })
          break
        case "charge.dispute.created":
        case "charge.dispute.closed":
          yield* applyDisputeReversal({
            dispute: event.data.object,
            eventId: event.id,
            eventCreatedAt,
          })
          break
        default:
          break
      }

      yield* billingRepository
        .markEventProcessed({ eventId: event.id, eventType: event.type })
        .pipe(Effect.mapError(() => stripeError("Could not mark Stripe event as processed")))
    })

  return {
    catalog,
    status,
    createAnnualCheckout,
    createTopUpCheckout,
    createPortalSession,
    processWebhook,
  } satisfies StripeBillingServiceShape
})

/** Live Stripe implementation configured through Effect Config. */
export const StripeBillingServiceLive = Layer.effect(StripeBillingService, make)
