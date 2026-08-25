import type {
  AssetCatalogAssetResponse,
  AssetCatalogListResponse,
  AssetCanonicalizationRequest,
  AssetCanonicalizationResponse,
  AssetExceptionDecisionConfirmationRequest,
  AssetExceptionDecisionRequest,
  AssetExceptionDetailResponse,
  AssetExceptionListResponse,
  AssetExceptionPreviewResponse,
  PendingAssetListResponse,
  ProviderAssetApprovalRequest,
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
export type AssetCanonicalizationInput = {
  readonly id: string
} & AssetCanonicalizationRequest
export type AssetCanonicalization = AssetCanonicalizationResponse
export type ProviderAssetApprovalInput = {
  readonly id: string
} & ProviderAssetApprovalRequest
export type AssetExceptionList = AssetExceptionListResponse
export type AssetExceptionDetail = AssetExceptionDetailResponse
export type AssetExceptionPreview = AssetExceptionPreviewResponse
export type AssetExceptionDecisionInput = {
  readonly id: string
} & AssetExceptionDecisionRequest
export type AssetExceptionDecisionConfirmationInput = {
  readonly id: string
} & AssetExceptionDecisionConfirmationRequest

export type AssetExceptionListInput = {
  readonly query?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

export type AssetExceptionLookupInput =
  | {
      readonly provider: string
      readonly providerAssetId: string
      readonly naturalKey?: never
    }
  | {
      readonly provider: string
      readonly naturalKey: string
      readonly providerAssetId?: never
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
  readonly provider?: string
  readonly status?: "approved" | "excluded" | "pending_review" | "rejected"
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
  readonly listExceptions: (
    input?: AssetExceptionListInput
  ) => Effect.Effect<AssetExceptionList, unknown, never>
  readonly getException: (input: {
    readonly id: string
  }) => Effect.Effect<AssetExceptionDetail, unknown, never>
  readonly lookupException: (
    input: AssetExceptionLookupInput
  ) => Effect.Effect<AssetExceptionDetail, unknown, never>
  readonly previewExceptionDecision: (
    input: AssetExceptionDecisionInput
  ) => Effect.Effect<AssetExceptionPreview, unknown, never>
  readonly submitExceptionDecision: (
    input: AssetExceptionDecisionConfirmationInput
  ) => Effect.Effect<AssetExceptionDetail, unknown, never>
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
  readonly listExceptions: (
    input?: AssetExceptionListInput,
    options?: AssetRequestOptions
  ) => Promise<AssetExceptionList>
  readonly getException: (
    input: { readonly id: string },
    options?: AssetRequestOptions
  ) => Promise<AssetExceptionDetail>
  readonly lookupException: (
    input: AssetExceptionLookupInput,
    options?: AssetRequestOptions
  ) => Promise<AssetExceptionDetail>
  readonly previewExceptionDecision: (
    input: AssetExceptionDecisionInput,
    options?: AssetRequestOptions
  ) => Promise<AssetExceptionPreview>
  readonly submitExceptionDecision: (
    input: AssetExceptionDecisionConfirmationInput,
    options?: AssetRequestOptions
  ) => Promise<AssetExceptionDetail>
}

export type InternalAssetsEffectResource = AssetsEffectResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Effect.Effect<ProviderAssetReviewList, unknown, never>
  readonly canonicalizeProviderAsset: (
    input: AssetCanonicalizationInput
  ) => Effect.Effect<AssetCanonicalization, unknown, never>
  readonly approveProviderAsset: (
    input: ProviderAssetApprovalInput
  ) => Effect.Effect<ProviderAssetReview, unknown, never>
  readonly listUnresolvedTransferReconciliations: (
    input?: UnresolvedTransferReconciliationListInput
  ) => Effect.Effect<UnresolvedTransferReconciliationList, unknown, never>
}

export type InternalAssetsPromiseResource = AssetsPromiseResource & {
  readonly listProviderAssetReviews: (
    input?: ProviderAssetReviewListInput
  ) => Promise<ProviderAssetReviewList>
  readonly canonicalizeProviderAsset: (
    input: AssetCanonicalizationInput
  ) => Promise<AssetCanonicalization>
  readonly approveProviderAsset: (input: ProviderAssetApprovalInput) => Promise<ProviderAssetReview>
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
  listExceptions: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.listAssetExceptions({
        query: {
          q: input?.query ?? undefined,
          cursor: input?.cursor ?? undefined,
          limit: input?.limit,
        },
      })
    ),
  getException: ({ id }) =>
    Effect.flatMap(client, (resolved) => resolved.assets.getAssetException({ params: { id } })),
  lookupException: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.lookupAssetException({
        query: {
          provider: input.provider,
          providerAssetId: input.providerAssetId,
          naturalKey: input.naturalKey,
        },
      })
    ),
  previewExceptionDecision: ({ id, ...payload }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.previewAssetExceptionDecision({ params: { id }, payload })
    ),
  submitExceptionDecision: ({ id, ...payload }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.submitAssetExceptionDecision({ params: { id }, payload })
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
          provider: input?.provider,
          status: input?.status,
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
  canonicalizeProviderAsset: ({ id, reviewerNotes }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.canonicalizeProviderAsset({
        params: {
          id,
        },
        payload: {
          reviewerNotes,
        },
      })
    ),
  approveProviderAsset: ({ id, canonicalAssetId, assetRepresentationId, reviewerNotes }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.assets.approveProviderAsset({
        params: { id },
        payload: {
          canonicalAssetId,
          assetRepresentationId,
          reviewerNotes,
        },
      })
    ),
})

export const makeAssetsPromiseResource = (
  effect: AssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): AssetsPromiseResource => ({
  list: (input, options) => run(effect.list(input), options),
  get: (input, options) => run(effect.get(input), options),
  listPending: (input, options) => run(effect.listPending(input), options),
  listExceptions: (input, options) => run(effect.listExceptions(input), options),
  getException: (input, options) => run(effect.getException(input), options),
  lookupException: (input, options) => run(effect.lookupException(input), options),
  previewExceptionDecision: (input, options) =>
    run(effect.previewExceptionDecision(input), options),
  submitExceptionDecision: (input, options) => run(effect.submitExceptionDecision(input), options),
})

export const makeInternalAssetsPromiseResource = (
  effect: InternalAssetsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): InternalAssetsPromiseResource => ({
  ...makeAssetsPromiseResource(effect, run),
  listProviderAssetReviews: (input) => run(effect.listProviderAssetReviews(input)),
  listUnresolvedTransferReconciliations: (input, options) =>
    run(effect.listUnresolvedTransferReconciliations(input), options),
  canonicalizeProviderAsset: (input) => run(effect.canonicalizeProviderAsset(input)),
  approveProviderAsset: (input) => run(effect.approveProviderAsset(input)),
})
