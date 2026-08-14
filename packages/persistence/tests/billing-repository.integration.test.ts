import { AuthUserId } from "@my/core/authentication"
import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { BillingRepositoryLive } from "../src/layers/BillingRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { schema } from "../src/schema/index.ts"
import { BillingRepository } from "../src/services/BillingRepository.ts"
import { makeIntegrationTestDatabaseContext } from "./support/integration-test-kit.ts"

const TEST_USER_ID = AuthUserId.make("00000000-0000-0000-0000-000000000191")
const STRIPE_CUSTOMER_ID = "cus_billing_repository_test"
const REVERSAL_EVENT_AT = new Date("2026-08-13T12:00:00.000Z")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_billing_repository",
})

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, BillingRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: BillingRepositoryLive }))

const seedBillingAccount = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle

      yield* db.insert(schema.users).values({
        id: TEST_USER_ID,
        email: "billing-repository@taxmaxi.test",
        name: "Billing Repository Test User",
      })
      yield* db.insert(schema.billingAccounts).values({
        userId: TEST_USER_ID,
        stripeCustomerId: STRIPE_CUSTOMER_ID,
      })
    })
  )

describe("BillingRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await seedBillingAccount()
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("consumes one credit per transaction and treats retries as duplicates", async () => {
    const expiringAt = new Date(Date.now() + 60 * 60 * 1000)

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1,
          kind: "annual_grant",
          reference: "invoice:annual-period",
          paymentReference: "pi_annual",
          expiresAt: expiringAt,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1,
          kind: "top_up",
          reference: "checkout:top-up",
          paymentReference: "pi_top_up",
          expiresAt: null,
        })

        return yield* Effect.all({
          first: repository.consumeTransactionCredit({
            userId: TEST_USER_ID,
            transactionId: "transaction-1",
          }),
          second: repository.consumeTransactionCredit({
            userId: TEST_USER_ID,
            transactionId: "transaction-2",
          }),
        }).pipe(
          Effect.andThen(
            Effect.all({
              duplicate: repository.consumeTransactionCredit({
                userId: TEST_USER_ID,
                transactionId: "transaction-1",
              }),
              exhausted: repository.consumeTransactionCredit({
                userId: TEST_USER_ID,
                transactionId: "transaction-3",
              }),
              available: repository.availableCredits(TEST_USER_ID),
            })
          )
        )
      })
    )

    expect(result).toEqual({
      duplicate: "duplicate",
      exhausted: "exhausted",
      available: 0,
    })
  })

  it("keeps one zero-due annual allowance across webhook retries", async () => {
    const expiresAt = new Date("2027-08-14T00:00:00.000Z")
    const grant = {
      userId: TEST_USER_ID,
      amount: 10_000,
      kind: "annual_grant" as const,
      reference: "stripe:annual:sub_zero_due:1:2:invoice:in_zero_due",
      paymentReference: null,
      expiresAt,
    }

    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        yield* repository.grantCredits(grant)
        yield* repository.grantCredits(grant)
        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )
    const rows = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            delta: schema.creditLedger.delta,
            paymentReference: schema.creditLedger.paymentReference,
            expiresAt: schema.creditLedger.expiresAt,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.reference, grant.reference))
      })
    )

    expect(available).toBe(10_000)
    expect(rows).toEqual([{ delta: 10_000, paymentReference: null, expiresAt }])
  })

  it("moves a payment reversal to the latest proportional refund amount", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1_000,
          kind: "top_up",
          reference: "checkout:refundable",
          paymentReference: "pi_refundable",
          expiresAt: null,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refundable",
          reversalGroup: "stripe:refund:ch_refundable",
          reversedAmount: 250,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_refundable:250",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: false,
        })
        const afterPartialRefund = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refundable",
          reversalGroup: "stripe:refund:ch_refundable",
          reversedAmount: 500,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_refundable:500",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: true,
          terminal: false,
        })
        const afterLargerRefund = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refundable",
          reversalGroup: "stripe:dispute:dp_refundable",
          reversedAmount: 1_000,
          paymentAmount: 1_000,
          reference: "stripe:dispute:dp_refundable:created",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: false,
          terminal: false,
        })
        const duringDispute = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refundable",
          reversalGroup: "stripe:dispute:dp_refundable",
          reversedAmount: 0,
          paymentAmount: 1_000,
          reference: "stripe:dispute:dp_refundable:won",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: false,
          terminal: true,
        })
        const afterDisputeWon = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refundable",
          reversalGroup: "stripe:dispute:dp_refundable",
          reversedAmount: 1_000,
          paymentAmount: 1_000,
          reference: "stripe:dispute:dp_refundable:late-created",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: false,
          terminal: false,
        })
        const afterLateCreated = yield* repository.availableCredits(TEST_USER_ID)

        return {
          afterPartialRefund,
          afterLargerRefund,
          duringDispute,
          afterDisputeWon,
          afterLateCreated,
        }
      })
    )

    expect(result).toEqual({
      afterPartialRefund: 750,
      afterLargerRefund: 500,
      duringDispute: 0,
      afterDisputeWon: 500,
      afterLateCreated: 500,
    })
  })

  it("applies a reversal that arrives before its payment grant", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        const reconciledBeforeGrant = yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_out_of_order",
          reversalGroup: "stripe:refund:ch_out_of_order",
          reversedAmount: 500,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_out_of_order:early",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: false,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1_000,
          kind: "top_up",
          reference: "checkout:out-of-order",
          paymentReference: "pi_out_of_order",
          expiresAt: null,
        })
        const reconciledAfterGrant =
          yield* repository.reconcilePaymentCreditReversals("pi_out_of_order")
        const available = yield* repository.availableCredits(TEST_USER_ID)

        return { reconciledBeforeGrant, reconciledAfterGrant, available }
      })
    )

    expect(result).toEqual({
      reconciledBeforeGrant: false,
      reconciledAfterGrant: true,
      available: 500,
    })
  })

  it("recalculates refund debt across split annual payments", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000)
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 4,
          kind: "annual_grant",
          reference: "invoice:split:first",
          paymentReference: "pi_split_first",
          expiresAt,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 6,
          kind: "annual_grant",
          reference: "invoice:split:second",
          paymentReference: "pi_split_second",
          expiresAt,
        })
        yield* Effect.forEach([1, 2, 3, 4, 5], (transactionId) =>
          repository.consumeTransactionCredit({
            userId: TEST_USER_ID,
            transactionId: `split-payment-usage-${transactionId}`,
          })
        )
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_split_first",
          reversalGroup: "stripe:dispute:dp_split_first",
          reversedAmount: 4,
          paymentAmount: 4,
          reference: "stripe:dispute:dp_split_first:open",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: false,
          terminal: false,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_split_second",
          reversalGroup: "stripe:dispute:dp_split_second",
          reversedAmount: 6,
          paymentAmount: 6,
          reference: "stripe:dispute:dp_split_second:open",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: false,
          terminal: false,
        })
        const bothReversed = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_split_first",
          reversalGroup: "stripe:dispute:dp_split_first",
          reversedAmount: 0,
          paymentAmount: 4,
          reference: "stripe:dispute:dp_split_first:won",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: false,
          terminal: true,
        })
        const firstRestored = yield* repository.availableCredits(TEST_USER_ID)

        return { bothReversed, firstRestored }
      })
    )

    expect(result).toEqual({ bothReversed: -5, firstRestored: -1 })
  })

  it("reverses every annual period funded by the same payment", async () => {
    const firstExpiry = new Date(Date.now() + 60 * 60 * 1_000)
    const secondExpiry = new Date(Date.now() + 2 * 60 * 60 * 1_000)
    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 4,
          kind: "annual_grant",
          reference: "invoice:shared-payment:first-period",
          paymentReference: "pi_shared_periods",
          expiresAt: firstExpiry,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 6,
          kind: "annual_grant",
          reference: "invoice:shared-payment:second-period",
          paymentReference: "pi_shared_periods",
          expiresAt: secondExpiry,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_shared_periods",
          reversalGroup: "stripe:refund:ch_shared_periods",
          reversedAmount: 10,
          paymentAmount: 10,
          reference: "stripe:refund:ch_shared_periods:full",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: false,
        })

        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )

    expect(available).toBe(0)
  })

  it("moves refund debt when later grants change the expiry bucket", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000)
    await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10,
          kind: "annual_grant",
          reference: "invoice:bucket-state:refunded",
          paymentReference: "pi_bucket_refunded",
          expiresAt,
        })
        yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8, 9], (transactionId) =>
          repository.consumeTransactionCredit({
            userId: TEST_USER_ID,
            transactionId: `bucket-state-usage-${transactionId}`,
          })
        )
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_bucket_refunded",
          reversalGroup: "stripe:refund:ch_bucket_refunded",
          reversedAmount: 10,
          paymentAmount: 10,
          reference: "stripe:refund:ch_bucket_refunded:full",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: false,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10,
          kind: "annual_grant",
          reference: "invoice:bucket-state:sibling",
          paymentReference: "pi_bucket_sibling",
          expiresAt,
        })
        yield* repository.reconcilePaymentCreditReversals("pi_bucket_sibling")
      })
    )

    const adjustments = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ delta: schema.creditLedger.delta, expiresAt: schema.creditLedger.expiresAt })
          .from(schema.creditLedger)
          .where(
            and(
              eq(schema.creditLedger.paymentReference, "pi_bucket_refunded"),
              eq(schema.creditLedger.kind, "manual_adjustment")
            )
          )
      })
    )
    const permanent = adjustments
      .filter((adjustment) => adjustment.expiresAt === null)
      .reduce((total, adjustment) => total + adjustment.delta, 0)
    const expiring = adjustments
      .filter((adjustment) => adjustment.expiresAt !== null)
      .reduce((total, adjustment) => total + adjustment.delta, 0)

    expect({ permanent, expiring }).toEqual({ permanent: 0, expiring: -10 })
  })

  it("does not let an older reversal event reduce a newer cumulative refund", async () => {
    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1_000,
          kind: "top_up",
          reference: "checkout:ordered-refund",
          paymentReference: "pi_ordered_refund",
          expiresAt: null,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_ordered_refund",
          reversalGroup: "stripe:refund:ch_ordered_refund",
          reversedAmount: 1_000,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_ordered_refund:newer",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: true,
          terminal: false,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_ordered_refund",
          reversalGroup: "stripe:refund:ch_ordered_refund",
          reversedAmount: 500,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_ordered_refund:older",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: true,
          terminal: false,
        })

        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )

    expect(available).toBe(0)
  })

  it("reserves one annual Checkout generation for concurrent requests", async () => {
    const reservations = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        return yield* Effect.all(
          [
            repository.reserveAnnualCheckout({ userId: TEST_USER_ID, priceId: "price_annual" }),
            repository.reserveAnnualCheckout({ userId: TEST_USER_ID, priceId: "price_annual" }),
          ],
          { concurrency: "unbounded" }
        )
      })
    )

    expect(reservations[0]?.generation).toBe(1)
    expect(reservations[1]?.generation).toBe(1)
    expect(reservations[0]?.expiresAt).toEqual(reservations[1]?.expiresAt)
  })

  it("advances the annual Checkout generation after its reservation expires", async () => {
    const first = await runRepository(
      Effect.flatMap(BillingRepository, (repository) =>
        repository.reserveAnnualCheckout({ userId: TEST_USER_ID, priceId: "price_annual" })
      )
    )
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.billingAccounts)
          .set({ annualCheckoutExpiresAt: new Date("2020-01-01T00:00:00.000Z") })
          .where(eq(schema.billingAccounts.userId, TEST_USER_ID))
      })
    )
    const second = await runRepository(
      Effect.flatMap(BillingRepository, (repository) =>
        repository.reserveAnnualCheckout({ userId: TEST_USER_ID, priceId: "price_annual" })
      )
    )

    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    expect(second.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it("pins the annual price for the lifetime of a Checkout reservation", async () => {
    const reservations = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const first = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_original",
        })
        const afterLookupChange = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_new",
        })
        return { first, afterLookupChange }
      })
    )

    expect(reservations.afterLookupChange).toEqual(reservations.first)
    expect(reservations.afterLookupChange.priceId).toBe("price_original")
  })

  it("keeps a new annual Checkout reservation when a terminal subscription event arrives", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const first = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })
        const syncGeneration = yield* repository.reserveSubscriptionSync(STRIPE_CUSTOMER_ID)
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_terminal",
          status: "canceled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: REVERSAL_EVENT_AT,
          syncGeneration,
        })
        const second = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })

        return { first, second }
      })
    )

    expect(result.second).toEqual(result.first)
  })

  it("uses new credits to cover refunded usage before allowing more transactions", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10,
          kind: "annual_grant",
          reference: "invoice:refunded-after-usage",
          paymentReference: "pi_refunded_after_usage",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        yield* Effect.forEach(
          Array.from({ length: 9 }, (_, index) => `used-${index}`),
          (transactionId) =>
            repository.consumeTransactionCredit({ userId: TEST_USER_ID, transactionId }),
          { concurrency: 1 }
        )
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_refunded_after_usage",
          reversalGroup: "stripe:refund:ch_refunded_after_usage",
          reversedAmount: 1_000,
          paymentAmount: 1_000,
          reference: "stripe:refund:ch_refunded_after_usage:full",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: false,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10,
          kind: "top_up",
          reference: "checkout:after-refund",
          paymentReference: "pi_after_refund",
          expiresAt: null,
        })

        const coveredDebt = yield* repository.consumeTransactionCredit({
          userId: TEST_USER_ID,
          transactionId: "covered-debt",
        })
        const exhausted = yield* repository.consumeTransactionCredit({
          userId: TEST_USER_ID,
          transactionId: "still-positive-bucket",
        })
        const available = yield* repository.availableCredits(TEST_USER_ID)

        return { coveredDebt, exhausted, available }
      })
    )

    expect(result).toEqual({ coveredDebt: "consumed", exhausted: "exhausted", available: 0 })
  })

  it("does not let an older subscription event overwrite newer state", async () => {
    const newestEventAt = new Date("2026-08-13T12:00:02.000Z")
    const staleEventAt = new Date("2026-08-13T12:00:01.000Z")

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const acceptedNewest = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_new",
          status: "active",
          currentPeriodEnd: new Date("2027-08-13T12:00:00.000Z"),
          cancelAtPeriodEnd: false,
          eventCreatedAt: newestEventAt,
          syncGeneration: 0,
        })
        const acceptedStale = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_old",
          status: "canceled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: true,
          eventCreatedAt: staleEventAt,
          syncGeneration: 0,
        })
        const account = Option.getOrThrow(yield* repository.findByUserId(TEST_USER_ID))

        return { acceptedNewest, acceptedStale, account }
      })
    )

    expect(result.acceptedNewest).toBe(true)
    expect(result.acceptedStale).toBe(false)
    expect(result.account).toMatchObject({
      stripeSubscriptionId: "sub_new",
      subscriptionStatus: "active",
      lastSubscriptionEventCreatedAt: newestEventAt,
    })
  })

  it("rejects a late subscription fetch after a newer sync reservation", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const olderGeneration = yield* repository.reserveSubscriptionSync(STRIPE_CUSTOMER_ID)
        const newerGeneration = yield* repository.reserveSubscriptionSync(STRIPE_CUSTOMER_ID)
        const eventCreatedAt = new Date("2026-08-13T12:00:00.000Z")
        const acceptedNewer = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_same_second",
          status: "paused",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt,
          syncGeneration: newerGeneration,
        })
        const acceptedOlder = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_same_second",
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt,
          syncGeneration: olderGeneration,
        })
        const account = Option.getOrThrow(yield* repository.findByUserId(TEST_USER_ID))

        return { acceptedNewer, acceptedOlder, account }
      })
    )

    expect(result.acceptedNewer).toBe(true)
    expect(result.acceptedOlder).toBe(false)
    expect(result.account.subscriptionStatus).toBe("paused")
  })

  it("clears a tracked subscription only under the winning sync generation", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_moved_off_annual",
          status: "active",
          currentPeriodEnd: new Date("2027-08-13T12:00:00.000Z"),
          cancelAtPeriodEnd: false,
          eventCreatedAt: new Date("2026-08-13T12:00:00.000Z"),
          syncGeneration: 0,
        })
        const staleGeneration = yield* repository.reserveSubscriptionSync(STRIPE_CUSTOMER_ID)
        const winningGeneration = yield* repository.reserveSubscriptionSync(STRIPE_CUSTOMER_ID)
        const input = {
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_moved_off_annual",
          eventCreatedAt: new Date("2026-08-13T12:00:01.000Z"),
        } as const
        const rejected = yield* repository.clearSubscription({
          ...input,
          syncGeneration: staleGeneration,
        })
        const cleared = yield* repository.clearSubscription({
          ...input,
          syncGeneration: winningGeneration,
        })
        const account = Option.getOrThrow(yield* repository.findByUserId(TEST_USER_ID))

        return { rejected, cleared, account }
      })
    )

    expect(result.rejected).toBe(false)
    expect(result.cleared).toBe(true)
    expect(result.account).toMatchObject({
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
  })
})
