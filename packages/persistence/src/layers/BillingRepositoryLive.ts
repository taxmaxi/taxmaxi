/**
 * BillingRepositoryLive - PostgreSQL billing and transaction-credit persistence.
 *
 * @module BillingRepositoryLive
 */

import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AuthUserId } from "@my/core/authentication"

import { wrapSqlError } from "../errors/RepositoryError.ts"
import {
  billingAccounts,
  billingPaymentReversals,
  creditLedger,
  stripeEvents,
} from "../schema/BillingTables.ts"
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
    stripeCustomerGeneration: billingAccounts.stripeCustomerGeneration,
    stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
    subscriptionStatus: billingAccounts.subscriptionStatus,
    currentPeriodEnd: billingAccounts.currentPeriodEnd,
    cancelAtPeriodEnd: billingAccounts.cancelAtPeriodEnd,
    lastSubscriptionEventCreatedAt: billingAccounts.lastSubscriptionEventCreatedAt,
  } as const

  type SelectedBillingAccount = Pick<
    typeof billingAccounts.$inferSelect,
    | "userId"
    | "stripeCustomerId"
    | "stripeCustomerGeneration"
    | "stripeSubscriptionId"
    | "subscriptionStatus"
    | "currentPeriodEnd"
    | "cancelAtPeriodEnd"
    | "lastSubscriptionEventCreatedAt"
  >

  const toBillingAccount = (row: SelectedBillingAccount): BillingAccount => ({
    userId: AuthUserId.make(row.userId),
    stripeCustomerId: row.stripeCustomerId,
    stripeCustomerGeneration: row.stripeCustomerGeneration,
    stripeSubscriptionId: row.stripeSubscriptionId,
    subscriptionStatus: row.subscriptionStatus,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    lastSubscriptionEventCreatedAt: row.lastSubscriptionEventCreatedAt,
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
    Effect.gen(function* () {
      const isTerminal = input.status === "canceled" || input.status === "incomplete_expired"
      const updated = yield* db
        .update(billingAccounts)
        .set({
          stripeSubscriptionId: input.stripeSubscriptionId,
          subscriptionStatus: input.status,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          lastSubscriptionEventCreatedAt: input.eventCreatedAt,
          ...(isTerminal ? {} : { annualCheckoutExpiresAt: null }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billingAccounts.stripeCustomerId, input.stripeCustomerId),
            eq(billingAccounts.subscriptionSyncGeneration, input.syncGeneration),
            or(
              isNull(billingAccounts.lastSubscriptionEventCreatedAt),
              lte(billingAccounts.lastSubscriptionEventCreatedAt, input.eventCreatedAt)
            )
          )
        )
        .returning({ userId: billingAccounts.userId })

      return updated.length === 1
    }).pipe(wrapSqlError("billing.saveSubscription"))

  const reserveSubscriptionSync: BillingRepositoryService["reserveSubscriptionSync"] = (
    stripeCustomerId
  ) =>
    Effect.gen(function* () {
      const [account] = yield* db
        .update(billingAccounts)
        .set({
          subscriptionSyncGeneration: sql`${billingAccounts.subscriptionSyncGeneration} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(billingAccounts.stripeCustomerId, stripeCustomerId))
        .returning({ generation: billingAccounts.subscriptionSyncGeneration })

      return account?.generation ?? 0
    }).pipe(wrapSqlError("billing.reserveSubscriptionSync"))

  const clearCustomer: BillingRepositoryService["clearCustomer"] = (stripeCustomerId) =>
    db
      .update(billingAccounts)
      .set({
        stripeCustomerId: null,
        stripeCustomerGeneration: sql`${billingAccounts.stripeCustomerGeneration} + 1`,
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        lastSubscriptionEventCreatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.stripeCustomerId, stripeCustomerId))
      .pipe(Effect.asVoid, wrapSqlError("billing.clearCustomer"))

  const reserveAnnualCheckout: BillingRepositoryService["reserveAnnualCheckout"] = (userId) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [account] = yield* tx
            .select({
              generation: billingAccounts.annualCheckoutGeneration,
              expiresAt: billingAccounts.annualCheckoutExpiresAt,
            })
            .from(billingAccounts)
            .where(eq(billingAccounts.userId, userId))
            .for("update")
          if (account === undefined) {
            return yield* Effect.dieMessage("Billing account missing after customer creation")
          }

          const now = new Date()
          if (account.expiresAt !== null && account.expiresAt > now) {
            return { generation: account.generation, expiresAt: account.expiresAt }
          }

          const generation = account.generation + 1
          const expiresAt = new Date(now.getTime() + 23 * 60 * 60 * 1_000)
          yield* tx
            .update(billingAccounts)
            .set({
              annualCheckoutGeneration: generation,
              annualCheckoutExpiresAt: expiresAt,
              updatedAt: now,
            })
            .where(eq(billingAccounts.userId, userId))

          return { generation, expiresAt }
        })
      )
      .pipe(wrapSqlError("billing.reserveAnnualCheckout"))

  const grantCredits: BillingRepositoryService["grantCredits"] = (input) =>
    Effect.gen(function* () {
      const inserted = yield* db
        .insert(creditLedger)
        .values({
          userId: input.userId,
          delta: input.amount,
          kind: input.kind,
          reference: input.reference,
          paymentReference: input.paymentReference,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: creditLedger.reference,
          set: {
            paymentReference: sql`coalesce(${creditLedger.paymentReference}, excluded.payment_reference)`,
          },
        })
        .returning({ id: creditLedger.id })

      return inserted.length === 1
    }).pipe(wrapSqlError("billing.grantCredits"))

  const reconcilePaymentCreditReversals: BillingRepositoryService["reconcilePaymentCreditReversals"] =
    (paymentReference) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [grant] = yield* tx
              .select({
                userId: creditLedger.userId,
                amount: creditLedger.delta,
                expiresAt: creditLedger.expiresAt,
              })
              .from(creditLedger)
              .where(
                and(
                  eq(creditLedger.paymentReference, paymentReference),
                  or(eq(creditLedger.kind, "annual_grant"), eq(creditLedger.kind, "top_up"))
                )
              )
              .limit(1)

            if (grant === undefined) return false

            yield* tx
              .select({ userId: billingAccounts.userId })
              .from(billingAccounts)
              .where(eq(billingAccounts.userId, grant.userId))
              .for("update")

            const reversals = yield* tx
              .select({
                reversalGroup: billingPaymentReversals.reversalGroup,
                reversedAmount: billingPaymentReversals.reversedAmount,
                paymentAmount: billingPaymentReversals.paymentAmount,
              })
              .from(billingPaymentReversals)
              .where(eq(billingPaymentReversals.paymentReference, paymentReference))
            const targetReversal = Math.min(
              grant.amount,
              reversals.reduce(
                (total, reversal) =>
                  total +
                  Math.max(
                    reversal.paymentAmount <= 0
                      ? grant.amount
                      : Math.ceil(
                          (grant.amount * reversal.reversedAmount) / reversal.paymentAmount
                        ),
                    0
                  ),
                0
              )
            )
            const [baseBucket] = yield* tx
              .select({ total: sql<number>`coalesce(sum(${creditLedger.delta}), 0)` })
              .from(creditLedger)
              .where(
                and(
                  eq(creditLedger.userId, grant.userId),
                  grant.expiresAt === null
                    ? isNull(creditLedger.expiresAt)
                    : eq(creditLedger.expiresAt, grant.expiresAt),
                  sql`${creditLedger.kind} <> 'manual_adjustment'`
                )
              )
            const unspentExpiringCredits =
              grant.expiresAt === null
                ? 0
                : Math.min(Math.max(Number(baseBucket?.total ?? 0), 0), grant.amount)
            const permanentDebt =
              grant.expiresAt === null
                ? targetReversal
                : Math.max(targetReversal - unspentExpiringCredits, 0)
            const expiringReversal = targetReversal - permanentDebt

            const adjustments = yield* tx
              .select({ delta: creditLedger.delta, expiresAt: creditLedger.expiresAt })
              .from(creditLedger)
              .where(
                and(
                  eq(creditLedger.paymentReference, paymentReference),
                  eq(creditLedger.kind, "manual_adjustment")
                )
              )
            const currentPermanentAdjustment = adjustments
              .filter((adjustment) => adjustment.expiresAt === null)
              .reduce((total, adjustment) => total + adjustment.delta, 0)
            const currentExpiringAdjustment = adjustments
              .filter((adjustment) => adjustment.expiresAt !== null)
              .reduce((total, adjustment) => total + adjustment.delta, 0)

            const version = reversals
              .map((reversal) => `${reversal.reversalGroup}:${reversal.reversedAmount}`)
              .sort()
              .join("|")
            const desiredAdjustments = [
              {
                delta: -permanentDebt - currentPermanentAdjustment,
                expiresAt: null,
                suffix: "permanent",
              },
              {
                delta: -expiringReversal - currentExpiringAdjustment,
                expiresAt: grant.expiresAt,
                suffix: "expiring",
              },
            ].filter((adjustment) => adjustment.delta !== 0)
            if (desiredAdjustments.length === 0) return false

            const inserted = yield* Effect.forEach(desiredAdjustments, (adjustment) =>
              tx
                .insert(creditLedger)
                .values({
                  userId: grant.userId,
                  delta: adjustment.delta,
                  kind: "manual_adjustment",
                  reference: `stripe:payment-reversal:${paymentReference}:${version}:${adjustment.suffix}`,
                  paymentReference,
                  expiresAt: adjustment.expiresAt,
                })
                .onConflictDoNothing({ target: creditLedger.reference })
                .returning({ id: creditLedger.id })
            )

            return inserted.some((rows) => rows.length === 1)
          })
        )
        .pipe(wrapSqlError("billing.reconcilePaymentCreditReversals"))

  const setPaymentCreditReversal: BillingRepositoryService["setPaymentCreditReversal"] = (input) =>
    db
      .insert(billingPaymentReversals)
      .values({
        paymentReference: input.paymentReference,
        reversalGroup: input.reversalGroup,
        reversedAmount: input.reversedAmount,
        paymentAmount: input.paymentAmount,
        eventReference: input.reference,
        eventCreatedAt: input.eventCreatedAt,
        terminal: input.terminal,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [billingPaymentReversals.paymentReference, billingPaymentReversals.reversalGroup],
        set: {
          reversedAmount: input.monotonic
            ? sql`greatest(${billingPaymentReversals.reversedAmount}, excluded.reversed_amount)`
            : input.reversedAmount,
          paymentAmount: input.paymentAmount,
          eventReference: input.reference,
          eventCreatedAt: input.eventCreatedAt,
          terminal: input.terminal,
          updatedAt: new Date(),
        },
        setWhere: sql`${billingPaymentReversals.terminal} = false and ${billingPaymentReversals.eventCreatedAt} <= ${input.eventCreatedAt}`,
      })
      .pipe(
        Effect.andThen(reconcilePaymentCreditReversals(input.paymentReference)),
        wrapSqlError("billing.setPaymentCreditReversal")
      )

  const consumeTransactionCredit: BillingRepositoryService["consumeTransactionCredit"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [account] = yield* tx
            .select({ userId: billingAccounts.userId })
            .from(billingAccounts)
            .where(eq(billingAccounts.userId, input.userId))
            .for("update")
          if (account === undefined) return "exhausted" as const

          const reference = `transaction:${input.transactionId}`
          const [existing] = yield* tx
            .select({ id: creditLedger.id })
            .from(creditLedger)
            .where(eq(creditLedger.reference, reference))
            .limit(1)
          if (existing !== undefined) return "duplicate" as const

          const now = new Date()
          const rows = yield* tx
            .select({ delta: creditLedger.delta, expiresAt: creditLedger.expiresAt })
            .from(creditLedger)
            .where(
              and(
                eq(creditLedger.userId, input.userId),
                or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, now))
              )
            )
            .orderBy(asc(creditLedger.expiresAt))

          const buckets = new Map<string, { balance: number; expiresAt: Date | null }>()
          for (const row of rows) {
            const key = row.expiresAt?.toISOString() ?? "never"
            const bucket = buckets.get(key) ?? { balance: 0, expiresAt: row.expiresAt }
            buckets.set(key, { ...bucket, balance: bucket.balance + row.delta })
          }
          const totalBalance = [...buckets.values()].reduce(
            (total, candidate) => total + candidate.balance,
            0
          )
          if (totalBalance <= 0) return "exhausted" as const

          const bucket = [...buckets.values()].find((candidate) => candidate.balance > 0)
          if (bucket === undefined) return "exhausted" as const

          yield* tx.insert(creditLedger).values({
            userId: input.userId,
            delta: -1,
            kind: "transaction_usage",
            reference,
            paymentReference: null,
            expiresAt: bucket.expiresAt,
          })
          return "consumed" as const
        })
      )
      .pipe(wrapSqlError("billing.consumeTransactionCredit"))

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
    reserveSubscriptionSync,
    clearCustomer,
    reserveAnnualCheckout,
    grantCredits,
    reconcilePaymentCreditReversals,
    setPaymentCreditReversal,
    consumeTransactionCredit,
    availableCredits,
    hasProcessedEvent,
    markEventProcessed,
  } satisfies BillingRepositoryService
})

/** Live PostgreSQL implementation of BillingRepository. */
export const BillingRepositoryLive = Layer.effect(BillingRepository, make)
