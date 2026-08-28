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
 *
 * Retry bookkeeping lives on the DB job row (`attempt_count`, `max_attempts`,
 * `next_retry_at`), so callers pass no retry metadata: a retryable failure is
 * persisted and reported as a `queued` summary, and the worker poll loop picks
 * the job up again once the retry delay has passed.
 */
export interface ExecuteSourceSyncJobParams {
  readonly jobId: string
  readonly workerId?: string
}

export type SourceSyncJobExecutorError =
  | SourceSyncJobExecutionNotFoundError
  | SourceSyncJobExecutionConflictError
  | SourceSyncJobExecutionPayloadError
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
export class SourceSyncJobExecutor extends Context.Service<
  SourceSyncJobExecutor,
  SourceSyncJobExecutorShape
>()("SourceSyncJobExecutor") {}
