/**
 * HeliusSolanaSourceSyncProvider - Provider-facing Helius Solana sync abstraction.
 *
 * @module HeliusSolanaSourceSyncProvider
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ResolvedProviderTransactionTypeMapping } from "../../../services/ProviderReferenceRepository.ts"
import type {
  PersistedSourceTransaction,
  PersistedSourceTransfer,
  PersistedSourceVenueContext,
  SourceProviderTransferDraft,
  SourceTransactionDraft,
  SourceTransactionLegDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../../services/SourceSyncModels.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import type {
  FetchProviderRawBatchParams,
  FetchProviderRawBatchResult,
  SourceSyncProviderError,
} from "../../../shared/SourceProviderRawBatch.ts"

/**
 * Concrete provider key for production Solana wallet ingestion.
 */
export const HELIUS_SOLANA_PROVIDER_KEY = "helius-solana"

/**
 * HeliusSolanaReferenceDataRefreshResult - Helius-owned reference refresh summary.
 */
export interface HeliusSolanaReferenceDataRefreshResult {
  readonly transactionTypeCatalogCount: number
  readonly providerAssetCatalogCount: number
  readonly defaultTransactionMappingCount: number
  readonly defaultProviderAssetMappingCount: number
}

/**
 * HeliusSolanaNormalizationLookups - Provider-side lookup data reused across normalization.
 */
export interface HeliusSolanaNormalizationLookups {
  readonly providerKey: typeof HELIUS_SOLANA_PROVIDER_KEY
}

/**
 * PrepareHeliusSolanaNormalizationParams - Inputs required to normalize one Helius raw record.
 */
export interface PrepareHeliusSolanaNormalizationParams {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
  readonly lookups: HeliusSolanaNormalizationLookups
}

/**
 * PreparedHeliusSolanaNormalization - Canonical Solana artifacts ready for persistence.
 */
export interface PreparedHeliusSolanaNormalization {
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
  readonly legDerivationStrategy: "derive" | "skip"
}

/**
 * DeriveHeliusSolanaProviderLegsParams - Persisted artifacts required for deterministic leg derivation.
 */
export interface DeriveHeliusSolanaProviderLegsParams {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext | null
  readonly feeTransfers: ReadonlyArray<PersistedSourceTransfer>
}

/**
 * HeliusSolanaNormalizationNotImplementedError - Current typed stub for follow-up ingestion slices.
 */
export class HeliusSolanaNormalizationNotImplementedError extends Schema.TaggedError<HeliusSolanaNormalizationNotImplementedError>()(
  "HeliusSolanaNormalizationNotImplementedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaRecoverableNormalizationError - Helius errors that fail one raw row without aborting the job.
 */
export type HeliusSolanaRecoverableNormalizationError = HeliusSolanaNormalizationNotImplementedError

/**
 * HeliusSolanaSourceSyncProviderShape - Helius provider surface consumed by the registry adapter.
 *
 * Keep this contract provider-specific. SourceProviderRegistryLive adapts it to
 * SourceProviderModuleShape for generic source sync orchestration.
 */
export interface HeliusSolanaSourceSyncProviderShape {
  readonly fetchRawBatch: (
    params: FetchProviderRawBatchParams
  ) => Effect.Effect<FetchProviderRawBatchResult, SourceSyncProviderError>

  readonly refreshReferenceData: () => Effect.Effect<
    HeliusSolanaReferenceDataRefreshResult,
    SyncEngineStorageError
  >

  readonly loadNormalizationLookups: () => Effect.Effect<
    HeliusSolanaNormalizationLookups,
    SyncEngineStorageError
  >

  readonly prepareNormalization: (
    params: PrepareHeliusSolanaNormalizationParams
  ) => Effect.Effect<
    PreparedHeliusSolanaNormalization,
    HeliusSolanaRecoverableNormalizationError | SyncEngineStorageError
  >

  readonly deriveLegs: (
    params: DeriveHeliusSolanaProviderLegsParams
  ) => Effect.Effect<
    ReadonlyArray<SourceTransactionLegDraft>,
    HeliusSolanaRecoverableNormalizationError | SyncEngineStorageError
  >
}

/**
 * HeliusSolanaSourceSyncProvider - Context tag for the Helius Solana provider boundary.
 */
export class HeliusSolanaSourceSyncProvider extends Context.Tag("HeliusSolanaSourceSyncProvider")<
  HeliusSolanaSourceSyncProvider,
  HeliusSolanaSourceSyncProviderShape
>() {}
