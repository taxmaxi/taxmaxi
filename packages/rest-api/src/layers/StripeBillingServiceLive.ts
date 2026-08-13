/**
 * StripeBillingServiceLive - Stripe Checkout, Portal, and signed webhook integration.
 *
 * @module StripeBillingServiceLive
 */

import { AuthUserId } from "@my/core/authentication"
import { BillingRepository, UserRepository } from "@my/persistence/services"
import type { BillingAccount, BillingSubscriptionStatus } from "@my/persistence/services"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import Stripe from "stripe"

import {
  StripeBillingError,
  StripeBillingService,
  TAXMAXI_ANNUAL_LOOKUP_KEY,
  TAXMAXI_ENTERPRISE_PILOT_LOOKUP_KEY,
  TAXMAXI_PROFESSIONAL_ANNUAL_LOOKUP_KEY,
  TAXMAXI_PROFESSIONAL_MATTER_LOOKUP_KEY,
  TAXMAXI_PROFESSIONAL_TOP_UP_LOOKUP_KEY,
  TAXMAXI_TOP_UP_LOOKUP_KEY,
  type BillingCatalogPrice,
  type StripeBillingServiceShape,
} from "../services/StripeBillingService.ts"

const ANNUAL_CREDITS = 10_000
const TOP_UP_CREDITS = 1_000
const INTEGRATION_IDENTIFIER = "taxmaxi_direct_q7m4w2kp"

const stripeError = (message: string) => new StripeBillingError({ message })

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

const paymentIntentId = (paymentIntent: string | Stripe.PaymentIntent | null): string | null => {
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
  return end === 0 ? null : new Date(end * 1_000)
}

const isTopUpEligibleSubscription = (status: string | null): boolean =>
  status === "active" || status === "trialing"

const isExistingSubscription = (status: string | null): boolean =>
  status !== null && status !== "canceled" && status !== "incomplete_expired"

export const isAnnualInvoiceEligible = ({
  billingReason,
  planLookupKey,
}: {
  readonly billingReason: string | null
  readonly planLookupKey: string | undefined
}): boolean =>
  (billingReason === "subscription_create" || billingReason === "subscription_cycle") &&
  planLookupKey === TAXMAXI_ANNUAL_LOOKUP_KEY

export const isAnnualInvoiceLineEligible = ({
  proration,
  periodStart,
  periodEnd,
  interval,
  productId,
  currentProductId,
}: {
  readonly proration: boolean
  readonly periodStart: number
  readonly periodEnd: number
  readonly interval: string | undefined
  readonly productId: string
  readonly currentProductId: string
}): boolean =>
  !proration && periodEnd > periodStart && interval === "year" && productId === currentProductId

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
    readonly productId: string
    readonly currentProductId: string
  }>
): Line | undefined => candidates.find((candidate) => isAnnualInvoiceLineEligible(candidate))?.line

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

    const userId = yield* Schema.decodeUnknown(AuthUserId)(metadataUserId).pipe(
      Effect.mapError(() => stripeError("Invalid TaxMaxi user metadata on paid Stripe object"))
    )
    const account = yield* findByUserId(userId)
    if (Option.isNone(account)) {
      return yield* Effect.fail(stripeError("TaxMaxi billing account not found"))
    }
    return userId
  })

export const verifiedTopUpCustomer = ({
  account,
  userId,
  getOrCreateCustomer,
  findByUserId,
}: {
  readonly account: Option.Option<BillingAccount>
  readonly userId: AuthUserId
  readonly getOrCreateCustomer: (userId: AuthUserId) => Effect.Effect<string, StripeBillingError>
  readonly findByUserId: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<BillingAccount>, StripeBillingError>
}) =>
  Effect.gen(function* () {
    if (
      Option.isNone(account) ||
      account.value.stripeCustomerId === null ||
      !isTopUpEligibleSubscription(account.value.subscriptionStatus)
    ) {
      return yield* Effect.fail(stripeError("An active annual subscription is required"))
    }

    const stripeCustomerId = yield* getOrCreateCustomer(userId)
    const refreshedAccount = yield* findByUserId(userId)
    if (
      Option.isNone(refreshedAccount) ||
      refreshedAccount.value.stripeCustomerId !== stripeCustomerId ||
      !isTopUpEligibleSubscription(refreshedAccount.value.subscriptionStatus)
    ) {
      return yield* Effect.fail(stripeError("An active annual subscription is required"))
    }
    return stripeCustomerId
  })

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

  const stripePromise = <A>(operation: string, run: (client: Stripe) => Promise<A>) =>
    stripeClient.pipe(
      Effect.flatMap((client) =>
        Effect.tryPromise({
          try: () => run(client),
          catch: (cause) =>
            stripeError(
              cause instanceof Error
                ? `${operation}: ${cause.message}`
                : `${operation}: Stripe request failed`
            ),
        })
      )
    )

  const webhookSecret = Option.flatMap(configuredWebhookSecret, (secret) => {
    const value = Redacted.value(secret).trim()
    return value === "" ? Option.none<string>() : Option.some(value)
  })

  const findPrice = (lookupKey: string) =>
    stripePromise("Could not load Stripe price", (client) =>
      client.prices.list({ active: true, lookup_keys: [lookupKey], limit: 1 })
    ).pipe(
      Effect.flatMap((prices) => {
        const price = prices.data[0]
        return price === undefined
          ? Effect.fail(stripeError(`No active Stripe price found for ${lookupKey}`))
          : Effect.succeed(price)
      })
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
        return yield* Effect.fail(stripeError("TaxMaxi account not found"))
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

  const catalogLookupKeys = [
    TAXMAXI_ANNUAL_LOOKUP_KEY,
    TAXMAXI_TOP_UP_LOOKUP_KEY,
    TAXMAXI_PROFESSIONAL_ANNUAL_LOOKUP_KEY,
    TAXMAXI_PROFESSIONAL_MATTER_LOOKUP_KEY,
    TAXMAXI_PROFESSIONAL_TOP_UP_LOOKUP_KEY,
    TAXMAXI_ENTERPRISE_PILOT_LOOKUP_KEY,
  ] as const

  const catalog: StripeBillingServiceShape["catalog"] = stripePromise(
    "Could not load Stripe prices",
    (client) => client.prices.list({ active: true, lookup_keys: [...catalogLookupKeys], limit: 10 })
  ).pipe(
    Effect.map((prices) =>
      prices.data.map(
        (price): BillingCatalogPrice => ({
          lookupKey: price.lookup_key ?? "",
          amount: price.unit_amount ?? 0,
          currency: price.currency,
          taxBehavior: price.tax_behavior ?? "unspecified",
          recurringInterval: price.recurring?.interval === "year" ? "year" : null,
        })
      )
    )
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
      const account = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isSome(account) && isExistingSubscription(account.value.subscriptionStatus)) {
        return yield* Effect.fail(stripeError("This account already has a subscription"))
      }

      const [customer, price] = yield* Effect.all(
        [getOrCreateCustomer(userId), findPrice(TAXMAXI_ANNUAL_LOOKUP_KEY)],
        { concurrency: "unbounded" }
      )
      const subscriptions = yield* stripePromise(
        "Could not verify existing Stripe subscriptions",
        (client) => client.subscriptions.list({ customer, status: "all", limit: 100 })
      )
      if (subscriptions.data.some((subscription) => isExistingSubscription(subscription.status))) {
        return yield* Effect.fail(stripeError("This account already has a subscription"))
      }
      const checkoutReservation = yield* billingRepository
        .reserveAnnualCheckout(userId)
        .pipe(Effect.mapError(() => stripeError("Could not reserve annual Checkout")))
      const session = yield* stripePromise("Could not create annual Checkout", (client) =>
        client.checkout.sessions.create(
          {
            mode: "subscription",
            customer,
            line_items: [{ price: price.id, quantity: 1 }],
            billing_address_collection: "required",
            tax_id_collection: { enabled: true },
            customer_update: { address: "auto", name: "auto" },
            success_url: `${frontendUrl}/app/billing?checkout=success`,
            cancel_url: `${frontendUrl}/#pricing`,
            expires_at: Math.floor(checkoutReservation.expiresAt.getTime() / 1_000),
            integration_identifier: INTEGRATION_IDENTIFIER,
            metadata: { purchase_kind: "annual", taxmaxi_user_id: userId },
            subscription_data: {
              metadata: {
                taxmaxi_user_id: userId,
                plan_lookup_key: TAXMAXI_ANNUAL_LOOKUP_KEY,
                plan_product_id: productId(price.product),
              },
            },
          },
          {
            idempotencyKey: `taxmaxi-annual-checkout-${userId}-${customer}-${checkoutReservation.generation}`,
          }
        )
      )
      if (session.url === null) {
        return yield* Effect.fail(stripeError("Stripe did not return a Checkout URL"))
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
      })
      const price = yield* findPrice(TAXMAXI_TOP_UP_LOOKUP_KEY)
      const session = yield* stripePromise("Could not create top-up Checkout", (client) =>
        client.checkout.sessions.create({
          mode: "payment",
          customer: stripeCustomerId,
          line_items: [{ price: price.id, quantity: 1 }],
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto", name: "auto" },
          success_url: `${frontendUrl}/app/billing?top_up=success`,
          cancel_url: `${frontendUrl}/app/billing`,
          integration_identifier: INTEGRATION_IDENTIFIER,
          metadata: { purchase_kind: "top_up", taxmaxi_user_id: userId },
          payment_intent_data: {
            metadata: { purchase_kind: "top_up", taxmaxi_user_id: userId },
          },
        })
      )
      if (session.url === null) {
        return yield* Effect.fail(stripeError("Stripe did not return a Checkout URL"))
      }
      return session.url
    })

  const createPortalSession: StripeBillingServiceShape["createPortalSession"] = (userId) =>
    Effect.gen(function* () {
      const account = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isNone(account) || account.value.stripeCustomerId === null) {
        return yield* Effect.fail(stripeError("No Stripe customer exists for this account"))
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
  }: {
    readonly subscription: Stripe.Subscription
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
  }) =>
    Effect.gen(function* () {
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
        })
        .pipe(Effect.mapError(() => stripeError("Could not save subscription state")))
    })

  const syncDeletedSubscription = ({
    subscription,
    eventCreatedAt,
    syncGeneration,
  }: {
    readonly subscription: Stripe.Subscription
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
  }) =>
    Effect.gen(function* () {
      const customer = customerId(subscription.customer)
      if (customer === null) return
      const account = yield* billingRepository
        .findByStripeCustomerId(customer)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isNone(account) || account.value.stripeSubscriptionId !== subscription.id) {
        return
      }
      yield* syncSubscription({ subscription, eventCreatedAt, syncGeneration })
    })

  const paidInvoicePaymentReference = (invoiceId: string) =>
    stripePromise("Could not load paid invoice payment", (client) =>
      client.invoicePayments.list({ invoice: invoiceId, status: "paid", limit: 10 })
    ).pipe(
      Effect.map((payments) => {
        const payment = payments.data.find(
          (candidate) => candidate.payment.type === "payment_intent"
        )
        return paymentIntentId(payment?.payment.payment_intent ?? null)
      })
    )

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
      const expectedAnnualProductId = details.metadata?.plan_product_id
      if (expectedAnnualProductId === undefined) return
      const id = subscriptionId(details.subscription)
      const customer = customerId(invoice.customer)
      if (id === null || customer === null) return

      const candidateLines = invoice.lines.data.filter((line) => {
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
            productId: productId(price.product),
            currentProductId: expectedAnnualProductId,
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
      const paymentReference = yield* paidInvoicePaymentReference(invoice.id)

      yield* billingRepository
        .grantCredits({
          userId,
          amount: ANNUAL_CREDITS,
          kind: "annual_grant",
          reference: `stripe:annual:${id}:${annualLine.period.start}:${annualLine.period.end}`,
          paymentReference,
          expiresAt: new Date(annualLine.period.end * 1_000),
        })
        .pipe(Effect.mapError(() => stripeError("Could not grant annual credits")))
      if (paymentReference !== null) {
        yield* billingRepository
          .reconcilePaymentCreditReversals(paymentReference)
          .pipe(Effect.mapError(() => stripeError("Could not reconcile annual credit reversals")))
      }
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
    reference,
    eventCreatedAt,
    monotonic,
    terminal,
  }: {
    readonly charge: Stripe.Charge
    readonly reversedAmount: number
    readonly reversalGroup: string
    readonly reference: string
    readonly eventCreatedAt: Date
    readonly monotonic: boolean
    readonly terminal: boolean
  }) =>
    Effect.gen(function* () {
      const paymentReference = paymentIntentId(charge.payment_intent)
      if (paymentReference === null) return
      yield* billingRepository
        .setPaymentCreditReversal({
          paymentReference,
          reversalGroup,
          reversedAmount,
          paymentAmount: charge.amount,
          reference,
          eventCreatedAt,
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
      const reversedAmount = currentDispute.status === "won" ? 0 : currentDispute.amount
      yield* applyChargeReversal({
        charge,
        reversedAmount,
        reversalGroup: `stripe:dispute:${dispute.id}`,
        reference: `stripe:dispute:${dispute.id}:${eventId}`,
        eventCreatedAt,
        monotonic: false,
        terminal: currentDispute.status === "won" || currentDispute.status === "lost",
      })
    })

  const processWebhook: StripeBillingServiceShape["processWebhook"] = (input) =>
    Effect.gen(function* () {
      const secret = Option.getOrNull(webhookSecret)
      if (secret === null) {
        return yield* Effect.fail(stripeError("Stripe webhook is not configured"))
      }
      const event = yield* stripePromise("Invalid Stripe webhook signature", (client) =>
        client.webhooks.constructEventAsync(input.payload, input.signature, secret)
      )
      const processed = yield* billingRepository
        .hasProcessedEvent(event.id)
        .pipe(Effect.mapError(() => stripeError("Could not check Stripe event")))
      if (processed) return

      const eventCreatedAt = new Date(event.created * 1_000)
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.paused":
        case "customer.subscription.resumed": {
          const customer = customerId(event.data.object.customer)
          if (customer === null) break
          const syncGeneration = yield* billingRepository
            .reserveSubscriptionSync(customer)
            .pipe(Effect.mapError(() => stripeError("Could not reserve subscription sync")))
          const subscription = yield* stripePromise(
            "Could not load current subscription state",
            (client) => client.subscriptions.retrieve(event.data.object.id)
          )
          yield* syncSubscription({ subscription, eventCreatedAt, syncGeneration })
          const confirmedSubscription = yield* stripePromise(
            "Could not confirm current subscription state",
            (client) => client.subscriptions.retrieve(event.data.object.id)
          )
          yield* syncSubscription({
            subscription: confirmedSubscription,
            eventCreatedAt,
            syncGeneration,
          })
          break
        }
        case "customer.subscription.deleted": {
          const customer = customerId(event.data.object.customer)
          if (customer === null) break
          const syncGeneration = yield* billingRepository
            .reserveSubscriptionSync(customer)
            .pipe(Effect.mapError(() => stripeError("Could not reserve subscription sync")))
          yield* syncDeletedSubscription({
            subscription: event.data.object,
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
          yield* applyChargeReversal({
            charge: event.data.object,
            reversedAmount: event.data.object.amount_refunded,
            reversalGroup: `stripe:refund:${event.data.object.id}`,
            reference: `stripe:refund:${event.data.object.id}:${event.id}`,
            eventCreatedAt,
            monotonic: true,
            terminal: false,
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
