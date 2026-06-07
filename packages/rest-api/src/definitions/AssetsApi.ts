/**
 * AssetsApi - Canonical asset and provider-asset review endpoints.
 *
 * @module AssetsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { ForbiddenError, InternalServerError } from "./ApiErrors.ts"

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
  canonicalAssetSymbol: Schema.NullOr(Schema.String),
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

export class AssetCanonicalizationRequest extends Schema.Class<AssetCanonicalizationRequest>(
  "AssetCanonicalizationRequest"
)({
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

const listProviderAssetReviews = HttpApiEndpoint.get(
  "listProviderAssetReviews",
  "/assets/provider-assets"
)
  .setUrlParams(ProviderAssetReviewQuery)
  .addSuccess(ProviderAssetReviewListResponse)
  .addError(ForbiddenError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List provider asset review rows",
      description: "Lists provider assets by mapping review status.",
    })
  )

const canonicalizeProviderAssetFromCoinGecko = HttpApiEndpoint.post(
  "canonicalizeProviderAssetFromCoinGecko",
  "/assets/provider-assets/:providerAssetRowId/canonicalize/coingecko"
)
  .setPath(
    Schema.Struct({
      providerAssetRowId: Schema.UUID,
    })
  )
  .setPayload(AssetCanonicalizationRequest)
  .addSuccess(AssetCanonicalizationResponse)
  .addError(AssetBadRequestError)
  .addError(AssetNotFoundError)
  .addError(ForbiddenError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Canonicalize provider asset through CoinGecko",
      description:
        "Creates or refreshes a canonical asset from CoinGecko metadata and approves the provider asset mapping.",
    })
  )

export class AssetsApi extends HttpApiGroup.make("assets")
  .add(listProviderAssetReviews)
  .add(canonicalizeProviderAssetFromCoinGecko)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Assets",
      description: "Canonical asset and provider asset review endpoints",
    })
  ) {}
