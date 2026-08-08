/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { AdminAuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

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
  mappingKind: Schema.NullOr(Schema.Literal("asset", "fiat")),
  canonicalAssetId: Schema.NullOr(Schema.String),
  assetRepresentationId: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: Schema.NullOr(Schema.Literal("approved", "pending_review", "rejected")),
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
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

export class TransferReconciliationReviewRow extends Schema.Class<TransferReconciliationReviewRow>(
  "TransferReconciliationReviewRow"
)({
  id: Schema.UUID,
  principalId: Schema.UUID,
  providerTransferId: Schema.UUID,
  providerSourceId: Schema.UUID,
  providerTimestamp: Schema.String,
  providerDirection: Schema.Literal("inbound", "outbound"),
  providerAmount: Schema.String,
  networkName: Schema.NullOr(Schema.String),
  networkHash: Schema.NullOr(Schema.String),
  canonicalTransferId: Schema.NullOr(Schema.UUID),
  canonicalTransactionId: Schema.NullOr(Schema.UUID),
  status: Schema.Literal("pending", "needs_review", "approved", "rejected", "auto_applied"),
  matchReason: Schema.String,
  confidence: Schema.String,
  deterministic: Schema.Boolean,
  reviewMetadata: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class TransferReconciliationReviewListResponse extends Schema.Class<TransferReconciliationReviewListResponse>(
  "TransferReconciliationReviewListResponse"
)({
  reconciliations: Schema.Array(TransferReconciliationReviewRow),
  page: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.UUID),
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
  type: Schema.Literal("native", "token", "nft"),
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
  logoUrl: Schema.NullOr(Schema.String),
  type: Schema.Literal("fungible", "nft"),
  representations: Schema.Array(AssetRepresentationResponse),
}) {}

export class AssetCatalogListResponse extends Schema.Class<AssetCatalogListResponse>(
  "AssetCatalogListResponse"
)({
  assets: Schema.Array(AssetCatalogAssetResponse),
}) {}

export class AssetCanonicalizationRequest extends Schema.Class<AssetCanonicalizationRequest>(
  "AssetCanonicalizationRequest"
)({
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class ProviderAssetApprovalRequest extends Schema.Class<ProviderAssetApprovalRequest>(
  "ProviderAssetApprovalRequest"
)({
  canonicalAssetId: Schema.UUID,
  assetRepresentationId: Schema.NullOr(Schema.UUID),
  reviewerNotes: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class CanonicalAssetResponse extends Schema.Class<CanonicalAssetResponse>(
  "CanonicalAssetResponse"
)({
  id: Schema.String,
  representationId: Schema.String,
  blockchainId: Schema.String,
  blockchainName: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
  type: Schema.Literal("fungible", "nft"),
  decimals: Schema.Number,
  contractAddress: Schema.NullOr(Schema.String),
  mintAddress: Schema.NullOr(Schema.String),
  representationType: Schema.Literal("native", "token", "nft"),
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
}) {}

const ProviderAssetReviewQuery = Schema.Struct({
  provider: Schema.optional(Schema.String),
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

const TransferReconciliationReviewQuery = Schema.Struct({
  status: Schema.optional(
    Schema.Literal("pending", "needs_review", "approved", "rejected", "auto_applied")
  ),
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

const listTransferReconciliationReviews = HttpApiEndpoint.get(
  "listTransferReconciliationReviews",
  "/assets/transfer-reconciliations"
)
  .setUrlParams(TransferReconciliationReviewQuery)
  .addSuccess(TransferReconciliationReviewListResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List transfer reconciliation review rows",
      description: "Lists durable transfer reconciliation decisions and their candidate evidence.",
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
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Canonicalize provider asset",
      description:
        "Creates or refreshes a canonical asset and approves the provider asset mapping.",
    })
  )
  .middleware(AdminAuthMiddleware)

const approveProviderAsset = HttpApiEndpoint.post(
  "approveProviderAsset",
  "/assets/provider-assets/:id/approve"
)
  .setPath(
    Schema.Struct({
      id: Schema.UUID,
    })
  )
  .setPayload(ProviderAssetApprovalRequest)
  .addSuccess(ProviderAssetReviewRow)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Approve provider asset mapping",
      description:
        "Maps a provider asset to an existing canonical asset and optional network representation.",
    })
  )
  .middleware(AdminAuthMiddleware)

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listAssets)
  .add(getAsset)
  .add(listProviderAssetReviews)
  .add(listTransferReconciliationReviews)
  .add(approveProviderAsset)
  .add(canonicalizeProviderAsset)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
