/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"
import { SourceSyncJobResponse, SourceSyncStartResponse } from "./SourcesApi.ts"

export class AssetBadRequestError extends Schema.TaggedError<AssetBadRequestError>()(
  "AssetBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {}

export class AssetNotFoundError extends Schema.TaggedError<AssetNotFoundError>()(
  "AssetNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class AssetConflictError extends Schema.TaggedError<AssetConflictError>()(
  "AssetConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

/** Maximum accepted length for public asset catalog search queries. */
export const ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH = 128

const AssetCatalogSearchQuery = Schema.String.check(
  Schema.isMaxLength(ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH)
)

export class ProviderAssetReviewRow extends Schema.Class<ProviderAssetReviewRow>(
  "ProviderAssetReviewRow"
)({
  id: Schema.String,
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  naturalKey: Schema.NullOr(Schema.String),
  currencyCode: Schema.String,
  name: Schema.NullOr(Schema.String),
  exponent: Schema.NullOr(Schema.Number),
  providerType: Schema.NullOr(Schema.String),
  rawProviderPayload: Schema.Unknown,
  discoveredAt: Schema.String,
  retrievedAt: Schema.String,
  mappingKind: Schema.NullOr(Schema.Literals(["asset", "fiat"])),
  canonicalAssetId: Schema.NullOr(Schema.String),
  assetRepresentationId: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: Schema.NullOr(Schema.Literals(["approved", "pending_review", "rejected"])),
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
  reviewedBy: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.String),
}) {}

export class ProviderAssetReviewListResponse extends Schema.Class<ProviderAssetReviewListResponse>(
  "ProviderAssetReviewListResponse"
)({
  providerAssets: Schema.Array(ProviderAssetReviewRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class UnresolvedTransferReconciliationRow extends Schema.Class<UnresolvedTransferReconciliationRow>(
  "UnresolvedTransferReconciliationRow"
)({
  id: Schema.String.check(Schema.isUUID()),
  principalId: Schema.String.check(Schema.isUUID()),
  providerTransferId: Schema.String.check(Schema.isUUID()),
  providerSourceId: Schema.String.check(Schema.isUUID()),
  providerTimestamp: Schema.String,
  providerDirection: Schema.Literals(["inbound", "outbound"]),
  providerAmount: Schema.String,
  networkName: Schema.NullOr(Schema.String),
  networkHash: Schema.NullOr(Schema.String),
  canonicalTransferId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  canonicalTransactionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  status: Schema.Literals(["pending", "needs_review"]),
  matchReason: Schema.String,
  confidence: Schema.String,
  deterministic: Schema.Boolean,
  reviewMetadata: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class UnresolvedTransferReconciliationListResponse extends Schema.Class<UnresolvedTransferReconciliationListResponse>(
  "UnresolvedTransferReconciliationListResponse"
)({
  reconciliations: Schema.Array(UnresolvedTransferReconciliationRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class PendingAssetResponse extends Schema.Class<PendingAssetResponse>(
  "PendingAssetResponse"
)({
  id: Schema.String,
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  symbol: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerType: Schema.NullOr(Schema.String),
}) {}

export class PendingAssetListResponse extends Schema.Class<PendingAssetListResponse>(
  "PendingAssetListResponse"
)({
  pendingAssets: Schema.Array(PendingAssetResponse),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class AssetRepresentationResponse extends Schema.Class<AssetRepresentationResponse>(
  "AssetRepresentationResponse"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  blockchainChainType: Schema.String,
  blockchainChainId: Schema.NullOr(Schema.Number),
  blockchainExplorerUrl: Schema.NullOr(Schema.String),
  blockchainLogoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literals(["native", "token", "nft"]),
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  decimals: Schema.Number,
  logoUrl: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
}) {}

export class AssetCatalogAssetResponse extends Schema.Class<AssetCatalogAssetResponse>(
  "AssetCatalogAssetResponse"
)({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  coingeckoCoinId: Schema.NullOr(Schema.String),
  logoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literals(["fungible", "nft"]),
  representations: Schema.Array(AssetRepresentationResponse),
}) {}

export class AssetCatalogListResponse extends Schema.Class<AssetCatalogListResponse>(
  "AssetCatalogListResponse"
)({
  assets: Schema.Array(AssetCatalogAssetResponse),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
}) {}

export class AssetCanonicalizationRequest extends Schema.Class<AssetCanonicalizationRequest>(
  "AssetCanonicalizationRequest"
)({
  coinId: Schema.String.check(Schema.isNonEmpty()),
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class ProviderAssetApprovalRequest extends Schema.Class<ProviderAssetApprovalRequest>(
  "ProviderAssetApprovalRequest"
)({
  canonicalAssetId: Schema.String.check(Schema.isUUID()),
  assetRepresentationId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class CanonicalAssetResponse extends Schema.Class<CanonicalAssetResponse>(
  "CanonicalAssetResponse"
)({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  type: Schema.Literals(["fungible", "nft"]),
}) {}

export class CanonicalAssetRepresentationResponse extends Schema.Class<CanonicalAssetRepresentationResponse>(
  "CanonicalAssetRepresentationResponse"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  type: Schema.Literals(["native", "token", "nft"]),
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  decimals: Schema.Number,
}) {}

export class AssetCanonicalizationEvidenceResponse extends Schema.Class<AssetCanonicalizationEvidenceResponse>(
  "AssetCanonicalizationEvidenceResponse"
)({
  source: Schema.Literal("coingecko"),
  economicAsset: Schema.Struct({
    coinId: Schema.String,
    name: Schema.String,
    symbol: Schema.String,
  }),
  representation: Schema.Struct({
    platformId: Schema.String,
    platformName: Schema.String,
    contractAddress: Schema.NullOr(Schema.String),
  }),
}) {}

export class ProviderAssetReplayResponse extends Schema.Class<ProviderAssetReplayResponse>(
  "ProviderAssetReplayResponse"
)({
  sourceId: Schema.String.check(Schema.isUUID()),
  jobId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literal("queued"),
}) {}

export class AssetCanonicalizationResponse extends Schema.Class<AssetCanonicalizationResponse>(
  "AssetCanonicalizationResponse"
)({
  providerAsset: ProviderAssetReviewRow,
  canonicalAsset: CanonicalAssetResponse,
  representation: CanonicalAssetRepresentationResponse,
  evidence: AssetCanonicalizationEvidenceResponse,
  replays: Schema.Array(ProviderAssetReplayResponse),
}) {}

export class ProviderAssetDecisionResponse extends Schema.Class<ProviderAssetDecisionResponse>(
  "ProviderAssetDecisionResponse"
)({
  providerAsset: ProviderAssetReviewRow,
  replays: Schema.Array(ProviderAssetReplayResponse),
}) {}

export class ProviderAssetCandidateResponse extends Schema.Class<ProviderAssetCandidateResponse>(
  "ProviderAssetCandidateResponse"
)({
  economicAsset: Schema.Struct({
    coinId: Schema.String,
    name: Schema.String,
    symbol: Schema.String,
  }),
  representationEvidence: Schema.Array(
    Schema.Struct({
      platformId: Schema.String,
      platformName: Schema.NullOr(Schema.String),
      contractAddress: Schema.NullOr(Schema.String),
      kind: Schema.Literals(["native", "token"]),
    })
  ),
  matchStrength: Schema.Literals(["exact_name_and_symbol", "symbol_only"]),
}) {}

export class ProviderAssetCandidateListResponse extends Schema.Class<ProviderAssetCandidateListResponse>(
  "ProviderAssetCandidateListResponse"
)({ candidates: Schema.Array(ProviderAssetCandidateResponse) }) {}

export class RejectProviderAssetRequest extends Schema.Class<RejectProviderAssetRequest>(
  "RejectProviderAssetRequest"
)({ reason: Schema.String.check(Schema.isNonEmpty()) }) {}

const ProviderAssetReviewQuery = Schema.Struct({
  provider: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["pending_review", "approved", "rejected"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const UnresolvedTransferReconciliationQuery = Schema.Struct({
  status: Schema.optional(Schema.Literals(["pending", "needs_review"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const PendingAssetListQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  provider: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

const AssetCatalogListQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(500)
    )
  ),
})

const listAssets = HttpApiEndpoint.get("listAssets", "/assets", {
  query: AssetCatalogListQuery,
  success: AssetCatalogListResponse,
  error: [AssetBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List canonical assets",
    description: "Lists non-spam canonical assets from the TaxMaxi asset registry.",
  })
)

const getAsset = HttpApiEndpoint.get("getAsset", "/assets/:assetId", {
  params: Schema.Struct({
    assetId: Schema.String.check(Schema.isUUID()),
  }),
  success: AssetCatalogAssetResponse,
  error: [AssetNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get canonical asset",
    description: "Returns one non-spam canonical asset from the TaxMaxi asset registry.",
  })
)

const listPendingAssets = HttpApiEndpoint.get("listPendingAssets", "/assets/pending", {
  query: PendingAssetListQuery,
  success: PendingAssetListResponse,
  error: [AssetBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List pending assets",
    description:
      "Lists provider assets waiting for TaxMaxi review without exposing internal review data.",
  })
)

const listProviderAssetReviews = HttpApiEndpoint.get(
  "listProviderAssetReviews",
  "/assets/provider-assets",
  {
    query: ProviderAssetReviewQuery,
    success: ProviderAssetReviewListResponse,
    error: [AssetBadRequestError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "List provider asset review rows",
      description: "Lists provider assets by mapping review status.",
    })
  )
  .middleware(AdminAuthMiddleware)

const listUnresolvedTransferReconciliations = HttpApiEndpoint.get(
  "listUnresolvedTransferReconciliations",
  "/assets/transfer-reconciliations/unresolved",
  {
    query: UnresolvedTransferReconciliationQuery,
    success: UnresolvedTransferReconciliationListResponse,
    error: [AssetBadRequestError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "List unresolved transfer reconciliation evidence",
      description:
        "Lists pending and ambiguous transfer matches for the narrow admin review queue.",
    })
  )
  .middleware(AdminAuthMiddleware)

const canonicalizeProviderAsset = HttpApiEndpoint.post(
  "canonicalizeProviderAsset",
  "/assets/provider-assets/:id/canonicalize",
  {
    params: Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
    }),
    payload: Schema.Struct(AssetCanonicalizationRequest.fields),
    success: AssetCanonicalizationResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Canonicalize provider asset",
      description:
        "Creates or refreshes a canonical asset and approves the provider asset mapping.",
    })
  )
  .middleware(AdminAuthMiddleware)

const approveProviderAsset = HttpApiEndpoint.post(
  "approveProviderAsset",
  "/assets/provider-assets/:id/approve",
  {
    params: Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
    }),
    payload: Schema.Struct(ProviderAssetApprovalRequest.fields),
    success: ProviderAssetDecisionResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Approve provider asset mapping",
      description:
        "Approves an exact provider-asset target and requests replay for affected sources.",
    })
  )
  .middleware(AdminAuthMiddleware)

const listProviderAssetCandidates = HttpApiEndpoint.get(
  "listProviderAssetCandidates",
  "/assets/provider-assets/:id/candidates",
  {
    params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
    success: ProviderAssetCandidateListResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

const approveProviderAssetAsFiat = HttpApiEndpoint.post(
  "approveProviderAssetAsFiat",
  "/assets/provider-assets/:id/approve-fiat",
  {
    params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
    payload: Schema.Struct({ reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)) }),
    success: ProviderAssetDecisionResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

const rejectProviderAsset = HttpApiEndpoint.post(
  "rejectProviderAsset",
  "/assets/provider-assets/:id/reject",
  {
    params: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
    payload: Schema.Struct(RejectProviderAssetRequest.fields),
    success: ProviderAssetDecisionResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

const ProviderAssetReplayPath = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  sourceId: Schema.String.check(Schema.isUUID()),
  jobId: Schema.String.check(Schema.isUUID()),
})

const getProviderAssetReplay = HttpApiEndpoint.get(
  "getProviderAssetReplay",
  "/assets/provider-assets/:id/replays/:sourceId/jobs/:jobId",
  {
    params: ProviderAssetReplayPath,
    success: SourceSyncJobResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

const retryProviderAssetReplay = HttpApiEndpoint.post(
  "retryProviderAssetReplay",
  "/assets/provider-assets/:id/replays/:sourceId/jobs/:jobId/retry",
  {
    params: ProviderAssetReplayPath,
    success: SourceSyncStartResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listAssets)
  .add(getAsset)
  .add(listPendingAssets)
  .add(listProviderAssetReviews)
  .add(listProviderAssetCandidates)
  .add(listUnresolvedTransferReconciliations)
  .add(approveProviderAsset)
  .add(approveProviderAssetAsFiat)
  .add(rejectProviderAsset)
  .add(getProviderAssetReplay)
  .add(retryProviderAssetReplay)
  .add(canonicalizeProviderAsset)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
