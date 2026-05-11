/**
 * SourceSyncRunRepository - User-wide sync run persistence contract.
 *
 * @module SourceSyncRunRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SyncRunStatus - Aggregate user-wide source sync run status.
 */
export type SyncRunStatus = "queued" | "running" | "completed" | "failed" | "partially_failed"

/**
 * SyncRunItemStatus - Per-source item status within a user-wide source sync run.
 */
export type SyncRunItemStatus = "queued" | "running" | "completed" | "failed"

/**
 * SyncRunRecord - Persisted aggregate sync run projection.
 */
export interface SyncRunRecord {
  readonly id: string
  readonly userId: string
  readonly status: SyncRunStatus
  readonly requestedSourceCount: number
  readonly queuedSourceCount: number
  readonly runningSourceCount: number
  readonly completedSourceCount: number
  readonly failedSourceCount: number
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly message: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * SyncRunItemRecord - Persisted per-source sync run item projection.
 */
export interface SyncRunItemRecord {
  readonly id: string
  readonly runId: string
  readonly sourceId: string
  readonly processingJobId: string | null
  readonly provider: string | null
  readonly status: SyncRunItemStatus
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
  readonly message: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * SourceSyncRunRecordNotFoundError - The requested run does not exist in the requested scope.
 */
export class SourceSyncRunRecordNotFoundError extends Schema.TaggedError<SourceSyncRunRecordNotFoundError>()(
  "SourceSyncRunRecordNotFoundError",
  {
    runId: Schema.String,
  }
) {}

/**
 * CreateSourceSyncRunParams - Input for creating an aggregate run row.
 */
export interface CreateSourceSyncRunParams {
  readonly userId: string
  readonly requestedSourceCount: number
}

/**
 * AttachSourceSyncRunItemParams - Input for linking a source job to a run.
 */
export interface AttachSourceSyncRunItemParams {
  readonly runId: string
  readonly sourceId: string
  readonly processingJobId: string
}

/**
 * RecordSourceSyncRunItemFailureParams - Input for a source that failed before job attachment.
 */
export interface RecordSourceSyncRunItemFailureParams {
  readonly runId: string
  readonly sourceId: string
  readonly message: string
}

/**
 * GetSourceSyncRunRecordParams - Input for loading a sync run by id.
 */
export interface GetSourceSyncRunRecordParams {
  readonly runId: string
}

/**
 * GetVisibleSourceSyncRunParams - Input for loading a run owned by a user.
 */
export interface GetVisibleSourceSyncRunParams {
  readonly userId: string
  readonly runId: string
}

/**
 * ListSourceSyncRunItemsParams - Input for loading run item summaries.
 */
export interface ListSourceSyncRunItemsParams {
  readonly runId: string
}

/**
 * RefreshSourceSyncRunStatusParams - Input for recomputing run counters from child jobs.
 */
export interface RefreshSourceSyncRunStatusParams {
  readonly runId: string
  readonly userId?: string
}

/**
 * SourceSyncRunRepositoryShape - User-wide sync run repository operations.
 */
export interface SourceSyncRunRepositoryShape {
  /**
   * Create a run aggregate row for a user's current source set.
   */
  readonly createRun: (
    params: CreateSourceSyncRunParams
  ) => Effect.Effect<SyncRunRecord, SyncEngineStorageError>

  /**
   * Attach or reuse a run item for a source-level processing job.
   *
   * If the same run/source was already attached, the existing item is returned.
   * The returned item may therefore reference a different processing job than
   * the one supplied by the caller.
   */
  readonly attachRunItem: (
    params: AttachSourceSyncRunItemParams
  ) => Effect.Effect<SyncRunItemRecord, SyncEngineStorageError>

  /**
   * Record a failed run item when a source cannot be dispatched to a processing job.
   */
  readonly recordRunItemFailure: (
    params: RecordSourceSyncRunItemFailureParams
  ) => Effect.Effect<SyncRunItemRecord, SyncEngineStorageError>

  /**
   * Load a run by id without checking user visibility.
   */
  readonly getRun: (
    params: GetSourceSyncRunRecordParams
  ) => Effect.Effect<Option.Option<SyncRunRecord>, SyncEngineStorageError>

  /**
   * Load a run only when it belongs to the provided user.
   */
  readonly getVisibleRun: (
    params: GetVisibleSourceSyncRunParams
  ) => Effect.Effect<Option.Option<SyncRunRecord>, SyncEngineStorageError>

  /**
   * List source item summaries for a run.
   */
  readonly listRunItems: (
    params: ListSourceSyncRunItemsParams
  ) => Effect.Effect<ReadonlyArray<SyncRunItemRecord>, SyncEngineStorageError>

  /**
   * Synchronize item statuses with child jobs and recompute aggregate counters.
   */
  readonly refreshRunStatus: (
    params: RefreshSourceSyncRunStatusParams
  ) => Effect.Effect<SyncRunRecord, SourceSyncRunRecordNotFoundError | SyncEngineStorageError>
}

/**
 * SourceSyncRunRepository - Context tag for user-wide sync run persistence.
 */
export class SourceSyncRunRepository extends Context.Tag("SourceSyncRunRepository")<
  SourceSyncRunRepository,
  SourceSyncRunRepositoryShape
>() {}
