/**
 * SourceSyncJobRepositoryLive - Processing job persistence for sync-engine orchestration.
 *
 * @module SourceSyncJobRepositoryLive
 */

import { SyncCreditReasonCode } from "@my/core/billing"
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { isActiveProcessingJobConflict } from "../errors/ProcessingJobConflict.ts"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  type CreateOrReuseSourceSyncJobResult,
  type ActiveSourceSyncJobStatus,
  type SourceSyncExecutionJob,
  type SourceSyncJobMode,
  type SourceSyncJobStatus,
  getSourceSyncProgressPercent,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  SourceSyncJobRecordNotVisibleError,
  SourceSyncJobRepository,
  SyncEngineStorageError,
  toPublicSourceSyncJobStatus,
  type SourceSyncJobRepositoryShape,
  type SourceSyncPendingDispatchJob,
  type SourceSyncRepairableActiveJob,
  type SourceSyncStaleActiveJob,
} from "@my/sync-engine/services"
import {
  decodeSourceSyncJobProgressSnapshot,
  highWatermarkToIso,
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const ACTIVE_JOB_STATUSES = [
  "pending",
  "processing",
] as const satisfies ReadonlyArray<ActiveSourceSyncJobStatus>
const MAX_CREATE_OR_REUSE_RACE_ATTEMPTS = 3

interface PersistedExecutionJobRow {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncExecutionJob["mode"]
  readonly status: SourceSyncJobStatus
}

const decodeCreditReasonCode = Schema.decodeUnknownEffect(SyncCreditReasonCode)

/** Decode the persisted credit-outcome columns, falling back to null on any malformed row. */
const toCreditOutcome = (row: {
  readonly creditReasonCode: string | null
  readonly creditsAvailable: number | null
  readonly creditsConsumed: number | null
  readonly additionalCreditsRequired: number | null
}) => {
  const { creditReasonCode, creditsAvailable, creditsConsumed, additionalCreditsRequired } = row

  return creditReasonCode === null || creditsAvailable === null || creditsConsumed === null
    ? Effect.succeed(null)
    : decodeCreditReasonCode(creditReasonCode).pipe(
        Effect.map((reasonCode) => ({
          reasonCode,
          availableCredits: creditsAvailable,
          creditsConsumed,
          additionalCreditsRequired,
        })),
        Effect.orElseSucceed(() => null)
      )
}

const toExecutionJob = ({
  job,
  jobId,
}: {
  readonly job: PersistedExecutionJobRow
  readonly jobId: string
}): Effect.Effect<SourceSyncExecutionJob, SourceSyncJobExecutionRecordConflictError> =>
  Effect.gen(function* () {
    if (job.status !== "pending" && job.status !== "processing") {
      return yield* new SourceSyncJobExecutionRecordConflictError({
        jobId,
        reason: `Job status ${job.status} is not executable.`,
      })
    }

    return {
      id: job.id,
      sourceId: job.sourceId,
      principalId: job.principalId,
      mode: job.mode,
      status: job.status,
    } satisfies SourceSyncExecutionJob
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type SourceSyncJobExecutor = Pick<typeof db, "insert" | "update">

  const preserveExpectedExecutionError = (operation: string) =>
    Effect.mapError((error: unknown) =>
      error instanceof SourceSyncJobExecutionRecordNotFoundError ||
      error instanceof SourceSyncJobExecutionRecordConflictError
        ? error
        : toSyncEngineStorageError({ error, operation })
    )

  const materializeFollowUpJob = ({
    executor,
    jobId,
    sourceId,
    principalId,
    followUpMode,
    createdAt,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly jobId: string
    readonly sourceId: string
    readonly principalId: string
    readonly followUpMode: SourceSyncJobMode | null
    readonly createdAt: Date
  }) =>
    Effect.gen(function* () {
      if (followUpMode === null) return

      const [followUpJob] = yield* executor
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode: followUpMode,
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.insert"))

      if (followUpJob === undefined) {
        return yield* new SyncEngineStorageError({
          operation: "sourceSyncJobRepository.materializeFollowUpJob.insert",
          cause: { sourceId, jobId },
        })
      }

      yield* executor
        .update(schema.processingJobs)
        .set({ followUpJobId: followUpJob.id })
        .where(eq(schema.processingJobs.id, jobId))
        .pipe(
          Effect.asVoid,
          wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.link")
        )

      if (followUpMode === "replay") {
        yield* executor
          .update(schema.principalAssetOverrideApplications)
          .set({ replayJobId: followUpJob.id })
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.sourceId, sourceId),
              isNull(schema.principalAssetOverrideApplications.supersededAt),
              or(
                isNull(schema.principalAssetOverrideApplications.replayJobId),
                eq(schema.principalAssetOverrideApplications.replayJobId, jobId),
                sql`exists (
                  select 1
                  from ${schema.processingJobs} previous_replay
                  where previous_replay.id = ${schema.principalAssetOverrideApplications.replayJobId}
                    and (
                      previous_replay.status in ('failed', 'credit_required')
                      or (
                        previous_replay.status = 'completed'
                        and previous_replay.progress_details ->> 'failedRecords' <> '0'
                      )
                    )
                )`
              )
            )
          )
          .pipe(
            Effect.asVoid,
            wrapSyncEngineSqlError(
              "sourceSyncJobRepository.materializeFollowUpJob.linkOverrideApplications"
            )
          )

        // The follow-up replay also owns every unfinished global decision
        // rebuild for this source, including earlier operator failures.
        yield* executor
          .update(schema.assetDecisionRematerializations)
          .set({
            processingJobId: followUpJob.id,
            status: "pending",
            failureCode: null,
            lastFailureAt: null,
            updatedAt: createdAt,
          })
          .where(
            and(
              eq(schema.assetDecisionRematerializations.sourceId, sourceId),
              ne(schema.assetDecisionRematerializations.status, "complete")
            )
          )
          .pipe(
            Effect.asVoid,
            wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.repointRebuilds")
          )
      }
    })

  const recordNewlyObservedOverrideApplications = ({
    executor,
    jobId,
    sourceId,
    completedAt,
  }: {
    readonly executor: SourceSyncJobExecutor & Pick<typeof db, "execute">
    readonly jobId: string
    readonly sourceId: string
    readonly completedAt: Date
  }) =>
    executor
      .execute(sql`
        insert into principal_asset_override_applications (
          override_id,
          source_id,
          replay_job_id,
          requires_replay,
          created_at
        )
        select
          asset_override.id,
          ${sourceId}::uuid,
          ${jobId}::uuid,
          false,
          ${completedAt}
        from ${schema.principalAssetOverrides} asset_override
        where asset_override.principal_id = (
            select ${schema.sources.principalId}
            from ${schema.sources}
            where ${schema.sources.id} = ${sourceId}::uuid
          )
          and not exists (
            select 1
            from ${schema.principalAssetOverrides} superseding_override
            where superseding_override.supersedes_override_id = asset_override.id
          )
          and (
            (
              asset_override.target_kind = 'provider_asset'
              and exists (
                select 1
                from ${schema.providerAssetSourceUses} source_use
                where source_use.source_id = ${sourceId}
                  and source_use.provider_asset_row_id = asset_override.provider_asset_row_id
              )
            )
            or (
              asset_override.target_kind = 'representation'
              and exists (
                select 1
                from ${schema.sourceRepresentationUses} representation_use
                where representation_use.source_id = ${sourceId}
                  and representation_use.blockchain_id = asset_override.blockchain_id
                  and representation_use.representation_type = asset_override.representation_type
                  and lower(representation_use.contract_address) is not distinct from lower(asset_override.contract_address)
                  and representation_use.mint_address is not distinct from asset_override.mint_address
              )
            )
          )
        on conflict (override_id, source_id) do update
          set replay_job_id = excluded.replay_job_id,
              created_at = excluded.created_at
          where (
            principal_asset_override_applications.requires_replay = false
            and not exists (
                select 1
                from ${schema.processingJobs} applied_job
                where applied_job.id = principal_asset_override_applications.replay_job_id
                  and applied_job.status = 'completed'
                  and applied_job.progress_details ->> 'failedRecords' = '0'
              )
          ) or (
            principal_asset_override_applications.requires_replay = true
            and exists (
              select 1
              from ${schema.processingJobs} successful_replay
              where successful_replay.id = excluded.replay_job_id
                and successful_replay.mode = 'replay'
                and successful_replay.status = 'completed'
                and successful_replay.progress_details ->> 'failedRecords' = '0'
                -- Only a replay requested at or after the override was written can
                -- have applied it; an older replay ran without the override.
                and successful_replay.created_at >= (
                  select applied_override.created_at
                  from ${schema.principalAssetOverrides} applied_override
                  where applied_override.id = excluded.override_id
                )
            )
          )
      `)
      .pipe(
        Effect.asVoid,
        wrapSyncEngineSqlError("sourceSyncJobRepository.recordNewlyObservedOverrideApplications")
      )

  /**
   * Record the outcome of a finished replay on every unfinished decision
   * rebuild for the source. A replay rebuilds the whole source from raw
   * records, so one clean replay completes every tracked rebuild, and any
   * failure parks them at operator_attention until a later replay succeeds.
   * Rebuild readers (tax readiness, exception status) trust this stored
   * status instead of re-deriving it from job chains.
   */
  const settleSourceRebuilds = ({
    executor,
    sourceId,
    outcome,
    at,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly sourceId: string
    readonly outcome:
      | { readonly _tag: "complete" }
      | { readonly _tag: "failed"; readonly failureCode: string }
    readonly at: Date
  }) =>
    executor
      .update(schema.assetDecisionRematerializations)
      .set(
        outcome._tag === "complete"
          ? {
              status: "complete",
              failureCode: null,
              lastFailureAt: null,
              updatedAt: at,
            }
          : {
              status: "operator_attention",
              failureCode: outcome.failureCode,
              lastFailureAt: at,
              updatedAt: at,
            }
      )
      .where(
        and(
          eq(schema.assetDecisionRematerializations.sourceId, sourceId),
          ne(schema.assetDecisionRematerializations.status, "complete")
        )
      )
      .pipe(Effect.asVoid, wrapSyncEngineSqlError("sourceSyncJobRepository.settleSourceRebuilds"))

  const selectActiveJobFields = {
    id: schema.processingJobs.id,
    sourceId: schema.processingJobs.sourceId,
    principalId: schema.processingJobs.principalId,
    mode: schema.processingJobs.mode,
    status: schema.processingJobs.status,
    updatedAt: schema.processingJobs.updatedAt,
    queueName: schema.processingJobs.queueName,
    queueJobId: schema.processingJobs.queueJobId,
  } as const

  const selectExecutionJobFields = {
    id: schema.processingJobs.id,
    sourceId: schema.processingJobs.sourceId,
    principalId: schema.processingJobs.principalId,
    mode: schema.processingJobs.mode,
    status: schema.processingJobs.status,
  } as const

  const loadExecutionJobById = ({
    jobId,
    operation,
  }: {
    readonly jobId: string
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select(selectExecutionJobFields)
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError(operation))

      if (job === undefined) {
        return yield* new SourceSyncJobExecutionRecordNotFoundError({ jobId })
      }

      return yield* toExecutionJob({ job, jobId })
    })

  const failExpectedState = ({
    jobId,
    operation,
    reason,
  }: {
    readonly jobId: string
    readonly operation: string
    readonly reason: string
  }) =>
    loadExecutionJobById({ jobId, operation }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new SourceSyncJobExecutionRecordConflictError({ jobId, reason }))
      )
    )

  const findActiveJob: SourceSyncJobRepositoryShape["findActiveJob"] = ({
    sourceId,
    principalId,
  }) =>
    db
      .select(selectActiveJobFields)
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.sourceId, sourceId),
          eq(schema.processingJobs.principalId, principalId),
          inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
        )
      )
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.findActiveJob"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status === "pending" || job.status === "processing") {
              return [
                {
                  id: job.id,
                  sourceId: job.sourceId,
                  principalId: job.principalId,
                  mode: job.mode,
                  status: job.status,
                  updatedAt: job.updatedAt,
                  queueName: job.queueName,
                  queueJobId: job.queueJobId,
                },
              ]
            }

            return []
          })
        )
      )

  const createProcessingJob = ({
    sourceId,
    principalId,
    mode,
    maxAttempts,
  }: {
    readonly sourceId: string
    readonly principalId: string
    readonly mode: "sync" | "replay"
    readonly maxAttempts: number
  }): Effect.Effect<string, PersistenceError> =>
    Effect.gen(function* () {
      const [job] = yield* db
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode,
          status: "pending",
          attemptCount: 0,
          maxAttempts,
          progressDetails: { mode },
        })
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSqlError("sourceSyncJobRepository.createProcessingJob.insert"))

      if (job === undefined) {
        return yield* new PersistenceError({
          operation: "sourceSyncJobRepository.createProcessingJob.insert",
          cause: "failed to create processing job",
        })
      }

      return job.id
    })

  const createOrReuseJob: SourceSyncJobRepositoryShape["createOrReuseJob"] = ({
    sourceId,
    principalId,
    mode,
    maxAttempts,
  }) => {
    const attemptCreateOrReuse = (
      attemptsRemaining: number
    ): Effect.Effect<CreateOrReuseSourceSyncJobResult, SyncEngineStorageError> =>
      createProcessingJob({ sourceId, principalId, mode, maxAttempts }).pipe(
        Effect.map(
          (jobId): CreateOrReuseSourceSyncJobResult => ({
            _tag: "CreatedSourceSyncJob",
            id: jobId,
          })
        ),
        Effect.catch((error) => {
          if (!isActiveProcessingJobConflict(error)) {
            return Effect.fail(toSyncEngineStorageError({ error }))
          }

          const retryAfterCompletionRace = () =>
            attemptsRemaining > 1
              ? Effect.suspend(() => attemptCreateOrReuse(attemptsRemaining - 1))
              : Effect.fail(toSyncEngineStorageError({ error }))

          return findActiveJob({ sourceId, principalId }).pipe(
            Effect.flatMap(([concurrentJob]) =>
              Effect.gen(function* () {
                // The conflicting job may finish before it can be read. Retry the
                // insert so this request can become the new active job.
                if (concurrentJob === undefined) {
                  return yield* retryAfterCompletionRace()
                }

                if (mode === "replay" && concurrentJob.mode !== "replay") {
                  const [updatedJob] = yield* db
                    .update(schema.processingJobs)
                    .set({ followUpMode: "replay" })
                    .where(
                      and(
                        eq(schema.processingJobs.id, concurrentJob.id),
                        inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
                      )
                    )
                    .returning({ id: schema.processingJobs.id })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "sourceSyncJobRepository.createOrReuseJob.requestFollowUp"
                      )
                    )

                  // The job may finish between the read and conditional update.
                  // Retry against the active job that now owns the source.
                  if (updatedJob === undefined) {
                    return yield* retryAfterCompletionRace()
                  }
                }

                return {
                  _tag: "ReusedSourceSyncJob",
                  id: concurrentJob.id,
                  sourceId: concurrentJob.sourceId,
                  principalId: concurrentJob.principalId,
                  mode: concurrentJob.mode,
                  status: concurrentJob.status,
                  queueName: concurrentJob.queueName,
                  queueJobId: concurrentJob.queueJobId,
                } satisfies CreateOrReuseSourceSyncJobResult
              })
            )
          )
        })
      )

    return attemptCreateOrReuse(MAX_CREATE_OR_REUSE_RACE_ATTEMPTS)
  }

  const attachQueueMetadata: SourceSyncJobRepositoryShape["attachQueueMetadata"] = ({
    jobId,
    queueName,
    queueJobId,
    queuedAt,
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({
          queueName,
          queueJobId,
          queuedAt,
          updatedAt: queuedAt,
        })
        .where(
          and(
            eq(schema.processingJobs.id, jobId),
            inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.attachQueueMetadata.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.attachQueueMetadata.select",
          reason: "Only active jobs can receive queue metadata.",
        })
      }
    })

  const claimJob: SourceSyncJobRepositoryShape["claimJob"] = ({ jobId, workerId, startedAt }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({
          status: "processing",
          workerId,
          startedAt,
          heartbeatAt: startedAt,
          completedAt: null,
          nextRetryAt: null,
          errorMessage: null,
          updatedAt: startedAt,
        })
        .where(
          and(
            eq(schema.processingJobs.id, jobId),
            eq(schema.processingJobs.status, "pending"),
            isNotNull(schema.processingJobs.principalId)
          )
        )
        .returning(selectExecutionJobFields)
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.claimJob.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.claimJob.select",
          reason: "Only pending jobs can be claimed.",
        })
      }

      return yield* toExecutionJob({ job, jobId })
    })

  const heartbeatJob: SourceSyncJobRepositoryShape["heartbeatJob"] = ({
    jobId,
    workerId,
    heartbeatAt,
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({ heartbeatAt, updatedAt: heartbeatAt })
        .where(
          and(
            eq(schema.processingJobs.id, jobId),
            eq(schema.processingJobs.status, "processing"),
            eq(schema.processingJobs.workerId, workerId)
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.heartbeatJob.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.heartbeatJob.select",
          reason: "Only the worker that claimed a processing job can heartbeat it.",
        })
      }
    })

  const recordRetryableFailure: SourceSyncJobRepositoryShape["recordRetryableFailure"] = ({
    jobId,
    message,
    attemptCount,
    nextRetryAt,
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({
          status: "pending",
          attemptCount,
          startedAt: null,
          heartbeatAt: null,
          nextRetryAt,
          completedAt: null,
          errorMessage: message,
          workerId: null,
          updatedAt: now,
        })
        .where(
          and(eq(schema.processingJobs.id, jobId), eq(schema.processingJobs.status, "processing"))
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.recordRetryableFailure.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.recordRetryableFailure.select",
          reason: "Only processing jobs can record retryable failures.",
        })
      }
    })

  const recoverStaleActiveJob: SourceSyncJobRepositoryShape["recoverStaleActiveJob"] = ({
    sourceId,
    jobId,
    staleBefore,
    message,
    completedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "failed",
              completedAt,
              errorMessage: message,
              workerId: null,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.sourceId, sourceId),
                eq(schema.processingJobs.status, "processing"),
                or(
                  lt(schema.processingJobs.heartbeatAt, staleBefore),
                  and(
                    isNull(schema.processingJobs.heartbeatAt),
                    lt(schema.processingJobs.updatedAt, staleBefore)
                  )
                )
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.recoverStaleActiveJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.recoverStaleActiveJob.select",
              reason: "Only processing jobs that are still stale can be recovered.",
            })
          }

          yield* tx
            .delete(schema.creditLedger)
            .where(eq(schema.creditLedger.replayReservationId, jobId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceSyncJobRepository.recoverStaleActiveJob.releaseReplayCredits"
              )
            )

          yield* recordNewlyObservedOverrideApplications({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            completedAt,
          })

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: "replay_interrupted" },
              at: completedAt,
            })
          }

          yield* Effect.logWarning(
            { sourceId, jobId, completedAt: completedAt.toISOString() },
            "source-sync:stale-active-job-recovered"
          )
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.recoverStaleActiveJob"))

  const failJob: SourceSyncJobRepositoryShape["failJob"] = ({ jobId, message, completedAt }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "failed",
              completedAt,
              errorMessage: message,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.failJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.failJob.select",
              reason: "Only processing jobs can fail.",
            })
          }

          yield* recordNewlyObservedOverrideApplications({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            completedAt,
          })

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: "replay_failed" },
              at: completedAt,
            })
          }
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.failJob"))

  const failCreditRequiredJob: SourceSyncJobRepositoryShape["failCreditRequiredJob"] = ({
    jobId,
    completedAt,
    reasonCode,
    availableCredits,
    creditsConsumed,
    additionalCreditsRequired,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "credit_required",
              completedAt,
              // Clients derive localized copy from the status and the credit
              // fields; no server-authored message is stored.
              errorMessage: null,
              creditReasonCode: reasonCode,
              creditsAvailable: availableCredits,
              creditsConsumed,
              additionalCreditsRequired,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.failCreditRequiredJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.failCreditRequiredJob.select",
              reason: "Only processing jobs can become credit-required.",
            })
          }

          yield* recordNewlyObservedOverrideApplications({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            completedAt,
          })

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: reasonCode },
              at: completedAt,
            })
          }
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.failCreditRequiredJob"))

  const completeJob: SourceSyncJobRepositoryShape["completeJob"] = ({ jobId, state }) => {
    const completedAt = nowDate()
    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "completed",
              completedAt,
              errorMessage: null,
              progressDetails: {
                phase: state.phase,
                processedRecords: state.processedRecords,
                totalRecords: state.totalRecords,
                fetchedRecords: state.fetchedRecords,
                normalizedRecords: state.normalizedRecords,
                failedRecords: state.failedRecords,
                cursorPayload: state.cursorPayload,
                highWatermark: highWatermarkToIso(state.highWatermark),
              },
              checkpointExternalId: state.checkpointExternalId,
              checkpointPayload: state.cursorPayload,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.completeJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.completeJob.select",
              reason: "Only processing jobs can complete.",
            })
          }

          yield* recordNewlyObservedOverrideApplications({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            completedAt,
          })

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          // A replay that skipped rows left derived accounting incomplete
          // even though the job itself completed, so it must not count as a
          // finished rebuild.
          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome:
                state.failedRecords === 0
                  ? { _tag: "complete" }
                  : { _tag: "failed", failureCode: "replay_failed_records" },
              at: completedAt,
            })
          }
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.completeJob"))
  }

  const getJob: SourceSyncJobRepositoryShape["getJob"] = ({ principalId, sourceId, jobId }) =>
    Effect.gen(function* () {
      const loadJobRecord = (recordJobId: string) =>
        db
          .select({
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            status: schema.processingJobs.status,
            errorMessage: schema.processingJobs.errorMessage,
            creditReasonCode: schema.processingJobs.creditReasonCode,
            creditsAvailable: schema.processingJobs.creditsAvailable,
            creditsConsumed: schema.processingJobs.creditsConsumed,
            additionalCreditsRequired: schema.processingJobs.additionalCreditsRequired,
            progressDetails: schema.processingJobs.progressDetails,
            followUpJobId: schema.processingJobs.followUpJobId,
          })
          .from(schema.processingJobs)
          .where(
            and(
              eq(schema.processingJobs.id, recordJobId),
              eq(schema.processingJobs.sourceId, sourceId),
              eq(schema.processingJobs.principalId, principalId)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError("sourceSyncJobRepository.getJob.select"),
            Effect.flatMap(([job]) =>
              job === undefined
                ? Effect.fail(new SourceSyncJobRecordNotVisibleError({ sourceId, jobId }))
                : Effect.succeed(job)
            )
          )

      const requestedJob = yield* loadJobRecord(jobId)
      const visibleJob =
        requestedJob.followUpJobId === null
          ? requestedJob
          : yield* loadJobRecord(requestedJob.followUpJobId)
      const progress = yield* decodeSourceSyncJobProgressSnapshot(visibleJob.progressDetails)
      const creditOutcome = yield* toCreditOutcome(visibleJob)

      return {
        sourceId: visibleJob.sourceId,
        jobId: visibleJob.id,
        status: toPublicSourceSyncJobStatus(visibleJob.status),
        phase: progress?.phase ?? null,
        processedRecords: progress?.processedRecords ?? null,
        totalRecords: progress?.totalRecords ?? null,
        progressPercent: getSourceSyncProgressPercent({
          phase: progress?.phase ?? null,
          processedRecords: progress?.processedRecords ?? null,
          totalRecords: progress?.totalRecords ?? null,
        }),
        fetchedRecords: progress?.fetchedRecords ?? null,
        normalizedRecords: progress?.normalizedRecords ?? null,
        failedRecords: progress?.failedRecords ?? null,
        message: visibleJob.errorMessage,
        resumable: visibleJob.status === "credit_required",
        creditOutcome,
      }
    })

  const getExecutionJob: SourceSyncJobRepositoryShape["getExecutionJob"] = ({ jobId }) =>
    loadExecutionJobById({
      jobId,
      operation: "sourceSyncJobRepository.getExecutionJob.select",
    })

  const listStaleActiveJobs: SourceSyncJobRepositoryShape["listStaleActiveJobs"] = ({
    staleBefore,
    limit,
  }) =>
    db
      .select({
        id: schema.processingJobs.id,
        sourceId: schema.processingJobs.sourceId,
        principalId: schema.processingJobs.principalId,
        status: schema.processingJobs.status,
        startedAt: schema.processingJobs.startedAt,
        heartbeatAt: schema.processingJobs.heartbeatAt,
        updatedAt: schema.processingJobs.updatedAt,
        workerId: schema.processingJobs.workerId,
      })
      .from(schema.processingJobs)
      .where(
        and(
          isNotNull(schema.processingJobs.principalId),
          inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES),
          or(
            lt(schema.processingJobs.heartbeatAt, staleBefore),
            and(
              isNull(schema.processingJobs.heartbeatAt),
              lt(schema.processingJobs.updatedAt, staleBefore)
            )
          )
        )
      )
      .orderBy(asc(schema.processingJobs.updatedAt))
      .limit(limit)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.listStaleActiveJobs"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status !== "pending" && job.status !== "processing") {
              return []
            }

            return [
              {
                id: job.id,
                sourceId: job.sourceId,
                principalId: job.principalId,
                status: job.status,
                startedAt: job.startedAt,
                heartbeatAt: job.heartbeatAt,
                updatedAt: job.updatedAt,
                workerId: job.workerId,
              } satisfies SourceSyncStaleActiveJob,
            ]
          })
        )
      )

  const listRepairableActiveJobs: SourceSyncJobRepositoryShape["listRepairableActiveJobs"] = ({
    pendingStaleBefore,
    processingStaleBefore,
    limit,
  }) =>
    db
      .select({
        id: schema.processingJobs.id,
        sourceId: schema.processingJobs.sourceId,
        principalId: schema.processingJobs.principalId,
        mode: schema.processingJobs.mode,
        status: schema.processingJobs.status,
        startedAt: schema.processingJobs.startedAt,
        heartbeatAt: schema.processingJobs.heartbeatAt,
        updatedAt: schema.processingJobs.updatedAt,
        workerId: schema.processingJobs.workerId,
        queueName: schema.processingJobs.queueName,
        queueJobId: schema.processingJobs.queueJobId,
      })
      .from(schema.processingJobs)
      .where(
        and(
          isNotNull(schema.processingJobs.principalId),
          or(
            and(
              eq(schema.processingJobs.status, "pending"),
              sql`not exists (
                select 1
                from ${schema.principalAssetOverrideApplications} dependent_application
                cross join lateral unnest(dependent_application.depends_on_source_ids) dependency_source_id
                where dependent_application.replay_job_id = ${schema.processingJobs.id}
                  and dependent_application.superseded_at is null
                  and not exists (
                    select 1
                    from ${schema.principalAssetOverrideApplications} owner_application
                    inner join ${schema.processingJobs} owner_job
                      on owner_job.id = owner_application.replay_job_id
                    where owner_application.override_id = dependent_application.override_id
                      and owner_application.source_id = dependency_source_id
                      and owner_application.superseded_at is null
                      and owner_job.status = 'completed'
                      and owner_job.progress_details ->> 'failedRecords' = '0'
                  )
              )`,
              or(
                isNull(schema.processingJobs.queueName),
                isNull(schema.processingJobs.queueJobId),
                lt(schema.processingJobs.updatedAt, pendingStaleBefore)
              )
            ),
            and(
              eq(schema.processingJobs.status, "processing"),
              or(
                lt(schema.processingJobs.heartbeatAt, processingStaleBefore),
                and(
                  isNull(schema.processingJobs.heartbeatAt),
                  lt(schema.processingJobs.updatedAt, processingStaleBefore)
                )
              )
            )
          )
        )
      )
      .orderBy(asc(schema.processingJobs.updatedAt))
      .limit(limit)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.listRepairableActiveJobs"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status !== "pending" && job.status !== "processing") {
              return []
            }

            return [
              {
                id: job.id,
                sourceId: job.sourceId,
                principalId: job.principalId,
                mode: job.mode,
                status: job.status,
                startedAt: job.startedAt,
                heartbeatAt: job.heartbeatAt,
                updatedAt: job.updatedAt,
                workerId: job.workerId,
                queueName: job.queueName,
                queueJobId: job.queueJobId,
              } satisfies SourceSyncRepairableActiveJob,
            ]
          })
        )
      )

  const listPendingJobsNeedingDispatch: SourceSyncJobRepositoryShape["listPendingJobsNeedingDispatch"] =
    ({ staleBefore, limit, jobId }) =>
      db
        .select({
          id: schema.processingJobs.id,
          sourceId: schema.processingJobs.sourceId,
          principalId: schema.processingJobs.principalId,
          mode: schema.processingJobs.mode,
          startedAt: schema.processingJobs.startedAt,
          heartbeatAt: schema.processingJobs.heartbeatAt,
          updatedAt: schema.processingJobs.updatedAt,
          workerId: schema.processingJobs.workerId,
          queueName: schema.processingJobs.queueName,
          queueJobId: schema.processingJobs.queueJobId,
        })
        .from(schema.processingJobs)
        .where(
          and(
            isNotNull(schema.processingJobs.principalId),
            eq(schema.processingJobs.status, "pending"),
            jobId === undefined ? undefined : eq(schema.processingJobs.id, jobId),
            sql`not exists (
              select 1
              from ${schema.principalAssetOverrideApplications} dependent_application
              cross join lateral unnest(dependent_application.depends_on_source_ids) dependency_source_id
              where dependent_application.replay_job_id = ${schema.processingJobs.id}
                and dependent_application.superseded_at is null
                and not exists (
                  select 1
                  from ${schema.principalAssetOverrideApplications} owner_application
                  inner join ${schema.processingJobs} owner_job
                    on owner_job.id = owner_application.replay_job_id
                  where owner_application.override_id = dependent_application.override_id
                    and owner_application.source_id = dependency_source_id
                    and owner_application.superseded_at is null
                    and owner_job.status = 'completed'
                    and owner_job.progress_details ->> 'failedRecords' = '0'
                )
            )`,
            or(
              isNull(schema.processingJobs.queueName),
              isNull(schema.processingJobs.queueJobId),
              lt(schema.processingJobs.updatedAt, staleBefore)
            )
          )
        )
        .orderBy(asc(schema.processingJobs.updatedAt))
        .limit(limit)
        .pipe(
          wrapSyncEngineSqlError("sourceSyncJobRepository.listPendingJobsNeedingDispatch"),
          Effect.map((jobs) =>
            jobs.map(
              (job) =>
                ({
                  ...job,
                  status: "pending",
                }) satisfies SourceSyncPendingDispatchJob
            )
          )
        )

  return SourceSyncJobRepository.of({
    findActiveJob,
    createOrReuseJob,
    attachQueueMetadata,
    claimJob,
    heartbeatJob,
    recordRetryableFailure,
    recoverStaleActiveJob,
    failJob,
    failCreditRequiredJob,
    completeJob,
    getJob,
    getExecutionJob,
    listStaleActiveJobs,
    listRepairableActiveJobs,
    listPendingJobsNeedingDispatch,
  } satisfies SourceSyncJobRepositoryShape)
})

export const SourceSyncJobRepositoryLive = Layer.effect(SourceSyncJobRepository, make)
