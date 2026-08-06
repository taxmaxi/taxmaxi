/**
 * SourceSyncJobRepositoryLive - Processing job persistence for sync-engine orchestration.
 *
 * @module SourceSyncJobRepositoryLive
 */

import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

const toPublicStatus = (
  status: SourceSyncJobStatus
): "queued" | "running" | "completed" | "failed" => {
  switch (status) {
    case "pending":
      return "queued"
    case "processing":
      return "running"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
  }
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
      return yield* Effect.fail(
        new SourceSyncJobExecutionRecordConflictError({
          jobId,
          reason: `Job status ${job.status} is not executable.`,
        })
      )
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
        return yield* Effect.fail(
          new SyncEngineStorageError({
            operation: "sourceSyncJobRepository.materializeFollowUpJob.insert",
            cause: { sourceId, jobId },
          })
        )
      }

      yield* executor
        .update(schema.processingJobs)
        .set({ followUpJobId: followUpJob.id })
        .where(eq(schema.processingJobs.id, jobId))
        .pipe(
          Effect.asVoid,
          wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.link")
        )
    })

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
        return yield* Effect.fail(new SourceSyncJobExecutionRecordNotFoundError({ jobId }))
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
        return yield* Effect.fail(
          new PersistenceError({
            operation: "sourceSyncJobRepository.createProcessingJob.insert",
            cause: "failed to create processing job",
          })
        )
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
        Effect.catchAll((error) => {
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

                if (mode === "replay") {
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
                inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.recoverStaleActiveJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.recoverStaleActiveJob.select",
              reason: "Only active jobs can be recovered as stale.",
            })
          }

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

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

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.failJob"))

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
                importedRecords: state.importedRecords,
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

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })
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

      return {
        sourceId: visibleJob.sourceId,
        jobId: visibleJob.id,
        status: toPublicStatus(visibleJob.status),
        phase: progress?.phase ?? null,
        processedRecords: progress?.processedRecords ?? null,
        totalRecords: progress?.totalRecords ?? null,
        progressPercent: getSourceSyncProgressPercent({
          phase: progress?.phase ?? null,
          processedRecords: progress?.processedRecords ?? null,
          totalRecords: progress?.totalRecords ?? null,
        }),
        importedRecords: progress?.importedRecords ?? null,
        normalizedRecords: progress?.normalizedRecords ?? null,
        failedRecords: progress?.failedRecords ?? null,
        message: visibleJob.errorMessage,
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
    ({ staleBefore, limit }) =>
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
    completeJob,
    getJob,
    getExecutionJob,
    listStaleActiveJobs,
    listRepairableActiveJobs,
    listPendingJobsNeedingDispatch,
  } satisfies SourceSyncJobRepositoryShape)
})

export const SourceSyncJobRepositoryLive = Layer.effect(SourceSyncJobRepository, make)
