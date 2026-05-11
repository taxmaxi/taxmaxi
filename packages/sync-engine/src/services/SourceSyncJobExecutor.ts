/**
 * SourceSyncJobExecutor - Worker-facing source job execution contract.
 *
 * @module SourceSyncJobExecutor
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SourceSyncJobSummary } from "./SourceSyncModels.ts"

/**
 * SourceSyncJobExecutionNotFoundError - Requested job cannot be found for execution.
 */
export class SourceSyncJobExecutionNotFoundError extends Schema.TaggedError<SourceSyncJobExecutionNotFoundError>()(
  "SourceSyncJobExecutionNotFoundError",
  {
    jobId: Schema.String,
  }
) {}

/**
 * SourceSyncJobExecutionConflictError - Requested job is not currently executable.
 */
export class SourceSyncJobExecutionConflictError extends Schema.TaggedError<SourceSyncJobExecutionConflictError>()(
  "SourceSyncJobExecutionConflictError",
  {
    jobId: Schema.String,
    reason: Schema.String,
  }
) {}

/**
 * SourceSyncJobExecutionPayloadError - Persisted job payload is malformed.
 */
export class SourceSyncJobExecutionPayloadError extends Schema.TaggedError<SourceSyncJobExecutionPayloadError>()(
  "SourceSyncJobExecutionPayloadError",
  {
    jobId: Schema.String,
    reason: Schema.String,
  }
) {}

/**
 * ExecuteSourceSyncJobParams - Identifies one existing DB job to execute.
 */
export interface ExecuteSourceSyncJobParams {
  readonly jobId: string
  readonly workerId?: string
  readonly retryPolicy?: SourceSyncJobExecutionRetryPolicy
}

/**
 * SourceSyncJobExecutionRetryPolicy - BullMQ attempt metadata used by workers.
 */
export interface SourceSyncJobExecutionRetryPolicy {
  readonly attemptNumber: number
  readonly maxAttempts: number
  readonly nextRetryAt: Date
}

/**
 * SourceSyncJobRetryableExecutionError - Retryable job failure returned to the queue worker.
 */
export class SourceSyncJobRetryableExecutionError extends Schema.TaggedError<SourceSyncJobRetryableExecutionError>()(
  "SourceSyncJobRetryableExecutionError",
  {
    jobId: Schema.String,
    message: Schema.String,
    attemptNumber: Schema.Number,
    maxAttempts: Schema.Number,
    nextRetryAt: Schema.DateFromSelf,
  }
) {}

export type SourceSyncJobExecutorError =
  | SourceSyncJobExecutionNotFoundError
  | SourceSyncJobExecutionConflictError
  | SourceSyncJobExecutionPayloadError
  | SourceSyncJobRetryableExecutionError
  | SyncEngineStorageError

/**
 * SourceSyncJobExecutorShape - Executes one already-created source sync DB job.
 */
export interface SourceSyncJobExecutorShape {
  readonly execute: (
    params: ExecuteSourceSyncJobParams
  ) => Effect.Effect<SourceSyncJobSummary, SourceSyncJobExecutorError>
}

/**
 * SourceSyncJobExecutor - Context tag for source job execution.
 */
export class SourceSyncJobExecutor extends Context.Tag("SourceSyncJobExecutor")<
  SourceSyncJobExecutor,
  SourceSyncJobExecutorShape
>() {}
