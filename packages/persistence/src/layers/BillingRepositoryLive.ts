/**
 * BillingRepositoryLive - PostgreSQL billing and transaction-credit persistence.
 *
 * @module BillingRepositoryLive
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AuthUserId } from "@my/core/authentication"

import { wrapSqlError } from "../errors/RepositoryError.ts"
import { billingAccounts, creditLedger, stripeEvents } from "../schema/BillingTables.ts"
import {
  BillingRepository,
  type BillingAccount,
  type BillingRepositoryService,
} from "../services/BillingRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectedBillingFields = {
    userId: billingAccounts.userId,
    stripeCustomerId: billingAccounts.stripeCustomerId,
    stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
    subscriptionStatus: billingAccounts.subscriptionStatus,
    currentPeriodEnd: billingAccounts.currentPeriodEnd,
    cancelAtPeriodEnd: billingAccounts.cancelAtPeriodEnd,
  } as const

  type SelectedBillingAccount = Pick<
    typeof billingAccounts.$inferSelect,
    | "userId"
    | "stripeCustomerId"
    | "stripeSubscriptionId"
    | "subscriptionStatus"
    | "currentPeriodEnd"
    | "cancelAtPeriodEnd"
  >

  const toBillingAccount = (row: SelectedBillingAccount): BillingAccount => ({
    userId: AuthUserId.make(row.userId),
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    subscriptionStatus: row.subscriptionStatus,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  })

  const findByUserId: BillingRepositoryService["findByUserId"] = (userId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectedBillingFields)
        .from(billingAccounts)
        .where(eq(billingAccounts.userId, userId))

      return row === undefined ? Option.none() : Option.some(toBillingAccount(row))
    }).pipe(wrapSqlError("billing.findByUserId"))

  const findByStripeCustomerId: BillingRepositoryService["findByStripeCustomerId"] = (
    stripeCustomerId
  ) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectedBillingFields)
        .from(billingAccounts)
        .where(eq(billingAccounts.stripeCustomerId, stripeCustomerId))

      return row === undefined ? Option.none() : Option.some(toBillingAccount(row))
    }).pipe(wrapSqlError("billing.findByStripeCustomerId"))

  const saveCustomer: BillingRepositoryService["saveCustomer"] = (input) =>
    db
      .insert(billingAccounts)
      .values({ userId: input.userId, stripeCustomerId: input.stripeCustomerId })
      .onConflictDoUpdate({
        target: billingAccounts.userId,
        set: { stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() },
      })
      .pipe(
        Effect.map(() => undefined),
        wrapSqlError("billing.saveCustomer")
      )

  const saveSubscription: BillingRepositoryService["saveSubscription"] = (input) =>
    db
      .update(billingAccounts)
      .set({
        stripeSubscriptionId: input.stripeSubscriptionId,
        subscriptionStatus: input.status,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, input.stripeCustomerId))
      .pipe(
        Effect.map(() => undefined),
        wrapSqlError("billing.saveSubscription")
      )

  const grantCredits: BillingRepositoryService["grantCredits"] = (input) =>
    Effect.gen(function* () {
      const inserted = yield* db
        .insert(creditLedger)
        .values({
          userId: input.userId,
          delta: input.amount,
          kind: input.kind,
          reference: input.reference,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({ target: creditLedger.reference })
        .returning({ id: creditLedger.id })

      return inserted.length === 1
    }).pipe(wrapSqlError("billing.grantCredits"))

  const availableCredits: BillingRepositoryService["availableCredits"] = (userId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)` })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.userId, userId),
            or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, new Date()))
          )
        )

      return Number(row?.balance ?? 0)
    }).pipe(wrapSqlError("billing.availableCredits"))

  const hasProcessedEvent: BillingRepositoryService["hasProcessedEvent"] = (eventId) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({ id: stripeEvents.id })
        .from(stripeEvents)
        .where(eq(stripeEvents.id, eventId))
        .limit(1)
      return rows.length === 1
    }).pipe(wrapSqlError("billing.hasProcessedEvent"))

  const markEventProcessed: BillingRepositoryService["markEventProcessed"] = (input) =>
    db
      .insert(stripeEvents)
      .values({ id: input.eventId, type: input.eventType })
      .onConflictDoNothing({ target: stripeEvents.id })
      .pipe(
        Effect.map(() => undefined),
        wrapSqlError("billing.markEventProcessed")
      )

  return {
    findByUserId,
    findByStripeCustomerId,
    saveCustomer,
    saveSubscription,
    grantCredits,
    availableCredits,
    hasProcessedEvent,
    markEventProcessed,
  } satisfies BillingRepositoryService
})

/** Live PostgreSQL implementation of BillingRepository. */
export const BillingRepositoryLive = Layer.effect(BillingRepository, make)
