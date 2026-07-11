/**
 * SourceRawRecordRepository - Durable cached raw record persistence contract.
 *
 * @module SourceRawRecordRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { ProviderRawRecord } from "../shared/SourceProviderRawBatch.ts"
import type { SourceRawRecord, SourceSyncCheckpoint } from "./SourceSyncModels.ts"

/**
 * UpsertSourceRawBatchResult - Idempotent batch write result plus checkpoint ids.
 */
export interface UpsertSourceRawBatchResult extends SourceSyncCheckpoint {
  readonly rawRecords: ReadonlyArray<SourceRawRecord>
}

/**
 * SourceRawRecordRepositoryShape - Cached raw-row operations used by sync and replay.
 */
export interface SourceRawRecordRepositoryShape {
  /**
   * Upsert one durable raw batch and return the persisted rows plus checkpoint ids.
   */
  readonly upsertRawBatch: (params: {
    readonly sourceId: string
    readonly records: ReadonlyArray<ProviderRawRecord>
  }) => Effect.Effect<UpsertSourceRawBatchResult, SyncEngineStorageError>

  /**
   * Load failed raw rows that should be retried at the end of a sync run.
   * Includes rows that failed during the current run so multi-row provider
   * events split across pages can normalize once all sibling rows are cached.
   */
  readonly listReplayCandidates: (params: {
    readonly sourceId: string
  }) => Effect.Effect<ReadonlyArray<SourceRawRecord>, SyncEngineStorageError>

  /**
   * Load all cached raw rows for deterministic full replay.
   */
  readonly listAllRawRowsForReplay: (params: {
    readonly sourceId: string
  }) => Effect.Effect<ReadonlyArray<SourceRawRecord>, SyncEngineStorageError>

  /**
   * List ids for raw rows that still require normalization.
   *
   * Callers can snapshot these ids after discovery and load them in bounded
   * batches while normalization markers change underneath the job.
   */
  readonly listPendingNormalizationRecordIds: (params: {
    readonly sourceId: string
  }) => Effect.Effect<ReadonlyArray<string>, SyncEngineStorageError>

  /** Load a selected batch of raw rows by durable id. */
  readonly listRawRecordsByIds: (params: {
    readonly sourceId: string
    readonly rawRecordIds: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<SourceRawRecord>, SyncEngineStorageError>

  /**
   * Load all cached raw rows of one record type that occurred at one provider timestamp.
   * Used to find sibling rows of multi-row provider events (e.g. paired unstaking rows).
   */
  readonly listRawRecordsByOccurredAt: (params: {
    readonly sourceId: string
    readonly recordType: string
    readonly occurredAt: Date
  }) => Effect.Effect<ReadonlyArray<SourceRawRecord>, SyncEngineStorageError>

  /**
   * Mark one raw row normalized once canonical writes succeed.
   */
  readonly markRawRecordNormalized: (params: {
    readonly rawRecordId: string
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Persist a per-row normalization failure without aborting the whole sync.
   */
  readonly markRawRecordFailed: (params: {
    readonly rawRecordId: string
    readonly message: string
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Clear row-level normalization markers during an explicit replay.
   */
  readonly resetNormalizationStateForSource: (params: {
    readonly sourceId: string
  }) => Effect.Effect<void, SyncEngineStorageError>
}

/**
 * SourceRawRecordRepository - Context tag for raw record persistence.
 */
export class SourceRawRecordRepository extends Context.Tag("SourceRawRecordRepository")<
  SourceRawRecordRepository,
  SourceRawRecordRepositoryShape
>() {}
