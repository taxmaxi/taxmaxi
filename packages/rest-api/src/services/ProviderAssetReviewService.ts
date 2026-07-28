/**
 * ProviderAssetReviewService - Provider asset review use-case contract.
 *
 * @module ProviderAssetReviewService
 */

import type {
  CanonicalAssetRecord,
  ProviderAssetReviewRecord,
  SourceSyncJobDetails,
  SourceSyncJobSummary,
} from "@my/sync-engine/services"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class ProviderAssetReviewNotFoundError extends Schema.TaggedError<ProviderAssetReviewNotFoundError>()(
  "ProviderAssetReviewNotFoundError",
  {
    message: Schema.String,
  }
) {}

export class ProviderAssetReviewBadRequestError extends Schema.TaggedError<ProviderAssetReviewBadRequestError>()(
  "ProviderAssetReviewBadRequestError",
  {
    message: Schema.String,
  }
) {}

export class ProviderAssetReviewProviderError extends Schema.TaggedError<ProviderAssetReviewProviderError>()(
  "ProviderAssetReviewProviderError",
  {
    message: Schema.String,
  }
) {}

export class ProviderAssetReviewInternalError extends Schema.TaggedError<ProviderAssetReviewInternalError>()(
  "ProviderAssetReviewInternalError",
  {
    message: Schema.String,
  }
) {}

export class ProviderAssetReviewConflictError extends Schema.TaggedError<ProviderAssetReviewConflictError>()(
  "ProviderAssetReviewConflictError",
  { message: Schema.String }
) {}

export type ProviderAssetReviewError =
  | ProviderAssetReviewBadRequestError
  | ProviderAssetReviewConflictError
  | ProviderAssetReviewInternalError
  | ProviderAssetReviewNotFoundError
  | ProviderAssetReviewProviderError

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
  readonly availability: "actionable" | "unavailable"
  readonly coinId: string
  readonly coinName: string
  readonly coinSymbol: string
  readonly platformId: string | null
  readonly platformName: string | null
  readonly contractAddress: string | null
  readonly exactContractMatch: boolean
  readonly evidenceStrength: "exact_contract" | "exact_name_and_symbol" | "symbol_only"
  readonly representation: "native" | "token" | "unknown"
  readonly matchReasons: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly unavailableReason: string | null
  readonly proposedAsset: {
    readonly blockchainName: string
    readonly contractAddress: string | null
    readonly name: string
    readonly symbol: string
    readonly decimals: number
    readonly logoUrl: string | null
    readonly type: "native" | "token" | "nft"
  } | null
}

export interface ReviewProviderAssetResult {
  readonly providerAsset: ProviderAssetReviewRecord
  readonly replays: ReadonlyArray<ProviderAssetReplayResult>
}

export interface ProviderAssetReviewServiceShape {
  readonly listCoinGeckoCandidates: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<CoinGeckoAssetCandidate>, ProviderAssetReviewError>

  readonly canonicalizeProviderAssetFromCoinGecko: (params: {
    readonly providerAssetRowId: string
    readonly coinId: string
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<CanonicalizeProviderAssetResult, ProviderAssetReviewError>

  readonly mapProviderAssetToExisting: (params: {
    readonly providerAssetRowId: string
    readonly canonicalAssetId: string
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<ReviewProviderAssetResult, ProviderAssetReviewError>

  readonly approveProviderAssetAsFiat: (params: {
    readonly providerAssetRowId: string
    readonly reviewedBy: string
  }) => Effect.Effect<ReviewProviderAssetResult, ProviderAssetReviewError>

  readonly rejectProviderAsset: (params: {
    readonly providerAssetRowId: string
    readonly rejectionReason: string
    readonly reviewedBy: string
  }) => Effect.Effect<ReviewProviderAssetResult, ProviderAssetReviewError>

  readonly getProviderAssetReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<SourceSyncJobDetails, ProviderAssetReviewError>

  readonly retryProviderAssetReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<SourceSyncJobSummary, ProviderAssetReviewError>
}

export class ProviderAssetReviewService extends Context.Tag("ProviderAssetReviewService")<
  ProviderAssetReviewService,
  ProviderAssetReviewServiceShape
>() {}
