/**
 * StripeBillingService - Checkout, Customer Portal, and webhook operations.
 *
 * @module StripeBillingService
 */

import type { AuthUserId } from "@my/core/authentication"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const TAXMAXI_ANNUAL_LOOKUP_KEY = "taxmaxi_annual_10k_eur"
export const TAXMAXI_TOP_UP_LOOKUP_KEY = "taxmaxi_topup_1k_eur"
export const TAXMAXI_PROFESSIONAL_ANNUAL_LOOKUP_KEY = "taxmaxi_professional_annual_100k_eur"
export const TAXMAXI_PROFESSIONAL_MATTER_LOOKUP_KEY = "taxmaxi_professional_matter_annual_10k_eur"
export const TAXMAXI_PROFESSIONAL_TOP_UP_LOOKUP_KEY = "taxmaxi_professional_topup_20k_eur"
export const TAXMAXI_ENTERPRISE_PILOT_LOOKUP_KEY = "taxmaxi_enterprise_pilot_eur"

export interface BillingCatalogPrice {
  readonly lookupKey: string
  /** Price in the currency's minor unit, such as cents for EUR. */
  readonly amountMinor: number
  readonly currency: string
  readonly taxBehavior: "inclusive" | "exclusive" | "unspecified"
  readonly recurringInterval: "year" | null
}

export interface BillingStatus {
  readonly credits: number
  readonly subscriptionStatus: string | null
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
}

export class StripeBillingError extends Schema.TaggedError<StripeBillingError>()(
  "StripeBillingError",
  { message: Schema.String }
) {}

/**
 * Stripe-backed billing operations for the public price catalog, account status,
 * annual and top-up Checkout sessions, Customer Portal access, and signed webhook fulfillment.
 */
export interface StripeBillingServiceShape {
  readonly catalog: Effect.Effect<ReadonlyArray<BillingCatalogPrice>, StripeBillingError>
  readonly status: (userId: AuthUserId) => Effect.Effect<BillingStatus, StripeBillingError>
  readonly createAnnualCheckout: (userId: AuthUserId) => Effect.Effect<string, StripeBillingError>
  readonly createTopUpCheckout: (userId: AuthUserId) => Effect.Effect<string, StripeBillingError>
  readonly createPortalSession: (userId: AuthUserId) => Effect.Effect<string, StripeBillingError>
  readonly processWebhook: (input: {
    readonly payload: string
    readonly signature: string
  }) => Effect.Effect<void, StripeBillingError>
}

export class StripeBillingService extends Context.Service<
  StripeBillingService,
  StripeBillingServiceShape
>()("StripeBillingService") {}
