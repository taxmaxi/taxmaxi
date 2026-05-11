/**
 * Shared helpers for persistence-backed sync-engine repository layers.
 *
 * @module SyncEngineRepositorySupport
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, isPersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import {
  SourceSyncJobModeSchema,
  SyncEngineStorageError,
  type SourceSyncJobProgressSnapshot,
} from "@my/sync-engine/services"

const ProgressCounterSchema = Schema.Union(Schema.Number, Schema.NumberFromString)

const SourceSyncProgressDetailsSchema = Schema.Struct({
  mode: Schema.optional(SourceSyncJobModeSchema),
  importedRecords: Schema.optional(ProgressCounterSchema),
  normalizedRecords: Schema.optional(ProgressCounterSchema),
  failedRecords: Schema.optional(ProgressCounterSchema),
  cursorPayload: Schema.optional(Schema.Unknown),
  highWatermark: Schema.optional(Schema.NullOr(Schema.String)),
})

type SourceSyncProgressDetails = Schema.Schema.Type<typeof SourceSyncProgressDetailsSchema>

/**
 * Create a new timestamp using the repo's shared clock helper.
 */
export const nowDate = (): Date => Timestamp.now().toDate()

/**
 * Serialize a nullable high watermark for job progress payloads.
 */
export const highWatermarkToIso = (highWatermark: Date | null): string | null =>
  highWatermark === null ? null : Timestamp.fromDate(highWatermark).toISOString()

/**
 * Normalize lower-level repository failures into the sync-engine storage error surface.
 *
 * Existing `SyncEngineStorageError` values pass through unchanged so callers do not
 * lose the original operation or end up with nested storage-error wrappers.
 */
export const toSyncEngineStorageError = ({
  error,
  operation,
}: {
  readonly error: PersistenceError | unknown
  readonly operation?: string
}): SyncEngineStorageError =>
  error instanceof SyncEngineStorageError
    ? error
    : isPersistenceError(error)
      ? new SyncEngineStorageError({
          operation: error.operation,
          cause: error.cause,
        })
      : new SyncEngineStorageError({
          operation: operation ?? "syncEngineRepository",
          cause: error,
        })

/**
 * Wrap SQL errors in SyncEngineStorageError.
 */
export const wrapSyncEngineSqlError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SyncEngineStorageError, R> =>
    wrapSyncEngineStorageError(operation)(wrapSqlError(operation)(effect))

/**
 * Wrap arbitrary repository errors in SyncEngineStorageError.
 */
export const wrapSyncEngineStorageError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SyncEngineStorageError, R> =>
    Effect.mapError(effect, (error) => toSyncEngineStorageError({ error, operation }))

/**
 * Decode persisted job progress JSON into the sync-engine snapshot shape.
 */
export const decodeSourceSyncJobProgressSnapshot = (
  progressDetails: unknown
): Effect.Effect<SourceSyncJobProgressSnapshot | null> =>
  Schema.decodeUnknown(SourceSyncProgressDetailsSchema)(progressDetails).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((details: SourceSyncProgressDetails | null) =>
      details === null
        ? null
        : {
            mode: details.mode ?? null,
            importedRecords: details.importedRecords ?? null,
            normalizedRecords: details.normalizedRecords ?? null,
            failedRecords: details.failedRecords ?? null,
            cursorPayload: details.cursorPayload ?? null,
            highWatermark: details.highWatermark ?? null,
          }
    )
  )
