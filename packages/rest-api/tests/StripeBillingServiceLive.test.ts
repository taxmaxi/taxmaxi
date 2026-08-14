import { AuthUserId } from "@my/core/authentication"
import {
  BillingRepository,
  type BillingAccount,
  type BillingRepositoryService,
  type BillingSubscriptionStatus,
  UserRepository,
  type UserRepositoryService,
} from "@my/persistence/services"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it, vi } from "vitest"

interface StripeMockState {
  event: unknown
  invoicePayments: Array<unknown>
  prices: Array<unknown>
  retrievedPrices: Record<string, unknown>
  subscription: unknown
}

const stripeMockState = vi.hoisted<StripeMockState>(() => ({
  event: null,
  invoicePayments: [],
  prices: [],
  retrievedPrices: {},
  subscription: null,
}))

vi.mock("stripe", () => ({
  default: class StripeMock {
    readonly prices = {
      list: () => Promise.resolve({ data: stripeMockState.prices }),
      retrieve: (priceId: string) => Promise.resolve(stripeMockState.retrievedPrices[priceId]),
    }
    readonly subscriptions = {
      list: () => ({
        autoPagingToArray: () => Promise.resolve([stripeMockState.subscription]),
      }),
      retrieve: () => Promise.resolve(stripeMockState.subscription),
    }
    readonly invoicePayments = {
      list: () => ({
        autoPagingToArray: () => Promise.resolve(stripeMockState.invoicePayments),
      }),
    }
    readonly webhooks = {
      constructEventAsync: () => Promise.resolve(stripeMockState.event),
    }
  },
}))

import {
  allocateAnnualCreditsAcrossPayments,
  annualInvoiceProductId,
  annualInvoiceCreditAllocations,
  annualPaymentAllocationsFromInvoicePayments,
  annualCheckoutIdempotencyKey,
  buildAnnualCheckoutParams,
  buildTopUpCheckoutParams,
  chargePaymentReference,
  completeInvoiceLines,
  createReservedAnnualCheckoutSession,
  currentExistingAnnualSubscription,
  hasExistingTaxMaxiAnnualSubscription,
  hasFixedUnitAmount,
  invoicePaymentReference,
  isAnnualInvoiceEligible,
  isAnnualInvoiceLineEligible,
  findEligibleAnnualInvoiceLine,
  isPaidTopUpSessionEligible,
  isTaxMaxiAnnualSubscription,
  isValidAnnualPrice,
  isValidTopUpPrice,
  loadAllStripeItems,
  persistAnnualCreditAllocations,
  resolvePaidFulfillmentUserId,
  resolveReservedAnnualCheckoutPrice,
  shouldReconcileAnnualSubscription,
  subscriptionIdToClearAfterConfirmation,
  StripeBillingServiceLive,
  verifiedTopUpCustomer,
  validateStripeWebhookEvent,
} from "../src/layers/StripeBillingServiceLive.ts"
import { StripeBillingService } from "../src/services/StripeBillingService.ts"

const TEST_USER_ID = AuthUserId.make("00000000-0000-0000-0000-000000000192")
const OTHER_USER_ID = AuthUserId.make("00000000-0000-0000-0000-000000000193")

const billingAccount = ({
  userId = TEST_USER_ID,
  stripeCustomerId,
  subscriptionStatus = "active",
}: {
  readonly userId?: AuthUserId
  readonly stripeCustomerId: string | null
  readonly subscriptionStatus?: BillingSubscriptionStatus
}): BillingAccount => ({
  userId,
  stripeCustomerId,
  stripeCustomerGeneration: 0,
  stripeSubscriptionId: "sub_test",
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  lastSubscriptionEventCreatedAt: null,
})

const billingRepositoryStub: BillingRepositoryService = {
  findByUserId: () => Effect.succeed(Option.none()),
  findByStripeCustomerId: () => Effect.succeed(Option.none()),
  saveCustomer: () => Effect.void,
  saveSubscription: () => Effect.succeed(true),
  clearSubscription: () => Effect.succeed(true),
  reserveSubscriptionSync: () => Effect.succeed(1),
  clearCustomer: () => Effect.void,
  reserveAnnualCheckout: () =>
    Effect.succeed({
      generation: 1,
      expiresAt: new Date("2026-08-14T11:00:00.000Z"),
      priceId: "price_annual",
    }),
  grantCredits: () => Effect.succeed(true),
  reconcilePaymentCreditReversals: () => Effect.succeed(false),
  setPaymentCreditReversal: () => Effect.succeed(true),
  consumeTransactionCredit: () => Effect.succeed("exhausted"),
  availableCredits: () => Effect.succeed(0),
  hasProcessedEvent: () => Effect.succeed(false),
  markEventProcessed: () => Effect.void,
}

const userRepositoryStub: UserRepositoryService = {
  findById: () => Effect.succeed(Option.none()),
  findByEmail: () => Effect.succeed(Option.none()),
  create: () => Effect.dieMessage("unused user repository create"),
  update: () => Effect.dieMessage("unused user repository update"),
  delete: () => Effect.dieMessage("unused user repository delete"),
  findPlatformAdmins: () => Effect.succeed([]),
  isPlatformAdmin: () => Effect.succeed(false),
}

const repositoryLayers = Layer.merge(
  Layer.succeed(BillingRepository, billingRepositoryStub),
  Layer.succeed(UserRepository, userRepositoryStub)
)

const loadServiceWithoutStripeConfig = () =>
  Effect.runPromise(
    StripeBillingService.pipe(
      Effect.provide(StripeBillingServiceLive.pipe(Layer.provide(repositoryLayers))),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))
    )
  )

const loadServiceWithStripe = (billingRepository: BillingRepositoryService) =>
  Effect.runPromise(
    StripeBillingService.pipe(
      Effect.provide(
        StripeBillingServiceLive.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(BillingRepository, billingRepository),
              Layer.succeed(UserRepository, userRepositoryStub)
            )
          )
        )
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["STRIPE_SECRET_KEY", "sk_test"],
            ["STRIPE_WEBHOOK_SECRET", "whsec_test"],
          ])
        )
      )
    )
  )

describe("StripeBillingServiceLive", () => {
  it("scopes annual billing state to the TaxMaxi annual plan", () => {
    const subscription = ({
      lookupKey,
      product,
      interval = "year",
      intervalCount = 1,
      metadata = {},
    }: {
      readonly lookupKey: string | null
      readonly product: string
      readonly interval?: string
      readonly intervalCount?: number
      readonly metadata?: Readonly<Record<string, string>>
    }) => ({
      metadata,
      items: {
        data: [
          {
            price: {
              lookup_key: lookupKey,
              product,
              recurring: { interval, interval_count: intervalCount },
            },
          },
        ],
      },
    })

    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_archived",
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_archived",
          },
        }),
      })
    ).toBe(true)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({ lookupKey: null, product: "prod_annual" }),
        currentProductId: "prod_annual",
      })
    ).toBe(true)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_annual",
          interval: "month",
        }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_annual",
          intervalCount: 2,
        }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({ lookupKey: "professional_annual", product: "prod_other" }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_professional",
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_original_annual",
          },
        }),
      })
    ).toBe(false)
  })

  it("loads every invoice line when Stripe embeds only the first page", async () => {
    let loadCount = 0
    const lines = await Effect.runPromise(
      completeInvoiceLines({
        embeddedLines: ["add-on"],
        hasMore: true,
        loadAll: () =>
          Effect.sync(() => {
            loadCount += 1
            return ["add-on", "annual"]
          }),
      })
    )

    expect(lines).toEqual(["add-on", "annual"])
    expect(loadCount).toBe(1)
  })

  it("ignores stale local state and unrelated Stripe plans for annual Checkout", () => {
    const unrelatedSubscription = {
      status: "active",
      metadata: { plan_lookup_key: "taxmaxi_professional_annual" },
      items: {
        data: [
          {
            price: {
              lookup_key: "taxmaxi_professional_annual",
              product: "prod_pro",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }

    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [unrelatedSubscription],
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [
          {
            status: "active",
            metadata: {},
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_annual",
                    recurring: { interval: "month", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [
          {
            status: "past_due",
            metadata: {
              plan_lookup_key: "taxmaxi_annual_10k_eur",
              plan_product_id: "prod_archived_annual",
            },
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_archived_annual",
                    recurring: { interval: "year", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        currentProductId: "prod_annual",
      })
    ).toBe(true)
  })

  it("auto-pages Stripe subscriptions before checking annual Checkout eligibility", async () => {
    const firstPage = ["unrelated"]
    let receivedLimit = 0
    const allSubscriptions = await loadAllStripeItems({
      page: {
        autoPagingToArray: ({ limit }) => {
          receivedLimit = limit
          return Promise.resolve([...firstPage, "annual"])
        },
      },
    })

    expect(allSubscriptions).toEqual(["unrelated", "annual"])
    expect(receivedLimit).toBe(10_000)
  })

  it("prefers an active annual replacement over a deleted annual subscription", () => {
    const annualSubscription = (id: string, status: string) => ({
      id,
      status,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_annual",
      },
      items: {
        data: [
          {
            price: {
              lookup_key: null,
              product: "prod_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    })

    expect(
      currentExistingAnnualSubscription([
        annualSubscription("sub_deleted", "canceled"),
        annualSubscription("sub_replacement", "active"),
      ])
    ).toMatchObject({ id: "sub_replacement", status: "active" })
    expect(
      currentExistingAnnualSubscription(
        [
          {
            id: "sub_legacy_same_product",
            status: "active",
            metadata: {},
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_annual",
                    recurring: { interval: "year", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        "prod_annual"
      )
    ).toMatchObject({ id: "sub_legacy_same_product", status: "active" })
  })

  it("reconciles current annual and tracked off-plan subscription events only", () => {
    const subscription = ({
      id,
      lookupKey,
      product,
    }: {
      readonly id: string
      readonly lookupKey: string | null
      readonly product: string
    }) => ({
      id,
      metadata: {},
      items: {
        data: [
          {
            price: {
              lookup_key: lookupKey,
              product,
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    })

    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_annual",
          lookupKey: "taxmaxi_annual_10k_eur",
          product: "prod_annual",
        }),
        trackedSubscriptionId: null,
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_legacy_same_product",
          lookupKey: null,
          product: "prod_annual",
        }),
        trackedSubscriptionId: null,
        currentProductId: "prod_annual",
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_tracked",
          lookupKey: "professional_annual",
          product: "prod_professional",
        }),
        trackedSubscriptionId: "sub_tracked",
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_unrelated",
          lookupKey: "professional_annual",
          product: "prod_professional",
        }),
        trackedSubscriptionId: "sub_annual",
      })
    ).toBe(false)
  })

  it("clears the replacement subscription when confirmation finds no annual plan", () => {
    expect(
      subscriptionIdToClearAfterConfirmation({
        currentSubscriptionId: "sub_replacement",
        confirmedSubscriptionId: null,
      })
    ).toBe("sub_replacement")
    expect(
      subscriptionIdToClearAfterConfirmation({
        currentSubscriptionId: "sub_replacement",
        confirmedSubscriptionId: "sub_confirmed",
      })
    ).toBeNull()
  })

  it("enables Stripe Tax in annual and top-up Checkout payloads", () => {
    const price = { id: "price_annual", product: "prod_annual" }
    const annual = buildAnnualCheckoutParams({
      customer: "cus_test",
      price,
      userId: TEST_USER_ID,
      frontendUrl: "https://taxmaxi.test",
      expiresAt: new Date("2026-08-15T12:00:00.000Z"),
    })
    const topUp = buildTopUpCheckoutParams({
      customer: "cus_test",
      price: { id: "price_top_up", product: "prod_top_up" },
      userId: TEST_USER_ID,
      frontendUrl: "https://taxmaxi.test",
    })

    expect(annual).toMatchObject({
      mode: "subscription",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
    })
    expect(topUp).toMatchObject({
      mode: "payment",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
    })
  })

  it("keeps annual Checkout idempotency stable for one reservation", () => {
    const input = {
      userId: TEST_USER_ID,
      customer: "cus_test",
      generation: 3,
    } as const
    const firstRequest = annualCheckoutIdempotencyKey(input)
    const repeatedRequestAfterPriceChange = annualCheckoutIdempotencyKey(input)

    expect(firstRequest).toBe(repeatedRequestAfterPriceChange)
    expect(firstRequest).toBe(`taxmaxi-annual-checkout-${TEST_USER_ID}-cus_test-3`)
  })

  it("reuses the complete reserved annual Checkout request after the lookup key changes", async () => {
    const loadedPriceIds: Array<string> = []
    const requests: Array<{
      readonly params: {
        readonly line_items?: ReadonlyArray<{
          readonly price?: string
          readonly quantity?: number
        }>
      }
      readonly idempotencyKey: string
    }> = []
    const reservation = {
      generation: 3,
      expiresAt: new Date("2026-08-14T11:00:00.000Z"),
      priceId: "price_original",
    }
    const runCheckout = (currentPriceId: string) =>
      Effect.runPromise(
        createReservedAnnualCheckoutSession({
          currentPrice: { id: currentPriceId, product: "prod_annual" },
          reservation,
          customer: "cus_test",
          userId: TEST_USER_ID,
          frontendUrl: "https://taxmaxi.test",
          loadPrice: (priceId) =>
            Effect.sync(() => {
              loadedPriceIds.push(priceId)
              return { id: priceId, product: "prod_annual" }
            }),
          createSession: ({ params, idempotencyKey }) =>
            Effect.sync(() => {
              requests.push({ params, idempotencyKey })
              return { url: "https://checkout.stripe.test/original" }
            }),
        })
      )

    await runCheckout("price_original")
    await runCheckout("price_new")

    expect(loadedPriceIds).toEqual(["price_original"])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(requests[0]?.params.line_items).toEqual([{ price: "price_original", quantity: 1 }])
  })

  it("loads a reserved annual price only when it differs from the current lookup", async () => {
    const loadedPriceIds: Array<string> = []
    const price = await Effect.runPromise(
      resolveReservedAnnualCheckoutPrice({
        currentPrice: { id: "price_new" },
        reservedPriceId: "price_original",
        loadPrice: (priceId) =>
          Effect.sync(() => {
            loadedPriceIds.push(priceId)
            return { id: priceId }
          }),
      })
    )

    expect(price.id).toBe("price_original")
    expect(loadedPriceIds).toEqual(["price_original"])
  })

  it("rejects Stripe catalog prices without a fixed unit amount", () => {
    expect(hasFixedUnitAmount({ unit_amount: 1_000 })).toBe(true)
    expect(hasFixedUnitAmount({ unit_amount: null })).toBe(false)
  })

  it("validates the nested shapes used by accepted Stripe webhook events", async () => {
    const valid = await Effect.runPromise(
      Effect.either(
        validateStripeWebhookEvent({
          id: "evt_valid",
          created: 1_700_000_000,
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_valid",
              customer: "cus_valid",
              payment_intent: "pi_valid",
              payment_status: "paid",
              metadata: { purchase_kind: "top_up", taxmaxi_user_id: TEST_USER_ID },
            },
          },
        })
      )
    )
    const invalid = await Effect.runPromise(
      Effect.either(
        validateStripeWebhookEvent({
          id: "evt_invalid",
          created: 1_700_000_000,
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_invalid",
              customer: "cus_invalid",
              payment_intent: "pi_invalid",
              metadata: { purchase_kind: "top_up" },
            },
          },
        })
      )
    )
    const unrelatedInvoice = await Effect.runPromise(
      Effect.either(
        validateStripeWebhookEvent({
          id: "evt_unrelated_invoice",
          created: 1_700_000_000,
          type: "invoice.paid",
          data: {
            object: {
              id: "in_unrelated",
              amount_due: 0,
              billing_reason: "subscription_cycle",
              customer: "cus_unrelated",
              parent: {
                subscription_details: {
                  subscription: "sub_unrelated",
                  metadata: null,
                },
              },
              lines: { data: [], has_more: false },
            },
          },
        })
      )
    )

    expect(valid).toMatchObject({ _tag: "Right" })
    expect(unrelatedInvoice).toMatchObject({ _tag: "Right" })
    expect(invalid).toMatchObject({
      _tag: "Left",
      left: { message: "Invalid Stripe webhook event payload" },
    })
  })

  it("grants annual credits only for create or renewal invoices on the annual product", () => {
    expect(isValidAnnualPrice({ recurring: { interval: "year", interval_count: 1 } })).toBe(true)
    expect(isValidAnnualPrice({ recurring: { interval: "year", interval_count: 2 } })).toBe(false)
    expect(isValidAnnualPrice({ recurring: { interval: "month", interval_count: 1 } })).toBe(false)
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_cycle",
        planLookupKey: "taxmaxi_annual_10k_eur",
      })
    ).toBe(true)
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_cycle",
        planLookupKey: undefined,
      })
    ).toBe(true)
    expect(
      annualInvoiceProductId({
        planLookupKey: undefined,
        planProductId: undefined,
        currentProductId: "prod_annual",
      })
    ).toBe("prod_annual")
    expect(
      annualInvoiceProductId({
        planLookupKey: "taxmaxi_professional_annual",
        planProductId: "prod_professional",
        currentProductId: "prod_annual",
      })
    ).toBeNull()
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_update",
        planLookupKey: "taxmaxi_annual_10k_eur",
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_annual",
        currentProductId: "prod_annual",
      })
    ).toBe(true)
    expect(
      isAnnualInvoiceLineEligible({
        proration: true,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_annual",
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_other",
        currentProductId: "prod_annual",
      })
    ).toBe(false)

    expect(
      findEligibleAnnualInvoiceLine([
        {
          line: "add-on",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_702_678_400,
          interval: "month",
          intervalCount: 1,
          productId: "prod_add_on",
          currentProductId: "prod_annual",
        },
        {
          line: "annual",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_annual",
          currentProductId: "prod_annual",
        },
      ])
    ).toBe("annual")
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_702_678_400,
        interval: "month",
        intervalCount: 1,
        productId: "prod_annual",
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_763_072_000,
        interval: "year",
        intervalCount: 2,
        productId: "prod_annual",
        currentProductId: "prod_annual",
      })
    ).toBe(false)
  })

  it("splits annual credits across every paid PaymentIntent contribution", () => {
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_first", amountPaid: 4_000 },
        { paymentReference: "pi_second", amountPaid: 6_000 },
      ])
    ).toEqual([
      { paymentReference: "pi_first", credits: 4_000 },
      { paymentReference: "pi_second", credits: 6_000 },
    ])
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_first", amountPaid: 1 },
        { paymentReference: "pi_second", amountPaid: 2 },
      ]).reduce((total, payment) => total + payment.credits, 0)
    ).toBe(10_000)
  })

  it("persists one stable allowance for a zero-due annual invoice across retries", async () => {
    const input = {
      invoiceId: "in_zero_due",
      amountDue: 0,
      paymentAllocations: [],
    } as const

    const allocations = annualInvoiceCreditAllocations(input)
    expect(allocations).toEqual([
      {
        paymentReference: null,
        referenceSuffix: "invoice:in_zero_due",
        credits: 10_000,
      },
    ])
    const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
    const reconciled: Array<string> = []
    const persist = () =>
      Effect.runPromise(
        persistAnnualCreditAllocations({
          userId: TEST_USER_ID,
          subscriptionId: "sub_zero_due",
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          allocations,
          grantCredits: (grant) =>
            Effect.sync(() => {
              grants.push(grant)
              return true
            }),
          reconcilePaymentCreditReversals: (paymentReference) =>
            Effect.sync(() => {
              reconciled.push(paymentReference)
              return true
            }),
        })
      )
    await persist()
    await persist()

    expect(grants).toHaveLength(2)
    expect(grants[1]).toEqual(grants[0])
    expect(grants[0]).toMatchObject({
      amount: 10_000,
      kind: "annual_grant",
      paymentReference: null,
      reference: "stripe:annual:sub_zero_due:1700000000:1731536000:invoice:in_zero_due",
    })
    expect(reconciled).toEqual([])
    expect(
      annualInvoiceCreditAllocations({
        invoiceId: "in_missing_payment",
        amountDue: 1,
        paymentAllocations: [],
      })
    ).toEqual([])
  })

  it("keeps every supported paid invoice contribution separate", () => {
    expect(
      [
        { payment: { type: "payment_intent" as const, payment_intent: "pi_test" } },
        { payment: { type: "charge" as const, charge: "ch_test" } },
        { payment: { type: "payment_record" as const, payment_record: "pyr_test" } },
      ].map(invoicePaymentReference)
    ).toEqual(["pi_test", "ch_test", "pyr_test"])

    expect(
      invoicePaymentReference({
        payment: {
          type: "charge",
          charge: { id: "ch_with_intent", payment_intent: "pi_canonical" },
        },
      })
    ).toBe("pi_canonical")
    expect(chargePaymentReference({ id: "ch_without_intent", payment_intent: null })).toBe(
      "ch_without_intent"
    )
  })

  it("uses one canonical PaymentIntent reference from annual grant through reversal", async () => {
    const allocations = annualPaymentAllocationsFromInvoicePayments([
      {
        amount_paid: 10_000,
        payment: {
          type: "charge",
          charge: { id: "ch_annual", payment_intent: "pi_annual" },
        },
      },
    ])
    const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
    const reconciled: Array<string> = []
    await Effect.runPromise(
      persistAnnualCreditAllocations({
        userId: TEST_USER_ID,
        subscriptionId: "sub_annual",
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        allocations: annualInvoiceCreditAllocations({
          invoiceId: "in_annual",
          amountDue: 10_000,
          paymentAllocations: allocations,
        }),
        grantCredits: (grant) =>
          Effect.sync(() => {
            grants.push(grant)
            return true
          }),
        reconcilePaymentCreditReversals: (paymentReference) =>
          Effect.sync(() => {
            reconciled.push(paymentReference)
            return true
          }),
      })
    )

    expect(grants[0]?.paymentReference).toBe("pi_annual")
    expect(reconciled).toEqual(["pi_annual"])
    expect(chargePaymentReference({ id: "ch_annual", payment_intent: "pi_annual" })).toBe(
      grants[0]?.paymentReference
    )
  })

  it("requires top-up prices to be one-time", () => {
    expect(isValidTopUpPrice({ recurring: null })).toBe(true)
    expect(isValidTopUpPrice({ recurring: { interval: "month" } })).toBe(false)
    expect(isValidTopUpPrice({ recurring: { interval: "year" } })).toBe(false)
  })

  it("accepts delayed top-ups from payment facts without consulting current subscription state", () => {
    expect(isPaidTopUpSessionEligible({ purchaseKind: "top_up", paymentStatus: "paid" })).toBe(true)
    expect(isPaidTopUpSessionEligible({ purchaseKind: "top_up", paymentStatus: "unpaid" })).toBe(
      false
    )
    expect(isPaidTopUpSessionEligible({ purchaseKind: "annual", paymentStatus: "paid" })).toBe(
      false
    )
  })

  it("uses signed user metadata for paid fulfillment after the customer mapping changes", async () => {
    const resolved = await Effect.runPromise(
      resolvePaidFulfillmentUserId({
        metadataUserId: TEST_USER_ID,
        stripeCustomerId: "cus_deleted",
        findByUserId: (userId) =>
          Effect.succeed(
            Option.some(billingAccount({ userId, stripeCustomerId: "cus_replacement" }))
          ),
        findByStripeCustomerId: () =>
          Effect.succeed(
            Option.some(billingAccount({ userId: OTHER_USER_ID, stripeCustomerId: "cus_deleted" }))
          ),
      })
    )
    const invalid = await Effect.runPromise(
      Effect.either(
        resolvePaidFulfillmentUserId({
          metadataUserId: OTHER_USER_ID,
          stripeCustomerId: "cus_deleted",
          findByUserId: () => Effect.succeed(Option.none()),
          findByStripeCustomerId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_deleted" }))),
        })
      )
    )

    expect(resolved).toBe(TEST_USER_ID)
    expect(invalid).toMatchObject({
      _tag: "Left",
      left: { message: "TaxMaxi billing account not found" },
    })
  })

  it("uses the replacement customer for top-up Checkout after deleted-customer recovery", async () => {
    const requestedCustomers: Array<string> = []
    const customer = await Effect.runPromise(
      verifiedTopUpCustomer({
        account: Option.some(billingAccount({ stripeCustomerId: "cus_deleted" })),
        userId: TEST_USER_ID,
        getOrCreateCustomer: () => Effect.succeed("cus_replacement"),
        findByUserId: () =>
          Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_replacement" }))),
        hasCurrentAnnualSubscription: () => Effect.succeed(true),
      })
    )
    requestedCustomers.push(customer)

    expect(requestedCustomers).toEqual(["cus_replacement"])
    expect(requestedCustomers).not.toContain("cus_deleted")
  })

  it("rejects top-up Checkout when Stripe no longer has an active annual subscription", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        verifiedTopUpCustomer({
          account: Option.some(billingAccount({ stripeCustomerId: "cus_test" })),
          userId: TEST_USER_ID,
          getOrCreateCustomer: () => Effect.succeed("cus_test"),
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          hasCurrentAnnualSubscription: () => Effect.succeed(false),
        })
      )
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: "An active annual subscription is required" },
    })
  })

  it("allows top-up Checkout when Stripe is active while local subscription state is stale", async () => {
    const customer = await Effect.runPromise(
      verifiedTopUpCustomer({
        account: Option.some(
          billingAccount({ stripeCustomerId: "cus_test", subscriptionStatus: "canceled" })
        ),
        userId: TEST_USER_ID,
        getOrCreateCustomer: () => Effect.succeed("cus_test"),
        findByUserId: () =>
          Effect.succeed(
            Option.some(
              billingAccount({ stripeCustomerId: "cus_test", subscriptionStatus: "canceled" })
            )
          ),
        hasCurrentAnnualSubscription: () => Effect.succeed(true),
      })
    )

    expect(customer).toBe("cus_test")
  })

  it("syncs a legacy yearly subscription through the webhook service path", async () => {
    const annualPrice = {
      id: "price_annual",
      lookup_key: "taxmaxi_annual_10k_eur",
      product: "prod_annual",
      recurring: { interval: "year", interval_count: 1 },
    }
    stripeMockState.prices = [annualPrice]
    stripeMockState.subscription = {
      id: "sub_legacy_same_product",
      customer: "cus_test",
      status: "active",
      cancel_at_period_end: false,
      metadata: {},
      items: {
        data: [
          {
            current_period_end: 1_731_536_000,
            price: { ...annualPrice, lookup_key: null },
          },
        ],
      },
    }
    stripeMockState.event = {
      id: "evt_subscription_updated",
      created: 1_700_000_000,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_legacy_same_product", customer: "cus_test" } },
    }
    const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByStripeCustomerId: () =>
        Effect.succeed(
          Option.some({
            ...billingAccount({ stripeCustomerId: "cus_test" }),
            stripeSubscriptionId: null,
            subscriptionStatus: null,
          })
        ),
      saveSubscription: (input) =>
        Effect.sync(() => {
          saved.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(saved).toHaveLength(2)
    expect(saved[0]).toMatchObject({
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_legacy_same_product",
      status: "active",
    })
  })

  it("keeps annual grant and refund references aligned through the webhook service path", async () => {
    const annualPrice = {
      id: "price_annual",
      lookup_key: "taxmaxi_annual_10k_eur",
      product: "prod_annual",
      recurring: { interval: "year", interval_count: 1 },
    }
    stripeMockState.prices = [annualPrice]
    stripeMockState.retrievedPrices = { price_annual: annualPrice }
    stripeMockState.invoicePayments = [
      {
        amount_paid: 10_000,
        payment: {
          type: "charge",
          charge: { id: "ch_annual", payment_intent: "pi_annual" },
        },
      },
    ]
    stripeMockState.event = {
      id: "evt_invoice_paid",
      created: 1_700_000_000,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_annual",
          amount_due: 10_000,
          billing_reason: "subscription_cycle",
          customer: "cus_test",
          parent: {
            subscription_details: {
              subscription: "sub_legacy_same_product",
              metadata: null,
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                parent: { subscription_item_details: { proration: false } },
                pricing: { price_details: { price: "price_annual" } },
                period: { start: 1_700_000_000, end: 1_731_536_000 },
              },
            ],
          },
        },
      },
    }
    const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
    const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByStripeCustomerId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
      grantCredits: (input) =>
        Effect.sync(() => {
          grants.push(input)
          return true
        }),
      setPaymentCreditReversal: (input) =>
        Effect.sync(() => {
          reversals.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))
    stripeMockState.event = {
      id: "evt_charge_refunded",
      created: 1_700_000_100,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_annual",
          amount: 10_000,
          amount_refunded: 10_000,
          payment_intent: "pi_annual",
        },
      },
    }
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(grants[0]).toMatchObject({
      amount: 10_000,
      paymentReference: "pi_annual",
      reference: "stripe:annual:sub_legacy_same_product:1700000000:1731536000:pi_annual",
    })
    expect(reversals[0]).toMatchObject({
      paymentReference: "pi_annual",
      reversalGroup: "stripe:refund:ch_annual",
    })
  })

  it("starts without Stripe configuration and keeps local billing status available", async () => {
    const service = await loadServiceWithoutStripeConfig()
    const status = await Effect.runPromise(service.status(TEST_USER_ID))
    const catalog = await Effect.runPromise(Effect.either(service.catalog))
    const webhook = await Effect.runPromise(
      Effect.either(service.processWebhook({ payload: "{}", signature: "missing" }))
    )

    expect(status).toEqual({
      credits: 0,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
    expect(catalog).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe billing is not configured" },
    })
    expect(webhook).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe webhook is not configured" },
    })
  })
})
