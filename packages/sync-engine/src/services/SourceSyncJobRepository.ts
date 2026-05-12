/**
 * SourceSyncJobRepository - Processing job lifecycle contract for the sync engine.
 *
 * @module SourceSyncJobRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type {
  CreateOrReuseSourceSyncJobResult,
  SourceSyncActiveJob,
  SourceSyncExecutionState,
  SourceSyncExecutionJob,
  SourceSyncJobDetails,
  SourceSyncJobMode,
  SourceSyncRepairableActiveJob,
  SourceSyncStaleActiveJob,
} from "./SourceSyncModels.ts"

/**
 * SourceSyncJobRecordNotVisibleError - The requested job is not visible to the principal/source pair.
 */
export class SourceSyncJobRecordNotVisibleError extends Schema.TaggedError<SourceSyncJobRecordNotVisibleError>()(
  "SourceSyncJobRecordNotVisibleError",
  {
    sourceId: Schema.String,
    jobId: Schema.String,
  }
) {}

/**
 * SourceSyncJobExecutionRecordNotFoundError - No active DB job exists for execution.
 */
export class SourceSyncJobExecutionRecordNotFoundError extends Schema.TaggedError<SourceSyncJobExecutionRecordNotFoundError>()(
  "SourceSyncJobExecutionRecordNotFoundError",
  {
    jobId: Schema.String,
  }
) {}

/**
 * SourceSyncJobExecutionRecordConflictError - Job exists but is not executable.
 */
export class SourceSyncJobExecutionRecordConflictError extends Schema.TaggedError<SourceSyncJobExecutionRecordConflictError>()(
  "SourceSyncJobExecutionRecordConflictError",
  {
    jobId: Schema.String,
    reason: Schema.String,
  }
) {}

/**
 * SourceSyncJobExecutionRecordPayloadError - Persisted execution metadata is malformed.
 */
export class SourceSyncJobExecutionRecordPayloadError extends Schema.TaggedError<SourceSyncJobExecutionRecordPayloadError>()(
  "SourceSyncJobExecutionRecordPayloadError",
  {
    jobId: Schema.String,
    reason: Schema.String,
  }
) {}

/**
 * CreateOrReuseSourceSyncJobParams - Input for creating a new active processing job.
 */
export interface CreateOrReuseSourceSyncJobParams {
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly maxAttempts: number
}

/**
 * AttachSourceSyncQueueMetadataParams - Input for recording durable queue metadata.
 */
export interface AttachSourceSyncQueueMetadataParams {
  readonly jobId: string
  readonly queueName: string
  readonly queueJobId: string
  readonly queuedAt: Date
}

/**
 * ClaimSourceSyncJobParams - Input for moving a pending job into worker execution.
 */
export interface ClaimSourceSyncJobParams {
  readonly jobId: string
  readonly workerId: string
  readonly startedAt: Date
}

/**
 * HeartbeatSourceSyncJobParams - Input for refreshing an executing worker heartbeat.
 */
export interface HeartbeatSourceSyncJobParams {
  readonly jobId: string
  readonly workerId: string
  readonly heartbeatAt: Date
}

/**
 * RecordRetryableSourceSyncFailureParams - Input for storing an intermediate retry failure.
 */
export interface RecordRetryableSourceSyncFailureParams {
  readonly jobId: string
  readonly message: string
  readonly attemptCount: number
  readonly nextRetryAt: Date
}

/**
 * FailSourceSyncJobParams - Input for terminally failing a processing job.
 */
export interface FailSourceSyncJobParams {
  readonly jobId: string
  readonly message: string
  readonly completedAt: Date
}

/**
 * CompleteSourceSyncJobParams - Input for terminally completing a processing job.
 */
export interface CompleteSourceSyncJobParams {
  readonly jobId: string
  readonly state: SourceSyncExecutionState
}

/**
 * RecoverStaleSourceSyncJobParams - Input for marking one stale active job failed.
 */
export interface RecoverStaleSourceSyncJobParams {
  readonly sourceId: string
  readonly jobId: string
  readonly message: string
  readonly completedAt: Date
}

/**
 * GetSourceSyncJobRecordParams - Input for loading one visible processing job.
 */
export interface GetSourceSyncJobRecordParams {
  readonly principalId: string
  readonly sourceId: string
  readonly jobId: string
}

/**
 * ListStaleActiveSourceSyncJobsParams - Input for selecting stale active jobs for repair.
 */
export interface ListStaleActiveSourceSyncJobsParams {
  readonly staleBefore: Date
  readonly limit: number
}

/**
 * ListRepairableActiveSourceSyncJobsParams - Input for startup recovery selection.
 */
export interface ListRepairableActiveSourceSyncJobsParams {
  readonly pendingStaleBefore: Date
  readonly processingStaleBefore: Date
  readonly limit: number
}

/**
 * SourceSyncJobRepositoryShape - Processing-job repository operations used by sync orchestration.
 */
export interface SourceSyncJobRepositoryShape {
  /**
   * Find the currently active job for a source, if one exists.
   */
  readonly findActiveJob: (params: {
    readonly sourceId: string
    readonly principalId: string
  }) => Effect.Effect<ReadonlyArray<SourceSyncActiveJob>, SyncEngineStorageError>

  /**
   * Create a new active job or return the concurrent winner when uniqueness races occur.
   */
  readonly createOrReuseJob: (
    params: CreateOrReuseSourceSyncJobParams
  ) => Effect.Effect<CreateOrReuseSourceSyncJobResult, SyncEngineStorageError>

  /**
   * Attach durable queue metadata after a pending job is enqueued.
   */
  readonly attachQueueMetadata: (
    params: AttachSourceSyncQueueMetadataParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Atomically claim a pending job for worker execution.
   */
  readonly claimJob: (
    params: ClaimSourceSyncJobParams
  ) => Effect.Effect<
    SourceSyncExecutionJob,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Refresh the heartbeat for the worker currently owning a processing job.
   */
  readonly heartbeatJob: (
    params: HeartbeatSourceSyncJobParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Record an intermediate retryable failure without terminally failing the DB job.
   */
  readonly recordRetryableFailure: (
    params: RecordRetryableSourceSyncFailureParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Mark a stale active job as failed so a new sync can start.
   */
  readonly recoverStaleActiveJob: (
    params: RecoverStaleSourceSyncJobParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Mark a job as failed with an error message.
   */
  readonly failJob: (
    params: FailSourceSyncJobParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Mark a job as completed and persist its final counters/checkpoint snapshot.
   */
  readonly completeJob: (
    params: CompleteSourceSyncJobParams
  ) => Effect.Effect<
    void,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SyncEngineStorageError
  >

  /**
   * Load one visible job for API reads.
   */
  readonly getJob: (
    params: GetSourceSyncJobRecordParams
  ) => Effect.Effect<
    SourceSyncJobDetails,
    SourceSyncJobRecordNotVisibleError | SyncEngineStorageError
  >

  /**
   * Load one active job for execution by a source sync executor.
   */
  readonly getExecutionJob: (params: {
    readonly jobId: string
  }) => Effect.Effect<
    SourceSyncExecutionJob,
    | SourceSyncJobExecutionRecordNotFoundError
    | SourceSyncJobExecutionRecordConflictError
    | SourceSyncJobExecutionRecordPayloadError
    | SyncEngineStorageError
  >

  /**
   * List active jobs whose heartbeat or last update is older than the stale cutoff.
   */
  readonly listStaleActiveJobs: (
    params: ListStaleActiveSourceSyncJobsParams
  ) => Effect.Effect<ReadonlyArray<SourceSyncStaleActiveJob>, SyncEngineStorageError>

  /**
   * List active jobs that need startup repair or queue reconciliation.
   */
  readonly listRepairableActiveJobs: (
    params: ListRepairableActiveSourceSyncJobsParams
  ) => Effect.Effect<ReadonlyArray<SourceSyncRepairableActiveJob>, SyncEngineStorageError>
}

/**
 * SourceSyncJobRepository - Context tag for processing-job persistence.
 */
export class SourceSyncJobRepository extends Context.Tag("SourceSyncJobRepository")<
  SourceSyncJobRepository,
  SourceSyncJobRepositoryShape
>() {}
