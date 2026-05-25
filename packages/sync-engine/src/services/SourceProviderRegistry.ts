/**
 * SourceProviderRegistry - Provider module registry for source sync orchestration.
 *
 * @module SourceProviderRegistry
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ResolvedProviderTransactionTypeMapping } from "./ProviderReferenceRepository.ts"
import type {
  PersistNormalizedSourceArtifactsContext,
  SourceProviderTransferDraft,
  SourceTransactionDraft,
  SourceTransactionLegDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "./SourceNormalizationRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "./SourceSyncModels.ts"
import type {
  FetchProviderRawBatchParams,
  FetchProviderRawBatchResult,
  SourceSyncProviderError,
  UnsupportedSyncProviderError,
} from "../shared/SourceProviderRawBatch.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SourceProviderReferenceDataRefreshResult - Provider-neutral reference-data refresh summary.
 */
export interface SourceProviderReferenceDataRefreshResult {
  readonly transactionTypeCatalogCount: number
  readonly providerAssetCatalogCount: number
  readonly defaultTransactionMappingCount: number
  readonly defaultProviderAssetMappingCount: number
}

/**
 * SourceProviderRecoverableNormalizationError - Provider row-level error that fails one raw row.
 */
export class SourceProviderRecoverableNormalizationError extends Schema.TaggedError<SourceProviderRecoverableNormalizationError>()(
  "SourceProviderRecoverableNormalizationError",
  {
    providerKey: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * SourceProviderReferenceDataError - Provider reference refresh failure with a stable message.
 */
export class SourceProviderReferenceDataError extends Schema.TaggedError<SourceProviderReferenceDataError>()(
  "SourceProviderReferenceDataError",
  {
    providerKey: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * SourceProviderModuleError - Provider-module failures visible to source orchestration.
 */
export type SourceProviderModuleError = SourceSyncProviderError | SourceProviderReferenceDataError

/**
 * SourceProviderPreparedNormalization - Provider-normalized artifacts ready for canonical persistence.
 */
export interface SourceProviderPreparedNormalization {
  readonly kind: "prepared"
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
  readonly deriveLegs: (
    context: PersistNormalizedSourceArtifactsContext
  ) => Effect.Effect<
    ReadonlyArray<SourceTransactionLegDraft>,
    SourceProviderRecoverableNormalizationError | SyncEngineStorageError
  >
}

/**
 * SourceProviderSkippedNormalization - Provider decision for raw rows that do not derive artifacts.
 */
export interface SourceProviderSkippedNormalization {
  readonly kind: "skipped"
}

/**
 * SourceProviderNormalizationDecision - Provider decision for one raw row.
 */
export type SourceProviderNormalizationDecision =
  | SourceProviderPreparedNormalization
  | SourceProviderSkippedNormalization

/**
 * SourceProviderNormalizeRawRecordParams - Inputs for provider-owned raw-row normalization.
 */
export interface SourceProviderNormalizeRawRecordParams {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
}

/**
 * SourceProviderRawRecordNormalizer - Provider normalizer closed over provider-specific lookups.
 */
export type SourceProviderRawRecordNormalizer = (
  params: SourceProviderNormalizeRawRecordParams
) => Effect.Effect<
  SourceProviderNormalizationDecision,
  SourceProviderRecoverableNormalizationError | SyncEngineStorageError
>

/**
 * SourceProviderModuleShape - Provider-neutral module consumed by sync orchestration.
 */
export interface SourceProviderModuleShape {
  readonly fetchRawBatch: (
    params: FetchProviderRawBatchParams
  ) => Effect.Effect<FetchProviderRawBatchResult, SourceSyncProviderError>

  readonly refreshReferenceData: () => Effect.Effect<
    SourceProviderReferenceDataRefreshResult,
    SourceProviderModuleError
  >

  readonly makeRawRecordNormalizer: () => Effect.Effect<
    SourceProviderRawRecordNormalizer,
    SourceProviderModuleError
  >
}

/**
 * SourceProviderRegistryShape - Provider-key module registry used by sync orchestration.
 */
export interface SourceProviderRegistryShape {
  readonly resolveProviderModule: (params: {
    readonly providerKey: string
  }) => Effect.Effect<SourceProviderModuleShape, UnsupportedSyncProviderError>
}

/**
 * SourceProviderRegistry - Context tag for provider-key module lookup.
 */
export class SourceProviderRegistry extends Context.Tag("SourceProviderRegistry")<
  SourceProviderRegistry,
  SourceProviderRegistryShape
>() {}
