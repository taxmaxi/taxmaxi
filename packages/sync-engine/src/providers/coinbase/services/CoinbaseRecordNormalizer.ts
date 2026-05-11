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
 * NormalizeCoinbaseRecordParams - Input required to normalize one Coinbase raw row.
 */
export interface NormalizeCoinbaseRecordParams {
  readonly sourceRecord: SourceRawRecord
  readonly source: SourceSyncSource
  readonly resolveAssetId: (
    currencyCode: string
  ) => Effect.Effect<Option.Option<string>, CoinbaseRecordNormalizationError>
  readonly resolveBlockchainId: (networkName: string) => Option.Option<string>
}

/**
 * CoinbaseRecordNormalizationResult - Canonical artifacts produced by Coinbase normalization.
 */
export interface CoinbaseRecordNormalizationResult {
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
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
export class CoinbaseRecordNormalizer extends Context.Tag("CoinbaseRecordNormalizer")<
  CoinbaseRecordNormalizer,
  CoinbaseRecordNormalizerShape
>() {}
