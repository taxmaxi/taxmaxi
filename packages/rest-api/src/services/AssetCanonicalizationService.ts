/**
 * AssetCanonicalizationService - Review-time canonical asset creation contract.
 *
 * @module AssetCanonicalizationService
 */

import type { CanonicalAssetRecord, ProviderAssetReviewRecord } from "@my/sync-engine/services"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class AssetCanonicalizationNotFoundError extends Schema.TaggedError<AssetCanonicalizationNotFoundError>()(
  "AssetCanonicalizationNotFoundError",
  {
    message: Schema.String,
  }
) {}

export class AssetCanonicalizationBadRequestError extends Schema.TaggedError<AssetCanonicalizationBadRequestError>()(
  "AssetCanonicalizationBadRequestError",
  {
    message: Schema.String,
  }
) {}

export class AssetCanonicalizationProviderError extends Schema.TaggedError<AssetCanonicalizationProviderError>()(
  "AssetCanonicalizationProviderError",
  {
    message: Schema.String,
  }
) {}

export class AssetCanonicalizationInternalError extends Schema.TaggedError<AssetCanonicalizationInternalError>()(
  "AssetCanonicalizationInternalError",
  {
    message: Schema.String,
  }
) {}

export type AssetCanonicalizationError =
  | AssetCanonicalizationBadRequestError
  | AssetCanonicalizationInternalError
  | AssetCanonicalizationNotFoundError
  | AssetCanonicalizationProviderError

export interface AssetCanonicalizationEvidence {
  readonly source: "coingecko"
  readonly coinId: string
  readonly coinName: string
  readonly coinSymbol: string
  readonly platformId: string
  readonly platformName: string
  readonly contractAddress: string | null
}

export interface CanonicalizeProviderAssetResult {
  readonly providerAsset: ProviderAssetReviewRecord
  readonly canonicalAsset: CanonicalAssetRecord
  readonly evidence: AssetCanonicalizationEvidence
}

export interface AssetCanonicalizationServiceShape {
  readonly canonicalizeProviderAssetFromCoinGecko: (params: {
    readonly providerAssetRowId: string
    readonly reviewerNotes: string | null
  }) => Effect.Effect<CanonicalizeProviderAssetResult, AssetCanonicalizationError>
}

export class AssetCanonicalizationService extends Context.Tag("AssetCanonicalizationService")<
  AssetCanonicalizationService,
  AssetCanonicalizationServiceShape
>() {}
