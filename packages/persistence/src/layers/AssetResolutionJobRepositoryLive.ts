/**
 * AssetResolutionJobRepositoryLive - Durable resolution job lifecycle persistence.
 *
 * The `asset_resolution_jobs` row is the source of truth for job state,
 * attempts, and retry timing; this layer owns scheduling, dispatch listing,
 * claiming, heartbeats, failure release, and finishing.
 *
 * @module AssetResolutionJobRepositoryLive
 */

import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  AssetResolutionJobRepository,
  SyncEngineStorageError,
  type AssetResolutionJobRepositoryShape,
  type AssetResolutionJobScheduleResult,
} from "@my/sync-engine/services"
import { PgClient } from "@effect/sql-pg"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const ASSET_RESOLUTION_JOB_RETRY_BASE_DELAY_MS = 30_000

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
 * for the same (observation, revision) pair are left untouched. Also used by
 * ProviderAssetRepositoryLive so observation writes schedule jobs with the
 * same rules as the standalone scheduling API.
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

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const pgClient = yield* PgClient.PgClient

  // Runs an effect outside whatever transaction the caller happens to be in,
  // so its writes commit even when the caller rolls back afterwards.
  const runDetachedFromAmbientTransaction = <A, E>(
    effect: Effect.Effect<A, E>
  ): Effect.Effect<A, E> => Effect.updateContext(effect, Context.omit(pgClient.transactionService))

  const scheduleUnresolvedResolutionJob: AssetResolutionJobRepositoryShape["scheduleUnresolvedResolutionJob"] =
    ({ providerAssetRowId }) =>
      // Callers schedule a job and then often fail on purpose (an unmapped
      // asset stops normalization). The job must survive that failure even
      // when the caller wrapped everything in one transaction.
      runDetachedFromAmbientTransaction(
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [providerAsset] = yield* tx
                .select({
                  id: schema.providerAssets.id,
                  evidenceRevision: schema.providerAssets.evidenceRevision,
                })
                .from(schema.providerAssets)
                .where(eq(schema.providerAssets.id, providerAssetRowId))
                .limit(1)
                .pipe(
                  wrapSyncEngineSqlError(
                    "assetResolutionJobRepository.scheduleUnresolvedResolutionJob.providerAsset"
                  )
                )

              if (providerAsset === undefined) {
                return yield* new SyncEngineStorageError({
                  operation:
                    "assetResolutionJobRepository.scheduleUnresolvedResolutionJob.providerAsset",
                  cause: {
                    providerAssetRowId,
                    message: "Provider asset observation does not exist.",
                  },
                })
              }

              const inserted = yield* insertUnresolvedResolutionJobs({
                tx,
                providerAssetRowIds: [providerAssetRowId],
                now: nowDate(),
                unresolvedStatuses: OBSERVED_UNRESOLVED_STATUSES,
              })
              const created = inserted.some((job) => job.providerAssetRowId === providerAssetRowId)

              return {
                created,
                providerAssetRowId,
                evidenceRevision: providerAsset.evidenceRevision,
              } satisfies AssetResolutionJobScheduleResult
            })
          )
          .pipe(
            wrapSyncEngineStorageError(
              "assetResolutionJobRepository.scheduleUnresolvedResolutionJob"
            )
          )
      )

  const claimResolutionJob: AssetResolutionJobRepositoryShape["claimResolutionJob"] = ({
    jobId,
    workerId,
    startedAt,
    staleBefore,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .select({
              id: schema.assetResolutionJobs.id,
              providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
              evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
              status: schema.assetResolutionJobs.status,
              attemptCount: schema.assetResolutionJobs.attemptCount,
              nextRetryAt: schema.assetResolutionJobs.nextRetryAt,
              heartbeatAt: schema.assetResolutionJobs.heartbeatAt,
              updatedAt: schema.assetResolutionJobs.updatedAt,
            })
            .from(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.id, jobId))
            .for("update")
            .limit(1)
            .pipe(wrapSyncEngineSqlError("assetResolutionJobRepository.claimResolutionJob.job"))

          if (job === undefined) {
            return { _tag: "not_claimable" } as const
          }

          const claimablePending =
            job.status === "pending" && (job.nextRetryAt === null || job.nextRetryAt <= startedAt)
          const claimableStaleProcessing =
            job.status === "processing" &&
            (job.heartbeatAt === null ? job.updatedAt < staleBefore : job.heartbeatAt < staleBefore)

          if (!claimablePending && !claimableStaleProcessing) {
            return { _tag: "not_claimable" } as const
          }

          const [providerAsset] = yield* tx
            .select({ evidenceRevision: schema.providerAssets.evidenceRevision })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.id, job.providerAssetRowId))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError(
                "assetResolutionJobRepository.claimResolutionJob.providerAsset"
              )
            )

          if (
            providerAsset === undefined ||
            providerAsset.evidenceRevision !== job.evidenceRevision
          ) {
            yield* tx
              .update(schema.assetResolutionJobs)
              .set({ status: "completed", updatedAt: startedAt })
              .where(eq(schema.assetResolutionJobs.id, jobId))
              .pipe(
                wrapSyncEngineSqlError(
                  "assetResolutionJobRepository.claimResolutionJob.completeStale"
                )
              )

            return { _tag: "stale" } as const
          }

          const attemptCount = job.attemptCount + 1

          yield* tx
            .update(schema.assetResolutionJobs)
            .set({
              status: "processing",
              workerId,
              startedAt,
              heartbeatAt: startedAt,
              nextRetryAt: null,
              errorMessage: null,
              attemptCount,
              updatedAt: startedAt,
            })
            .where(eq(schema.assetResolutionJobs.id, jobId))
            .pipe(wrapSyncEngineSqlError("assetResolutionJobRepository.claimResolutionJob.claim"))

          return {
            _tag: "claimed",
            providerAssetRowId: job.providerAssetRowId,
            evidenceRevision: job.evidenceRevision,
            attemptCount,
          } as const
        })
      )
      .pipe(wrapSyncEngineStorageError("assetResolutionJobRepository.claimResolutionJob"))

  const listDispatchableResolutionJobs: AssetResolutionJobRepositoryShape["listDispatchableResolutionJobs"] =
    ({ now, staleBefore, limit }) =>
      db
        .select({ jobId: schema.assetResolutionJobs.id })
        .from(schema.assetResolutionJobs)
        .where(
          or(
            and(
              eq(schema.assetResolutionJobs.status, "pending"),
              or(
                isNull(schema.assetResolutionJobs.nextRetryAt),
                lte(schema.assetResolutionJobs.nextRetryAt, now)
              )
            ),
            and(
              eq(schema.assetResolutionJobs.status, "processing"),
              or(
                and(
                  isNull(schema.assetResolutionJobs.heartbeatAt),
                  lt(schema.assetResolutionJobs.updatedAt, staleBefore)
                ),
                lt(schema.assetResolutionJobs.heartbeatAt, staleBefore)
              )
            )
          )
        )
        .orderBy(asc(schema.assetResolutionJobs.createdAt))
        .limit(limit)
        .pipe(
          wrapSyncEngineSqlError("assetResolutionJobRepository.listDispatchableResolutionJobs")
        )

  const heartbeatResolutionJob: AssetResolutionJobRepositoryShape["heartbeatResolutionJob"] = ({
    jobId,
    workerId,
    heartbeatAt,
  }) =>
    db
      .update(schema.assetResolutionJobs)
      .set({ heartbeatAt, updatedAt: heartbeatAt })
      .where(
        and(
          eq(schema.assetResolutionJobs.id, jobId),
          eq(schema.assetResolutionJobs.status, "processing"),
          eq(schema.assetResolutionJobs.workerId, workerId)
        )
      )
      .returning({ id: schema.assetResolutionJobs.id })
      .pipe(
        Effect.map((rows) => (rows.length > 0 ? ("heartbeated" as const) : ("not_owned" as const))),
        wrapSyncEngineSqlError("assetResolutionJobRepository.heartbeatResolutionJob")
      )

  const releaseResolutionJobAfterFailure: AssetResolutionJobRepositoryShape["releaseResolutionJobAfterFailure"] =
    ({ jobId, workerId, message }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = nowDate()
            const [job] = yield* tx
              .select({
                attemptCount: schema.assetResolutionJobs.attemptCount,
                maxAttempts: schema.assetResolutionJobs.maxAttempts,
              })
              .from(schema.assetResolutionJobs)
              .where(
                and(
                  eq(schema.assetResolutionJobs.id, jobId),
                  eq(schema.assetResolutionJobs.status, "processing"),
                  eq(schema.assetResolutionJobs.workerId, workerId)
                )
              )
              .for("update")
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "assetResolutionJobRepository.releaseResolutionJobAfterFailure.job"
                )
              )

            if (job === undefined) {
              return { _tag: "not_owned" } as const
            }

            if (job.attemptCount >= job.maxAttempts) {
              yield* tx
                .update(schema.assetResolutionJobs)
                .set({
                  status: "failed",
                  errorMessage: message,
                  workerId: null,
                  heartbeatAt: null,
                  updatedAt: now,
                })
                .where(eq(schema.assetResolutionJobs.id, jobId))
                .pipe(
                  wrapSyncEngineSqlError(
                    "assetResolutionJobRepository.releaseResolutionJobAfterFailure.fail"
                  )
                )

              return { _tag: "attempts_exhausted", attemptCount: job.attemptCount } as const
            }

            const nextRetryAt = new Date(
              now.getTime() + ASSET_RESOLUTION_JOB_RETRY_BASE_DELAY_MS * 2 ** (job.attemptCount - 1)
            )

            yield* tx
              .update(schema.assetResolutionJobs)
              .set({
                status: "pending",
                errorMessage: message,
                workerId: null,
                startedAt: null,
                heartbeatAt: null,
                nextRetryAt,
                updatedAt: now,
              })
              .where(eq(schema.assetResolutionJobs.id, jobId))
              .pipe(
                wrapSyncEngineSqlError(
                  "assetResolutionJobRepository.releaseResolutionJobAfterFailure.retry"
                )
              )

            return { _tag: "retry_scheduled", attemptCount: job.attemptCount, nextRetryAt } as const
          })
        )
        .pipe(
          wrapSyncEngineStorageError("assetResolutionJobRepository.releaseResolutionJobAfterFailure")
        )

  const finishResolutionJob: AssetResolutionJobRepositoryShape["finishResolutionJob"] = ({
    jobId,
    status,
  }) =>
    db
      .update(schema.assetResolutionJobs)
      .set({ status, updatedAt: nowDate() })
      .where(eq(schema.assetResolutionJobs.id, jobId))
      .pipe(
        Effect.asVoid,
        wrapSyncEngineSqlError("assetResolutionJobRepository.finishResolutionJob")
      )

  return AssetResolutionJobRepository.of({
    scheduleUnresolvedResolutionJob,
    claimResolutionJob,
    listDispatchableResolutionJobs,
    heartbeatResolutionJob,
    releaseResolutionJobAfterFailure,
    finishResolutionJob,
  } satisfies AssetResolutionJobRepositoryShape)
})

export const AssetResolutionJobRepositoryLive = Layer.effect(AssetResolutionJobRepository, make)
