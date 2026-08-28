/**
 * BillingRepositoryLive - PostgreSQL billing and transaction-credit persistence.
 *
 * @module BillingRepositoryLive
 */

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
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

const proportionalCredits = ({
  credits,
  numerators,
  denominators,
}: {
  readonly credits: number
  readonly numerators: ReadonlyArray<number>
  readonly denominators: ReadonlyArray<number>
}): BigDecimal.BigDecimal => {
  if (
    credits <= 0 ||
    numerators.some((amount) => amount <= 0) ||
    denominators.some((amount) => amount <= 0)
  ) {
    return BigDecimal.fromNumberUnsafe(0)
  }

  const numerator = numerators.reduce(
    (result, amount) => BigDecimal.multiply(result, BigDecimal.fromNumberUnsafe(amount)),
    BigDecimal.fromNumberUnsafe(credits)
  )
  return denominators.reduce(
    (result, amount) =>
      Option.getOrElse(BigDecimal.divide(result, BigDecimal.fromNumberUnsafe(amount)), () =>
        BigDecimal.fromNumberUnsafe(0)
      ),
    numerator
  )
}

interface PaymentCreditGrant {
  readonly allocationId: string
  readonly amount: number
  readonly paymentAmount: number | null
  readonly paymentReference: string
  readonly stripeInvoiceId: string | null
}

interface PaymentCreditReversal {
  readonly lossReference: string
  readonly paymentAmount: number
  readonly paymentReference: string
  readonly reversedAmount: number
  readonly stripeInvoiceId: string | null
}

const exactReversedCredits = ({
  grant,
  reversals,
}: {
  readonly grant: PaymentCreditGrant
  readonly reversals: ReadonlyArray<PaymentCreditReversal>
}): BigDecimal.BigDecimal => {
  const paymentReversals = reversals.filter(
    (reversal) => reversal.paymentReference === grant.paymentReference
  )
  const reversalLosses = [
    ...paymentReversals.reduce((losses, reversal) => {
      const loss = losses.get(reversal.lossReference) ?? []
      loss.push(reversal)
      losses.set(reversal.lossReference, loss)
      return losses
    }, new Map<string, Array<(typeof paymentReversals)[number]>>()),
  ].map(([, loss]) => loss)
  const exact = BigDecimal.sumAll(
    reversalLosses.map((loss) => {
      const scoped = loss.filter((reversal) => reversal.stripeInvoiceId !== null)
      const scopedAmount = scoped.reduce((amount, reversal) => amount + reversal.reversedAmount, 0)
      const matchingScopedAmount = scoped
        .filter((reversal) => reversal.stripeInvoiceId === grant.stripeInvoiceId)
        .reduce((amount, reversal) => amount + reversal.reversedAmount, 0)
      const paymentWide = loss.find((reversal) => reversal.stripeInvoiceId === null)
      const paymentWideRemainder = Math.max((paymentWide?.reversedAmount ?? 0) - scopedAmount, 0)
      const grantPaymentAmount = grant.paymentAmount ?? paymentWide?.paymentAmount ?? 0
      const unscopedPaymentAmount = Math.max((paymentWide?.paymentAmount ?? 0) - scopedAmount, 0)
      const unscopedGrantAmount = Math.max(grantPaymentAmount - matchingScopedAmount, 0)

      return BigDecimal.sum(
        proportionalCredits({
          credits: grant.amount,
          numerators: [matchingScopedAmount],
          denominators: [grantPaymentAmount],
        }),
        proportionalCredits({
          credits: grant.amount,
          numerators: [unscopedGrantAmount, paymentWideRemainder],
          denominators: [grantPaymentAmount, unscopedPaymentAmount],
        })
      )
    })
  )
  return BigDecimal.min(BigDecimal.fromNumberUnsafe(grant.amount), exact)
}

const allocateRoundedCreditReversals = (
  grants: ReadonlyArray<PaymentCreditGrant & { readonly exact: BigDecimal.BigDecimal }>
): ReadonlyMap<string, number> => {
  const allocations = grants.map((grant) => {
    const base = BigDecimal.toNumberUnsafe(BigDecimal.floor(grant.exact))
    return {
      ...grant,
      base,
      remainder: BigDecimal.subtract(grant.exact, BigDecimal.fromNumberUnsafe(base)),
    }
  })
  const targetTotal = Math.min(
    grants.reduce((total, grant) => total + grant.amount, 0),
    BigDecimal.toNumberUnsafe(BigDecimal.ceil(BigDecimal.sumAll(grants.map(({ exact }) => exact))))
  )
  let remaining = targetTotal - allocations.reduce((total, grant) => total + grant.base, 0)
  const rounded = new Map(allocations.map((grant) => [grant.allocationId, grant.base] as const))
  const candidates = [...allocations]
    .filter(
      (grant) =>
        grant.base < grant.amount &&
        BigDecimal.isGreaterThan(grant.remainder, BigDecimal.fromNumberUnsafe(0))
    )
    .sort(
      (left, right) =>
        BigDecimal.Order(right.remainder, left.remainder) ||
        left.allocationId.localeCompare(right.allocationId)
    )
  for (const candidate of candidates) {
    if (remaining === 0) break
    rounded.set(candidate.allocationId, candidate.base + 1)
    remaining -= 1
  }
  return rounded
}

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
        set: {
          stripeCustomerId: input.stripeCustomerId,
          updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
        },
      })
      .pipe(Effect.asVoid, wrapSqlError("billing.saveCustomer"))

  const saveSubscription: BillingRepositoryService["saveSubscription"] = (input) =>
    Effect.gen(function* () {
      const annualCheckoutGeneration = input.annualCheckoutGeneration ?? null
      const updated = yield* db
        .update(billingAccounts)
        .set({
          stripeSubscriptionId: input.stripeSubscriptionId,
          subscriptionStatus: input.status,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          lastSubscriptionEventCreatedAt: input.eventCreatedAt,
          annualCheckoutExpiresAt:
            annualCheckoutGeneration === null
              ? sql<Date | null>`${billingAccounts.annualCheckoutExpiresAt}`
              : sql<Date | null>`case
                  when ${billingAccounts.annualCheckoutGeneration} = ${annualCheckoutGeneration}
                  then null
                  else ${billingAccounts.annualCheckoutExpiresAt}
                end`,
          annualCheckoutPriceId:
            annualCheckoutGeneration === null
              ? sql<string | null>`${billingAccounts.annualCheckoutPriceId}`
              : sql<string | null>`case
                  when ${billingAccounts.annualCheckoutGeneration} = ${annualCheckoutGeneration}
                  then null
                  else ${billingAccounts.annualCheckoutPriceId}
                end`,
          updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
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

  const reserveSubscriptionSync: BillingRepositoryService["reserveSubscriptionSync"] = (input) =>
    Effect.gen(function* () {
      const [account] = yield* db
        .update(billingAccounts)
        .set({
          subscriptionSyncGeneration: sql`${billingAccounts.subscriptionSyncGeneration} + 1`,
          lastSubscriptionEventCreatedAt: input.eventCreatedAt,
          updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
        })
        .where(
          and(
            eq(billingAccounts.stripeCustomerId, input.stripeCustomerId),
            or(
              isNull(billingAccounts.lastSubscriptionEventCreatedAt),
              lte(billingAccounts.lastSubscriptionEventCreatedAt, input.eventCreatedAt)
            )
          )
        )
        .returning({ generation: billingAccounts.subscriptionSyncGeneration })

      return account?.generation ?? 0
    }).pipe(wrapSqlError("billing.reserveSubscriptionSync"))

  const clearSubscription: BillingRepositoryService["clearSubscription"] = (input) =>
    db
      .update(billingAccounts)
      .set({
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        lastSubscriptionEventCreatedAt: input.eventCreatedAt,
        updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
      })
      .where(
        and(
          eq(billingAccounts.stripeCustomerId, input.stripeCustomerId),
          eq(billingAccounts.stripeSubscriptionId, input.stripeSubscriptionId),
          eq(billingAccounts.subscriptionSyncGeneration, input.syncGeneration),
          or(
            isNull(billingAccounts.lastSubscriptionEventCreatedAt),
            lte(billingAccounts.lastSubscriptionEventCreatedAt, input.eventCreatedAt)
          )
        )
      )
      .returning({ userId: billingAccounts.userId })
      .pipe(
        Effect.map((updated) => updated.length === 1),
        wrapSqlError("billing.clearSubscription")
      )

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
        annualCheckoutExpiresAt: null,
        annualCheckoutPriceId: null,
        updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
      })
      .where(eq(billingAccounts.stripeCustomerId, stripeCustomerId))
      .pipe(Effect.asVoid, wrapSqlError("billing.clearCustomer"))

  const reserveAnnualCheckout: BillingRepositoryService["reserveAnnualCheckout"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [account] = yield* tx
            .select({
              generation: billingAccounts.annualCheckoutGeneration,
              expiresAt: billingAccounts.annualCheckoutExpiresAt,
              priceId: billingAccounts.annualCheckoutPriceId,
            })
            .from(billingAccounts)
            .where(eq(billingAccounts.userId, input.userId))
            .for("update")
          if (account === undefined) {
            return yield* Effect.die("Billing account missing after customer creation")
          }

          const now = yield* DateTime.nowAsDate
          if (account.expiresAt !== null && account.expiresAt > now && account.priceId !== null) {
            return {
              generation: account.generation,
              expiresAt: account.expiresAt,
              priceId: account.priceId,
            }
          }

          const generation = account.generation + 1
          const expiresAt = DateTime.toDateUtc(
            DateTime.addDuration(DateTime.makeUnsafe(now), 23 * 60 * 60 * 1_000)
          )
          yield* tx
            .update(billingAccounts)
            .set({
              annualCheckoutGeneration: generation,
              annualCheckoutExpiresAt: expiresAt,
              annualCheckoutPriceId: input.priceId,
              updatedAt: now,
            })
            .where(eq(billingAccounts.userId, input.userId))

          return { generation, expiresAt, priceId: input.priceId }
        })
      )
      .pipe(wrapSqlError("billing.reserveAnnualCheckout"))

  const clearAnnualCheckoutReservation: BillingRepositoryService["clearAnnualCheckoutReservation"] =
    (input) =>
      db
        .update(billingAccounts)
        .set({
          annualCheckoutExpiresAt: null,
          annualCheckoutPriceId: null,
          updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
        })
        .where(
          and(
            eq(billingAccounts.userId, input.userId),
            eq(billingAccounts.annualCheckoutGeneration, input.generation)
          )
        )
        .returning({ userId: billingAccounts.userId })
        .pipe(
          Effect.map((rows) => rows.length === 1),
          wrapSqlError("billing.clearAnnualCheckoutReservation")
        )

  const lockPaymentReference = ({
    executor,
    paymentReference,
  }: {
    readonly executor: Pick<typeof db, "execute">
    readonly paymentReference: string
  }) =>
    executor
      .execute(sql`select pg_advisory_xact_lock(hashtext(${paymentReference}))`)
      .pipe(Effect.asVoid)

  const grantCredits: BillingRepositoryService["grantCredits"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (input.paymentReference !== null) {
            yield* lockPaymentReference({
              executor: tx,
              paymentReference: input.paymentReference,
            })
          }

          yield* tx
            .select({ userId: billingAccounts.userId })
            .from(billingAccounts)
            .where(eq(billingAccounts.userId, input.userId))
            .for("update")

          const inserted = yield* tx
            .insert(creditLedger)
            .values({
              userId: input.userId,
              delta: input.amount,
              kind: input.kind,
              reference: input.reference,
              paymentReference: input.paymentReference,
              paymentAmount: input.paymentAmount ?? null,
              stripeInvoiceId: input.stripeInvoiceId ?? null,
              expiresAt: input.expiresAt,
            })
            .onConflictDoUpdate({
              target: creditLedger.reference,
              set: {
                paymentReference: sql`coalesce(${creditLedger.paymentReference}, excluded.payment_reference)`,
                paymentAmount: sql`coalesce(${creditLedger.paymentAmount}, excluded.payment_amount)`,
                stripeInvoiceId: sql`coalesce(${creditLedger.stripeInvoiceId}, excluded.stripe_invoice_id)`,
              },
            })
            .returning({ id: creditLedger.id })

          if (input.paymentReference !== null) {
            yield* reconcilePaymentCreditReversalsWith({
              executor: tx,
              paymentReference: input.paymentReference,
            })
          }

          return inserted.length === 1
        })
      )
      .pipe(wrapSqlError("billing.grantCredits"))

  const reconcilePaymentCreditReversalsWith = ({
    executor,
    paymentReference,
  }: {
    readonly executor: Pick<typeof db, "insert" | "select">
    readonly paymentReference: string
  }) =>
    Effect.gen(function* () {
      const matchingGrants = yield* executor
        .select({
          userId: creditLedger.userId,
          expiresAt: creditLedger.expiresAt,
        })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.paymentReference, paymentReference),
            or(eq(creditLedger.kind, "annual_grant"), eq(creditLedger.kind, "top_up"))
          )
        )

      if (matchingGrants.length === 0) return false

      const buckets = [
        ...new Map(
          matchingGrants.map((grant) => [
            `${grant.userId}:${grant.expiresAt?.toISOString() ?? "never"}`,
            grant,
          ])
        ).values(),
      ].sort((left, right) => {
        const userOrder = left.userId.localeCompare(right.userId)
        if (userOrder !== 0) return userOrder
        return (left.expiresAt?.toISOString() ?? "never").localeCompare(
          right.expiresAt?.toISOString() ?? "never"
        )
      })
      const userIds = [...new Set(buckets.map((bucket) => bucket.userId))].sort()

      yield* executor
        .select({ userId: billingAccounts.userId })
        .from(billingAccounts)
        .where(inArray(billingAccounts.userId, userIds))
        .orderBy(asc(billingAccounts.userId))
        .for("update")

      const allGrantRows = yield* executor
        .select({
          userId: creditLedger.userId,
          expiresAt: creditLedger.expiresAt,
          paymentReference: creditLedger.paymentReference,
          amount: creditLedger.delta,
          paymentAmount: creditLedger.paymentAmount,
          stripeInvoiceId: creditLedger.stripeInvoiceId,
        })
        .from(creditLedger)
        .where(
          and(
            inArray(creditLedger.userId, userIds),
            or(eq(creditLedger.kind, "annual_grant"), eq(creditLedger.kind, "top_up"))
          )
        )
        .orderBy(
          asc(creditLedger.userId),
          asc(creditLedger.expiresAt),
          asc(creditLedger.paymentReference),
          asc(creditLedger.stripeInvoiceId)
        )
      const allGrantsWithPayment = [
        ...allGrantRows.reduce((grouped, grantRow) => {
          if (grantRow.paymentReference === null) return grouped
          const bucketReference = grantRow.expiresAt?.toISOString() ?? "never"
          const allocationId = [
            grantRow.userId,
            bucketReference,
            grantRow.paymentReference,
            grantRow.stripeInvoiceId ?? "",
            grantRow.paymentAmount?.toString() ?? "",
          ].join(":")
          const current = grouped.get(allocationId)
          grouped.set(allocationId, {
            allocationId,
            userId: grantRow.userId,
            expiresAt: grantRow.expiresAt,
            paymentReference: grantRow.paymentReference,
            paymentAmount: grantRow.paymentAmount,
            stripeInvoiceId: grantRow.stripeInvoiceId,
            amount: (current?.amount ?? 0) + grantRow.amount,
          })
          return grouped
        }, new Map<string, PaymentCreditGrant & { readonly userId: string; readonly expiresAt: Date | null }>()),
      ]
        .map(([, grant]) => grant)
        .sort((left, right) => left.allocationId.localeCompare(right.allocationId))
      const allPaymentReferences = [
        ...new Set(allGrantsWithPayment.map((grant) => grant.paymentReference)),
      ]
      const allReversals = yield* executor
        .select({
          paymentReference: billingPaymentReversals.paymentReference,
          reversalGroup: billingPaymentReversals.reversalGroup,
          lossReference: billingPaymentReversals.lossReference,
          reversedAmount: billingPaymentReversals.reversedAmount,
          paymentAmount: billingPaymentReversals.paymentAmount,
          eventReference: billingPaymentReversals.eventReference,
          stripeInvoiceId: billingPaymentReversals.stripeInvoiceId,
        })
        .from(billingPaymentReversals)
        .where(inArray(billingPaymentReversals.paymentReference, allPaymentReferences))
      const grantsByPaymentReference = allGrantsWithPayment.reduce((grouped, grant) => {
        const grants = grouped.get(grant.paymentReference) ?? []
        grants.push({
          ...grant,
          exact: exactReversedCredits({ grant, reversals: allReversals }),
        })
        grouped.set(grant.paymentReference, grants)
        return grouped
      }, new Map<string, Array<PaymentCreditGrant & { readonly exact: BigDecimal.BigDecimal }>>())
      const roundedReversals = new Map(
        [...grantsByPaymentReference.values()].flatMap((grants) => [
          ...allocateRoundedCreditReversals(grants),
        ])
      )

      const insertedByBucket = yield* Effect.forEach(buckets, (bucket) =>
        Effect.gen(function* () {
          const grantsWithPayment = allGrantsWithPayment.filter(
            (grant) =>
              grant.userId === bucket.userId &&
              (bucket.expiresAt === null
                ? grant.expiresAt === null
                : grant.expiresAt?.getTime() === bucket.expiresAt.getTime())
          )
          const paymentReferences = grantsWithPayment.map(
            (bucketGrant) => bucketGrant.paymentReference
          )
          if (paymentReferences.length === 0) return false

          const reversals = allReversals.filter((reversal) =>
            paymentReferences.includes(reversal.paymentReference)
          )
          const [baseBucket] = yield* executor
            .select({ total: sql<number>`coalesce(sum(${creditLedger.delta}), 0)` })
            .from(creditLedger)
            .where(
              and(
                eq(creditLedger.userId, bucket.userId),
                bucket.expiresAt === null
                  ? isNull(creditLedger.expiresAt)
                  : eq(creditLedger.expiresAt, bucket.expiresAt),
                sql`${creditLedger.kind} <> 'manual_adjustment'`
              )
            )
          const adjustments = yield* executor
            .select({
              reference: creditLedger.reference,
              paymentReference: creditLedger.paymentReference,
              delta: creditLedger.delta,
              expiresAt: creditLedger.expiresAt,
            })
            .from(creditLedger)
            .where(
              and(
                inArray(creditLedger.paymentReference, paymentReferences),
                eq(creditLedger.kind, "manual_adjustment")
              )
            )
          const baseBucketTotal = Number(baseBucket?.total ?? 0)
          const grantVersion = grantsWithPayment
            .map(
              (bucketGrant) =>
                `${bucketGrant.paymentReference}:${bucketGrant.stripeInvoiceId ?? "all"}:${bucketGrant.paymentAmount ?? "unknown"}:${bucketGrant.amount}`
            )
            .sort()
            .join("|")
          const allocationVersion = allGrantsWithPayment
            .filter((grant) => paymentReferences.includes(grant.paymentReference))
            .map((grant) => `${grant.allocationId}:${grant.amount}`)
            .sort()
            .join("|")
          const reversalVersion = reversals
            .map(
              (reversal) =>
                `${reversal.paymentReference}:${reversal.reversalGroup}:${reversal.lossReference}:${reversal.stripeInvoiceId ?? "all"}:${reversal.reversedAmount}:${reversal.eventReference}`
            )
            .sort()
            .join("|")
          const bucketVersion = `${baseBucketTotal}:${grantVersion}:${allocationVersion}:${reversalVersion}`
          const bucketReference = bucket.expiresAt?.getTime().toString() ?? "never"
          let remainingExpiringCredits =
            bucket.expiresAt === null ? 0 : Math.max(baseBucketTotal, 0)
          const desiredAdjustments = grantsWithPayment.flatMap((bucketGrant) => {
            const targetReversal = roundedReversals.get(bucketGrant.allocationId) ?? 0
            const expiringReversal = Math.min(targetReversal, remainingExpiringCredits)
            remainingExpiringCredits -= expiringReversal
            const permanentDebt = targetReversal - expiringReversal
            const allocationReference = bucketGrant.stripeInvoiceId ?? "payment"
            const adjustmentPrefix = `stripe:payment-reversal:${bucketGrant.paymentReference}:${allocationReference}:${bucketReference}:`
            const grantAdjustments = adjustments.filter(
              (adjustment) =>
                adjustment.paymentReference === bucketGrant.paymentReference &&
                adjustment.reference.startsWith(adjustmentPrefix)
            )
            const currentPermanentAdjustment = grantAdjustments
              .filter((adjustment) => adjustment.expiresAt === null)
              .reduce((total, adjustment) => total + adjustment.delta, 0)
            const currentExpiringAdjustment = grantAdjustments
              .filter((adjustment) => adjustment.expiresAt !== null)
              .reduce((total, adjustment) => total + adjustment.delta, 0)

            return [
              {
                paymentReference: bucketGrant.paymentReference,
                allocationReference,
                delta: -permanentDebt - currentPermanentAdjustment,
                expiresAt: null,
                suffix: "permanent",
              },
              {
                paymentReference: bucketGrant.paymentReference,
                allocationReference,
                delta: -expiringReversal - currentExpiringAdjustment,
                expiresAt: bucket.expiresAt,
                suffix: "expiring",
              },
            ].filter((adjustment) => adjustment.delta !== 0)
          })
          if (desiredAdjustments.length === 0) return false

          const inserted = yield* Effect.forEach(desiredAdjustments, (adjustment) =>
            executor
              .insert(creditLedger)
              .values({
                userId: bucket.userId,
                delta: adjustment.delta,
                kind: "manual_adjustment",
                reference: `stripe:payment-reversal:${adjustment.paymentReference}:${adjustment.allocationReference}:${bucketReference}:${bucketVersion}:${adjustment.suffix}`,
                paymentReference: adjustment.paymentReference,
                expiresAt: adjustment.expiresAt,
              })
              .onConflictDoNothing({ target: creditLedger.reference })
              .returning({ id: creditLedger.id })
          )

          return inserted.some((rows) => rows.length === 1)
        })
      )

      return insertedByBucket.some(Boolean)
    })

  const reconcilePaymentCreditReversals: BillingRepositoryService["reconcilePaymentCreditReversals"] =
    (paymentReference) =>
      db
        .transaction((tx) =>
          lockPaymentReference({ executor: tx, paymentReference }).pipe(
            Effect.andThen(reconcilePaymentCreditReversalsWith({ executor: tx, paymentReference }))
          )
        )
        .pipe(wrapSqlError("billing.reconcilePaymentCreditReversals"))

  const setPaymentCreditReversal: BillingRepositoryService["setPaymentCreditReversal"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* lockPaymentReference({
            executor: tx,
            paymentReference: input.paymentReference,
          })

          yield* reconcilePaymentCreditReversalsWith({
            executor: tx,
            paymentReference: input.paymentReference,
          })

          yield* tx
            .insert(billingPaymentReversals)
            .values({
              paymentReference: input.paymentReference,
              reversalGroup: input.reversalGroup,
              lossReference: input.lossReference ?? input.reversalGroup,
              reversedAmount: input.reversedAmount,
              paymentAmount: input.paymentAmount,
              eventReference: input.reference,
              eventCreatedAt: input.eventCreatedAt,
              stripeInvoiceId: input.stripeInvoiceId ?? null,
              terminal: input.terminal,
              updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
            })
            .onConflictDoUpdate({
              target: [
                billingPaymentReversals.paymentReference,
                billingPaymentReversals.reversalGroup,
              ],
              set: {
                reversedAmount: input.monotonic
                  ? sql`greatest(${billingPaymentReversals.reversedAmount}, excluded.reversed_amount)`
                  : input.reversedAmount,
                paymentAmount: input.paymentAmount,
                lossReference: input.lossReference ?? input.reversalGroup,
                eventReference: input.reference,
                eventCreatedAt: input.eventCreatedAt,
                stripeInvoiceId: input.stripeInvoiceId ?? null,
                terminal: input.terminal,
                updatedAt: DateTime.toDateUtc(DateTime.nowUnsafe()),
              },
              setWhere: sql`${billingPaymentReversals.terminal} = false and ${billingPaymentReversals.eventCreatedAt} <= ${input.eventCreatedAt}`,
            })

          return yield* reconcilePaymentCreditReversalsWith({
            executor: tx,
            paymentReference: input.paymentReference,
          })
        })
      )
      .pipe(wrapSqlError("billing.setPaymentCreditReversal"))

  const availableCredits: BillingRepositoryService["availableCredits"] = (userId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)` })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.userId, userId),
            or(
              isNull(creditLedger.expiresAt),
              gt(creditLedger.expiresAt, DateTime.toDateUtc(DateTime.nowUnsafe()))
            )
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
      .pipe(Effect.asVoid, wrapSqlError("billing.markEventProcessed"))

  return {
    findByUserId,
    findByStripeCustomerId,
    saveCustomer,
    saveSubscription,
    clearSubscription,
    reserveSubscriptionSync,
    clearCustomer,
    reserveAnnualCheckout,
    clearAnnualCheckoutReservation,
    grantCredits,
    reconcilePaymentCreditReversals,
    setPaymentCreditReversal,
    availableCredits,
    hasProcessedEvent,
    markEventProcessed,
  } satisfies BillingRepositoryService
})

/** Live PostgreSQL implementation of BillingRepository. */
export const BillingRepositoryLive = Layer.effect(BillingRepository, make)
