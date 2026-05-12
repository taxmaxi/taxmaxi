/**
 * SourceSyncService - Service interface for syncing provider sources.
 *
 * @module SourceSyncService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SourceSyncJobDetails, SourceSyncJobSummary } from "./SourceSyncModels.ts"
import type { SourceSyncQueueError } from "./SourceSyncQueue.ts"

/**
 * UnsupportedProviderError - Provider is not supported by the sync engine.
 */
export class UnsupportedProviderError extends Schema.TaggedError<UnsupportedProviderError>()(
  "UnsupportedProviderError",
  {
    provider: Schema.String,
  }
) {}

/**
 * SourceNotFoundError - Principal has no configured source for the requested source id.
 */
export class SourceNotFoundError extends Schema.TaggedError<SourceNotFoundError>()(
  "SourceNotFoundError",
  {
    sourceId: Schema.String,
  }
) {}

/**
 * SourceSyncJobNotFoundError - Requested job is not visible for the principal/source pair.
 */
export class SourceSyncJobNotFoundError extends Schema.TaggedError<SourceSyncJobNotFoundError>()(
  "SourceSyncJobNotFoundError",
  {
    sourceId: Schema.String,
    jobId: Schema.String,
  }
) {}

/**
 * StartSourceSyncJobParams - Input for starting a provider sync job.
 */
export interface StartSourceSyncJobParams {
  readonly principalId: string
  readonly sourceId: string
}

/**
 * ReplaySourceSyncJobParams - Input for replaying cached raw rows for one source.
 */
export interface ReplaySourceSyncJobParams {
  readonly principalId: string
  readonly sourceId: string
}

/**
 * GetSourceSyncJobParams - Input for loading a sync job status.
 */
export interface GetSourceSyncJobParams {
  readonly principalId: string
  readonly sourceId: string
  readonly jobId: string
}

/**
 * SourceSyncServiceError - Union of source sync service failures.
 */
export type SourceSyncServiceError =
  | UnsupportedProviderError
  | SourceNotFoundError
  | SourceSyncJobNotFoundError
  | SourceSyncQueueError
  | SyncEngineStorageError

/**
 * SourceSyncServiceShape - Contract used by API handlers for sync and replay operations.
 */
export interface SourceSyncServiceShape {
  /**
   * Start a sync for a provider source, or reuse an active job.
   */
  readonly startSourceSyncJob: (
    params: StartSourceSyncJobParams
  ) => Effect.Effect<SourceSyncJobSummary, SourceSyncServiceError>

  /**
   * Clear canonical source-derived data and replay normalization from cached raw rows.
   */
  readonly replaySourceSyncJob: (
    params: ReplaySourceSyncJobParams
  ) => Effect.Effect<SourceSyncJobSummary, SourceSyncServiceError>

  /**
   * Get status and progress details for a source sync job.
   */
  readonly getSourceSyncJob: (
    params: GetSourceSyncJobParams
  ) => Effect.Effect<SourceSyncJobDetails, SourceSyncServiceError>
}

/**
 * SourceSyncService - Context tag for sync engine orchestration.
 */
export class SourceSyncService extends Context.Tag("SourceSyncService")<
  SourceSyncService,
  SourceSyncServiceShape
>() {}
