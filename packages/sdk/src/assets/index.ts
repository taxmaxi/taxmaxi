import type {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  PendingAssetListResponse,
  ProviderAssetDecisionRequest,
  ProviderAssetDecisionResponse,
  ProviderAssetReplayResponse,
  ProviderAssetResolutionProposalListResponse,
  ProviderAssetReviewDetailResponse,
  ProviderAssetReviewListResponse,
  UnresolvedTransferReconciliationListResponse,
} from "@my/rest-api/contracts"
import { TaxMaxiApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import { HttpApiClient } from "effect/unstable/httpapi"

type TaxMaxiApiFullClient = HttpApiClient.ForApi<typeof TaxMaxiApi>

type TaxMaxiAssetsClient = Pick<TaxMaxiApiFullClient, Extract<keyof TaxMaxiApiFullClient, "assets">>

export type ProviderAssetReview = ProviderAssetReviewListResponse["providerAssets"][number]
export type ProviderAssetReviewList = ProviderAssetReviewListResponse
export type ProviderAssetReviewDetail = ProviderAssetReviewDetailResponse
export type ProviderAssetResolutionProposalList = ProviderAssetResolutionProposalListResponse
export type ProviderAssetDecisionResult = ProviderAssetDecisionResponse
export type ProviderAssetReplayStatus = ProviderAssetReplayResponse
export type UnresolvedTransferReconciliation =
  UnresolvedTransferReconciliationListResponse["reconciliations"][number]
export type UnresolvedTransferReconciliationList = UnresolvedTransferReconciliationListResponse
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
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
  readonly type: "fungible" | "nft"
  readonly representations: ReadonlyArray<AssetRepresentation>
}
export type TaxMaxiAssetType = AssetCatalogAsset["type"]
export type AssetCatalogList = {
  readonly assets: ReadonlyArray<AssetCatalogAsset>
  readonly page: {
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }
}
export type ProviderAssetDecisionInput = { readonly id: string } & ProviderAssetDecisionRequest
export type ProviderAssetProposalSearchInput = {
  readonly id: string
  readonly query?: string | null
}
export type ProviderAssetReplayInput = {
  readonly id: string
  readonly sourceId: string
  readonly jobId: string
}

export type AssetCatalogListInput = {
  readonly query?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

export type AssetCatalogDetailInput = {
  readonly assetId: string
}

export type PendingAssetListInput = {
  readonly query?: string | null
  readonly provider?: string
  readonly cursor?: string | null
  readonly limit?: number
}

export type ProviderAssetReviewListInput = {
  readonly query?: string | null
  readonly provider?: string
  readonly status?: "approved" | "pending_review" | "rejected"
  readonly evidence?: "exact" | "ambiguous" | "conflicting" | "insufficient"
  readonly cursor?: string | null
  readonly limit?: number
}

export type UnresolvedTransferReconciliationListInput = {
  readonly status?: "pending" | "needs_review"
  readonly cursor?: string | null
  readonly limit?: number
}

export type AssetRequestOptions = {
  readonly signal?: AbortSignal
}

export type AssetsEffectResource = {
  readonly list: (input?: AssetCatalogListInput) => Effect.Effect<AssetCatalogList, unknown, never>
  readonly get: (input: AssetCatalogDetailInput) => Effect.Effect<AssetCatalogAsset, unknown, never>
  readonly listPending: (
    input?: PendingAssetListInput
  ) => Effect.Effect<PendingAssetList, unknown, never>
}

export type AssetsPromiseResource = {
  readonly list: (
    input?: AssetCatalogListInput,
    options?: AssetRequestOptions
  ) => Promise<AssetCatalogList>
  readonly get: (
    input: AssetCatalogDetailInput,
    options?: AssetRequestOptions
  ) => Promise<AssetCatalogAsset>
  readonly listPending: (
    input?: PendingAssetListInput,
    options?: AssetRequestOptions
  ) => Promise<PendingAssetList>
}

export type InternalAssetsEffectResource = AssetsEffectResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Effect.Effect<ProviderAssetReviewList, unknown, never>
  readonly getProviderAssetReview: (input: {
    readonly id: string
  }) => Effect.Effect<ProviderAssetReviewDetail, unknown, never>
  readonly searchProviderAssetResolutionProposals: (
    input: ProviderAssetProposalSearchInput
  ) => Effect.Effect<ProviderAssetResolutionProposalList, unknown, never>
  readonly decideProviderAssetReview: (
    input: ProviderAssetDecisionInput
  ) => Effect.Effect<ProviderAssetDecisionResult, unknown, never>
  readonly getProviderAssetReplay: (
    input: ProviderAssetReplayInput
  ) => Effect.Effect<ProviderAssetReplayStatus, unknown, never>
  readonly retryProviderAssetReplay: (
    input: ProviderAssetReplayInput
  ) => Effect.Effect<ProviderAssetReplayStatus, unknown, never>
  readonly listUnresolvedTransferReconciliations: (
    input?: UnresolvedTransferReconciliationListInput
  ) => Effect.Effect<UnresolvedTransferReconciliationList, unknown, never>
}

export type InternalAssetsPromiseResource = AssetsPromiseResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Promise<ProviderAssetReviewList>
  readonly getProviderAssetReview: (input: {
    readonly id: string
  }) => Promise<ProviderAssetReviewDetail>
  readonly searchProviderAssetResolutionProposals: (
    input: ProviderAssetProposalSearchInput
  ) => Promise<ProviderAssetResolutionProposalList>
  readonly decideProviderAssetReview: (
    input: ProviderAssetDecisionInput
  ) => Promise<ProviderAssetDecisionResult>
  readonly getProviderAssetReplay: (
    input: ProviderAssetReplayInput
  ) => Promise<ProviderAssetReplayStatus>
  readonly retryProviderAssetReplay: (
    input: ProviderAssetReplayInput
  ) => Promise<ProviderAssetReplayStatus>
  readonly listUnresolvedTransferReconciliations: (
    input?: UnresolvedTransferReconciliationListInput,
    options?: AssetRequestOptions
  ) => Promise<UnresolvedTransferReconciliationList>
}

const toAssetCatalogAsset = (asset: AssetCatalogAssetResponse): AssetCatalogAsset => ({
  id: asset.id,
  name: asset.name,
  symbol: asset.symbol,
  coingeckoCoinId: asset.coingeckoCoinId,
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
  page: {
    nextCursor: response.page.nextCursor,
    hasMore: response.page.hasMore,
  },
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
          query: {
            q: input?.query ?? undefined,
            cursor: input?.cursor ?? undefined,
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
          params: {
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
          query: {
            q: input?.query ?? undefined,
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
        query: {
          q: input?.query ?? undefined,
          provider: input?.provider,
          status: input?.status,
          evidence: input?.evidence,
          cursor: input?.cursor ?? undefined,
          limit: input?.limit,
        },
      })
    ),
  listUnresolvedTransferReconciliations: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.listUnresolvedTransferReconciliations({
        query: {
          status: input?.status,
          cursor: input?.cursor ?? undefined,
          limit: input?.limit,
        },
      })
    ),
  getProviderAssetReview: ({ id }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.getProviderAssetReview({ params: { id } })
    ),
  searchProviderAssetResolutionProposals: ({ id, query }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.searchProviderAssetResolutionProposals({
        params: { id },
        query: { q: query ?? undefined },
      })
    ),
  decideProviderAssetReview: ({ id, decision, reviewRevision, reviewerNotes }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.decideProviderAssetReview({
        params: { id },
        payload: { decision, reviewRevision, reviewerNotes },
      })
    ),
  getProviderAssetReplay: ({ id, sourceId, jobId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.getProviderAssetReplay({ params: { id, sourceId, jobId } })
    ),
  retryProviderAssetReplay: ({ id, sourceId, jobId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.retryProviderAssetReplay({ params: { id, sourceId, jobId } })
    ),
})

export const makeAssetsPromiseResource = (
  effect: AssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): AssetsPromiseResource => ({
  list: (input, options) => run(effect.list(input), options),
  get: (input, options) => run(effect.get(input), options),
  listPending: (input, options) => run(effect.listPending(input), options),
})

export const makeInternalAssetsPromiseResource = (
  effect: InternalAssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): InternalAssetsPromiseResource => ({
  ...makeAssetsPromiseResource(effect, run),
  listProviderAssetReviews: (input) => run(effect.listProviderAssetReviews(input)),
  listUnresolvedTransferReconciliations: (input, options) =>
    run(effect.listUnresolvedTransferReconciliations(input), options),
  getProviderAssetReview: (input) => run(effect.getProviderAssetReview(input)),
  searchProviderAssetResolutionProposals: (input) =>
    run(effect.searchProviderAssetResolutionProposals(input)),
  decideProviderAssetReview: (input) => run(effect.decideProviderAssetReview(input)),
  getProviderAssetReplay: (input) => run(effect.getProviderAssetReplay(input)),
  retryProviderAssetReplay: (input) => run(effect.retryProviderAssetReplay(input)),
})
