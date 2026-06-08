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
  readonly id: string
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
  readonly canonicalizeProviderAsset: (
    input: AssetCanonicalizationInput
  ) => Effect.Effect<AssetCanonicalization, unknown, never>
}

export type AssetsPromiseResource = {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Promise<ProviderAssetReviewList>
  readonly canonicalizeProviderAsset: (
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
  canonicalizeProviderAsset: ({ id, reviewerNotes }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.canonicalizeProviderAsset({
        path: {
          id,
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
  canonicalizeProviderAsset: (input) => run(effect.canonicalizeProviderAsset(input)),
})
