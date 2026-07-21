/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"
import { SourceSyncJobResponse, SourceSyncStartResponse } from "./SourcesApi.ts"

export class AssetBadRequestError extends Schema.TaggedError<AssetBadRequestError>()(
  "AssetBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 })
) {}

export class AssetNotFoundError extends Schema.TaggedError<AssetNotFoundError>()(
  "AssetNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class AssetConflictError extends Schema.TaggedError<AssetConflictError>()(
  "AssetConflictError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 409 })
) {}

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
  evidenceSource: Schema.Struct({
    providerName: Schema.String,
    apiName: Schema.String,
    endpoint: Schema.NullOr(Schema.String),
    documentationUrl: Schema.NullOr(Schema.String),
    payloadKind: Schema.Literal("direct_response", "derived_observation", "fallback"),
    typeSource: Schema.Literal("provider", "taxmaxi_inferred"),
    typeExplanation: Schema.String,
  }),
  rawProviderPayload: Schema.Unknown,
  discoveredAt: Schema.DateTimeUtc,
  retrievedAt: Schema.DateTimeUtc,
  mappingKind: Schema.NullOr(Schema.Literal("asset", "fiat")),
  canonicalAssetId: Schema.NullOr(Schema.String),
  canonicalAssetSymbol: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: Schema.NullOr(Schema.Literal("approved", "pending_review", "rejected")),
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
  reviewedBy: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.DateTimeUtc),
}) {}

export class ProviderAssetReviewListResponse extends Schema.Class<ProviderAssetReviewListResponse>(
  "ProviderAssetReviewListResponse"
)({
  providerAssets: Schema.Array(ProviderAssetReviewRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
  totalCount: Schema.Number,
}) {}

export class AssetCatalogAssetResponse extends Schema.Class<AssetCatalogAssetResponse>(
  "AssetCatalogAssetResponse"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  blockchainChainType: Schema.String,
  blockchainChainId: Schema.NullOr(Schema.Number),
  blockchainExplorerUrl: Schema.NullOr(Schema.String),
  blockchainLogoUrl: Schema.NullOr(Schema.String),
  contractAddress: Schema.NullOr(Schema.String),
  name: Schema.String,
  symbol: Schema.String,
  decimals: Schema.Number,
  logoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literal("native", "token", "nft"),
  isSpam: Schema.Boolean,
}) {}

export class AssetCatalogListResponse extends Schema.Class<AssetCatalogListResponse>(
  "AssetCatalogListResponse"
)({
  assets: Schema.Array(AssetCatalogAssetResponse),
}) {}

export class AssetCanonicalizationRequest extends Schema.Class<AssetCanonicalizationRequest>(
  "AssetCanonicalizationRequest"
)({
  coinId: Schema.NonEmptyTrimmedString,
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class CanonicalAssetResponse extends Schema.Class<CanonicalAssetResponse>(
  "CanonicalAssetResponse"
)({
  id: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  decimals: Schema.Number,
  contractAddress: Schema.NullOr(Schema.String),
  type: Schema.Literal("native", "token", "nft"),
}) {}

export class AssetCanonicalizationEvidenceResponse extends Schema.Class<AssetCanonicalizationEvidenceResponse>(
  "AssetCanonicalizationEvidenceResponse"
)({
  source: Schema.Literal("coingecko"),
  coinId: Schema.String,
  coinName: Schema.String,
  coinSymbol: Schema.String,
  platformId: Schema.String,
  platformName: Schema.String,
  contractAddress: Schema.NullOr(Schema.String),
}) {}

export class AssetCanonicalizationResponse extends Schema.Class<AssetCanonicalizationResponse>(
  "AssetCanonicalizationResponse"
)({
  providerAsset: ProviderAssetReviewRow,
  canonicalAsset: CanonicalAssetResponse,
  evidence: AssetCanonicalizationEvidenceResponse,
  replays: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      jobId: Schema.NullOr(Schema.String),
      status: Schema.Literal("queued", "failed_to_queue"),
      message: Schema.NullOr(Schema.String),
    })
  ),
}) {}

export class CoinGeckoAssetCandidateResponse extends Schema.Class<CoinGeckoAssetCandidateResponse>(
  "CoinGeckoAssetCandidateResponse"
)({
  availability: Schema.Literal("actionable", "unavailable"),
  coinId: Schema.String,
  coinName: Schema.String,
  coinSymbol: Schema.String,
  platformId: Schema.NullOr(Schema.String),
  platformName: Schema.NullOr(Schema.String),
  contractAddress: Schema.NullOr(Schema.String),
  exactContractMatch: Schema.Boolean,
  evidenceStrength: Schema.Literal("exact_contract", "exact_name_and_symbol", "symbol_only"),
  representation: Schema.Literal("native", "token", "unknown"),
  matchReasons: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  unavailableReason: Schema.NullOr(Schema.String),
  proposedAsset: Schema.NullOr(
    Schema.Struct({
      blockchainName: Schema.String,
      contractAddress: Schema.NullOr(Schema.String),
      name: Schema.String,
      symbol: Schema.String,
      decimals: Schema.Number,
      logoUrl: Schema.NullOr(Schema.String),
      type: Schema.Literal("native", "token", "nft"),
    })
  ),
}) {}

export class CoinGeckoAssetCandidateListResponse extends Schema.Class<CoinGeckoAssetCandidateListResponse>(
  "CoinGeckoAssetCandidateListResponse"
)({ candidates: Schema.Array(CoinGeckoAssetCandidateResponse) }) {}

export class MapProviderAssetRequest extends Schema.Class<MapProviderAssetRequest>(
  "MapProviderAssetRequest"
)({
  canonicalAssetId: Schema.UUID,
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class RejectProviderAssetRequest extends Schema.Class<RejectProviderAssetRequest>(
  "RejectProviderAssetRequest"
)({ rejectionReason: Schema.NonEmptyTrimmedString }) {}

export class ProviderAssetDecisionResponse extends Schema.Class<ProviderAssetDecisionResponse>(
  "ProviderAssetDecisionResponse"
)({
  providerAsset: ProviderAssetReviewRow,
  replays: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      jobId: Schema.NullOr(Schema.String),
      status: Schema.Literal("queued", "failed_to_queue"),
      message: Schema.NullOr(Schema.String),
    })
  ),
}) {}

const ProviderAssetReviewQuery = Schema.Struct({
  provider: Schema.optional(Schema.String),
  q: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal("pending_review", "approved", "rejected")),
  cursor: Schema.optional(Schema.UUID),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(100)
    )
  ),
})

const AssetCatalogListQuery = Schema.Struct({
  q: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(500)
    )
  ),
})

const listAssets = HttpApiEndpoint.get("listAssets", "/assets")
  .setUrlParams(AssetCatalogListQuery)
  .addSuccess(AssetCatalogListResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List canonical assets",
      description: "Lists non-spam canonical assets from the TaxMaxi asset registry.",
    })
  )

const getAsset = HttpApiEndpoint.get("getAsset", "/assets/:assetId")
  .setPath(
    Schema.Struct({
      assetId: Schema.UUID,
    })
  )
  .addSuccess(AssetCatalogAssetResponse)
  .addError(AssetNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Get canonical asset",
      description: "Returns one non-spam canonical asset from the TaxMaxi asset registry.",
    })
  )

const listProviderAssetReviews = HttpApiEndpoint.get(
  "listProviderAssetReviews",
  "/assets/provider-assets"
)
  .setUrlParams(ProviderAssetReviewQuery)
  .addSuccess(ProviderAssetReviewListResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List provider asset review rows",
      description: "Lists provider assets by mapping review status.",
    })
  )
  .middleware(AdminAuthMiddleware)

const canonicalizeProviderAsset = HttpApiEndpoint.post(
  "canonicalizeProviderAsset",
  "/assets/provider-assets/:id/canonicalize"
)
  .setPath(
    Schema.Struct({
      id: Schema.UUID,
    })
  )
  .setPayload(AssetCanonicalizationRequest)
  .addSuccess(AssetCanonicalizationResponse)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(AssetConflictError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Canonicalize provider asset",
      description:
        "Creates or refreshes a canonical asset and approves the provider asset mapping.",
    })
  )
  .middleware(AdminAuthMiddleware)

const listProviderAssetCandidates = HttpApiEndpoint.get(
  "listProviderAssetCandidates",
  "/assets/provider-assets/:id/candidates"
)
  .setPath(Schema.Struct({ id: Schema.UUID }))
  .addSuccess(CoinGeckoAssetCandidateListResponse)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(AssetConflictError)
  .addError(InternalServerError)
  .middleware(AdminAuthMiddleware)

const mapProviderAsset = HttpApiEndpoint.post("mapProviderAsset", "/assets/provider-assets/:id/map")
  .setPath(Schema.Struct({ id: Schema.UUID }))
  .setPayload(MapProviderAssetRequest)
  .addSuccess(ProviderAssetDecisionResponse)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(AssetConflictError)
  .addError(InternalServerError)
  .middleware(AdminAuthMiddleware)

const rejectProviderAsset = HttpApiEndpoint.post(
  "rejectProviderAsset",
  "/assets/provider-assets/:id/reject"
)
  .setPath(Schema.Struct({ id: Schema.UUID }))
  .setPayload(RejectProviderAssetRequest)
  .addSuccess(ProviderAssetDecisionResponse)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(AssetConflictError)
  .addError(InternalServerError)
  .middleware(AdminAuthMiddleware)

const ProviderAssetReplayPath = Schema.Struct({
  id: Schema.UUID,
  sourceId: Schema.UUID,
})

const getProviderAssetReplay = HttpApiEndpoint.get(
  "getProviderAssetReplay",
  "/assets/provider-assets/:id/replays/:sourceId/jobs/:jobId"
)
  .setPath(Schema.Struct({ ...ProviderAssetReplayPath.fields, jobId: Schema.UUID }))
  .addSuccess(SourceSyncJobResponse)
  .addError(AssetNotFoundError)
  .addError(InternalServerError)
  .middleware(AdminAuthMiddleware)

const retryProviderAssetReplay = HttpApiEndpoint.post(
  "retryProviderAssetReplay",
  "/assets/provider-assets/:id/replays/:sourceId/jobs/:jobId/retry"
)
  .setPath(Schema.Struct({ ...ProviderAssetReplayPath.fields, jobId: Schema.UUID }))
  .addSuccess(SourceSyncStartResponse)
  .addError(AssetNotFoundError)
  .addError(InternalServerError)
  .middleware(AdminAuthMiddleware)

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listAssets)
  .add(getAsset)
  .add(listProviderAssetReviews)
  .add(listProviderAssetCandidates)
  .add(canonicalizeProviderAsset)
  .add(mapProviderAsset)
  .add(rejectProviderAsset)
  .add(getProviderAssetReplay)
  .add(retryProviderAssetReplay)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
