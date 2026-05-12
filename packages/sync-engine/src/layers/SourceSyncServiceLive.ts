/**
 * SourceSyncServiceLive - API-facing source sync orchestration.
 *
 * @module SourceSyncServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  SourceNotFoundError,
  SourceRepository,
  type SourceSyncJobMode,
  SourceSyncJobNotFoundError,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueuePayload,
  SourceSyncService,
  SyncEngineStorageError,
  UnsupportedProviderError,
  type SourceSyncJobStatus,
  type SourceSyncJobSummary,
  type SourceSyncServiceShape,
  type SourceSyncSource,
  type SyncJobStatus,
  type SourceSyncQueueError,
} from "../services/index.ts"
import {
  nowDate,
  recordSourceSyncJobOutcome,
  sourceSyncSpan,
} from "./internal/SourceSyncTelemetry.ts"

const ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS = 30_000
const DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS = 3

const toPublicStatus = (status: SourceSyncJobStatus): SyncJobStatus => {
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
    sourceId,
    jobId,
    updatedAt,
  }: {
    readonly sourceId: string
    readonly jobId: string
    readonly updatedAt: Date
  }) =>
    Effect.gen(function* () {
      const message = "Recovered stale source sync job after a previous execution stopped."
      const completedAt = nowDate()

      yield* Effect.logWarning(
        {
          sourceId,
          jobId,
          updatedAt: updatedAt.toISOString(),
          staleAfterMs: ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS,
        },
        "source-sync:recovering-stale-job"
      )

      yield* sourceSyncJobRepository
        .recoverStaleActiveJob({
          sourceId,
          jobId,
          message,
          completedAt,
        })
        .pipe(
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
  }): Effect.Effect<void, SourceSyncQueueError> =>
    sourceSyncQueue
      .enqueueSourceSyncJob(
        SourceSyncQueuePayload.make({
          jobId,
          sourceId,
          principalId,
          mode,
        })
      )
      .pipe(
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
        return yield* Effect.fail(new UnsupportedProviderError({ provider: "unknown" }))
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
            sourceId: source.id,
            jobId: activeJob.id,
            updatedAt: activeJob.updatedAt,
          })

          yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "recovered-stale-job" })
        } else {
          if (activeJob.status === "pending") {
            if (
              shouldEnqueuePendingJob({
                queueName: activeJob.queueName,
                queueJobId: activeJob.queueJobId,
              })
            ) {
              yield* enqueuePendingJob({
                jobId: activeJob.id,
                sourceId: activeJob.sourceId,
                principalId: activeJob.principalId,
                mode: activeJob.mode,
              })
              yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "enqueued-active-job" })
            } else {
              yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "already-queued" })
            }
          } else {
            yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "already-running" })
          }

          return {
            sourceId: source.id,
            jobId: activeJob.id,
            status: toPublicStatus(activeJob.status),
            message: null,
          } satisfies SourceSyncJobSummary
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

        return {
          sourceId: source.id,
          jobId: job.id,
          status: toPublicStatus(job.status),
          message: null,
        } satisfies SourceSyncJobSummary
      }

      yield* enqueuePendingJob({
        jobId: job.id,
        sourceId: source.id,
        principalId,
        mode,
      })

      yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "enqueued-job" })

      return {
        sourceId: source.id,
        jobId: job.id,
        status: "queued",
        message: null,
      } satisfies SourceSyncJobSummary
    }).pipe(
      sourceSyncSpan({ name: "source-sync.job", attributes: { principalId, sourceId, mode } })
    )

  const getSourceSyncJob: SourceSyncServiceShape["getSourceSyncJob"] = ({
    principalId,
    sourceId,
    jobId,
  }) =>
    Effect.gen(function* () {
      return yield* sourceSyncJobRepository
        .getJob({ principalId, sourceId, jobId })
        .pipe(
          Effect.catchTag("SourceSyncJobRecordNotVisibleError", () =>
            Effect.fail(new SourceSyncJobNotFoundError({ sourceId, jobId }))
          )
        )
    })

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
