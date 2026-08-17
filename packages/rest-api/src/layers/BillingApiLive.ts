/**
 * BillingApiLive - HTTP handlers for Stripe billing and transaction credits.
 *
 * @module BillingApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

import {
  BillingBadRequestError,
  BillingCatalogPriceResponse,
  BillingCatalogResponse,
  BillingRedirectResponse,
  BillingStatusResponse,
} from "../definitions/BillingApi.ts"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { StripeBillingService } from "../services/StripeBillingService.ts"

const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const checkoutError = (message: string) => {
  if (
    message.includes("already has a subscription") ||
    message.includes("active annual subscription") ||
    message.includes("No Stripe customer")
  ) {
    return new BillingBadRequestError({ message })
  }
  return internalError("Billing is temporarily unavailable.")
}

/**
 * Implements the billing HTTP group using `StripeBillingService` for catalog,
 * Checkout, Customer Portal, account status, and webhook operations.
 */
export const BillingApiLive = HttpApiBuilder.group(TaxMaxiApi, "billing", (handlers) =>
  Effect.gen(function* () {
    const billing = yield* StripeBillingService

    return handlers
      .handle("getBillingCatalog", () =>
        billing.catalog.pipe(
          Effect.map((prices) =>
            BillingCatalogResponse.make({
              prices: prices.map((price) => BillingCatalogPriceResponse.make(price)),
            })
          ),
          Effect.mapError(() => internalError("Could not load the billing catalog."))
        )
      )
      .handle("getBillingStatus", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const status = yield* billing
            .status(currentUser.userId)
            .pipe(Effect.mapError(() => internalError("Could not load billing status.")))
          return BillingStatusResponse.make({
            ...status,
            currentPeriodEnd:
              status.currentPeriodEnd === null
                ? null
                : DateTime.makeUnsafe(status.currentPeriodEnd),
          })
        })
      )
      .handle("createAnnualCheckout", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const url = yield* billing
            .createAnnualCheckout(currentUser.userId)
            .pipe(Effect.mapError((error) => checkoutError(error.message)))
          return BillingRedirectResponse.make({ url })
        })
      )
      .handle("createTopUpCheckout", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const url = yield* billing
            .createTopUpCheckout(currentUser.userId)
            .pipe(Effect.mapError((error) => checkoutError(error.message)))
          return BillingRedirectResponse.make({ url })
        })
      )
      .handle("createBillingPortalSession", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const url = yield* billing
            .createPortalSession(currentUser.userId)
            .pipe(Effect.mapError((error) => checkoutError(error.message)))
          return BillingRedirectResponse.make({ url })
        })
      )
      .handle("stripeWebhook", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signature = Headers.get(request.headers, "stripe-signature")
          if (Option.isNone(signature)) {
            return yield* new BillingBadRequestError({ message: "Missing Stripe signature." })
          }
          const payload = yield* request.text.pipe(
            Effect.mapError(() => new BillingBadRequestError({ message: "Invalid request body." }))
          )
          yield* billing
            .processWebhook({ payload, signature: signature.value })
            .pipe(
              Effect.mapError(
                () => new BillingBadRequestError({ message: "Invalid Stripe webhook." })
              )
            )
        })
      )
  })
)
