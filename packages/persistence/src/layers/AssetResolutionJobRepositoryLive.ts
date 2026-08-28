/**
 * AssetResolutionJobRepositoryLive - Durable resolution job lifecycle persistence.
 *
 * The `asset_resolution_jobs` row is the source of truth for job state,
 * attempts, and retry timing; this layer owns scheduling, dispatch listing,
 * claiming, heartbeats, failure release, and finishing.
 *
 * @module AssetResolutionJobRepositoryLive
 */

import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
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
  OBSERVED_UNRESOLVED_STATUSES,
  insertResolutionJobsForMappings,
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const ASSET_RESOLUTION_JOB_RETRY_BASE_DELAY_MS = 30_000

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

              const inserted = yield* insertResolutionJobsForMappings({
                tx,
                providerAssetRowIds: [providerAssetRowId],
                now: nowDate(),
                mappingStatuses: OBSERVED_UNRESOLVED_STATUSES,
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
    policyRevision,
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
              policyRevision: schema.assetResolutionJobs.policyRevision,
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

          // The worker evaluates with the policy compiled into its binary. A
          // job stamped with a different revision stays pending for a worker
          // running that revision; claiming it here would record the wrong
          // evaluation and burn the job identity for the intended one.
          if (job.policyRevision !== policyRevision) {
            return { _tag: "revision_mismatch", jobPolicyRevision: job.policyRevision } as const
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
        .pipe(wrapSyncEngineSqlError("assetResolutionJobRepository.listDispatchableResolutionJobs"))

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

            const nextRetryAt = DateTime.toDateUtc(
              DateTime.addDuration(
                DateTime.makeUnsafe(now),
                ASSET_RESOLUTION_JOB_RETRY_BASE_DELAY_MS * 2 ** (job.attemptCount - 1)
              )
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
          wrapSyncEngineStorageError(
            "assetResolutionJobRepository.releaseResolutionJobAfterFailure"
          )
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
