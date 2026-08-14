/**
 * BillingRepository - Stripe customer, subscription, and transaction-credit persistence.
 *
 * @module BillingRepository
 */

import type { AuthUserId } from "@my/core/authentication"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

import type { PersistenceError } from "../errors/RepositoryError.ts"

export type BillingSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

export type CreditEntryKind = "annual_grant" | "top_up" | "transaction_usage" | "manual_adjustment"

/** Persisted Stripe billing state used for ordering webhooks and Checkout reservations. */
export interface BillingAccount {
  /** TaxMaxi user that owns the billing account. */
  readonly userId: AuthUserId
  /** Current Stripe customer, or `null` before creation or after Stripe deletes it. */
  readonly stripeCustomerId: string | null
  /** Increases when a deleted Stripe customer is replaced so retries use a new idempotency key. */
  readonly stripeCustomerGeneration: number
  /** Current TaxMaxi annual subscription tracked from Stripe webhook reconciliation. */
  readonly stripeSubscriptionId: string | null
  /** Last reconciled Stripe status for the tracked annual subscription. */
  readonly subscriptionStatus: BillingSubscriptionStatus | null
  /** Latest item period end for the tracked subscription. */
  readonly currentPeriodEnd: Date | null
  /** Whether Stripe will cancel the tracked subscription at its current period end. */
  readonly cancelAtPeriodEnd: boolean
  /** Latest reserved Stripe event time used to ignore older subscription state and fetches. */
  readonly lastSubscriptionEventCreatedAt: Date | null
}

/** Durable Stripe account, subscription, credit-ledger, and webhook operations. */
export interface BillingRepositoryService {
  readonly findByUserId: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<BillingAccount>, PersistenceError>
  readonly findByStripeCustomerId: (
    stripeCustomerId: string
  ) => Effect.Effect<Option.Option<BillingAccount>, PersistenceError>
  readonly saveCustomer: (input: {
    readonly userId: AuthUserId
    readonly stripeCustomerId: string
  }) => Effect.Effect<void, PersistenceError>
  readonly saveSubscription: (input: {
    readonly stripeCustomerId: string
    readonly stripeSubscriptionId: string
    readonly status: BillingSubscriptionStatus
    readonly currentPeriodEnd: Date | null
    readonly cancelAtPeriodEnd: boolean
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
    readonly annualCheckoutGeneration?: number | null
  }) => Effect.Effect<boolean, PersistenceError>
  readonly clearSubscription: (input: {
    readonly stripeCustomerId: string
    readonly stripeSubscriptionId: string
    readonly eventCreatedAt: Date
    readonly syncGeneration: number
  }) => Effect.Effect<boolean, PersistenceError>
  /** Reserves the newest observed subscription event and rejects older in-flight fetches. */
  readonly reserveSubscriptionSync: (input: {
    readonly stripeCustomerId: string
    readonly eventCreatedAt: Date
  }) => Effect.Effect<number, PersistenceError>
  readonly clearCustomer: (stripeCustomerId: string) => Effect.Effect<void, PersistenceError>
  readonly reserveAnnualCheckout: (input: {
    readonly userId: AuthUserId
    readonly priceId: string
  }) => Effect.Effect<
    { readonly generation: number; readonly expiresAt: Date; readonly priceId: string },
    PersistenceError
  >
  /** Clear a failed Checkout reservation only while its generation is still current. */
  readonly clearAnnualCheckoutReservation: (input: {
    readonly userId: AuthUserId
    readonly generation: number
  }) => Effect.Effect<boolean, PersistenceError>
  /** Grant credits and reconcile any known payment loss before the balance becomes visible. */
  readonly grantCredits: (input: {
    readonly userId: AuthUserId
    readonly amount: number
    readonly kind: Exclude<CreditEntryKind, "transaction_usage">
    readonly reference: string
    readonly paymentReference: string | null
    readonly paymentAmount?: number | null
    readonly stripeInvoiceId?: string | null
    readonly expiresAt: Date | null
  }) => Effect.Effect<boolean, PersistenceError>
  readonly reconcilePaymentCreditReversals: (
    paymentReference: string
  ) => Effect.Effect<boolean, PersistenceError>
  /** Record payment loss and reconcile affected credit balances in the same transaction. */
  readonly setPaymentCreditReversal: (input: {
    readonly paymentReference: string
    readonly reversalGroup: string
    readonly lossReference?: string
    readonly reversedAmount: number
    readonly paymentAmount: number
    readonly reference: string
    readonly eventCreatedAt: Date
    readonly stripeInvoiceId?: string | null
    readonly monotonic: boolean
    readonly terminal: boolean
  }) => Effect.Effect<boolean, PersistenceError>
  readonly consumeTransactionCredit: (input: {
    readonly userId: AuthUserId
    readonly transactionId: string
  }) => Effect.Effect<"consumed" | "duplicate" | "exhausted", PersistenceError>
  readonly availableCredits: (userId: AuthUserId) => Effect.Effect<number, PersistenceError>
  readonly hasProcessedEvent: (eventId: string) => Effect.Effect<boolean, PersistenceError>
  readonly markEventProcessed: (input: {
    readonly eventId: string
    readonly eventType: string
  }) => Effect.Effect<void, PersistenceError>
}

/** Stripe billing persistence used by Checkout and webhook handlers. */
export class BillingRepository extends Context.Tag("BillingRepository")<
  BillingRepository,
  BillingRepositoryService
>() {}
