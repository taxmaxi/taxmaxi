/**
 * SourceSyncRunService - User-wide source sync run orchestration contract.
 *
 * @module SourceSyncRunService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SyncRunItemRecord, SyncRunRecord } from "./SourceSyncRunRepository.ts"

/**
 * SourceSyncRunNotFoundError - Requested user-wide sync run was not found for the user.
 */
export class SourceSyncRunNotFoundError extends Schema.TaggedError<SourceSyncRunNotFoundError>()(
  "SourceSyncRunNotFoundError",
  {
    runId: Schema.String,
  }
) {}

/**
 * StartSourceSyncRunParams - Input for starting a user-wide sync run.
 */
export interface StartSourceSyncRunParams {
  readonly userId: string
}

/**
 * GetSourceSyncRunParams - Input for loading a user-wide sync run.
 */
export interface GetSourceSyncRunParams {
  readonly userId: string
  readonly runId: string
}

/**
 * SourceSyncRunDetails - Aggregate run response with per-source item summaries.
 */
export interface SourceSyncRunDetails extends SyncRunRecord {
  readonly items: ReadonlyArray<SyncRunItemRecord>
}

/**
 * SourceSyncRunServiceError - Union of user-wide sync run service failures.
 */
export type SourceSyncRunServiceError = SourceSyncRunNotFoundError | SyncEngineStorageError

/**
 * SourceSyncRunServiceShape - API-facing user-wide sync run operations.
 */
export interface SourceSyncRunServiceShape {
  /**
   * Start a user-wide run by creating or reusing one source job per source.
   */
  readonly startSyncRun: (
    params: StartSourceSyncRunParams
  ) => Effect.Effect<SourceSyncRunDetails, SourceSyncRunServiceError>

  /**
   * Get a current run aggregate, refreshing counters from child jobs first.
   */
  readonly getSyncRun: (
    params: GetSourceSyncRunParams
  ) => Effect.Effect<SourceSyncRunDetails, SourceSyncRunServiceError>
}

/**
 * SourceSyncRunService - Context tag for user-wide source sync orchestration.
 */
export class SourceSyncRunService extends Context.Tag("SourceSyncRunService")<
  SourceSyncRunService,
  SourceSyncRunServiceShape
>() {}
