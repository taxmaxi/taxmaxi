import { AuthUserId } from "@my/core/authentication"
import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"

import { BillingRepositoryLive } from "../src/layers/BillingRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { schema } from "../src/schema/index.ts"
import { BillingRepository } from "../src/services/BillingRepository.ts"
import { makeIntegrationTestDatabaseContext } from "./support/integration-test-kit.ts"

const TEST_USER_ID = AuthUserId.make("00000000-4000-4000-8000-000000000191")
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

const seedTransactionUsage = ({
  references,
  expiresAt,
}: {
  readonly references: ReadonlyArray<string>
  readonly expiresAt: Date | null
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle

      yield* db.insert(schema.creditLedger).values(
        references.map((reference) => ({
          userId: TEST_USER_ID,
          delta: -1,
          kind: "transaction_usage" as const,
          reference,
          paymentReference: null,
          expiresAt,
        }))
      )
    })
  )

describe("BillingRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await seedBillingAccount()
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

  it("rounds once after combining separate partial refunds", async () => {
    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1_000,
          kind: "top_up",
          reference: "checkout:small-refunds",
          paymentReference: "pi_small_refunds",
          paymentAmount: 2_000,
          stripeInvoiceId: "in_small_refunds",
          expiresAt: null,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_small_refunds",
          reversalGroup: "stripe:refund:re_small_first:payment",
          lossReference: "stripe:refund:re_small_first",
          reversedAmount: 1,
          paymentAmount: 2_000,
          reference: "stripe:refund:re_small_first:payment",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: true,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_small_refunds",
          reversalGroup: "stripe:refund:re_small_second:payment",
          lossReference: "stripe:refund:re_small_second",
          reversedAmount: 1,
          paymentAmount: 2_000,
          reference: "stripe:refund:re_small_second:payment",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          monotonic: true,
          terminal: true,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_small_refunds",
          reversalGroup: "stripe:credit-note:cn_small_first:refund:re_small_first",
          lossReference: "stripe:refund:re_small_first",
          reversedAmount: 1,
          paymentAmount: 2_000,
          reference: "stripe:credit-note:cn_small_first",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 2_000),
          stripeInvoiceId: "in_small_refunds",
          monotonic: true,
          terminal: true,
        })

        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )

    expect(available).toBe(999)
  })

  it("reverses the credit linked to a one-cent annual payment", async () => {
    const expiresAt = new Date("2027-08-14T00:00:00.000Z")
    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1,
          kind: "annual_grant",
          reference: "invoice:one-cent:first",
          paymentReference: "pi_one_cent",
          paymentAmount: 1,
          stripeInvoiceId: "in_one_cent",
          expiresAt,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 9_999,
          kind: "annual_grant",
          reference: "invoice:one-cent:remainder",
          paymentReference: "pi_one_cent_remainder",
          paymentAmount: 15_899,
          stripeInvoiceId: "in_one_cent",
          expiresAt,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_one_cent",
          reversalGroup: "stripe:refund:re_one_cent:payment",
          lossReference: "stripe:refund:re_one_cent",
          reversedAmount: 1,
          paymentAmount: 1,
          reference: "stripe:refund:re_one_cent:payment",
          eventCreatedAt: REVERSAL_EVENT_AT,
          monotonic: true,
          terminal: true,
        })

        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )

    expect(available).toBe(9_999)
  })

  it.each([
    {
      firstExpiresAt: null,
      name: "inside one expiry bucket",
      secondExpiresAt: null,
    },
    {
      firstExpiresAt: new Date("2027-08-14T00:00:00.000Z"),
      name: "across expiry buckets",
      secondExpiresAt: null,
    },
  ])("rounds a shared-payment reversal once $name", async ({ firstExpiresAt, secondExpiresAt }) => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10_000,
          kind: "annual_grant",
          reference: `invoice:rounding:second:${firstExpiresAt === null ? "same" : "split"}`,
          paymentReference: "pi_shared_rounding",
          paymentAmount: 20_000,
          stripeInvoiceId: "in_rounding_second",
          expiresAt: secondExpiresAt,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10_000,
          kind: "annual_grant",
          reference: `invoice:rounding:first:${firstExpiresAt === null ? "same" : "split"}`,
          paymentReference: "pi_shared_rounding",
          paymentAmount: 20_000,
          stripeInvoiceId: "in_rounding_first",
          expiresAt: firstExpiresAt,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_shared_rounding",
          reversalGroup: "stripe:refund:re_shared_rounding:payment",
          lossReference: "stripe:refund:re_shared_rounding",
          reversedAmount: 1,
          paymentAmount: 20_000,
          reference: "stripe:refund:re_shared_rounding:payment",
          eventCreatedAt: REVERSAL_EVENT_AT,
          stripeInvoiceId: null,
          monotonic: true,
          terminal: true,
        })
        yield* repository.reconcilePaymentCreditReversals("pi_shared_rounding")
        const available = yield* repository.availableCredits(TEST_USER_ID)
        return { available }
      })
    )
    const adjustments = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ delta: schema.creditLedger.delta, reference: schema.creditLedger.reference })
          .from(schema.creditLedger)
          .where(
            and(
              eq(schema.creditLedger.kind, "manual_adjustment"),
              eq(schema.creditLedger.paymentReference, "pi_shared_rounding")
            )
          )
      })
    )

    expect(result.available).toBe(19_999)
    expect(adjustments.reduce((total, adjustment) => total + adjustment.delta, 0)).toBe(-1)
    expect(adjustments.some(({ reference }) => reference.includes("in_rounding_first"))).toBe(true)
  })

  it("moves a shared-payment refund from payment-wide to its credited invoice", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 100,
          kind: "annual_grant",
          reference: "invoice:shared:first",
          paymentReference: "pi_shared_invoices",
          paymentAmount: 100,
          stripeInvoiceId: "in_first",
          expiresAt: null,
        })
        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 300,
          kind: "annual_grant",
          reference: "invoice:shared:second",
          paymentReference: "pi_shared_invoices",
          paymentAmount: 100,
          stripeInvoiceId: "in_second",
          expiresAt: null,
        })
        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_shared_invoices",
          reversalGroup: "stripe:refund:re_shared:payment",
          lossReference: "stripe:refund:re_shared",
          reversedAmount: 150,
          paymentAmount: 200,
          reference: "stripe:refund:re_shared:generic",
          eventCreatedAt: REVERSAL_EVENT_AT,
          stripeInvoiceId: null,
          monotonic: true,
          terminal: false,
        })
        const paymentWide = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_shared_invoices",
          reversalGroup: "stripe:credit-note:cn_first:refund:re_shared",
          lossReference: "stripe:refund:re_shared",
          reversedAmount: 100,
          paymentAmount: 100,
          reference: "stripe:credit-note:cn_first",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 1_000),
          stripeInvoiceId: "in_first",
          monotonic: true,
          terminal: true,
        })
        const invoiceScoped = yield* repository.availableCredits(TEST_USER_ID)

        yield* repository.setPaymentCreditReversal({
          paymentReference: "pi_shared_invoices",
          reversalGroup: "stripe:refund:re_shared:payment",
          lossReference: "stripe:refund:re_shared",
          reversedAmount: 150,
          paymentAmount: 200,
          reference: "stripe:refund:re_shared:late",
          eventCreatedAt: new Date(REVERSAL_EVENT_AT.getTime() + 2_000),
          stripeInvoiceId: null,
          monotonic: true,
          terminal: false,
        })
        const afterLateGeneric = yield* repository.availableCredits(TEST_USER_ID)

        return { paymentWide, invoiceScoped, afterLateGeneric }
      })
    )

    expect(result).toEqual({
      paymentWide: 100,
      invoiceScoped: 150,
      afterLateGeneric: 150,
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
        const granted = yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 1_000,
          kind: "top_up",
          reference: "checkout:out-of-order",
          paymentReference: "pi_out_of_order",
          expiresAt: null,
        })
        const available = yield* repository.availableCredits(TEST_USER_ID)

        return { reconciledBeforeGrant, granted, available }
      })
    )

    expect(result).toEqual({
      reconciledBeforeGrant: false,
      granted: true,
      available: 500,
    })
  })

  it("serializes concurrent grants and reversals for the same payment", async () => {
    const paymentReferences = Array.from(
      { length: 10 },
      (_, index) => `pi_concurrent_grant_reversal_${index}`
    )

    await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* Effect.forEach(
          paymentReferences,
          (paymentReference) =>
            Effect.all(
              [
                repository.grantCredits({
                  userId: TEST_USER_ID,
                  amount: 1_000,
                  kind: "top_up",
                  reference: `checkout:${paymentReference}`,
                  paymentReference,
                  expiresAt: null,
                }),
                repository.setPaymentCreditReversal({
                  paymentReference,
                  reversalGroup: `stripe:refund:${paymentReference}`,
                  reversedAmount: 500,
                  paymentAmount: 1_000,
                  reference: `stripe:refund:${paymentReference}:concurrent`,
                  eventCreatedAt: REVERSAL_EVENT_AT,
                  monotonic: true,
                  terminal: true,
                }),
              ],
              { concurrency: "unbounded" }
            ),
          { concurrency: "unbounded", discard: true }
        )
      })
    )

    const available = await runRepository(
      Effect.flatMap(BillingRepository, (repository) => repository.availableCredits(TEST_USER_ID))
    )

    expect(available).toBe(5_000)
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
        yield* Effect.promise(() =>
          seedTransactionUsage({
            references: [1, 2, 3, 4, 5].map(
              (transactionId) => `split-payment-usage-${transactionId}`
            ),
            expiresAt,
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
        yield* Effect.promise(() =>
          seedTransactionUsage({
            references: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
              (transactionId) => `bucket-state-usage-${transactionId}`
            ),
            expiresAt,
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

  it("clears only the current failed annual Checkout reservation", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const first = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_first",
        })
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.billingAccounts)
                .set({ annualCheckoutExpiresAt: new Date("2020-01-01T00:00:00.000Z") })
                .where(eq(schema.billingAccounts.userId, TEST_USER_ID))
            })
          )
        )
        const second = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_second",
        })
        const clearedOld = yield* repository.clearAnnualCheckoutReservation({
          userId: TEST_USER_ID,
          generation: first.generation,
        })
        const afterOldClear = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_third",
        })
        const clearedCurrent = yield* repository.clearAnnualCheckoutReservation({
          userId: TEST_USER_ID,
          generation: second.generation,
        })
        const afterCurrentClear = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_third",
        })
        return { second, clearedOld, afterOldClear, clearedCurrent, afterCurrentClear }
      })
    )

    expect(result.clearedOld).toBe(false)
    expect(result.afterOldClear).toEqual(result.second)
    expect(result.clearedCurrent).toBe(true)
    expect(result.afterCurrentClear.generation).toBe(result.second.generation + 1)
    expect(result.afterCurrentClear.priceId).toBe("price_third")
  })

  it("invalidates the Checkout reservation that produced a terminal subscription", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const first = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })
        const syncGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: REVERSAL_EVENT_AT,
        })
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_terminal",
          status: "canceled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: REVERSAL_EVENT_AT,
          syncGeneration,
          annualCheckoutGeneration: first.generation,
        })
        const second = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })

        return { first, second }
      })
    )

    expect(result.second.generation).toBe(result.first.generation + 1)
  })

  it("keeps a newer Checkout reservation when an older terminal subscription arrives", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const first = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.billingAccounts)
                .set({ annualCheckoutExpiresAt: new Date("2020-01-01T00:00:00.000Z") })
                .where(eq(schema.billingAccounts.userId, TEST_USER_ID))
            })
          )
        )
        const current = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })
        const syncGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: REVERSAL_EVENT_AT,
        })
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_old_terminal",
          status: "incomplete_expired",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: REVERSAL_EVENT_AT,
          syncGeneration,
          annualCheckoutGeneration: first.generation,
        })
        const afterOldEvent = yield* repository.reserveAnnualCheckout({
          userId: TEST_USER_ID,
          priceId: "price_annual",
        })

        return { current, afterOldEvent }
      })
    )

    expect(result.afterOldEvent).toEqual(result.current)
  })

  it("uses new credits to cover refunded usage debt", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    const available = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository

        yield* repository.grantCredits({
          userId: TEST_USER_ID,
          amount: 10,
          kind: "annual_grant",
          reference: "invoice:refunded-after-usage",
          paymentReference: "pi_refunded_after_usage",
          expiresAt,
        })
        yield* Effect.promise(() =>
          seedTransactionUsage({
            references: Array.from({ length: 9 }, (_, index) => `used-${index}`),
            expiresAt,
          })
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

        return yield* repository.availableCredits(TEST_USER_ID)
      })
    )

    expect(available).toBe(1)
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

  it("accepts a newer subscription event after a delayed older event reserves later", async () => {
    const baselineEventAt = new Date("2026-08-13T12:00:02.000Z")
    const currentEventAt = new Date("2026-08-13T12:00:03.000Z")
    const delayedEventAt = new Date("2026-08-13T12:00:01.000Z")

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_ordered",
          status: "paused",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: baselineEventAt,
          syncGeneration: 0,
        })
        const currentGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: currentEventAt,
        })
        const delayedGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: delayedEventAt,
        })
        const acceptedDelayed = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_ordered",
          status: "past_due",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: delayedEventAt,
          syncGeneration: delayedGeneration,
        })
        const acceptedCurrent = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_ordered",
          status: "active",
          currentPeriodEnd: new Date("2027-08-13T12:00:03.000Z"),
          cancelAtPeriodEnd: false,
          eventCreatedAt: currentEventAt,
          syncGeneration: currentGeneration,
        })
        const account = Option.getOrThrow(yield* repository.findByUserId(TEST_USER_ID))

        return { acceptedDelayed, acceptedCurrent, account }
      })
    )

    expect(result.acceptedDelayed).toBe(false)
    expect(result.acceptedCurrent).toBe(true)
    expect(result.account).toMatchObject({
      stripeSubscriptionId: "sub_ordered",
      subscriptionStatus: "active",
      lastSubscriptionEventCreatedAt: currentEventAt,
    })
  })

  it("accepts a newer subscription clear after a delayed older event reserves later", async () => {
    const baselineEventAt = new Date("2026-08-13T12:00:02.000Z")
    const currentEventAt = new Date("2026-08-13T12:00:03.000Z")
    const delayedEventAt = new Date("2026-08-13T12:00:01.000Z")

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_deleted",
          status: "active",
          currentPeriodEnd: new Date("2027-08-13T12:00:02.000Z"),
          cancelAtPeriodEnd: false,
          eventCreatedAt: baselineEventAt,
          syncGeneration: 0,
        })
        const currentGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: currentEventAt,
        })
        const delayedGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: delayedEventAt,
        })
        const acceptedDelayed = yield* repository.saveSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_deleted",
          status: "past_due",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreatedAt: delayedEventAt,
          syncGeneration: delayedGeneration,
        })
        const acceptedCurrent = yield* repository.clearSubscription({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_deleted",
          eventCreatedAt: currentEventAt,
          syncGeneration: currentGeneration,
        })
        const account = Option.getOrThrow(yield* repository.findByUserId(TEST_USER_ID))

        return { acceptedDelayed, acceptedCurrent, account }
      })
    )

    expect(result.acceptedDelayed).toBe(false)
    expect(result.acceptedCurrent).toBe(true)
    expect(result.account).toMatchObject({
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      lastSubscriptionEventCreatedAt: currentEventAt,
    })
  })

  it("rejects a late subscription fetch after a newer sync reservation", async () => {
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* BillingRepository
        const eventCreatedAt = new Date("2026-08-13T12:00:00.000Z")
        const olderGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt,
        })
        const newerGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt,
        })
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
        const input = {
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          stripeSubscriptionId: "sub_moved_off_annual",
          eventCreatedAt: new Date("2026-08-13T12:00:01.000Z"),
        } as const
        const staleGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: input.eventCreatedAt,
        })
        const winningGeneration = yield* repository.reserveSubscriptionSync({
          stripeCustomerId: STRIPE_CUSTOMER_ID,
          eventCreatedAt: input.eventCreatedAt,
        })
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
