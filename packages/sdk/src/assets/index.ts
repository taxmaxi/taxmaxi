import type {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  AssetCanonicalizationRequest,
  AssetCanonicalizationResponse,
  PendingAssetListResponse,
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
export type PendingAsset = {
  readonly id: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly symbol: string
  readonly name: string | null
  readonly providerType: string | null
}
export type PendingAssetList = {
  readonly pendingAssets: ReadonlyArray<PendingAsset>
  readonly page: {
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }
}
export type AssetRepresentation = {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly blockchainChainType: string
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly type: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
  readonly logoUrl: string | null
  readonly metadata: unknown
}
export type AssetCatalogAsset = {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly logoUrl: string | null
  readonly type: "fungible" | "nft"
  readonly representations: ReadonlyArray<AssetRepresentation>
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

export type PendingAssetListInput = {
  readonly provider?: string
  readonly cursor?: string | null
  readonly limit?: number
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
  readonly listPending: (
    input?: PendingAssetListInput
  ) => Effect.Effect<PendingAssetList, unknown, never>
}

export type AssetsPromiseResource = {
  readonly list: (input?: AssetCatalogListInput) => Promise<AssetCatalogList>
  readonly get: (input: AssetCatalogDetailInput) => Promise<AssetCatalogAsset>
  readonly listPending: (input?: PendingAssetListInput) => Promise<PendingAssetList>
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
  name: asset.name,
  symbol: asset.symbol,
  logoUrl: asset.logoUrl,
  type: asset.type,
  representations: asset.representations.map((representation) => ({
    id: representation.id,
    blockchainId: representation.blockchainId,
    blockchainName: representation.blockchainName,
    blockchainChainType: representation.blockchainChainType,
    blockchainChainId: representation.blockchainChainId,
    blockchainExplorerUrl: representation.blockchainExplorerUrl,
    blockchainLogoUrl: representation.blockchainLogoUrl,
    type: representation.type,
    contractAddress: representation.contractAddress,
    mintAddress: representation.mintAddress,
    decimals: representation.decimals,
    logoUrl: representation.logoUrl,
    metadata: representation.metadata,
  })),
})

const toAssetCatalogList = (response: AssetCatalogListResponse): AssetCatalogList => ({
  assets: response.assets.map(toAssetCatalogAsset),
})

const toPendingAssetList = (response: PendingAssetListResponse): PendingAssetList => ({
  pendingAssets: response.pendingAssets.map((asset) => ({
    id: asset.id,
    provider: asset.provider,
    providerAssetId: asset.providerAssetId,
    symbol: asset.symbol,
    name: asset.name,
    providerType: asset.providerType,
  })),
  page: {
    nextCursor: response.page.nextCursor,
    hasMore: response.page.hasMore,
  },
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
  listPending: (input) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.assets.listPendingAssets({
          urlParams: {
            provider: input?.provider,
            cursor: input?.cursor ?? undefined,
            limit: input?.limit,
          },
        })
      ),
      toPendingAssetList
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
  listPending: (input) => run(effect.listPending(input)),
})

export const makeInternalAssetsPromiseResource = (
  effect: InternalAssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): InternalAssetsPromiseResource => ({
  ...makeAssetsPromiseResource(effect, run),
  listProviderAssetReviews: (input) => run(effect.listProviderAssetReviews(input)),
  canonicalizeProviderAsset: (input) => run(effect.canonicalizeProviderAsset(input)),
})
