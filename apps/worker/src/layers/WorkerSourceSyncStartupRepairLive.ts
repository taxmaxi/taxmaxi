/**
 * WorkerSourceSyncStartupRepairLive - Startup repair for source sync queue state.
 *
 * @module WorkerSourceSyncStartupRepairLive
 */

import { Queue, type JobsOptions } from "bullmq"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { Redis } from "ioredis"
import {
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncQueuePayload,
  type SourceSyncJobExecutionRecordConflictError,
  type SourceSyncJobExecutionRecordNotFoundError,
  type SourceSyncJobRepositoryShape,
  type SourceSyncRepairableActiveJob,
  type SyncEngineStorageError,
} from "@my/sync-engine/services"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_REPAIR_STALE_AFTER_MS = 120_000
const DEFAULT_REPAIR_BATCH_SIZE = 100
const DEFAULT_QUEUE_ATTEMPTS = 3
const DEFAULT_BACKOFF_DELAY_MS = 5_000
const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 1_000
const DEFAULT_REMOVE_ON_FAIL_COUNT = 5_000

/**
 * WorkerSourceSyncStartupRepairConfig - Runtime configuration for startup repair.
 */
export interface WorkerSourceSyncStartupRepairConfig {
  readonly redisUrl: URL
  readonly queuePrefix: string
  readonly staleAfterMs: number
  readonly batchSize: number
  readonly attempts: number
  readonly backoffDelayMs: number
  readonly removeOnCompleteCount: number
  readonly removeOnFailCount: number
}

/**
 * WorkerSourceSyncStartupRepairQueue - Minimal BullMQ queue surface for startup repair.
 */
export interface WorkerSourceSyncStartupRepairQueue {
  readonly add: (
    name: typeof SOURCE_SYNC_JOB_NAME,
    payload: SourceSyncQueuePayload,
    options: JobsOptions
  ) => Promise<{ readonly id?: string }>
  readonly close: Effect.Effect<void, WorkerSourceSyncStartupRepairError>
}

/**
 * WorkerSourceSyncStartupRepairOptions - Optional dependency hooks for tests.
 */
export interface WorkerSourceSyncStartupRepairOptions {
  readonly acquireQueue?: (
    config: WorkerSourceSyncStartupRepairConfig
  ) => Effect.Effect<WorkerSourceSyncStartupRepairQueue, WorkerSourceSyncStartupRepairError>
}

/**
 * WorkerSourceSyncStartupRepairError - Startup repair lifecycle failure.
 */
export class WorkerSourceSyncStartupRepairError extends Schema.TaggedError<WorkerSourceSyncStartupRepairError>()(
  "WorkerSourceSyncStartupRepairError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

/**
 * WorkerSourceSyncStartupRepair - Service used to reconcile DB jobs with BullMQ on boot.
 */
export class WorkerSourceSyncStartupRepair extends Context.Tag("WorkerSourceSyncStartupRepair")<
  WorkerSourceSyncStartupRepair,
  {
    readonly repair: Effect.Effect<
      WorkerSourceSyncStartupRepairSummary,
      WorkerSourceSyncStartupRepairError
    >
  }
>() {}

/**
 * WorkerSourceSyncStartupRepairSummary - Count of actions taken during one repair pass.
 */
export interface WorkerSourceSyncStartupRepairSummary {
  readonly scannedJobs: number
  readonly requeuedPending: number
  readonly failedProcessing: number
  readonly skippedJobs: number
  readonly erroredJobs: number
  readonly stoppedAfterErrors: boolean
}

type WorkerSourceSyncStartupRepairJobOutcome =
  | { readonly _tag: "RequeuedPending" }
  | { readonly _tag: "FailedProcessing" }
  | { readonly _tag: "SkippedJob" }
  | { readonly _tag: "ErroredJob" }

type WorkerSourceSyncStartupRepairJobError =
  | WorkerSourceSyncStartupRepairError
  | SourceSyncJobExecutionRecordNotFoundError
  | SourceSyncJobExecutionRecordConflictError
  | SyncEngineStorageError

const makeSkippedJob = (): WorkerSourceSyncStartupRepairJobOutcome => ({ _tag: "SkippedJob" })
const makeErroredJob = (): WorkerSourceSyncStartupRepairJobOutcome => ({ _tag: "ErroredJob" })

const positiveConfig = ({
  name,
  defaultValue,
}: {
  readonly name: string
  readonly defaultValue: number
}) =>
  Config.integer(name).pipe(
    Config.withDefault(defaultValue),
    Config.validate({
      message: `${name} must be greater than zero`,
      validation: (value) => value > 0,
    })
  )

const nonNegativeConfig = ({
  name,
  defaultValue,
}: {
  readonly name: string
  readonly defaultValue: number
}) =>
  Config.integer(name).pipe(
    Config.withDefault(defaultValue),
    Config.validate({
      message: `${name} must be zero or greater`,
      validation: (value) => value >= 0,
    })
  )

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("SOURCE_SYNC_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
    staleAfterMs: yield* positiveConfig({
      name: "SOURCE_SYNC_REPAIR_STALE_AFTER_MS",
      defaultValue: DEFAULT_REPAIR_STALE_AFTER_MS,
    }),
    batchSize: yield* positiveConfig({
      name: "SOURCE_SYNC_REPAIR_BATCH_SIZE",
      defaultValue: DEFAULT_REPAIR_BATCH_SIZE,
    }),
    attempts: yield* Config.integer("SOURCE_SYNC_QUEUE_ATTEMPTS").pipe(
      Config.orElse(() => Config.integer("SYNC_WORKER_MAX_ATTEMPTS")),
      Config.withDefault(DEFAULT_QUEUE_ATTEMPTS),
      Config.validate({
        message: "SOURCE_SYNC_QUEUE_ATTEMPTS must be greater than zero",
        validation: (value) => value > 0,
      })
    ),
    backoffDelayMs: yield* positiveConfig({
      name: "SOURCE_SYNC_QUEUE_BACKOFF_DELAY_MS",
      defaultValue: DEFAULT_BACKOFF_DELAY_MS,
    }),
    removeOnCompleteCount: yield* nonNegativeConfig({
      name: "SOURCE_SYNC_QUEUE_REMOVE_ON_COMPLETE_COUNT",
      defaultValue: DEFAULT_REMOVE_ON_COMPLETE_COUNT,
    }),
    removeOnFailCount: yield* nonNegativeConfig({
      name: "SOURCE_SYNC_QUEUE_REMOVE_ON_FAIL_COUNT",
      defaultValue: DEFAULT_REMOVE_ON_FAIL_COUNT,
    }),
  } satisfies WorkerSourceSyncStartupRepairConfig
})

const currentDate = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(currentTimeMillis)
)

const makeJobOptions = ({
  jobId,
  attempts,
  backoffDelayMs,
  removeOnCompleteCount,
  removeOnFailCount,
}: {
  readonly jobId: string
  readonly attempts: number
  readonly backoffDelayMs: number
  readonly removeOnCompleteCount: number
  readonly removeOnFailCount: number
}): JobsOptions => ({
  jobId,
  attempts,
  backoff: {
    type: "exponential",
    delay: backoffDelayMs,
  },
  removeOnComplete: {
    count: removeOnCompleteCount,
  },
  removeOnFail: {
    count: removeOnFailCount,
  },
})

const acquireLiveQueue = ({
  redisUrl,
  queuePrefix,
}: WorkerSourceSyncStartupRepairConfig): Effect.Effect<
  WorkerSourceSyncStartupRepairQueue,
  WorkerSourceSyncStartupRepairError
> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(redisUrl.toString()),
      catch: (cause) =>
        new WorkerSourceSyncStartupRepairError({
          operation: "workerSourceSyncStartupRepair.acquireConnection",
          cause,
        }),
    })

    const queue = yield* Effect.try({
      try: () =>
        new Queue<SourceSyncQueuePayload, unknown, typeof SOURCE_SYNC_JOB_NAME>(
          SOURCE_SYNC_QUEUE_NAME,
          {
            connection,
            prefix: queuePrefix,
          }
        ),
      catch: (cause) =>
        new WorkerSourceSyncStartupRepairError({
          operation: "workerSourceSyncStartupRepair.acquireQueue",
          cause,
        }),
      // Defensive cleanup if a future BullMQ version throws after taking ownership of the Redis connection.
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      add: (name, payload, options) => queue.add(name, payload, options),
      close: Effect.tryPromise({
        try: async () => {
          try {
            await queue.close()
          } finally {
            connection.disconnect()
          }
        },
        catch: (cause) =>
          new WorkerSourceSyncStartupRepairError({
            operation: "workerSourceSyncStartupRepair.close",
            cause,
          }),
      }),
    } satisfies WorkerSourceSyncStartupRepairQueue
  })

const ageMs = ({ now, updatedAt }: { readonly now: Date; readonly updatedAt: Date | null }) =>
  updatedAt === null ? null : now.getTime() - updatedAt.getTime()

const enqueuePendingJob = ({
  job,
  queue,
  config,
}: {
  readonly job: SourceSyncRepairableActiveJob
  readonly queue: WorkerSourceSyncStartupRepairQueue
  readonly config: WorkerSourceSyncStartupRepairConfig
}) =>
  Effect.gen(function* () {
    const payload = SourceSyncQueuePayload.make({
      jobId: job.id,
      sourceId: job.sourceId,
      principalId: job.principalId,
      mode: job.mode,
    })
    const queueJob = yield* Effect.tryPromise({
      try: () =>
        queue.add(
          SOURCE_SYNC_JOB_NAME,
          payload,
          makeJobOptions({
            jobId: job.id,
            attempts: config.attempts,
            backoffDelayMs: config.backoffDelayMs,
            removeOnCompleteCount: config.removeOnCompleteCount,
            removeOnFailCount: config.removeOnFailCount,
          })
        ),
      catch: (cause) =>
        new WorkerSourceSyncStartupRepairError({
          operation: "workerSourceSyncStartupRepair.requeuePendingJob",
          cause,
        }),
    })

    return queueJob.id ?? job.id
  })

const repairPendingJob = ({
  job,
  queue,
  repository,
  config,
  now,
}: {
  readonly job: SourceSyncRepairableActiveJob
  readonly queue: WorkerSourceSyncStartupRepairQueue
  readonly repository: SourceSyncJobRepositoryShape
  readonly config: WorkerSourceSyncStartupRepairConfig
  readonly now: Date
}) =>
  Effect.gen(function* () {
    const queueJobId = yield* enqueuePendingJob({ job, queue, config })

    yield* repository.attachQueueMetadata({
      jobId: job.id,
      queueName: SOURCE_SYNC_QUEUE_NAME,
      queueJobId,
      queuedAt: now,
    })

    yield* Effect.logWarning(
      {
        jobId: job.id,
        sourceId: job.sourceId,
        principalId: job.principalId,
        mode: job.mode,
        status: job.status,
        ageMs: ageMs({ now, updatedAt: job.updatedAt }),
        action: "requeued-pending",
        queueName: SOURCE_SYNC_QUEUE_NAME,
        queueJobId,
        hadQueueMetadata: job.queueName !== null && job.queueJobId !== null,
      },
      "source-sync-worker:startup-repair-job"
    )

    return { _tag: "RequeuedPending" } satisfies WorkerSourceSyncStartupRepairJobOutcome
  })

const recoverStaleProcessingJob = ({
  job,
  repository,
  now,
}: {
  readonly job: SourceSyncRepairableActiveJob
  readonly repository: SourceSyncJobRepositoryShape
  readonly now: Date
}) =>
  Effect.gen(function* () {
    yield* repository.recoverStaleActiveJob({
      sourceId: job.sourceId,
      jobId: job.id,
      message: "Startup repair failed stale processing source sync job.",
      completedAt: now,
    })

    yield* Effect.logWarning(
      {
        jobId: job.id,
        sourceId: job.sourceId,
        principalId: job.principalId,
        mode: job.mode,
        status: job.status,
        workerId: job.workerId,
        ageMs: ageMs({ now, updatedAt: job.heartbeatAt ?? job.updatedAt }),
        action: "failed-stale-processing",
      },
      "source-sync-worker:startup-repair-job"
    )

    return { _tag: "FailedProcessing" } satisfies WorkerSourceSyncStartupRepairJobOutcome
  })

const repairJob = ({
  job,
  queue,
  repository,
  config,
  now,
}: {
  readonly job: SourceSyncRepairableActiveJob
  readonly queue: WorkerSourceSyncStartupRepairQueue
  readonly repository: SourceSyncJobRepositoryShape
  readonly config: WorkerSourceSyncStartupRepairConfig
  readonly now: Date
}): Effect.Effect<WorkerSourceSyncStartupRepairJobOutcome> => {
  const effect: Effect.Effect<
    WorkerSourceSyncStartupRepairJobOutcome,
    WorkerSourceSyncStartupRepairJobError
  > =
    job.status === "pending"
      ? repairPendingJob({ job, queue, repository, config, now })
      : recoverStaleProcessingJob({ job, repository, now })

  return effect.pipe(
    Effect.catchAll((cause) => {
      if (cause._tag === "SourceSyncJobExecutionRecordNotFoundError") {
        return Effect.logWarning(
          { jobId: job.id, sourceId: job.sourceId, cause, action: "skip-missing" },
          "source-sync-worker:startup-repair-skip"
        ).pipe(Effect.as(makeSkippedJob()))
      }

      if (cause._tag === "SourceSyncJobExecutionRecordConflictError") {
        return Effect.logWarning(
          { jobId: job.id, sourceId: job.sourceId, cause, action: "skip-conflict" },
          "source-sync-worker:startup-repair-skip"
        ).pipe(Effect.as(makeSkippedJob()))
      }

      return Effect.logWarning(
        {
          jobId: job.id,
          sourceId: job.sourceId,
          principalId: job.principalId,
          mode: job.mode,
          status: job.status,
          action: "repair-error",
          cause,
        },
        "source-sync-worker:startup-repair-error"
      ).pipe(Effect.as(makeErroredJob()))
    })
  )
}

const countOutcomes = ({
  jobs,
  outcomes,
  batchSize,
}: {
  readonly jobs: ReadonlyArray<SourceSyncRepairableActiveJob>
  readonly outcomes: ReadonlyArray<WorkerSourceSyncStartupRepairJobOutcome>
  readonly batchSize: number
}): WorkerSourceSyncStartupRepairSummary => {
  const erroredJobs = outcomes.filter((outcome) => outcome._tag === "ErroredJob").length

  return {
    scannedJobs: jobs.length,
    requeuedPending: outcomes.filter((outcome) => outcome._tag === "RequeuedPending").length,
    failedProcessing: outcomes.filter((outcome) => outcome._tag === "FailedProcessing").length,
    skippedJobs: outcomes.filter((outcome) => outcome._tag === "SkippedJob").length,
    erroredJobs,
    stoppedAfterErrors: erroredJobs > 0 && jobs.length === batchSize,
  }
}

const combineSummaries = (
  left: WorkerSourceSyncStartupRepairSummary,
  right: WorkerSourceSyncStartupRepairSummary
): WorkerSourceSyncStartupRepairSummary => ({
  scannedJobs: left.scannedJobs + right.scannedJobs,
  requeuedPending: left.requeuedPending + right.requeuedPending,
  failedProcessing: left.failedProcessing + right.failedProcessing,
  skippedJobs: left.skippedJobs + right.skippedJobs,
  erroredJobs: left.erroredJobs + right.erroredJobs,
  stoppedAfterErrors: left.stoppedAfterErrors || right.stoppedAfterErrors,
})

const emptySummary = {
  scannedJobs: 0,
  requeuedPending: 0,
  failedProcessing: 0,
  skippedJobs: 0,
  erroredJobs: 0,
  stoppedAfterErrors: false,
} satisfies WorkerSourceSyncStartupRepairSummary

/**
 * Construct the startup repair service layer.
 */
export const makeWorkerSourceSyncStartupRepairLive = (
  options: WorkerSourceSyncStartupRepairOptions = {}
) =>
  Layer.scoped(
    WorkerSourceSyncStartupRepair,
    Effect.gen(function* () {
      const repository = yield* SourceSyncJobRepository
      const config = yield* loadConfig
      const acquireQueue = options.acquireQueue ?? acquireLiveQueue

      const repairBatch = (
        queue: WorkerSourceSyncStartupRepairQueue
      ): Effect.Effect<WorkerSourceSyncStartupRepairSummary, WorkerSourceSyncStartupRepairError> =>
        Effect.gen(function* () {
          const now = yield* currentDate
          const staleBefore = new Date(now.getTime() - config.staleAfterMs)
          const jobs = yield* repository
            .listRepairableActiveJobs({
              pendingStaleBefore: staleBefore,
              processingStaleBefore: staleBefore,
              limit: config.batchSize,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkerSourceSyncStartupRepairError({
                    operation: "workerSourceSyncStartupRepair.listRepairableActiveJobs",
                    cause,
                  })
              )
            )

          const outcomes = yield* Effect.forEach(
            jobs,
            (job) => repairJob({ job, queue, repository, config, now }),
            { concurrency: 1 }
          )

          return countOutcomes({
            jobs,
            outcomes,
            batchSize: config.batchSize,
          })
        })

      const repairUntilDrained = (
        queue: WorkerSourceSyncStartupRepairQueue,
        accumulated: WorkerSourceSyncStartupRepairSummary
      ): Effect.Effect<WorkerSourceSyncStartupRepairSummary, WorkerSourceSyncStartupRepairError> =>
        repairBatch(queue).pipe(
          Effect.flatMap((batchSummary) => {
            const nextSummary = combineSummaries(accumulated, batchSummary)

            // A full batch containing an errored row can return the same row at
            // the head of the next SQL page. Stop this boot pass and leave the
            // remaining backlog for the next repair run instead of spinning.
            if (batchSummary.scannedJobs < config.batchSize || batchSummary.stoppedAfterErrors) {
              return Effect.succeed(nextSummary)
            }

            return repairUntilDrained(queue, nextSummary)
          })
        )

      const repair = Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Effect.acquireRelease(acquireQueue(config), (queueToClose) =>
            queueToClose.close.pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  { operation: error.operation, cause: error.cause },
                  "source-sync-worker:startup-repair-queue-close-failed"
                )
              )
            )
          )
          const summary = yield* repairUntilDrained(queue, emptySummary)

          yield* Effect.logInfo(
            {
              ...summary,
              staleAfterMs: config.staleAfterMs,
              batchSize: config.batchSize,
            },
            "source-sync-worker:startup-repair-completed"
          )

          return summary
        })
      )

      return WorkerSourceSyncStartupRepair.of({ repair })
    })
  )

/**
 * WorkerSourceSyncStartupRepairLive - Live startup repair service.
 */
export const WorkerSourceSyncStartupRepairLive = makeWorkerSourceSyncStartupRepairLive()
