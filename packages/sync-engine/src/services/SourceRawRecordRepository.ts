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

/** Stable keyset cursor for principal-wide chronological replay. */
export interface PrincipalReplayRawRowCursor {
  readonly occurredAt: Date
  readonly sourceId: string
  readonly externalRecordId: string
  readonly id: string
}

/** One bounded page of principal raw rows and its continuation cursor. */
export interface PrincipalReplayRawRowPage {
  readonly rawRecords: ReadonlyArray<SourceRawRecord>
  readonly nextCursor: PrincipalReplayRawRowCursor | null
}

/** Cached raw-row total used to initialize one source child job. */
export interface PrincipalReplayRawRowCount {
  readonly sourceId: string
  readonly totalRecords: number
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

  /** Load one cached principal page in global deterministic replay order. */
  readonly listPrincipalRawRowsForReplay: (params: {
    readonly principalId: string
    readonly cursor: PrincipalReplayRawRowCursor | null
    readonly limit: number
  }) => Effect.Effect<PrincipalReplayRawRowPage, SyncEngineStorageError>

  /** Count cached principal rows by source without loading their payloads. */
  readonly countPrincipalRawRowsForReplay: (params: {
    readonly principalId: string
  }) => Effect.Effect<ReadonlyArray<PrincipalReplayRawRowCount>, SyncEngineStorageError>

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
   * Load cached raw rows near one provider timestamp. Used to find sibling rows
   * of multi-row provider events when provider accounts record slightly different times.
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
