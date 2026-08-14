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
  checkoutParams: Array<unknown>
  charge: unknown
  dispute: unknown
  event: unknown
  invoicePayments: Array<unknown>
  paymentRecord: unknown
  prices: Array<{
    readonly lookup_key?: string | null
    readonly [key: string]: unknown
  }>
  retrievedPrices: Record<string, unknown>
  refunds: Array<unknown>
  refundPagingLimit: number | null
  retrievedRefund: unknown
  listedSubscriptions: Array<unknown> | null
  subscription: unknown
}

const stripeMockState = vi.hoisted<StripeMockState>(() => ({
  checkoutParams: [],
  charge: null,
  dispute: null,
  event: null,
  invoicePayments: [],
  paymentRecord: null,
  prices: [],
  retrievedPrices: {},
  refunds: [],
  refundPagingLimit: null,
  retrievedRefund: null,
  listedSubscriptions: null,
  subscription: null,
}))

vi.mock("stripe", () => ({
  default: class StripeMock {
    readonly charges = {
      retrieve: () => Promise.resolve(stripeMockState.charge),
    }
    readonly checkout = {
      sessions: {
        create: (params: unknown) => {
          stripeMockState.checkoutParams.push(params)
          return Promise.resolve({ url: "https://checkout.stripe.test/session" })
        },
      },
    }
    readonly customers = {
      retrieve: () => Promise.resolve({ deleted: false }),
    }
    readonly disputes = {
      retrieve: () => Promise.resolve(stripeMockState.dispute),
    }
    readonly prices = {
      list: ({ lookup_keys: lookupKeys }: { readonly lookup_keys?: ReadonlyArray<string> } = {}) =>
        Promise.resolve({
          data:
            lookupKeys === undefined
              ? stripeMockState.prices
              : stripeMockState.prices.filter(
                  (price) =>
                    price.lookup_key !== undefined && lookupKeys.includes(price.lookup_key ?? "")
                ),
        }),
      retrieve: (priceId: string) => Promise.resolve(stripeMockState.retrievedPrices[priceId]),
    }
    readonly subscriptions = {
      list: () => ({
        autoPagingToArray: () =>
          Promise.resolve(stripeMockState.listedSubscriptions ?? [stripeMockState.subscription]),
      }),
      retrieve: () => Promise.resolve(stripeMockState.subscription),
    }
    readonly invoicePayments = {
      list: () => ({
        autoPagingToArray: () => Promise.resolve(stripeMockState.invoicePayments),
      }),
    }
    readonly paymentRecords = {
      retrieve: () => Promise.resolve(stripeMockState.paymentRecord),
    }
    readonly refunds = {
      list: () => ({
        autoPagingToArray: ({ limit }: { readonly limit: number }) => {
          stripeMockState.refundPagingLimit = limit
          return Promise.resolve(stripeMockState.refunds)
        },
      }),
      retrieve: () => Promise.resolve(stripeMockState.retrievedRefund),
    }
    readonly webhooks = {
      constructEventAsync: () => Promise.resolve(stripeMockState.event),
    }
  },
}))

import {
  allocateCreditNoteReversalAcrossPayments,
  allocateAnnualCreditsAcrossPayments,
  annualInvoiceProductIds,
  annualInvoiceCreditAllocations,
  annualPaymentAllocationsFromInvoicePayments,
  annualCheckoutIdempotencyKey,
  buildAnnualCheckoutParams,
  buildTopUpCheckoutParams,
  chargePaymentReference,
  completeInvoiceLines,
  createReservedAnnualCheckoutSession,
  currentExistingAnnualSubscription,
  disputeCreditReversal,
  hasExistingTaxMaxiAnnualSubscription,
  hasCompleteCatalogLookupKeys,
  hasFixedUnitAmount,
  invoicePaymentReference,
  isCatalogPriceCadenceValid,
  isAnnualInvoiceEligible,
  isAnnualInvoiceLineEligible,
  findEligibleAnnualInvoiceLine,
  isPaidTopUpSessionEligible,
  isSupportedCatalogCurrency,
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
        subscription: subscription({
          lookupKey: null,
          product: "prod_partially_tagged_archived",
          metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
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
      generation: 3,
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
      cancel_url: "https://taxmaxi.test/app/billing",
      subscription_data: {
        metadata: { annual_checkout_generation: "3" },
      },
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

  it("validates the cadence promised by every Stripe catalog lookup key", () => {
    const yearly = { recurring: { interval: "year", interval_count: 1 } }
    const monthly = { recurring: { interval: "month", interval_count: 1 } }
    const multiYear = { recurring: { interval: "year", interval_count: 2 } }
    const oneTime = { recurring: null }

    for (const lookupKey of [
      "taxmaxi_annual_10k_eur",
      "taxmaxi_professional_annual_100k_eur",
      "taxmaxi_professional_matter_annual_10k_eur",
    ]) {
      expect(isCatalogPriceCadenceValid({ lookupKey, price: yearly })).toBe(true)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: monthly })).toBe(false)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: multiYear })).toBe(false)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: oneTime })).toBe(false)
    }

    for (const lookupKey of [
      "taxmaxi_topup_1k_eur",
      "taxmaxi_professional_topup_20k_eur",
      "taxmaxi_enterprise_pilot_eur",
    ]) {
      expect(isCatalogPriceCadenceValid({ lookupKey, price: oneTime })).toBe(true)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: yearly })).toBe(false)
    }
  })

  it("accepts only one complete EUR catalog", () => {
    const prices = [
      "taxmaxi_annual_10k_eur",
      "taxmaxi_topup_1k_eur",
      "taxmaxi_professional_annual_100k_eur",
      "taxmaxi_professional_matter_annual_10k_eur",
      "taxmaxi_professional_topup_20k_eur",
      "taxmaxi_enterprise_pilot_eur",
    ].map((lookup_key) => ({ lookup_key }))

    expect(hasCompleteCatalogLookupKeys(prices)).toBe(true)
    expect(hasCompleteCatalogLookupKeys(prices.slice(1))).toBe(false)
    expect(
      hasCompleteCatalogLookupKeys([...prices.slice(1), { lookup_key: "taxmaxi_topup_1k_eur" }])
    ).toBe(false)
    expect(isSupportedCatalogCurrency("eur")).toBe(true)
    expect(isSupportedCatalogCurrency("usd")).toBe(false)
    expect(isSupportedCatalogCurrency("jpy")).toBe(false)
  })

  it("rejects a catalog price whose cadence contradicts its lookup key", async () => {
    stripeMockState.prices = [
      {
        id: "price_professional_monthly",
        lookup_key: "taxmaxi_professional_annual_100k_eur",
        product: "prod_professional",
        recurring: { interval: "month", interval_count: 1 },
        unit_amount: 15_900,
        currency: "eur",
        tax_behavior: "exclusive",
      },
    ]
    const service = await loadServiceWithStripe(billingRepositoryStub)

    const result = await Effect.runPromise(Effect.either(service.catalog))

    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe catalog price cadence does not match its lookup key" },
    })
  })

  it("rejects partial and non-EUR Stripe catalogs", async () => {
    const annualPrice = {
      id: "price_annual",
      lookup_key: "taxmaxi_annual_10k_eur",
      product: "prod_annual",
      recurring: { interval: "year", interval_count: 1 },
      unit_amount: 15_900,
      currency: "eur",
      tax_behavior: "inclusive",
    }
    stripeMockState.prices = [annualPrice]
    const service = await loadServiceWithStripe(billingRepositoryStub)

    const partial = await Effect.runPromise(Effect.either(service.catalog))
    stripeMockState.prices = [{ ...annualPrice, currency: "usd" }]
    const nonEur = await Effect.runPromise(Effect.either(service.catalog))

    expect(partial).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe catalog must include every supported lookup key exactly once" },
    })
    expect(nonEur).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe catalog prices must use EUR" },
    })
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
    const invalidDeletedSubscription = await Effect.runPromise(
      Effect.either(
        validateStripeWebhookEvent({
          id: "evt_invalid_deleted_subscription",
          created: 1_700_000_000,
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_invalid_deleted",
              customer: "cus_invalid_deleted",
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
    expect(invalidDeletedSubscription).toMatchObject({
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
      annualInvoiceProductIds({
        planLookupKey: undefined,
        planProductId: undefined,
        currentProductId: "prod_annual",
      })
    ).toEqual(["prod_annual"])
    expect(
      annualInvoiceProductIds({
        planLookupKey: "taxmaxi_professional_annual",
        planProductId: "prod_professional",
        currentProductId: "prod_annual",
      })
    ).toBeNull()
    expect(
      annualInvoiceProductIds({
        planLookupKey: "taxmaxi_annual_10k_eur",
        planProductId: "prod_original_annual",
        currentProductId: "prod_replacement_annual",
      })
    ).toEqual(["prod_original_annual", "prod_replacement_annual"])
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
        allowedProductIds: ["prod_annual"],
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
        allowedProductIds: ["prod_annual"],
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
        allowedProductIds: ["prod_annual"],
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
          allowedProductIds: ["prod_annual"],
        },
        {
          line: "annual",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_annual",
          allowedProductIds: ["prod_annual"],
        },
      ])
    ).toBe("annual")
    expect(
      findEligibleAnnualInvoiceLine([
        {
          line: "first-yearly-line",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_first",
          allowedProductIds: undefined,
        },
        {
          line: "second-yearly-line",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_second",
          allowedProductIds: undefined,
        },
      ])
    ).toBeUndefined()
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_702_678_400,
        interval: "month",
        intervalCount: 1,
        productId: "prod_annual",
        allowedProductIds: ["prod_annual"],
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
        allowedProductIds: ["prod_annual"],
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
      { paymentReference: "pi_first", paymentAmount: 4_000, credits: 4_000 },
      { paymentReference: "pi_second", paymentAmount: 6_000, credits: 6_000 },
    ])
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_first", amountPaid: 1 },
        { paymentReference: "pi_second", amountPaid: 2 },
      ]).reduce((total, payment) => total + payment.credits, 0)
    ).toBe(10_000)
  })

  it("allocates credit-note reversals deterministically across invoice payments", () => {
    const payments = [
      { paymentReference: "pi_second", paymentAmount: 6_000 },
      { paymentReference: "pi_first", paymentAmount: 4_000 },
    ]

    expect(allocateCreditNoteReversalAcrossPayments({ reversedAmount: 7_000, payments })).toEqual([
      { paymentReference: "pi_first", paymentAmount: 4_000, reversedAmount: 4_000 },
      { paymentReference: "pi_second", paymentAmount: 6_000, reversedAmount: 3_000 },
    ])
    expect(
      allocateCreditNoteReversalAcrossPayments({ reversedAmount: 10_001, payments })
    ).toBeNull()
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
        paymentAmount: null,
        stripeInvoiceId: "in_zero_due",
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

  it("maps only payment-loss dispute states to a credit reversal", () => {
    expect(disputeCreditReversal({ status: "warning_closed", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "won", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "prevented", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "lost", amount: 15_900 })).toEqual({
      reversedAmount: 15_900,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "needs_response", amount: 15_900 })).toEqual({
      reversedAmount: 15_900,
      terminal: false,
    })
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

  it("syncs a tagged archived subscription without an active annual catalog price", async () => {
    const archivedAnnualPrice = {
      id: "price_archived_annual",
      lookup_key: null,
      product: "prod_archived_annual",
      recurring: { interval: "year", interval_count: 1 },
    }
    stripeMockState.prices = []
    stripeMockState.subscription = {
      id: "sub_archived_annual",
      customer: "cus_test",
      status: "past_due",
      cancel_at_period_end: false,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_archived_annual",
      },
      items: {
        data: [{ current_period_end: 1_731_536_000, price: archivedAnnualPrice }],
      },
    }
    stripeMockState.event = {
      id: "evt_archived_subscription_updated",
      created: 1_700_000_000,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_archived_annual", customer: "cus_test" } },
    }
    const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByStripeCustomerId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
      saveSubscription: (input) =>
        Effect.sync(() => {
          saved.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(saved).toHaveLength(2)
    expect(saved[0]).toMatchObject({
      stripeSubscriptionId: "sub_archived_annual",
      status: "past_due",
    })
  })

  it("invalidates the producing Checkout when deletion arrives before local tracking", async () => {
    const deletedSubscription = {
      id: "sub_deleted_before_tracking",
      customer: "cus_test",
      status: "canceled",
      cancel_at_period_end: false,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_annual",
        annual_checkout_generation: "7",
      },
      items: {
        data: [
          {
            current_period_end: 1_731_536_000,
            price: {
              lookup_key: null,
              product: "prod_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }
    stripeMockState.prices = []
    stripeMockState.subscription = deletedSubscription
    stripeMockState.listedSubscriptions = []
    stripeMockState.event = {
      id: "evt_deleted_before_tracking",
      created: 1_700_000_000,
      type: "customer.subscription.deleted",
      data: { object: deletedSubscription },
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
    stripeMockState.listedSubscriptions = null

    expect(saved).toContainEqual(
      expect.objectContaining({
        stripeSubscriptionId: deletedSubscription.id,
        status: "canceled",
        annualCheckoutGeneration: 7,
      })
    )
  })

  it("restores an active replacement after a late terminal event for an old subscription", async () => {
    const oldSubscription = {
      id: "sub_old_terminal",
      customer: "cus_test",
      status: "canceled",
      cancel_at_period_end: false,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_old",
        annual_checkout_generation: "4",
      },
      items: {
        data: [
          {
            current_period_end: 1_700_000_000,
            price: {
              lookup_key: null,
              product: "prod_old",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }
    const replacementSubscription = {
      id: "sub_active_replacement",
      customer: "cus_test",
      status: "active",
      cancel_at_period_end: false,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_replacement",
        annual_checkout_generation: "5",
      },
      items: {
        data: [
          {
            current_period_end: 1_731_536_000,
            price: {
              lookup_key: null,
              product: "prod_replacement",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }
    stripeMockState.subscription = oldSubscription
    stripeMockState.listedSubscriptions = [replacementSubscription]
    stripeMockState.event = {
      id: "evt_old_subscription_terminal",
      created: 1_700_000_000,
      type: "customer.subscription.updated",
      data: { object: { id: oldSubscription.id, customer: "cus_test" } },
    }
    const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByStripeCustomerId: () =>
        Effect.succeed(
          Option.some({
            ...billingAccount({ stripeCustomerId: "cus_test" }),
            stripeSubscriptionId: replacementSubscription.id,
          })
        ),
      saveSubscription: (input) =>
        Effect.sync(() => {
          saved.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))
    stripeMockState.listedSubscriptions = null

    expect(saved[0]).toMatchObject({
      stripeSubscriptionId: oldSubscription.id,
      status: "canceled",
      annualCheckoutGeneration: 4,
    })
    expect(saved.at(-1)).toMatchObject({
      stripeSubscriptionId: replacementSubscription.id,
      status: "active",
      annualCheckoutGeneration: 5,
    })
  })

  it("clears a deleted tagged subscription without an active annual catalog price", async () => {
    stripeMockState.prices = []
    stripeMockState.subscription = {
      id: "sub_archived_deleted",
      customer: "cus_test",
      status: "canceled",
      cancel_at_period_end: false,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_archived_annual",
      },
      items: {
        data: [
          {
            current_period_end: 1_731_536_000,
            price: {
              lookup_key: null,
              product: "prod_archived_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }
    stripeMockState.event = {
      id: "evt_archived_subscription_deleted",
      created: 1_700_000_000,
      type: "customer.subscription.deleted",
      data: { object: stripeMockState.subscription },
    }
    const cleared: Array<Parameters<BillingRepositoryService["clearSubscription"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByStripeCustomerId: () =>
        Effect.succeed(
          Option.some({
            ...billingAccount({ stripeCustomerId: "cus_test" }),
            stripeSubscriptionId: "sub_archived_deleted",
          })
        ),
      clearSubscription: (input) =>
        Effect.sync(() => {
          cleared.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(cleared).toEqual([
      {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_archived_deleted",
        eventCreatedAt: new Date("2023-11-14T22:13:20.000Z"),
        syncGeneration: 1,
      },
    ])
  })

  it("allows an active tagged archived subscription to buy a top-up", async () => {
    stripeMockState.checkoutParams = []
    stripeMockState.prices = [
      {
        id: "price_top_up",
        lookup_key: "taxmaxi_topup_1k_eur",
        product: "prod_top_up",
        recurring: null,
        unit_amount: 2_000,
        currency: "eur",
      },
    ]
    stripeMockState.subscription = {
      id: "sub_archived_annual",
      customer: "cus_test",
      status: "active",
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
    }
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByUserId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
    })

    const checkoutUrl = await Effect.runPromise(service.createTopUpCheckout(TEST_USER_ID))

    expect(checkoutUrl).toBe("https://checkout.stripe.test/session")
    expect(stripeMockState.checkoutParams[0]).toMatchObject({
      mode: "payment",
      customer: "cus_test",
      line_items: [{ price: "price_top_up", quantity: 1 }],
    })
  })

  it("rejects unsupported direct Checkout prices before creating a session", async () => {
    stripeMockState.checkoutParams = []
    stripeMockState.prices = [
      {
        id: "price_top_up_tiered",
        lookup_key: "taxmaxi_topup_1k_eur",
        product: "prod_top_up",
        recurring: null,
        unit_amount: null,
        currency: "eur",
      },
    ]
    stripeMockState.subscription = {
      id: "sub_active_annual",
      customer: "cus_test",
      status: "active",
      metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
      items: {
        data: [
          {
            price: {
              lookup_key: "taxmaxi_annual_10k_eur",
              product: "prod_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByUserId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
    })

    const tieredTopUp = await Effect.runPromise(
      Effect.either(service.createTopUpCheckout(TEST_USER_ID))
    )

    stripeMockState.prices = [
      {
        id: "price_annual_usd",
        lookup_key: "taxmaxi_annual_10k_eur",
        product: "prod_annual",
        recurring: { interval: "year", interval_count: 1 },
        unit_amount: 15_900,
        currency: "usd",
      },
    ]
    stripeMockState.listedSubscriptions = []
    const nonEurAnnual = await Effect.runPromise(
      Effect.either(service.createAnnualCheckout(TEST_USER_ID))
    )
    stripeMockState.listedSubscriptions = null

    expect(tieredTopUp).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe Checkout prices must have a fixed unit amount" },
    })
    expect(nonEurAnnual).toMatchObject({
      _tag: "Left",
      left: { message: "Stripe Checkout prices must use EUR" },
    })
    expect(stripeMockState.checkoutParams).toEqual([])
  })

  it("blocks duplicate annual Checkout for a partially tagged archived subscription", async () => {
    stripeMockState.checkoutParams = []
    stripeMockState.prices = [
      {
        id: "price_replacement_annual",
        lookup_key: "taxmaxi_annual_10k_eur",
        product: "prod_replacement_annual",
        recurring: { interval: "year", interval_count: 1 },
        unit_amount: 15_900,
        currency: "eur",
      },
    ]
    stripeMockState.subscription = {
      id: "sub_partially_tagged_archived",
      customer: "cus_test",
      status: "active",
      metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
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
    }
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByUserId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
    })

    const result = await Effect.runPromise(
      Effect.either(service.createAnnualCheckout(TEST_USER_ID))
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: "This account already has a subscription" },
    })
    expect(stripeMockState.checkoutParams).toEqual([])
  })

  it("grants a paid renewal from tagged archived subscription facts", async () => {
    const archivedAnnualPrice = {
      id: "price_archived_annual",
      lookup_key: null,
      product: "prod_archived_annual",
      recurring: { interval: "year", interval_count: 1 },
    }
    stripeMockState.prices = []
    stripeMockState.retrievedPrices = { price_archived_annual: archivedAnnualPrice }
    stripeMockState.invoicePayments = [
      {
        amount_paid: 15_900,
        payment: { type: "payment_intent", payment_intent: "pi_archived_renewal" },
      },
    ]
    stripeMockState.event = {
      id: "evt_archived_invoice_paid",
      created: 1_700_000_000,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_archived_renewal",
          amount_due: 15_900,
          billing_reason: "subscription_cycle",
          customer: "cus_test",
          parent: {
            subscription_details: {
              subscription: "sub_archived_annual",
              metadata: {
                plan_lookup_key: "taxmaxi_annual_10k_eur",
                taxmaxi_user_id: TEST_USER_ID,
              },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                parent: { subscription_item_details: { proration: false } },
                pricing: { price_details: { price: "price_archived_annual" } },
                period: { start: 1_700_000_000, end: 1_731_536_000 },
              },
            ],
          },
        },
      },
    }
    const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByUserId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
      grantCredits: (input) =>
        Effect.sync(() => {
          grants.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      userId: TEST_USER_ID,
      amount: 10_000,
      paymentReference: "pi_archived_renewal",
      reference: "stripe:annual:sub_archived_annual:1700000000:1731536000:pi_archived_renewal",
    })
  })

  it("grants a paid renewal after the annual subscription moves to a new product", async () => {
    const replacementAnnualPrice = {
      id: "price_replacement_annual",
      lookup_key: "taxmaxi_annual_10k_eur",
      product: "prod_replacement_annual",
      recurring: { interval: "year", interval_count: 1 },
      unit_amount: 15_900,
      currency: "eur",
      tax_behavior: "inclusive",
    }
    stripeMockState.prices = [replacementAnnualPrice]
    stripeMockState.retrievedPrices = { price_replacement_annual: replacementAnnualPrice }
    stripeMockState.invoicePayments = [
      {
        amount_paid: 15_900,
        payment: { type: "payment_intent", payment_intent: "pi_migrated_renewal" },
      },
    ]
    stripeMockState.event = {
      id: "evt_migrated_invoice_paid",
      created: 1_700_000_000,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_migrated_renewal",
          amount_due: 15_900,
          billing_reason: "subscription_cycle",
          customer: "cus_test",
          parent: {
            subscription_details: {
              subscription: "sub_migrated_annual",
              metadata: {
                plan_lookup_key: "taxmaxi_annual_10k_eur",
                plan_product_id: "prod_original_annual",
                taxmaxi_user_id: TEST_USER_ID,
              },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                parent: { subscription_item_details: { proration: false } },
                pricing: { price_details: { price: "price_replacement_annual" } },
                period: { start: 1_700_000_000, end: 1_731_536_000 },
              },
            ],
          },
        },
      },
    }
    const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      findByUserId: () =>
        Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
      grantCredits: (input) =>
        Effect.sync(() => {
          grants.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      amount: 10_000,
      paymentReference: "pi_migrated_renewal",
      stripeInvoiceId: "in_migrated_renewal",
    })
  })

  it("restores credits when a Stripe inquiry closes without a chargeback", async () => {
    stripeMockState.event = {
      id: "evt_inquiry_closed",
      created: 1_700_000_000,
      type: "charge.dispute.closed",
      data: { object: { id: "dp_inquiry" } },
    }
    stripeMockState.dispute = {
      id: "dp_inquiry",
      amount: 15_900,
      status: "warning_closed",
      charge: "ch_inquiry",
    }
    stripeMockState.charge = {
      id: "ch_inquiry",
      amount: 15_900,
      payment_intent: "pi_inquiry",
    }
    const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      setPaymentCreditReversal: (input) =>
        Effect.sync(() => {
          reversals.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversals).toHaveLength(1)
    expect(reversals[0]).toMatchObject({
      paymentReference: "pi_inquiry",
      reversedAmount: 0,
      terminal: true,
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
    stripeMockState.refunds = [
      {
        id: "re_annual",
        amount: 10_000,
        status: "succeeded",
      },
    ]
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(grants[0]).toMatchObject({
      amount: 10_000,
      paymentReference: "pi_annual",
      paymentAmount: 10_000,
      stripeInvoiceId: "in_annual",
      reference: "stripe:annual:sub_legacy_same_product:1700000000:1731536000:pi_annual",
    })
    expect(reversals[0]).toMatchObject({
      paymentReference: "pi_annual",
      reversalGroup: "stripe:refund:re_annual:payment",
      lossReference: "stripe:refund:re_annual",
      stripeInvoiceId: null,
      terminal: true,
    })
    expect(stripeMockState.refundPagingLimit).toBe(10_000)

    stripeMockState.retrievedRefund = {
      id: "re_annual",
      amount: 10_000,
      charge: "ch_annual",
      payment_intent: "pi_annual",
      status: "succeeded",
    }
    stripeMockState.event = {
      id: "evt_credit_note_created",
      created: 1_700_000_200,
      type: "credit_note.created",
      data: {
        object: {
          id: "cn_annual",
          currency: "eur",
          invoice: "in_annual",
          post_payment_amount: 10_000,
          status: "issued",
          refunds: [
            {
              amount_refunded: 10_000,
              payment_record_refund: null,
              refund: "re_annual",
              type: "refund",
            },
          ],
        },
      },
    }
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversals[1]).toMatchObject({
      paymentReference: "pi_annual",
      reversalGroup: "stripe:credit-note:cn_annual:refund:re_annual",
      lossReference: "stripe:refund:re_annual",
      reversedAmount: 10_000,
      stripeInvoiceId: "in_annual",
      terminal: true,
    })
  })

  it("waits for a credit-note refund to succeed before reversing credits", async () => {
    stripeMockState.retrievedRefund = {
      id: "re_credit_note_pending",
      amount: 1_000,
      charge: "ch_credit_note_pending",
      payment_intent: "pi_credit_note_pending",
      status: "pending",
    }
    stripeMockState.charge = {
      id: "ch_credit_note_pending",
      amount: 2_000,
      payment_intent: "pi_credit_note_pending",
    }
    stripeMockState.event = {
      id: "evt_credit_note_pending",
      created: 1_700_000_000,
      type: "credit_note.created",
      data: {
        object: {
          id: "cn_pending_refund",
          currency: "eur",
          invoice: "in_pending_refund",
          post_payment_amount: 1_000,
          status: "issued",
          refunds: [
            {
              amount_refunded: 1_000,
              payment_record_refund: null,
              refund: "re_credit_note_pending",
              type: "refund",
            },
          ],
        },
      },
    }
    const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      setPaymentCreditReversal: (input) =>
        Effect.sync(() => {
          reversals.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))
    expect(reversals).toEqual([])

    stripeMockState.event = {
      id: "evt_credit_note_refund_succeeded",
      created: 1_700_000_100,
      type: "refund.updated",
      data: {
        object: {
          id: "re_credit_note_pending",
          amount: 1_000,
          charge: "ch_credit_note_pending",
          payment_intent: "pi_credit_note_pending",
          status: "succeeded",
        },
      },
    }
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversals).toEqual([
      expect.objectContaining({
        paymentReference: "pi_credit_note_pending",
        reversalGroup: "stripe:refund:re_credit_note_pending:payment",
        lossReference: "stripe:refund:re_credit_note_pending",
        reversedAmount: 1_000,
        terminal: true,
      }),
    ])
  })

  it("reverses credits when a pending refund later succeeds", async () => {
    stripeMockState.charge = {
      id: "ch_async_refund",
      amount: 2_000,
      payment_intent: "pi_async_refund",
    }
    stripeMockState.event = {
      id: "evt_async_refund_pending",
      created: 1_700_000_000,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_async_refund",
          amount: 2_000,
          amount_refunded: 1_000,
          payment_intent: "pi_async_refund",
        },
      },
    }
    stripeMockState.refunds = [
      {
        id: "re_async_refund",
        amount: 1_000,
        status: "pending",
      },
    ]
    const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      setPaymentCreditReversal: (input) =>
        Effect.sync(() => {
          reversals.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))
    expect(reversals).toEqual([])

    stripeMockState.event = {
      id: "evt_async_refund_succeeded",
      created: 1_700_000_100,
      type: "refund.updated",
      data: {
        object: {
          id: "re_async_refund",
          amount: 1_000,
          charge: "ch_async_refund",
          payment_intent: "pi_async_refund",
          status: "succeeded",
        },
      },
    }
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversals).toEqual([
      expect.objectContaining({
        paymentReference: "pi_async_refund",
        reversalGroup: "stripe:refund:re_async_refund:payment",
        lossReference: "stripe:refund:re_async_refund",
        reversedAmount: 1_000,
        paymentAmount: 2_000,
        terminal: true,
      }),
    ])
  })

  it("short-circuits duplicate Stripe webhook deliveries", async () => {
    stripeMockState.event = {
      id: "evt_already_processed",
      created: 1_700_000_000,
      type: "refund.updated",
      data: {
        object: {
          id: "re_already_processed",
          amount: 1_000,
          charge: "ch_already_processed",
          payment_intent: "pi_already_processed",
          status: "succeeded",
        },
      },
    }
    let reversalCalls = 0
    let processedCalls = 0
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      hasProcessedEvent: () => Effect.succeed(true),
      setPaymentCreditReversal: () =>
        Effect.sync(() => {
          reversalCalls += 1
          return true
        }),
      markEventProcessed: () =>
        Effect.sync(() => {
          processedCalls += 1
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversalCalls).toBe(0)
    expect(processedCalls).toBe(0)
  })

  it("reverses PaymentRecord-funded annual credits from credit note refunds", async () => {
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
        payment: { type: "payment_record", payment_record: "pr_annual" },
      },
    ]
    stripeMockState.event = {
      id: "evt_payment_record_invoice_paid",
      created: 1_700_000_000,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_payment_record_annual",
          amount_due: 10_000,
          billing_reason: "subscription_cycle",
          customer: "cus_test",
          parent: {
            subscription_details: {
              subscription: "sub_payment_record_annual",
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
    stripeMockState.paymentRecord = {
      id: "pr_annual",
      amount: { currency: "eur", value: 10_000 },
    }
    stripeMockState.event = {
      id: "evt_payment_record_refunded",
      created: 1_700_000_100,
      type: "credit_note.created",
      data: {
        object: {
          id: "cn_payment_record_refund",
          currency: "eur",
          invoice: "in_payment_record_annual",
          post_payment_amount: 10_000,
          status: "issued",
          refunds: [
            {
              amount_refunded: 10_000,
              payment_record_refund: {
                payment_record: "pr_annual",
                refund_group: "prr_annual",
              },
              type: "payment_record_refund",
            },
          ],
        },
      },
    }
    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(grants[0]).toMatchObject({
      amount: 10_000,
      paymentReference: "pr_annual",
      paymentAmount: 10_000,
      stripeInvoiceId: "in_payment_record_annual",
    })
    expect(reversals[0]).toMatchObject({
      paymentReference: "pr_annual",
      reversalGroup: "stripe:credit-note:cn_payment_record_refund:payment-record-refund:prr_annual",
      lossReference: "stripe:payment-record-refund:prr_annual",
      reversedAmount: 10_000,
      paymentAmount: 10_000,
      stripeInvoiceId: "in_payment_record_annual",
      terminal: true,
    })
  })

  it("reverses customer-balance and out-of-band credit note value", async () => {
    stripeMockState.invoicePayments = [
      {
        amount_paid: 4_000,
        payment: { type: "payment_intent", payment_intent: "pi_first" },
      },
      {
        amount_paid: 6_000,
        payment: { type: "payment_intent", payment_intent: "pi_second" },
      },
    ]
    stripeMockState.event = {
      id: "evt_non_refund_credit_note",
      created: 1_700_000_000,
      type: "credit_note.created",
      data: {
        object: {
          id: "cn_non_refund",
          currency: "eur",
          customer_balance_transaction: "cbtxn_credit_note",
          invoice: "in_non_refund",
          out_of_band_amount: 2_000,
          post_payment_amount: 7_000,
          status: "issued",
          refunds: [],
        },
      },
    }
    const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> = []
    const service = await loadServiceWithStripe({
      ...billingRepositoryStub,
      setPaymentCreditReversal: (input) =>
        Effect.sync(() => {
          reversals.push(input)
          return true
        }),
    })

    await Effect.runPromise(service.processWebhook({ payload: "{}", signature: "sig_test" }))

    expect(reversals).toEqual([
      expect.objectContaining({
        paymentReference: "pi_first",
        reversalGroup: "stripe:credit-note:cn_non_refund:non-refund:pi_first",
        lossReference: "stripe:credit-note:cn_non_refund:non-refund",
        reversedAmount: 4_000,
        paymentAmount: 4_000,
        stripeInvoiceId: "in_non_refund",
        terminal: true,
      }),
      expect.objectContaining({
        paymentReference: "pi_second",
        reversalGroup: "stripe:credit-note:cn_non_refund:non-refund:pi_second",
        lossReference: "stripe:credit-note:cn_non_refund:non-refund",
        reversedAmount: 3_000,
        paymentAmount: 6_000,
        stripeInvoiceId: "in_non_refund",
        terminal: true,
      }),
    ])
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
