/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import {
  ProviderAssetEvidenceStateSchema,
  ProviderAssetMappingKindSchema,
  ProviderAssetMappingStatusSchema,
} from "@my/sync-engine/services"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { ProviderAssetLatestDecisionSchema } from "../services/ProviderAssetReviewService.ts"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

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
  {
    message: Schema.String,
    latestDecision: Schema.optional(Schema.NullOr(ProviderAssetLatestDecisionSchema)),
  },
  { httpApiStatus: 409 }
) {}

/** Maximum accepted length for public asset catalog search queries. */
export const ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH = 128

const AssetCatalogSearchQuery = Schema.String.check(
  Schema.isMaxLength(ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH)
)

const ProviderAssetInvestigationLinkSchema = Schema.Struct({
  _tag: Schema.Literals(["chain_explorer", "market_data", "market_registry", "provider_page"]),
  label: Schema.String,
  source: Schema.String,
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
})

export class ProviderAssetReviewRow extends Schema.Class<ProviderAssetReviewRow>(
  "ProviderAssetReviewRow"
)({
  id: Schema.String,
  provider: Schema.String,
  providerAssetId: Schema.NullOr(Schema.String),
  naturalKey: Schema.NullOr(Schema.String),
  symbol: Schema.String,
  name: Schema.NullOr(Schema.String),
  assetType: Schema.NullOr(Schema.String),
  source: Schema.Struct({
    _tag: Schema.Literals(["cex", "chain"]),
    name: Schema.String,
  }),
  imageUrl: Schema.NullOr(Schema.String),
  evidenceState: ProviderAssetEvidenceStateSchema,
  affectedSourceCount: Schema.Number,
  discoveredAt: Schema.String,
  reviewRevision: Schema.String,
  investigationLinks: Schema.Array(ProviderAssetInvestigationLinkSchema),
}) {}

const ProviderAssetReviewMappingSchema = Schema.Struct({
  providerAssetRowId: Schema.String,
  mappingKind: ProviderAssetMappingKindSchema,
  canonicalAssetId: Schema.NullOr(Schema.String),
  assetRepresentationId: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: ProviderAssetMappingStatusSchema,
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
  reviewedBy: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})

const ProviderAssetObservedRepresentationSchema = Schema.Struct({
  blockchainName: Schema.String,
  representationType: Schema.NullOr(Schema.Literals(["native", "token", "nft"])),
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  decimals: Schema.NullOr(Schema.Number),
})

export class ProviderAssetReplayResponse extends Schema.Class<ProviderAssetReplayResponse>(
  "ProviderAssetReplayResponse"
)({
  sourceId: Schema.String.check(Schema.isUUID()),
  jobId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literals(["queued", "running", "completed", "failed", "failed_to_queue"]),
  message: Schema.NullOr(Schema.String),
}) {}

export class ProviderAssetReviewDetailResponse extends Schema.Class<ProviderAssetReviewDetailResponse>(
  "ProviderAssetReviewDetailResponse"
)({
  ...ProviderAssetReviewRow.fields,
  rawEvidence: Schema.Unknown,
  observedRepresentations: Schema.Array(ProviderAssetObservedRepresentationSchema),
  mapping: Schema.NullOr(ProviderAssetReviewMappingSchema),
  replays: Schema.Array(ProviderAssetReplayResponse),
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

const ProviderAssetResolutionEffectSchema = Schema.Union([
  Schema.TaggedStruct("UseExistingAsset", {
    canonicalAssetId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("UseExistingRepresentation", {
    canonicalAssetId: Schema.String.check(Schema.isUUID()),
    assetRepresentationId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("AddRepresentation", {
    canonicalAssetId: Schema.String.check(Schema.isUUID()),
    selectedCoinGeckoCoinId: Schema.String.check(Schema.isNonEmpty()),
  }),
  Schema.TaggedStruct("CreateEconomicAsset", {
    selectedCoinGeckoCoinId: Schema.String.check(Schema.isNonEmpty()),
  }),
  Schema.TaggedStruct("CreateAssetWithRepresentation", {
    selectedCoinGeckoCoinId: Schema.String.check(Schema.isNonEmpty()),
  }),
])

const ProviderAssetProposalEconomicAssetSchema = Schema.Union([
  Schema.TaggedStruct("existing", {
    id: Schema.String.check(Schema.isUUID()),
    name: Schema.String,
    symbol: Schema.String,
    coinGeckoCoinId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("proposed", {
    coinGeckoCoinId: Schema.String,
    name: Schema.String,
    symbol: Schema.String,
  }),
])

const ProviderAssetProposalRepresentationSchema = Schema.Union([
  Schema.TaggedStruct("existing", {
    id: Schema.String.check(Schema.isUUID()),
    blockchainName: Schema.String,
    representationType: Schema.Literals(["native", "token", "nft"]),
    contractAddress: Schema.NullOr(Schema.String),
    mintAddress: Schema.NullOr(Schema.String),
    decimals: Schema.Number,
  }),
  Schema.TaggedStruct("proposed", {
    blockchainName: Schema.String,
    representationType: Schema.Literals(["native", "token", "nft"]),
    contractAddress: Schema.NullOr(Schema.String),
    mintAddress: Schema.NullOr(Schema.String),
    decimals: Schema.NullOr(Schema.Number),
  }),
])

export class ProviderAssetResolutionProposalResponse extends Schema.Class<ProviderAssetResolutionProposalResponse>(
  "ProviderAssetResolutionProposalResponse"
)({
  id: Schema.String,
  effect: ProviderAssetResolutionEffectSchema,
  economicAsset: ProviderAssetProposalEconomicAssetSchema,
  representation: Schema.NullOr(ProviderAssetProposalRepresentationSchema),
  evidenceStrength: Schema.Literals(["exact", "name_and_symbol", "symbol_only"]),
  matchReasons: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  investigationLinks: Schema.Array(ProviderAssetInvestigationLinkSchema),
}) {}

export class ProviderAssetResolutionProposalListResponse extends Schema.Class<ProviderAssetResolutionProposalListResponse>(
  "ProviderAssetResolutionProposalListResponse"
)({
  evidenceState: ProviderAssetEvidenceStateSchema,
  recommendedProposalId: Schema.NullOr(Schema.String),
  proposals: Schema.Array(ProviderAssetResolutionProposalResponse),
}) {}

export class ProviderAssetDecisionRequest extends Schema.Class<ProviderAssetDecisionRequest>(
  "ProviderAssetDecisionRequest"
)({
  reviewRevision: Schema.String.check(Schema.isNonEmpty()),
  decision: Schema.Union([
    Schema.TaggedStruct("Resolve", {
      proposalId: Schema.String.check(Schema.isNonEmpty()),
      effect: ProviderAssetResolutionEffectSchema,
    }),
    Schema.TaggedStruct("Reject", {}),
  ]),
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class ProviderAssetDecisionResponse extends Schema.Class<ProviderAssetDecisionResponse>(
  "ProviderAssetDecisionResponse"
)({
  review: ProviderAssetReviewDetailResponse,
  resolutionEffect: Schema.NullOr(ProviderAssetResolutionEffectSchema),
  replays: Schema.Array(ProviderAssetReplayResponse),
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

const ProviderAssetReviewQuery = Schema.Struct({
  q: Schema.optional(AssetCatalogSearchQuery),
  provider: Schema.optional(Schema.String),
  status: Schema.optional(ProviderAssetMappingStatusSchema),
  evidence: Schema.optional(ProviderAssetEvidenceStateSchema),
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
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "List provider asset review rows",
      description: "Lists provider assets by mapping review status.",
    })
  )
  .middleware(AdminAuthMiddleware)

const ProviderAssetReviewPath = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
})

const getProviderAssetReview = HttpApiEndpoint.get(
  "getProviderAssetReview",
  "/assets/provider-assets/:id",
  {
    params: ProviderAssetReviewPath,
    success: ProviderAssetReviewDetailResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Get provider asset review",
      description: "Returns the complete evidence, current decision, and replay state.",
    })
  )
  .middleware(AdminAuthMiddleware)

const searchProviderAssetResolutionProposals = HttpApiEndpoint.get(
  "searchProviderAssetResolutionProposals",
  "/assets/provider-assets/:id/proposals",
  {
    params: ProviderAssetReviewPath,
    query: Schema.Struct({ q: Schema.optional(AssetCatalogSearchQuery) }),
    success: ProviderAssetResolutionProposalListResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Search provider asset resolution proposals",
      description: "Returns evidence-backed canonical asset choices and an exact recommendation.",
    })
  )
  .middleware(AdminAuthMiddleware)

const decideProviderAssetReview = HttpApiEndpoint.post(
  "decideProviderAssetReview",
  "/assets/provider-assets/:id/decision",
  {
    params: ProviderAssetReviewPath,
    payload: Schema.Struct(ProviderAssetDecisionRequest.fields),
    success: ProviderAssetDecisionResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
)
  .annotateMerge(
    OpenApi.annotations({
      summary: "Decide provider asset review",
      description: "Applies one revision-checked resolution or rejection and schedules replays.",
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
    success: ProviderAssetReplayResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

const retryProviderAssetReplay = HttpApiEndpoint.post(
  "retryProviderAssetReplay",
  "/assets/provider-assets/:id/replays/:sourceId/jobs/:jobId/retry",
  {
    params: ProviderAssetReplayPath,
    success: ProviderAssetReplayResponse,
    error: [AssetBadRequestError, AssetNotFoundError, AssetConflictError, InternalServerError],
  }
).middleware(AdminAuthMiddleware)

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listAssets)
  .add(getAsset)
  .add(listPendingAssets)
  .add(listProviderAssetReviews)
  .add(getProviderAssetReview)
  .add(searchProviderAssetResolutionProposals)
  .add(decideProviderAssetReview)
  .add(listUnresolvedTransferReconciliations)
  .add(getProviderAssetReplay)
  .add(retryProviderAssetReplay)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
