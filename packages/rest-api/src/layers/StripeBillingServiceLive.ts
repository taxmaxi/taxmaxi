/**
 * StripeBillingServiceLive - Stripe Checkout, Portal, and signed webhook integration.
 *
 * @module StripeBillingServiceLive
 */

import type { AuthUserId } from "@my/core/authentication"
import { BillingRepository, UserRepository } from "@my/persistence/services"
import type { BillingSubscriptionStatus } from "@my/persistence/services"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
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
const INTEGRATION_IDENTIFIER = "taxmaxi_direct"

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

const subscriptionPeriodEnd = (subscription: Stripe.Subscription): Date | null => {
  const end = subscription.items.data.reduce(
    (latest, item) => Math.max(latest, item.current_period_end),
    0
  )
  return end === 0 ? null : new Date(end * 1_000)
}

const isActiveSubscription = (status: string | null): boolean =>
  status === "active" || status === "trialing"

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
  const secretKey = yield* Config.redacted("STRIPE_SECRET_KEY")
  const webhookSecret = yield* Config.redacted("STRIPE_WEBHOOK_SECRET")
  const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
    Config.withDefault("http://localhost:3000"),
    Config.map((url) => url.replace(/\/$/, ""))
  )
  const billingRepository = yield* BillingRepository
  const userRepository = yield* UserRepository
  const stripe = new Stripe(Redacted.value(secretKey), {
    apiVersion: "2026-07-29.dahlia",
    typescript: true,
  })

  const stripePromise = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        stripeError(
          cause instanceof Error
            ? `${operation}: ${cause.message}`
            : `${operation}: Stripe request failed`
        ),
    })

  const findPrice = (lookupKey: string) =>
    stripePromise("Could not load Stripe price", () =>
      stripe.prices.list({ active: true, lookup_keys: [lookupKey], limit: 1 })
    ).pipe(
      Effect.flatMap((prices) => {
        const price = prices.data[0]
        return price === undefined
          ? Effect.fail(stripeError(`No active Stripe price found for ${lookupKey}`))
          : Effect.succeed(price)
      })
    )

  const getOrCreateCustomer = (userId: AuthUserId) =>
    Effect.gen(function* () {
      const existing = yield* billingRepository
        .findByUserId(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isSome(existing)) return existing.value.stripeCustomerId

      const maybeUser = yield* userRepository
        .findById(userId)
        .pipe(Effect.mapError(() => stripeError("Could not load account details")))
      if (Option.isNone(maybeUser)) {
        return yield* Effect.fail(stripeError("TaxMaxi account not found"))
      }

      const customer = yield* stripePromise("Could not create Stripe customer", () =>
        stripe.customers.create(
          {
            email: maybeUser.value.email,
            name: maybeUser.value.displayName,
            metadata: { taxmaxi_user_id: userId },
          },
          { idempotencyKey: `taxmaxi-customer-${userId}` }
        )
      )
      yield* billingRepository
        .saveCustomer({ userId, stripeCustomerId: customer.id })
        .pipe(Effect.mapError(() => stripeError("Could not save billing account")))
      return customer.id
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
    () => stripe.prices.list({ active: true, lookup_keys: [...catalogLookupKeys], limit: 10 })
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
      if (Option.isSome(account) && isActiveSubscription(account.value.subscriptionStatus)) {
        return yield* Effect.fail(stripeError("This account already has an active subscription"))
      }

      const [customer, price] = yield* Effect.all(
        [getOrCreateCustomer(userId), findPrice(TAXMAXI_ANNUAL_LOOKUP_KEY)],
        { concurrency: "unbounded" }
      )
      const session = yield* stripePromise("Could not create annual Checkout", () =>
        stripe.checkout.sessions.create({
          mode: "subscription",
          customer,
          line_items: [{ price: price.id, quantity: 1 }],
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto", name: "auto" },
          success_url: `${frontendUrl}/app?checkout=success`,
          cancel_url: `${frontendUrl}/#pricing`,
          integration_identifier: INTEGRATION_IDENTIFIER,
          metadata: { purchase_kind: "annual", taxmaxi_user_id: userId },
          subscription_data: {
            metadata: {
              taxmaxi_user_id: userId,
              plan_lookup_key: TAXMAXI_ANNUAL_LOOKUP_KEY,
            },
          },
        })
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
      if (Option.isNone(account) || !isActiveSubscription(account.value.subscriptionStatus)) {
        return yield* Effect.fail(stripeError("An active annual subscription is required"))
      }

      const price = yield* findPrice(TAXMAXI_TOP_UP_LOOKUP_KEY)
      const session = yield* stripePromise("Could not create top-up Checkout", () =>
        stripe.checkout.sessions.create({
          mode: "payment",
          customer: account.value.stripeCustomerId,
          line_items: [{ price: price.id, quantity: 1 }],
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto", name: "auto" },
          success_url: `${frontendUrl}/app?top_up=success`,
          cancel_url: `${frontendUrl}/app`,
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
      if (Option.isNone(account)) {
        return yield* Effect.fail(stripeError("No Stripe customer exists for this account"))
      }
      const session = yield* stripePromise("Could not create Customer Portal session", () =>
        stripe.billingPortal.sessions.create({
          customer: account.value.stripeCustomerId,
          return_url: `${frontendUrl}/app`,
        })
      )
      return session.url
    })

  const syncSubscription = (subscription: Stripe.Subscription) =>
    Effect.gen(function* () {
      const customer = customerId(subscription.customer)
      if (customer === null) return
      const status = yield* toBillingSubscriptionStatus(subscription.status)
      yield* billingRepository
        .saveSubscription({
          stripeCustomerId: customer,
          stripeSubscriptionId: subscription.id,
          status,
          currentPeriodEnd: subscriptionPeriodEnd(subscription),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })
        .pipe(Effect.mapError(() => stripeError("Could not save subscription state")))
    })

  const grantAnnualCredits = (invoice: Stripe.Invoice) =>
    Effect.gen(function* () {
      const details = invoice.parent?.subscription_details
      if (details === null || details === undefined) return
      if (details.metadata?.plan_lookup_key !== TAXMAXI_ANNUAL_LOOKUP_KEY) return
      const id = subscriptionId(details.subscription)
      const customer = customerId(invoice.customer)
      if (id === null || customer === null) return

      const account = yield* billingRepository
        .findByStripeCustomerId(customer)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isNone(account)) return

      yield* billingRepository
        .grantCredits({
          userId: account.value.userId,
          amount: ANNUAL_CREDITS,
          kind: "annual_grant",
          reference: `stripe:invoice:${invoice.id}`,
          expiresAt: new Date(invoice.period_end * 1_000),
        })
        .pipe(Effect.mapError(() => stripeError("Could not grant annual credits")))
    })

  const grantTopUpCredits = (session: Stripe.Checkout.Session) =>
    Effect.gen(function* () {
      if (session.metadata?.purchase_kind !== "top_up" || session.payment_status !== "paid") return
      const customer = customerId(session.customer)
      if (customer === null) return
      const account = yield* billingRepository
        .findByStripeCustomerId(customer)
        .pipe(Effect.mapError(() => stripeError("Could not load billing account")))
      if (Option.isNone(account) || !isActiveSubscription(account.value.subscriptionStatus)) return

      yield* billingRepository
        .grantCredits({
          userId: account.value.userId,
          amount: TOP_UP_CREDITS,
          kind: "top_up",
          reference: `stripe:checkout:${session.id}`,
          expiresAt: null,
        })
        .pipe(Effect.mapError(() => stripeError("Could not grant top-up credits")))
    })

  const processWebhook: StripeBillingServiceShape["processWebhook"] = (input) =>
    Effect.gen(function* () {
      const event = yield* stripePromise("Invalid Stripe webhook signature", () =>
        stripe.webhooks.constructEventAsync(
          input.payload,
          input.signature,
          Redacted.value(webhookSecret)
        )
      )
      const processed = yield* billingRepository
        .hasProcessedEvent(event.id)
        .pipe(Effect.mapError(() => stripeError("Could not check Stripe event")))
      if (processed) return

      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          yield* syncSubscription(event.data.object)
          break
        case "invoice.paid":
          yield* grantAnnualCredits(event.data.object)
          break
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          yield* grantTopUpCredits(event.data.object)
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
