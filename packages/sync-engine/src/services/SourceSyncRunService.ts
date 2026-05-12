/**
 * SourceSyncRunService - Principal-wide source sync run orchestration contract.
 *
 * @module SourceSyncRunService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SyncRunItemRecord, SyncRunRecord } from "./SourceSyncRunRepository.ts"

/**
 * SourceSyncRunNotFoundError - Requested principal-wide sync run was not found for the principal.
 */
export class SourceSyncRunNotFoundError extends Schema.TaggedError<SourceSyncRunNotFoundError>()(
  "SourceSyncRunNotFoundError",
  {
    runId: Schema.String,
  }
) {}

/**
 * StartSourceSyncRunParams - Input for starting a principal-wide sync run.
 */
export interface StartSourceSyncRunParams {
  readonly principalId: string
}

/**
 * GetSourceSyncRunParams - Input for loading a principal-wide sync run.
 */
export interface GetSourceSyncRunParams {
  readonly principalId: string
  readonly runId: string
}

/**
 * SourceSyncRunDetails - Aggregate run response with per-source item summaries.
 */
export interface SourceSyncRunDetails extends SyncRunRecord {
  readonly items: ReadonlyArray<SyncRunItemRecord>
}

/**
 * SourceSyncRunServiceError - Union of principal-wide sync run service failures.
 */
export type SourceSyncRunServiceError = SourceSyncRunNotFoundError | SyncEngineStorageError

/**
 * SourceSyncRunServiceShape - API-facing principal-wide sync run operations.
 */
export interface SourceSyncRunServiceShape {
  /**
   * Start a principal-wide run by creating or reusing one source job per source.
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
 * SourceSyncRunService - Context tag for principal-wide source sync orchestration.
 */
export class SourceSyncRunService extends Context.Tag("SourceSyncRunService")<
  SourceSyncRunService,
  SourceSyncRunServiceShape
>() {}
