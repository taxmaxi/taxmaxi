/**
 * SourceSyncServiceLive - API-facing source sync orchestration.
 *
 * @module SourceSyncServiceLive
 */

import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  CalculationRunOrchestrator,
  CalculationRunOrchestrationError,
  terminalizeSourceJobAndWakeCalculation,
  SourceNotFoundError,
  SourceRepository,
  type SourceSyncJobMode,
  SourceSyncJobNotFoundError,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueuePayload,
  SourceSyncService,
  SyncEngineTransaction,
  SyncEngineStorageError,
  makePlainSourceSyncJobSummary,
  toPublicSourceSyncJobStatus,
  UnsupportedProviderError,
  type SourceSyncJobSummary,
  type SourceSyncServiceShape,
  type SourceSyncSource,
  type SourceSyncQueueError,
} from "../services/index.ts"
import {
  nowDate,
  recordSourceSyncJobOutcome,
  sourceSyncSpan,
} from "./internal/SourceSyncTelemetry.ts"

const ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS = 30_000
const DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS = 3

const isStaleActiveProcessingJob = ({
  updatedAt,
  now,
}: {
  readonly updatedAt: Date
  readonly now: Date
}): boolean => now.getTime() - updatedAt.getTime() >= ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS

const make = Effect.gen(function* () {
  const sourceRepository = yield* SourceRepository
  const sourceSyncJobRepository = yield* SourceSyncJobRepository
  const sourceSyncQueue = yield* SourceSyncQueue
  const calculationRunOrchestrator = yield* CalculationRunOrchestrator
  const syncEngineTransaction = yield* SyncEngineTransaction

  const loadSource = ({
    principalId,
    sourceId,
  }: {
    readonly principalId: string
    readonly sourceId: string
  }): Effect.Effect<SourceSyncSource, SourceNotFoundError | SyncEngineStorageError> =>
    sourceRepository.findOwnedSourceSyncContext({ principalId, sourceId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new SourceNotFoundError({ sourceId })),
          onSome: Effect.succeed,
        })
      ),
      sourceSyncSpan({
        name: "source-sync.load-source",
        attributes: { principalId, sourceId },
        kind: "client",
      })
    )

  const recoverStaleActiveJob = ({
    principalId,
    sourceId,
    jobId,
    updatedAt,
  }: {
    readonly principalId: string
    readonly sourceId: string
    readonly jobId: string
    readonly updatedAt: Date
  }) =>
    Effect.gen(function* () {
      const message = "Recovered stale source sync job after a previous execution stopped."
      const completedAt = nowDate()
      const staleBefore = DateTime.toDateUtc(
        DateTime.subtractDuration(
          DateTime.makeUnsafe(completedAt),
          ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS
        )
      )

      yield* Effect.logWarning(
        {
          sourceId,
          jobId,
          updatedAt: updatedAt.toISOString(),
          staleAfterMs: ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS,
        },
        "source-sync:recovering-stale-job"
      )

      yield* terminalizeSourceJobAndWakeCalculation({
        calculationRunOrchestrator,
        principalId,
        transaction: syncEngineTransaction,
        terminalize: sourceSyncJobRepository.recoverStaleActiveJob({
          sourceId,
          jobId,
          staleBefore,
          message,
          completedAt,
        }),
        wake: calculationRunOrchestrator.runAfterPrincipalTerminal({ principalId }).pipe(
          Effect.mapError(
            (cause) =>
              new SyncEngineStorageError({
                operation: cause.operation,
                cause: cause.cause,
              })
          )
        ),
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunOrchestrationError)(error)
            ? new SyncEngineStorageError({ operation: error.operation, cause: error.cause })
            : error
        ),
        Effect.catchTags({
          SourceSyncJobExecutionRecordNotFoundError: (error) =>
            Effect.logWarning({ sourceId, jobId, error }, "source-sync:stale-job-not-found"),
          SourceSyncJobExecutionRecordConflictError: (error) =>
            Effect.logWarning({ sourceId, jobId, error }, "source-sync:stale-job-not-active"),
        })
      )
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.recover-stale-job",
        attributes: { sourceId, jobId, updatedAt: updatedAt.toISOString() },
        kind: "client",
      })
    )

  const shouldEnqueuePendingJob = ({
    queueName,
    queueJobId,
  }: {
    readonly queueName: string | null
    readonly queueJobId: string | null
  }): boolean => queueName === null || queueJobId === null

  const enqueuePendingJob = ({
    jobId,
    sourceId,
    principalId,
    mode,
  }: {
    readonly jobId: string
    readonly sourceId: string
    readonly principalId: string
    readonly mode: SourceSyncJobMode
  }): Effect.Effect<void, SourceSyncQueueError | SyncEngineStorageError> =>
    Effect.gen(function* () {
      const readyForDispatch = yield* sourceSyncJobRepository.getExecutionJob({ jobId }).pipe(
        Effect.as(true),
        Effect.catchTags({
          SourceSyncJobPrerequisitesPendingError: () => Effect.succeed(false),
          SourceSyncJobExecutionRecordConflictError: () => Effect.succeed(false),
        }),
        Effect.mapError((cause) =>
          Schema.is(SyncEngineStorageError)(cause)
            ? cause
            : new SyncEngineStorageError({
                operation: "sourceSyncService.enqueuePendingJob.checkPrerequisites",
                cause,
              })
        )
      )

      if (!readyForDispatch) return

      yield* sourceSyncQueue.enqueueSourceSyncJob(
        SourceSyncQueuePayload.make({
          jobId,
          sourceId,
          principalId,
          mode,
        })
      )
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.enqueue-job",
        attributes: { jobId, sourceId, principalId, mode },
        kind: "producer",
      })
    )

  const runSourceJob = ({
    principalId,
    sourceId,
    mode,
  }: {
    readonly principalId: string
    readonly sourceId: string
    readonly mode: SourceSyncJobMode
  }): Effect.Effect<
    SourceSyncJobSummary,
    UnsupportedProviderError | SourceNotFoundError | SourceSyncQueueError | SyncEngineStorageError
  > =>
    Effect.gen(function* () {
      const source = yield* loadSource({ principalId, sourceId })
      const provider = source.providerKey ?? "unknown"

      yield* Effect.annotateCurrentSpan({ principalId, sourceId: source.id, provider, mode })

      if (source.providerKey === null) {
        return yield* new UnsupportedProviderError({ provider: "unknown" })
      }

      const [activeJob] = yield* sourceSyncJobRepository.findActiveJob({
        sourceId: source.id,
        principalId,
      })

      if (activeJob !== undefined) {
        if (
          activeJob.status === "processing" &&
          isStaleActiveProcessingJob({ updatedAt: activeJob.updatedAt, now: nowDate() })
        ) {
          yield* recoverStaleActiveJob({
            principalId,
            sourceId: source.id,
            jobId: activeJob.id,
            updatedAt: activeJob.updatedAt,
          })

          yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "recovered-stale-job" })
        } else {
          // A replay needs follow-up handling only behind a non-replay job.
          // An active replay already satisfies the request and can be reused as-is.
          // If the active job still exists, the repository reuses it and records
          // the replay as follow-up work instead of losing the replay request.
          const replayRequest =
            mode === "replay" && activeJob.mode !== "replay"
              ? yield* sourceSyncJobRepository.createOrReuseJob({
                  sourceId: source.id,
                  principalId,
                  mode,
                  maxAttempts: DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS,
                })
              : undefined

          if (replayRequest?._tag === "CreatedSourceSyncJob") {
            // The active job may finish after findActiveJob. In that race, the
            // repository creates the replay directly, so it must be queued here.
            yield* enqueuePendingJob({
              jobId: replayRequest.id,
              sourceId: source.id,
              principalId,
              mode,
            })
            yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "queued" })

            return makePlainSourceSyncJobSummary({
              sourceId: source.id,
              jobId: replayRequest.id,
              status: "queued",
            })
          }

          // A different active job may have replaced the initial snapshot while
          // createOrReuseJob was recording the replay. Return that current owner.
          const jobToReuse =
            replayRequest?._tag === "ReusedSourceSyncJob" ? replayRequest : activeJob

          if (jobToReuse.status === "pending") {
            if (
              shouldEnqueuePendingJob({
                queueName: jobToReuse.queueName,
                queueJobId: jobToReuse.queueJobId,
              })
            ) {
              yield* enqueuePendingJob({
                jobId: jobToReuse.id,
                sourceId: jobToReuse.sourceId,
                principalId: jobToReuse.principalId,
                mode: jobToReuse.mode,
              })
              yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "enqueued-active-job" })
            } else {
              yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "already-queued" })
            }
          } else {
            yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "already-running" })
          }

          return makePlainSourceSyncJobSummary({
            sourceId: source.id,
            jobId: jobToReuse.id,
            status: toPublicSourceSyncJobStatus(jobToReuse.status),
          })
        }
      }

      const job = yield* sourceSyncJobRepository.createOrReuseJob({
        sourceId: source.id,
        principalId,
        mode,
        maxAttempts: DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS,
      })

      if (job._tag === "ReusedSourceSyncJob") {
        if (
          job.status === "pending" &&
          shouldEnqueuePendingJob({
            queueName: job.queueName,
            queueJobId: job.queueJobId,
          })
        ) {
          yield* enqueuePendingJob({
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            mode: job.mode,
          })
        }

        yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "reused-job" })

        return makePlainSourceSyncJobSummary({
          sourceId: source.id,
          jobId: job.id,
          status: toPublicSourceSyncJobStatus(job.status),
        })
      }

      yield* enqueuePendingJob({
        jobId: job.id,
        sourceId: source.id,
        principalId,
        mode,
      })

      yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "enqueued-job" })

      return makePlainSourceSyncJobSummary({
        sourceId: source.id,
        jobId: job.id,
        status: "queued",
      })
    }).pipe(
      sourceSyncSpan({ name: "source-sync.job", attributes: { principalId, sourceId, mode } })
    )

  const getSourceSyncJob: SourceSyncServiceShape["getSourceSyncJob"] = ({
    principalId,
    sourceId,
    jobId,
  }) =>
    sourceSyncJobRepository
      .getJob({ principalId, sourceId, jobId })
      .pipe(
        Effect.catchTag("SourceSyncJobRecordNotVisibleError", () =>
          Effect.fail(new SourceSyncJobNotFoundError({ sourceId, jobId }))
        )
      )

  const startSourceSyncJob: SourceSyncServiceShape["startSourceSyncJob"] = ({
    principalId,
    sourceId,
  }) => runSourceJob({ principalId, sourceId, mode: "sync" })

  const replaySourceSyncJob: SourceSyncServiceShape["replaySourceSyncJob"] = ({
    principalId,
    sourceId,
  }) => runSourceJob({ principalId, sourceId, mode: "replay" })

  return SourceSyncService.of({
    startSourceSyncJob,
    replaySourceSyncJob,
    getSourceSyncJob,
  } satisfies SourceSyncServiceShape)
})

/**
 * SourceSyncServiceLive - Live API-facing source sync layer.
 */
export const SourceSyncServiceLive = Layer.effect(SourceSyncService, make)
