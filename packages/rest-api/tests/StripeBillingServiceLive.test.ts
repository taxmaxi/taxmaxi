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
import { describe, expect, it } from "vitest"

import {
  allocateAnnualCreditsAcrossPayments,
  annualCheckoutIdempotencyKey,
  buildAnnualCheckoutParams,
  buildTopUpCheckoutParams,
  completeInvoiceLines,
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
  loadAllStripeItems,
  resolvePaidFulfillmentUserId,
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
    Effect.succeed({ generation: 1, expiresAt: new Date("2026-08-14T11:00:00.000Z") }),
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

describe("StripeBillingServiceLive", () => {
  it("scopes annual billing state to the TaxMaxi annual plan", () => {
    const subscription = ({
      lookupKey,
      product,
      metadata = {},
    }: {
      readonly lookupKey: string | null
      readonly product: string
      readonly metadata?: Readonly<Record<string, string>>
    }) => ({
      metadata,
      items: { data: [{ price: { lookup_key: lookupKey, product } }] },
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
        data: [{ price: { lookup_key: "taxmaxi_professional_annual", product: "prod_pro" } }],
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
            status: "past_due",
            metadata: {
              plan_lookup_key: "taxmaxi_annual_10k_eur",
              plan_product_id: "prod_archived_annual",
            },
            items: {
              data: [{ price: { lookup_key: null, product: "prod_archived_annual" } }],
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
      items: { data: [{ price: { lookup_key: null, product: "prod_annual" } }] },
    })

    expect(
      currentExistingAnnualSubscription([
        annualSubscription("sub_deleted", "canceled"),
        annualSubscription("sub_replacement", "active"),
      ])
    ).toMatchObject({ id: "sub_replacement", status: "active" })
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
      items: { data: [{ price: { lookup_key: lookupKey, product } }] },
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

  it("scopes annual Checkout idempotency to the selected Stripe price", () => {
    const input = {
      userId: TEST_USER_ID,
      customer: "cus_test",
      generation: 3,
    } as const
    const oldPrice = annualCheckoutIdempotencyKey({ ...input, priceId: "price_old" })
    const newPrice = annualCheckoutIdempotencyKey({ ...input, priceId: "price_new" })

    expect(oldPrice).toContain("price_old")
    expect(newPrice).toContain("price_new")
    expect(oldPrice).not.toBe(newPrice)
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

  it("keeps every supported paid invoice contribution separate", () => {
    expect(
      [
        { payment: { type: "payment_intent" as const, payment_intent: "pi_test" } },
        { payment: { type: "charge" as const, charge: "ch_test" } },
        { payment: { type: "payment_record" as const, payment_record: "pyr_test" } },
      ].map(invoicePaymentReference)
    ).toEqual(["pi_test", "ch_test", "pyr_test"])
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
