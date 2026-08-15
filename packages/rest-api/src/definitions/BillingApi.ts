/**
 * BillingApi - Stripe Checkout, subscription management, and credit balance endpoints.
 *
 * @module BillingApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"

import { AuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

export class BillingCatalogPriceResponse extends Schema.Class<BillingCatalogPriceResponse>(
  "BillingCatalogPriceResponse"
)({
  lookupKey: Schema.String,
  amountMinor: Schema.Int.annotations({
    title: "Amount Minor",
    description: "Price in the currency's minor unit, such as cents for EUR.",
  }),
  currency: Schema.String,
  taxBehavior: Schema.Literal("inclusive", "exclusive", "unspecified"),
  recurringInterval: Schema.NullOr(Schema.Literal("year")),
}) {}

export class BillingCatalogResponse extends Schema.Class<BillingCatalogResponse>(
  "BillingCatalogResponse"
)({ prices: Schema.Array(BillingCatalogPriceResponse) }) {}

export class BillingRedirectResponse extends Schema.Class<BillingRedirectResponse>(
  "BillingRedirectResponse"
)({ url: Schema.String }) {}

export class BillingStatusResponse extends Schema.Class<BillingStatusResponse>(
  "BillingStatusResponse"
)({
  credits: Schema.Int,
  subscriptionStatus: Schema.NullOr(Schema.String),
  currentPeriodEnd: Schema.NullOr(Schema.DateTimeUtc),
  cancelAtPeriodEnd: Schema.Boolean,
}) {}

export class BillingBadRequestError extends Schema.TaggedError<BillingBadRequestError>()(
  "BillingBadRequestError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 })
) {}

const getCatalog = HttpApiEndpoint.get("getBillingCatalog", "/catalog")
  .addSuccess(BillingCatalogResponse)
  .addError(InternalServerError)

const getStatus = HttpApiEndpoint.get("getBillingStatus", "/status")
  .addSuccess(BillingStatusResponse)
  .addError(InternalServerError)

const createAnnualCheckout = HttpApiEndpoint.post("createAnnualCheckout", "/checkout/annual")
  .addSuccess(BillingRedirectResponse)
  .addError(BillingBadRequestError)
  .addError(InternalServerError)

const createTopUpCheckout = HttpApiEndpoint.post("createTopUpCheckout", "/checkout/top-up")
  .addSuccess(BillingRedirectResponse)
  .addError(BillingBadRequestError)
  .addError(InternalServerError)

const createPortalSession = HttpApiEndpoint.post("createBillingPortalSession", "/portal")
  .addSuccess(BillingRedirectResponse)
  .addError(BillingBadRequestError)
  .addError(InternalServerError)

const stripeWebhook = HttpApiEndpoint.post("stripeWebhook", "/webhooks/stripe")
  .addSuccess(Schema.Void)
  .addError(BillingBadRequestError)
  .addError(InternalServerError)

export class BillingApi extends HttpApiGroup.make("billing")
  .add(getStatus)
  .add(createAnnualCheckout)
  .add(createTopUpCheckout)
  .add(createPortalSession)
  .middlewareEndpoints(AuthMiddleware)
  .add(getCatalog)
  .add(stripeWebhook)
  .prefix("/v1/billing")
  .annotateContext(
    OpenApi.annotations({
      title: "Billing",
      description: "Stripe Checkout, subscription management, and transaction credits",
    })
  ) {}
