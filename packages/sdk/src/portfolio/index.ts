import { PortfolioAssetsResponse } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type PortfolioAssets = Schema.Schema.Encoded<typeof PortfolioAssetsResponse>

export interface PortfolioAssetsInput {
  readonly sourceId?: string
  readonly currency?: string
}

export interface PortfolioEffectResource {
  readonly listAssets: (
    input?: PortfolioAssetsInput
  ) => Effect.Effect<PortfolioAssets, unknown, never>
}

export interface PortfolioPromiseResource {
  readonly listAssets: (input?: PortfolioAssetsInput) => Promise<PortfolioAssets>
}

const encodePortfolioAssets = Schema.encodeSync(PortfolioAssetsResponse)

export const makePortfolioEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): PortfolioEffectResource => ({
  listAssets: (input = {}) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.portfolio.listPortfolioAssets({
          urlParams: {
            sourceId: input.sourceId,
            currency: input.currency?.toLowerCase(),
          },
        })
      ),
      encodePortfolioAssets
    ),
})

export const makePortfolioPromiseResource = (
  effect: PortfolioEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): PortfolioPromiseResource => ({
  listAssets: (input) => run(effect.listAssets(input)),
})
