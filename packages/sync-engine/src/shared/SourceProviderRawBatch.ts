/**
 * SourceProviderRawBatch - Shared raw provider ingestion data contracts.
 *
 * @module SourceProviderRawBatch
 */

import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "../services/SyncEngineStorageError.ts"

/**
 * ProviderRawRecord - Source/provider record normalized for raw cache persistence.
 */
export class ProviderRawRecord extends Schema.Class<ProviderRawRecord>("ProviderRawRecord")({
  recordType: Schema.String,
  providerKey: Schema.String,
  externalRecordId: Schema.String,
  externalAccountId: Schema.NullOr(Schema.String),
  externalParentId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateFromSelf,
  payload: Schema.Unknown,
}) {}

/**
 * FetchProviderRawBatchParams - Input for one provider batch pull.
 */
export class FetchProviderRawBatchParams extends Schema.Class<FetchProviderRawBatchParams>(
  "FetchProviderRawBatchParams"
)({
  providerKey: Schema.String,
  sourceId: Schema.String,
  walletAddress: Schema.NullOr(Schema.String),
  cursorPayload: Schema.Unknown,
  resumeHighWatermark: Schema.NullOr(Schema.DateFromSelf),
  resumeCheckpointExternalId: Schema.NullOr(Schema.String),
  pageSize: Schema.Number,
}) {}

/**
 * FetchProviderRawBatchResult - One durable batch and next provider state.
 */
export class FetchProviderRawBatchResult extends Schema.Class<FetchProviderRawBatchResult>(
  "FetchProviderRawBatchResult"
)({
  records: Schema.Array(ProviderRawRecord),
  cursorPayload: Schema.Unknown,
  highWatermark: Schema.NullOr(Schema.DateFromSelf),
  done: Schema.Boolean,
}) {}

/**
 * UnsupportedSyncProviderError - Provider has no ingestion implementation.
 */
export class UnsupportedSyncProviderError extends Schema.TaggedError<UnsupportedSyncProviderError>()(
  "UnsupportedSyncProviderError",
  {
    providerKey: Schema.String,
  }
) {}

/**
 * SourceSyncCursorDecodeError - Persisted provider cursor payload is invalid.
 */
export class SourceSyncCursorDecodeError extends Schema.TaggedError<SourceSyncCursorDecodeError>()(
  "SourceSyncCursorDecodeError",
  {
    providerKey: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * SourceSyncProviderFailureError - Provider pull failed during ingestion.
 */
export class SourceSyncProviderFailureError extends Schema.TaggedError<SourceSyncProviderFailureError>()(
  "SourceSyncProviderFailureError",
  {
    providerKey: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  }
) {}

/**
 * SourceSyncProviderError - Union of typed provider failures.
 */
export type SourceSyncProviderError =
  | UnsupportedSyncProviderError
  | SourceSyncCursorDecodeError
  | SourceSyncProviderFailureError
  | SyncEngineStorageError
