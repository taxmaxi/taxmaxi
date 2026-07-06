import type {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
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
export type AssetCatalogAsset = {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly blockchainChainType: string
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly contractAddress: string | null
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly logoUrl: string | null
  readonly type: "native" | "token" | "nft"
  readonly isSpam: boolean
}
export type TaxMaxiAssetType = AssetCatalogAsset["type"]
export type AssetCatalogList = {
  readonly assets: ReadonlyArray<AssetCatalogAsset>
}
export type AssetCanonicalizationInput = {
  readonly id: string
} & AssetCanonicalizationRequest
export type AssetCanonicalization = AssetCanonicalizationResponse

export type AssetCatalogListInput = {
  readonly query?: string | null
  readonly limit?: number
}

export type AssetCatalogDetailInput = {
  readonly assetId: string
}

export type ProviderAssetReviewListInput = {
  readonly provider?: string
  readonly status?: "approved" | "pending_review" | "rejected"
  readonly cursor?: string | null
  readonly limit?: number
}

export type AssetsEffectResource = {
  readonly list: (input?: AssetCatalogListInput) => Effect.Effect<AssetCatalogList, unknown, never>
  readonly get: (input: AssetCatalogDetailInput) => Effect.Effect<AssetCatalogAsset, unknown, never>
}

export type AssetsPromiseResource = {
  readonly list: (input?: AssetCatalogListInput) => Promise<AssetCatalogList>
  readonly get: (input: AssetCatalogDetailInput) => Promise<AssetCatalogAsset>
}

export type InternalAssetsEffectResource = AssetsEffectResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Effect.Effect<ProviderAssetReviewList, unknown, never>
  readonly canonicalizeProviderAsset: (
    input: AssetCanonicalizationInput
  ) => Effect.Effect<AssetCanonicalization, unknown, never>
}

export type InternalAssetsPromiseResource = AssetsPromiseResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Promise<ProviderAssetReviewList>
  readonly canonicalizeProviderAsset: (
    input: AssetCanonicalizationInput
  ) => Promise<AssetCanonicalization>
}

const toAssetCatalogAsset = (asset: AssetCatalogAssetResponse): AssetCatalogAsset => ({
  id: asset.id,
  blockchainId: asset.blockchainId,
  blockchainName: asset.blockchainName,
  blockchainChainType: asset.blockchainChainType,
  blockchainChainId: asset.blockchainChainId,
  blockchainExplorerUrl: asset.blockchainExplorerUrl,
  blockchainLogoUrl: asset.blockchainLogoUrl,
  contractAddress: asset.contractAddress,
  name: asset.name,
  symbol: asset.symbol,
  decimals: asset.decimals,
  logoUrl: asset.logoUrl,
  type: asset.type,
  isSpam: asset.isSpam,
})

const toAssetCatalogList = (response: AssetCatalogListResponse): AssetCatalogList => ({
  assets: response.assets.map(toAssetCatalogAsset),
})

export const makeAssetsEffectResource = (
  client: Effect.Effect<TaxMaxiAssetsClient, never>
): AssetsEffectResource => ({
  list: (input) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assets.listAssets({
          urlParams: {
            q: input?.query ?? undefined,
            limit: input?.limit,
          },
        })
      ),
      toAssetCatalogList
    ),
  get: ({ assetId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assets.getAsset({
          path: {
            assetId,
          },
        })
      ),
      toAssetCatalogAsset
    ),
})

export const makeInternalAssetsEffectResource = (
  client: Effect.Effect<TaxMaxiAssetsClient, never>
): InternalAssetsEffectResource => ({
  ...makeAssetsEffectResource(client),
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
  list: (input) => run(effect.list(input)),
  get: (input) => run(effect.get(input)),
})

export const makeInternalAssetsPromiseResource = (
  effect: InternalAssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): InternalAssetsPromiseResource => ({
  ...makeAssetsPromiseResource(effect, run),
  listProviderAssetReviews: (input) => run(effect.listProviderAssetReviews(input)),
  canonicalizeProviderAsset: (input) => run(effect.canonicalizeProviderAsset(input)),
})
