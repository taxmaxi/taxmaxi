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

export interface BillingAccount {
  readonly userId: AuthUserId
  readonly stripeCustomerId: string
  readonly stripeSubscriptionId: string | null
  readonly subscriptionStatus: BillingSubscriptionStatus | null
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
}

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
  }) => Effect.Effect<void, PersistenceError>
  readonly grantCredits: (input: {
    readonly userId: AuthUserId
    readonly amount: number
    readonly kind: Exclude<CreditEntryKind, "transaction_usage">
    readonly reference: string
    readonly expiresAt: Date | null
  }) => Effect.Effect<boolean, PersistenceError>
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
