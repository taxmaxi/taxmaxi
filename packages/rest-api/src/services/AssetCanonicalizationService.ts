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

export class AssetCanonicalizationConflictError extends Schema.TaggedError<AssetCanonicalizationConflictError>()(
  "AssetCanonicalizationConflictError",
  { message: Schema.String }
) {}

export type AssetCanonicalizationError =
  | AssetCanonicalizationBadRequestError
  | AssetCanonicalizationConflictError
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
  readonly replays: ReadonlyArray<ProviderAssetReplayResult>
}

export interface ProviderAssetReplayResult {
  readonly sourceId: string
  readonly jobId: string | null
  readonly status: "failed_to_queue" | "queued"
  readonly message: string | null
}

export interface CoinGeckoAssetCandidate {
  readonly coinId: string
  readonly coinName: string
  readonly coinSymbol: string
  readonly platformId: string
  readonly platformName: string
  readonly contractAddress: string | null
  readonly exactContractMatch: boolean
  readonly evidenceStrength: "exact_contract" | "symbol_only"
  readonly proposedAsset: {
    readonly blockchainName: string
    readonly contractAddress: string | null
    readonly name: string
    readonly symbol: string
    readonly decimals: number
    readonly logoUrl: string | null
    readonly type: "native" | "token" | "nft"
  }
}

export interface ReviewProviderAssetResult {
  readonly providerAsset: ProviderAssetReviewRecord
  readonly replays: ReadonlyArray<ProviderAssetReplayResult>
}

export interface AssetCanonicalizationServiceShape {
  readonly listCoinGeckoCandidates: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<CoinGeckoAssetCandidate>, AssetCanonicalizationError>

  readonly canonicalizeProviderAssetFromCoinGecko: (params: {
    readonly providerAssetRowId: string
    readonly coinId: string
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<CanonicalizeProviderAssetResult, AssetCanonicalizationError>

  readonly mapProviderAssetToExisting: (params: {
    readonly providerAssetRowId: string
    readonly canonicalAssetId: string
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<ReviewProviderAssetResult, AssetCanonicalizationError>

  readonly rejectProviderAsset: (params: {
    readonly providerAssetRowId: string
    readonly rejectionReason: string
    readonly reviewedBy: string
  }) => Effect.Effect<ReviewProviderAssetResult, AssetCanonicalizationError>
}

export class AssetCanonicalizationService extends Context.Tag("AssetCanonicalizationService")<
  AssetCanonicalizationService,
  AssetCanonicalizationServiceShape
>() {}
