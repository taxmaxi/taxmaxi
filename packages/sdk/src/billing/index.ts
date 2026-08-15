import {
  BillingCatalogResponse,
  BillingRedirectResponse,
  BillingStatusResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { TaxMaxiEffectClient } from "../client.ts"

export type BillingCatalog = Schema.Schema.Encoded<typeof BillingCatalogResponse>
export type BillingRedirect = Schema.Schema.Encoded<typeof BillingRedirectResponse>
export type BillingStatus = Schema.Schema.Encoded<typeof BillingStatusResponse>

export interface BillingEffectResource {
  readonly catalog: () => Effect.Effect<BillingCatalog, unknown, never>
  readonly status: () => Effect.Effect<BillingStatus, unknown, never>
  readonly createAnnualCheckout: () => Effect.Effect<BillingRedirect, unknown, never>
  readonly createTopUpCheckout: () => Effect.Effect<BillingRedirect, unknown, never>
  readonly createPortalSession: () => Effect.Effect<BillingRedirect, unknown, never>
}

export interface BillingPromiseResource {
  readonly catalog: () => Promise<BillingCatalog>
  readonly status: () => Promise<BillingStatus>
  readonly createAnnualCheckout: () => Promise<BillingRedirect>
  readonly createTopUpCheckout: () => Promise<BillingRedirect>
  readonly createPortalSession: () => Promise<BillingRedirect>
}

const encodeCatalog = Schema.encodeSync(BillingCatalogResponse)
const encodeStatus = Schema.encodeSync(BillingStatusResponse)
const encodeRedirect = Schema.encodeSync(BillingRedirectResponse)

export const makeBillingEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): BillingEffectResource => ({
  catalog: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.billing.getBillingCatalog()),
      encodeCatalog
    ),
  status: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.billing.getBillingStatus()),
      encodeStatus
    ),
  createAnnualCheckout: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.billing.createAnnualCheckout()),
      encodeRedirect
    ),
  createTopUpCheckout: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.billing.createTopUpCheckout()),
      encodeRedirect
    ),
  createPortalSession: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.billing.createBillingPortalSession()),
      encodeRedirect
    ),
})

export const makeBillingPromiseResource = (
  effect: BillingEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): BillingPromiseResource => ({
  catalog: () => run(effect.catalog()),
  status: () => run(effect.status()),
  createAnnualCheckout: () => run(effect.createAnnualCheckout()),
  createTopUpCheckout: () => run(effect.createTopUpCheckout()),
  createPortalSession: () => run(effect.createPortalSession()),
})
