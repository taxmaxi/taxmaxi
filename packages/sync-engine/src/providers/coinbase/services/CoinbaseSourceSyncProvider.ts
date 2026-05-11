/**
 * CoinbaseSourceSyncProvider - Provider-facing Coinbase sync abstraction.
 *
 * @module CoinbaseSourceSyncProvider
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { SyncEngineAsset } from "../../../services/AssetRepository.ts"
import type {
  SourceProviderTransferDraft,
  PersistedSourceTransaction,
  PersistedSourceTransfer,
  PersistedSourceVenueContext,
  SourceTransactionDraft,
  SourceTransactionLegDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../../services/SourceSyncModels.ts"
import {
  FetchProviderRawBatchParams,
  FetchProviderRawBatchResult,
  type SourceSyncProviderError,
} from "../../../services/SourceSyncProvider.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import type { CoinbaseLegDerivationError } from "./CoinbaseLegDerivationService.ts"
import type { CoinbaseRecordNormalizationError } from "./CoinbaseRecordNormalizer.ts"
import type {
  RefreshCoinbaseReferenceDataResult,
  CoinbaseReferenceDataServiceError,
} from "./CoinbaseReferenceDataService.ts"
import type {
  CoinbaseBrokenApprovedProviderAssetMappingError,
  CoinbasePendingTransactionTypeMappingError,
  CoinbaseResolvedTransactionTypeMapping,
} from "./CoinbaseReferenceMappingService.ts"

/**
 * CoinbaseNormalizationLookups - Provider-side lookup data reused across normalization.
 */
export interface CoinbaseNormalizationLookups {
  readonly blockchainIdByName: ReadonlyMap<string, string>
}

/**
 * PrepareCoinbaseNormalizationParams - Inputs required to normalize one Coinbase raw record.
 */
export interface PrepareCoinbaseNormalizationParams {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
  readonly lookups: CoinbaseNormalizationLookups
}

/**
 * PreparedCoinbaseNormalization - Canonical Coinbase artifacts ready for persistence.
 */
export interface PreparedCoinbaseNormalization {
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: CoinbaseResolvedTransactionTypeMapping
  readonly primaryAsset: SyncEngineAsset | null
  readonly legDerivationStrategy: "derive" | "skip"
}

/**
 * DeriveCoinbaseProviderLegsParams - Persisted artifacts required for deterministic leg derivation.
 */
export interface DeriveCoinbaseProviderLegsParams {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext | null
  readonly primaryAsset: SyncEngineAsset | null
  readonly feeTransfers: ReadonlyArray<PersistedSourceTransfer>
}

/**
 * CoinbaseRecoverableNormalizationError - Provider errors that fail one raw row without aborting the job.
 */
export type CoinbaseRecoverableNormalizationError =
  | CoinbaseRecordNormalizationError
  | CoinbasePendingTransactionTypeMappingError
  | CoinbaseBrokenApprovedProviderAssetMappingError
  | CoinbaseLegDerivationError

/**
 * CoinbaseSourceSyncProviderShape - Coinbase provider surface consumed by orchestration.
 */
export interface CoinbaseSourceSyncProviderShape {
  readonly fetchRawBatch: (
    params: FetchProviderRawBatchParams
  ) => Effect.Effect<FetchProviderRawBatchResult, SourceSyncProviderError>

  readonly refreshReferenceData: () => Effect.Effect<
    RefreshCoinbaseReferenceDataResult,
    CoinbaseReferenceDataServiceError
  >

  readonly loadNormalizationLookups: () => Effect.Effect<
    CoinbaseNormalizationLookups,
    SyncEngineStorageError
  >

  readonly prepareNormalization: (
    params: PrepareCoinbaseNormalizationParams
  ) => Effect.Effect<
    PreparedCoinbaseNormalization,
    CoinbaseRecoverableNormalizationError | SyncEngineStorageError
  >

  readonly deriveLegs: (
    params: DeriveCoinbaseProviderLegsParams
  ) => Effect.Effect<
    ReadonlyArray<SourceTransactionLegDraft>,
    CoinbaseLegDerivationError | SyncEngineStorageError
  >
}

/**
 * CoinbaseSourceSyncProvider - Context tag for the Coinbase provider boundary.
 */
export class CoinbaseSourceSyncProvider extends Context.Tag("CoinbaseSourceSyncProvider")<
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProviderShape
>() {}
