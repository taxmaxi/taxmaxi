/**
 * CoinbaseRecordNormalizer - Provider-aware normalization contract for Coinbase raw records.
 *
 * @module CoinbaseRecordNormalizer
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SourceRawRecord, SourceSyncSource } from "../../../services/SourceSyncModels.ts"
import type {
  SourceProviderTransferDraft,
  SourceTransactionDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"

/**
 * CoinbaseResolvedAssetObservation - Exact provider observation and its optional economic asset.
 */
export interface CoinbaseResolvedAssetObservation {
  readonly assetId: Option.Option<string>
  readonly providerAssetRowId: string
}

/**
 * CoinbaseAssetDecisionFeeTransferCandidate - Complete fee transfer input retained when the
 * provider asset decision does not supply an economic asset.
 */
export interface CoinbaseAssetDecisionFeeTransferCandidate {
  readonly _tag: "asset_decision_fee_transfer"
  readonly providerAssetRowId: string
  readonly transfer: Omit<SourceTransferDraft, "assetId" | "providerAssetRowId">
}

/**
 * NormalizeCoinbaseRecordParams - Input required to normalize one Coinbase raw row.
 */
export interface NormalizeCoinbaseRecordParams {
  readonly sourceRecord: SourceRawRecord
  readonly source: SourceSyncSource
  readonly resolveAsset: (
    currencyCode: string
  ) => Effect.Effect<CoinbaseResolvedAssetObservation, CoinbaseRecordNormalizationError>
  readonly resolveBlockchainId: (networkName: string) => Option.Option<string>
}

/**
 * CoinbaseRecordNormalizationResult - Canonical artifacts produced by Coinbase normalization.
 */
export interface CoinbaseRecordNormalizationResult {
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  /** Exact principal movement draft which may produce the main accounting leg. */
  readonly primaryProviderTransfer: SourceProviderTransferDraft | null
  readonly canonicalTransfers: ReadonlyArray<SourceTransferDraft>
  /** Writer-built fees waiting for a later effective asset decision. */
  readonly feeTransferCandidates: ReadonlyArray<CoinbaseAssetDecisionFeeTransferCandidate>
  readonly feeProviderAssetRowIds: ReadonlyArray<string>
  readonly unresolvedAssetCurrencies: ReadonlyArray<string>
  readonly primaryAssetCurrency: string
}

/**
 * CoinbaseRecordNormalizationError - Tagged error for deterministic Coinbase normalization failures.
 */
export class CoinbaseRecordNormalizationError extends Schema.TaggedError<CoinbaseRecordNormalizationError>()(
  "CoinbaseRecordNormalizationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * CoinbaseRecordNormalizerShape - Contract for normalizing Coinbase raw rows.
 */
export interface CoinbaseRecordNormalizerShape {
  readonly normalize: (
    params: NormalizeCoinbaseRecordParams
  ) => Effect.Effect<CoinbaseRecordNormalizationResult, CoinbaseRecordNormalizationError>
}

/**
 * CoinbaseRecordNormalizer - Context tag for Coinbase raw-record normalization.
 */
export class CoinbaseRecordNormalizer extends Context.Service<
  CoinbaseRecordNormalizer,
  CoinbaseRecordNormalizerShape
>()("CoinbaseRecordNormalizer") {}
