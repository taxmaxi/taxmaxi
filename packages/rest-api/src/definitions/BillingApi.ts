/**
 * BillingApi - Stripe Checkout, subscription management, and credit balance endpoints.
 *
 * @module BillingApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"

import { AuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

export class BillingCatalogPriceResponse extends Schema.Class<BillingCatalogPriceResponse>(
  "BillingCatalogPriceResponse"
)({
  lookupKey: Schema.String,
  amountMinor: Schema.Int.annotate({
    title: "Amount Minor",
    description: "Price in the currency's minor unit, such as cents for EUR.",
  }),
  currency: Schema.String,
  taxBehavior: Schema.Literals(["inclusive", "exclusive", "unspecified"]),
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
  currentPeriodEnd: Schema.NullOr(Schema.DateTimeUtcFromString),
  cancelAtPeriodEnd: Schema.Boolean,
}) {}

export class BillingBadRequestError extends Schema.TaggedError<BillingBadRequestError>()(
  "BillingBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

const getCatalog = HttpApiEndpoint.get("getBillingCatalog", "/catalog", {
  success: BillingCatalogResponse,
  error: InternalServerError,
})

const getStatus = HttpApiEndpoint.get("getBillingStatus", "/status", {
  success: BillingStatusResponse,
  error: InternalServerError,
})

const createAnnualCheckout = HttpApiEndpoint.post("createAnnualCheckout", "/checkout/annual", {
  success: BillingRedirectResponse,
  error: [BillingBadRequestError, InternalServerError],
})

const createTopUpCheckout = HttpApiEndpoint.post("createTopUpCheckout", "/checkout/top-up", {
  success: BillingRedirectResponse,
  error: [BillingBadRequestError, InternalServerError],
})

const createPortalSession = HttpApiEndpoint.post("createBillingPortalSession", "/portal", {
  success: BillingRedirectResponse,
  error: [BillingBadRequestError, InternalServerError],
})

const stripeWebhook = HttpApiEndpoint.post("stripeWebhook", "/webhooks/stripe", {
  success: HttpApiSchema.NoContent,
  error: [BillingBadRequestError, InternalServerError],
})

export class BillingApi extends HttpApiGroup.make("billing")
  .add(getStatus)
  .add(createAnnualCheckout)
  .add(createTopUpCheckout)
  .add(createPortalSession)
  .middleware(AuthMiddleware)
  .add(getCatalog)
  .add(stripeWebhook)
  .prefix("/v1/billing")
  .annotateMerge(
    OpenApi.annotations({
      title: "Billing",
      description: "Stripe Checkout, subscription management, and transaction credits",
    })
  ) {}
