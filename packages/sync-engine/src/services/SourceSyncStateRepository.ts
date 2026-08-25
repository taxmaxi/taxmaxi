/**
 * SourceSyncStateRepository - Durable cursor/checkpoint/state persistence contract.
 *
 * @module SourceSyncStateRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SourceSyncExecutionState } from "./SourceSyncModels.ts"

/**
 * PersistSourceSyncProgressParams - Input for persisting source-level progress state.
 */
export interface PersistSourceSyncProgressParams {
  readonly sourceId: string
  readonly jobId: string
  readonly state: SourceSyncExecutionState
  /**
   * When the source last finished fetching from its provider. Omit to keep
   * the stored value unchanged: replay runs process already imported data
   * and must not look like a provider fetch.
   */
  readonly lastSyncedAt?: Date | null
  readonly lastErrorMessage: string | null
}

/**
 * PersistSourceSyncFailureParams - Input for persisting source-level failure metadata.
 */
export interface PersistSourceSyncFailureParams {
  readonly sourceId: string
  readonly lastErrorMessage: string
}

/**
 * SourceSyncStateRepositoryShape - Source-level checkpoint and failure metadata operations.
 */
export interface SourceSyncStateRepositoryShape {
  /**
   * Load or initialize durable execution state for a source.
   */
  readonly getExecutionState: (params: {
    readonly sourceId: string
  }) => Effect.Effect<SourceSyncExecutionState, SyncEngineStorageError>

  /**
   * Persist cursor/high-watermark/checkpoint progress after a durable raw write.
   */
  readonly persistProgress: (
    params: PersistSourceSyncProgressParams
  ) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Persist source-level failure metadata without advancing the checkpoint.
   */
  readonly persistFailureMetadata: (
    params: PersistSourceSyncFailureParams
  ) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Clear replay failure metadata while preserving cursor and checkpoint state.
   */
  readonly clearReplayFailureMetadata: (params: {
    readonly sourceId: string
  }) => Effect.Effect<void, SyncEngineStorageError>
}

/**
 * SourceSyncStateRepository - Context tag for source sync state persistence.
 */
export class SourceSyncStateRepository extends Context.Service<
  SourceSyncStateRepository,
  SourceSyncStateRepositoryShape
>()("SourceSyncStateRepository") {}
