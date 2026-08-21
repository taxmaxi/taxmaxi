/**
 * Shared helpers for persistence-backed sync-engine repository layers.
 *
 * @module SyncEngineRepositorySupport
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import { eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, isPersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import {
  SourceSyncJobModeSchema,
  SourceSyncPhaseSchema,
  SyncEngineStorageError,
  type SourceSyncJobProgressSnapshot,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"

const ProgressCounterSchema = Schema.Union([Schema.Number, Schema.NumberFromString])

const SourceSyncProgressDetailsSchema = Schema.Struct({
  mode: Schema.optional(SourceSyncJobModeSchema),
  phase: Schema.optional(SourceSyncPhaseSchema),
  processedRecords: Schema.optional(ProgressCounterSchema),
  totalRecords: Schema.optional(Schema.NullOr(ProgressCounterSchema)),
  fetchedRecords: Schema.optional(ProgressCounterSchema),
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

type SyncEngineDb = Effect.Success<typeof drizzle>

/** One drizzle transaction handle as passed to `db.transaction` callbacks. */
export type SyncEngineDbTransaction = Parameters<Parameters<SyncEngineDb["transaction"]>[0]>[0]

/** Mapping status of an observation that still needs resolution; null means no mapping row. */
export type UnresolvedMappingStatus = "pending_review" | null

/**
 * An observed asset with no mapping row or a pending_review mapping is
 * unresolved; approved and rejected are not.
 */
export const OBSERVED_UNRESOLVED_STATUSES: ReadonlyArray<UnresolvedMappingStatus> = [
  null,
  "pending_review",
]

/**
 * The catalog path deliberately skips assets with no mapping row: a mapping
 * row appears once an asset is actually observed, so a bare catalog entry
 * has never been seen in a transaction and must not trigger research.
 */
export const CATALOG_REVIEWABLE_STATUSES: ReadonlyArray<UnresolvedMappingStatus> = [
  "pending_review",
]

/**
 * Insert one pending resolution job per unresolved provider asset at its
 * current evidence revision, inside the caller's transaction. Existing jobs
 * for the same (observation, revision) pair are left untouched. Shared by
 * AssetResolutionJobRepositoryLive (the standalone scheduling API) and
 * ProviderAssetRepositoryLive (scheduling inside observation transactions)
 * so both paths follow the same unresolved-status and conflict rules.
 */
export const insertUnresolvedResolutionJobs = ({
  tx,
  providerAssetRowIds,
  now,
  unresolvedStatuses,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly providerAssetRowIds: ReadonlyArray<string>
  readonly now: Date
  readonly unresolvedStatuses: ReadonlyArray<UnresolvedMappingStatus>
}) =>
  Effect.gen(function* () {
    if (providerAssetRowIds.length === 0) {
      return [] as ReadonlyArray<{
        readonly providerAssetRowId: string
        readonly evidenceRevision: number
      }>
    }

    const candidates = yield* tx
      .select({
        providerAssetRowId: schema.providerAssets.id,
        evidenceRevision: schema.providerAssets.evidenceRevision,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(inArray(schema.providerAssets.id, providerAssetRowIds))
      .pipe(wrapSyncEngineSqlError("assetResolutionJobScheduling.load"))

    const unresolved = candidates.filter((candidate) =>
      unresolvedStatuses.some((status) => status === candidate.mappingStatus)
    )
    if (unresolved.length === 0) {
      return []
    }

    const inserted = yield* tx
      .insert(schema.assetResolutionJobs)
      .values(
        unresolved.map((candidate) => ({
          providerAssetRowId: candidate.providerAssetRowId,
          evidenceRevision: candidate.evidenceRevision,
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .onConflictDoNothing({
        target: [
          schema.assetResolutionJobs.providerAssetRowId,
          schema.assetResolutionJobs.evidenceRevision,
        ],
      })
      .returning({
        providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
        evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
      })
      .pipe(wrapSyncEngineSqlError("assetResolutionJobScheduling.insert"))

    return inserted
  })

/**
 * Decode persisted job progress JSON into the sync-engine snapshot shape.
 */
export const decodeSourceSyncJobProgressSnapshot = (
  progressDetails: unknown
): Effect.Effect<SourceSyncJobProgressSnapshot | null> =>
  Schema.decodeUnknownEffect(SourceSyncProgressDetailsSchema)(progressDetails).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((details: SourceSyncProgressDetails | null) =>
      details === null
        ? null
        : {
            mode: details.mode ?? null,
            phase: details.phase ?? null,
            processedRecords: details.processedRecords ?? null,
            totalRecords: details.totalRecords ?? null,
            fetchedRecords: details.fetchedRecords ?? null,
            normalizedRecords: details.normalizedRecords ?? null,
            failedRecords: details.failedRecords ?? null,
            cursorPayload: details.cursorPayload ?? null,
            highWatermark: details.highWatermark ?? null,
          }
    )
  )
