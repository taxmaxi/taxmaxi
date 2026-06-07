import type {
  AssetCanonicalizationRequest,
  AssetCanonicalizationResponse,
  ProviderAssetReviewListResponse,
} from "@my/rest-api/contracts"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import { HttpApiClient, type HttpApi } from "@effect/platform"
import * as Effect from "effect/Effect"

type TaxMaxiAssetsClient =
  typeof TaxMaxiApi extends HttpApi.HttpApi<string, infer Groups, infer ApiError, infer _ApiContext>
    ? Pick<
        HttpApiClient.Client<Groups, ApiError, never>,
        Extract<keyof HttpApiClient.Client<Groups, ApiError, never>, "assets">
      >
    : never

export type ProviderAssetReview = ProviderAssetReviewListResponse["providerAssets"][number]
export type ProviderAssetReviewList = ProviderAssetReviewListResponse
export type AssetCanonicalizationInput = {
  readonly providerAssetRowId: string
} & AssetCanonicalizationRequest
export type AssetCanonicalization = AssetCanonicalizationResponse

export type ProviderAssetReviewListInput = {
  readonly provider?: string
  readonly status?: "approved" | "pending_review" | "rejected"
  readonly cursor?: string | null
  readonly limit?: number
}

export type AssetsEffectResource = {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Effect.Effect<ProviderAssetReviewList, unknown, never>
  readonly canonicalizeProviderAssetFromCoinGecko: (
    input: AssetCanonicalizationInput
  ) => Effect.Effect<AssetCanonicalization, unknown, never>
}

export type AssetsPromiseResource = {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Promise<ProviderAssetReviewList>
  readonly canonicalizeProviderAssetFromCoinGecko: (
    input: AssetCanonicalizationInput
  ) => Promise<AssetCanonicalization>
}

export const makeAssetsEffectResource = (
  client: Effect.Effect<TaxMaxiAssetsClient, never>
): AssetsEffectResource => ({
  listProviderAssetReviews: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.listProviderAssetReviews({
        urlParams: {
          provider: input?.provider,
          status: input?.status,
          cursor: input?.cursor ?? undefined,
          limit: input?.limit,
        },
      })
    ),
  canonicalizeProviderAssetFromCoinGecko: ({ providerAssetRowId, reviewerNotes }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.canonicalizeProviderAssetFromCoinGecko({
        path: {
          providerAssetRowId,
        },
        payload: {
          reviewerNotes,
        },
      })
    ),
})

export const makeAssetsPromiseResource = (
  effect: AssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AssetsPromiseResource => ({
  listProviderAssetReviews: (input) => run(effect.listProviderAssetReviews(input)),
  canonicalizeProviderAssetFromCoinGecko: (input) =>
    run(effect.canonicalizeProviderAssetFromCoinGecko(input)),
})
