/**
 * WorkerBullMqSourceSyncConsumerLive - BullMQ consumer for source sync jobs.
 *
 * @module WorkerBullMqSourceSyncConsumerLive
 */

import { Config, DateTime, Effect, Exit, Layer, Result, Schedule, Schema } from "effect"
import {
  DelayedError,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
} from "bullmq"
import { Redis } from "ioredis"
import { randomUUID } from "node:crypto"
import {
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobExecutor,
  SourceSyncQueuePayload,
  type SourceSyncJobExecutorError,
  type SourceSyncJobSummary,
} from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"
import { WorkerSourceSyncStartupRepair } from "./WorkerSourceSyncStartupRepairLive.ts"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_SYNC_WORKER_CONCURRENCY = 1
const DEFAULT_SYNC_WORKER_LOCK_DURATION_MS = 30_000
const DEFAULT_PENDING_DISPATCH_INTERVAL_MS = 5_000
const DEFAULT_RETRY_DELAY_MS = 5_000
const PROCESS_WORKER_ID = `worker-${randomUUID()}`

/**
 * WorkerBullMqSourceSyncConsumerConfig - Runtime configuration for the worker consumer.
 */
export interface WorkerBullMqSourceSyncConsumerConfig {
  readonly redisUrl: URL
  readonly queuePrefix: string
  readonly concurrency: number
  readonly lockDurationMs: number
  readonly pendingDispatchIntervalMs: number
  readonly workerId: string
}

/**
 * WorkerBullMqSourceSyncJob - Minimal BullMQ job surface consumed by the processor.
 */
export interface WorkerBullMqSourceSyncJob {
  readonly id?: string
  readonly name: string
  readonly data: unknown
  readonly attemptsMade: number
  readonly opts: Pick<JobsOptions, "attempts" | "backoff">
  readonly moveToDelayed?: (timestamp: number, token?: string) => Promise<void>
}

/**
 * WorkerBullMqSourceSyncProcessor - Job processor installed into BullMQ.
 */
export type WorkerBullMqSourceSyncProcessor = (
  job: WorkerBullMqSourceSyncJob,
  token?: string
) => Promise<SourceSyncJobSummary>

/**
 * BullMqSourceSyncWorker - Small test seam over BullMQ's worker lifecycle.
 */
export interface BullMqSourceSyncWorker {
  readonly close: Effect.Effect<void, WorkerBullMqSourceSyncConsumerError>
}

/**
 * WorkerBullMqSourceSyncConsumerOptions - Optional dependency injection hooks for tests.
 */
export interface WorkerBullMqSourceSyncConsumerOptions {
  readonly acquireWorker?: (
    config: WorkerBullMqSourceSyncConsumerConfig,
    processor: WorkerBullMqSourceSyncProcessor
  ) => Effect.Effect<BullMqSourceSyncWorker, WorkerBullMqSourceSyncConsumerError>
}

/**
 * WorkerBullMqSourceSyncConsumerError - Worker lifecycle failure.
 */
export class WorkerBullMqSourceSyncConsumerError extends Schema.TaggedError<WorkerBullMqSourceSyncConsumerError>()(
  "WorkerBullMqSourceSyncConsumerError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

class WorkerBullMqMalformedSourceSyncPayloadError extends Schema.TaggedError<WorkerBullMqMalformedSourceSyncPayloadError>()(
  "WorkerBullMqMalformedSourceSyncPayloadError",
  {
    queueJobId: Schema.NullOr(Schema.String),
    cause: Schema.Unknown,
  }
) {}

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("SOURCE_SYNC_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
    concurrency: yield* positiveIntConfig({
      name: "SYNC_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_SYNC_WORKER_CONCURRENCY,
    }),
    lockDurationMs: yield* positiveIntConfig({
      name: "SYNC_WORKER_LOCK_DURATION_MS",
      defaultValue: DEFAULT_SYNC_WORKER_LOCK_DURATION_MS,
    }),
    pendingDispatchIntervalMs: yield* positiveIntConfig({
      name: "SOURCE_SYNC_PENDING_DISPATCH_INTERVAL_MS",
      defaultValue: DEFAULT_PENDING_DISPATCH_INTERVAL_MS,
    }),
    workerId: yield* Config.schema(
      Schema.Trimmed.check(Schema.isNonEmpty({ message: "WORKER_ID must not be empty" })),
      "WORKER_ID"
    ).pipe(Config.withDefault(PROCESS_WORKER_ID)),
  } satisfies WorkerBullMqSourceSyncConsumerConfig
})

const decodePayload = Schema.decodeUnknownEffect(SourceSyncQueuePayload)

const hasPositiveFiniteValue = (value: number): boolean => Number.isFinite(value) && value > 0

const resolveMaxAttempts = (job: WorkerBullMqSourceSyncJob): number => {
  const attempts = job.opts.attempts

  return typeof attempts === "number" && Number.isInteger(attempts) && attempts > 0 ? attempts : 1
}

const resolveBackoffDelayMs = (job: WorkerBullMqSourceSyncJob): number => {
  const { backoff } = job.opts

  if (typeof backoff === "number" && hasPositiveFiniteValue(backoff)) {
    return backoff
  }

  if (typeof backoff === "object" && backoff !== null) {
    const { delay } = backoff

    if (typeof delay === "number" && hasPositiveFiniteValue(delay)) {
      if (backoff.type === "exponential") {
        const exponentialDelay = delay * 2 ** job.attemptsMade

        if (hasPositiveFiniteValue(exponentialDelay)) {
          return exponentialDelay
        }
      }

      return delay
    }
  }

  return DEFAULT_RETRY_DELAY_MS
}

const UnknownErrorMessageSchema = Schema.Struct({
  message: Schema.Trimmed.check(Schema.isNonEmpty()),
})

const decodeUnknownErrorMessage = Schema.decodeUnknownExit(UnknownErrorMessageSchema)

const errorMessage = (error: unknown): string => {
  const decoded = decodeUnknownErrorMessage(error)

  if (Exit.isSuccess(decoded)) {
    return decoded.value.message
  }

  if (error instanceof Error && error.message.trim() !== "") {
    return error.message
  }

  return "Source sync worker job failed"
}

const toJobFailure = (error: unknown): Error =>
  error instanceof Error ? error : new Error(errorMessage(error))

const isRetryableWorkerError = (
  error: SourceSyncJobExecutorError | WorkerBullMqMalformedSourceSyncPayloadError
): boolean =>
  error._tag === "SourceSyncJobRetryableExecutionError" || error._tag === "SyncEngineStorageError"

const processJob = Effect.fn("worker.source-sync.process", {
  attributes: {
    queueName: SOURCE_SYNC_QUEUE_NAME,
  },
  kind: "consumer",
})(function* ({
  job,
  config,
}: {
  readonly job: WorkerBullMqSourceSyncJob
  readonly config: WorkerBullMqSourceSyncConsumerConfig
}) {
  const executor = yield* SourceSyncJobExecutor
  const payload = yield* decodePayload(job.data).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerBullMqMalformedSourceSyncPayloadError({
          queueJobId: job.id ?? null,
          cause,
        })
    )
  )
  const attemptNumber = job.attemptsMade + 1
  const maxAttempts = resolveMaxAttempts(job)
  const nextRetryAt = yield* DateTime.now.pipe(
    Effect.map(DateTime.add({ milliseconds: resolveBackoffDelayMs(job) })),
    Effect.map(DateTime.toDateUtc)
  )

  yield* Effect.logInfo(
    {
      queueName: SOURCE_SYNC_QUEUE_NAME,
      queueJobId: job.id ?? null,
      workerId: config.workerId,
      jobId: payload.jobId,
      sourceId: payload.sourceId,
      principalId: payload.principalId,
      mode: payload.mode,
      attemptNumber,
      maxAttempts,
    },
    "source-sync-worker:job-started"
  )

  const summary = yield* executor.execute({
    jobId: payload.jobId,
    workerId: config.workerId,
    retryPolicy: {
      attemptNumber,
      maxAttempts,
      nextRetryAt,
    },
  })

  const logPayload = {
    queueName: SOURCE_SYNC_QUEUE_NAME,
    queueJobId: job.id ?? null,
    workerId: config.workerId,
    jobId: payload.jobId,
    sourceId: summary.sourceId,
    mode: payload.mode,
    status: summary.status,
  }

  if (summary.status === "failed") {
    yield* Effect.logError(logPayload, "source-sync-worker:job-failed")
  } else if (summary.status === "credit_required") {
    yield* Effect.logWarning(logPayload, "source-sync-worker:job-credit-required")
  } else {
    yield* Effect.logInfo(logPayload, "source-sync-worker:job-succeeded")
  }

  return { payload, summary }
})

const acquireLiveWorker = (
  config: WorkerBullMqSourceSyncConsumerConfig,
  processor: WorkerBullMqSourceSyncProcessor
): Effect.Effect<BullMqSourceSyncWorker, WorkerBullMqSourceSyncConsumerError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(config.redisUrl.toString(), { maxRetriesPerRequest: null }),
      catch: (cause) =>
        new WorkerBullMqSourceSyncConsumerError({
          operation: "workerBullMqSourceSyncConsumer.acquireConnection",
          cause,
        }),
    })

    const worker = yield* Effect.try({
      try: () => {
        const bullMqProcessor: Processor<
          unknown,
          SourceSyncJobSummary,
          typeof SOURCE_SYNC_JOB_NAME
        > = (job: Job<unknown, SourceSyncJobSummary, typeof SOURCE_SYNC_JOB_NAME>, token) =>
          processor(job, token)

        return new Worker<unknown, SourceSyncJobSummary, typeof SOURCE_SYNC_JOB_NAME>(
          SOURCE_SYNC_QUEUE_NAME,
          bullMqProcessor,
          {
            connection,
            concurrency: config.concurrency,
            lockDuration: config.lockDurationMs,
            name: config.workerId,
            prefix: config.queuePrefix,
          }
        )
      },
      catch: (cause) =>
        new WorkerBullMqSourceSyncConsumerError({
          operation: "workerBullMqSourceSyncConsumer.acquireWorker",
          cause,
        }),
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      close: Effect.tryPromise({
        try: () => worker.close().finally(() => connection.disconnect()),
        catch: (cause) =>
          new WorkerBullMqSourceSyncConsumerError({
            operation: "workerBullMqSourceSyncConsumer.close",
            cause,
          }),
      }),
    } satisfies BullMqSourceSyncWorker
  })

/**
 * Construct a BullMQ-backed source sync worker consumer layer.
 */
export const makeWorkerBullMqSourceSyncConsumerLive = (
  options: WorkerBullMqSourceSyncConsumerOptions = {}
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* loadConfig
      const startupRepair = yield* WorkerSourceSyncStartupRepair
      const context = yield* Effect.context<SourceSyncJobExecutor>()
      const runPromise = Effect.runPromiseWith(context)
      const acquireWorker = options.acquireWorker ?? acquireLiveWorker
      const processor: WorkerBullMqSourceSyncProcessor = (job, token) =>
        runPromise(processJob({ job, config }).pipe(Effect.result)).then((result) => {
          if (Result.isSuccess(result)) {
            if (result.success.summary.status === "queued") {
              if (job.moveToDelayed === undefined) {
                return Promise.reject(
                  new WorkerBullMqSourceSyncConsumerError({
                    operation: "workerBullMqSourceSyncConsumer.delayJob",
                    cause: "Source sync queue job cannot be delayed",
                  })
                )
              }
              const moveToDelayed = job.moveToDelayed

              return runPromise(
                DateTime.now.pipe(
                  Effect.map(DateTime.add({ milliseconds: resolveBackoffDelayMs(job) })),
                  Effect.map(DateTime.toDateUtc),
                  Effect.map((date) => date.getTime())
                )
              ).then((delayedUntil) =>
                moveToDelayed(delayedUntil, token).then(() => {
                  throw new DelayedError()
                })
              )
            }

            return runPromise(
              startupRepair
                .dispatchFollowUp({
                  jobId: result.success.payload.jobId,
                  sourceId: result.success.payload.sourceId,
                  principalId: result.success.payload.principalId,
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      { operation: error.operation, cause: error.cause },
                      "source-sync-worker:follow-up-dispatch-failed"
                    )
                  )
                )
            ).then(() => result.success.summary)
          }

          const error = result.failure

          if (error._tag === "WorkerBullMqMalformedSourceSyncPayloadError") {
            return runPromise(
              Effect.logError(
                {
                  queueName: SOURCE_SYNC_QUEUE_NAME,
                  queueJobId: error.queueJobId,
                  workerId: config.workerId,
                  cause: error.cause,
                },
                "source-sync-worker:malformed-payload"
              )
            ).then(() => {
              throw new UnrecoverableError("Malformed source sync queue payload")
            })
          }

          if (!isRetryableWorkerError(error)) {
            return runPromise(
              Effect.logError(
                {
                  queueName: SOURCE_SYNC_QUEUE_NAME,
                  queueJobId: job.id ?? null,
                  workerId: config.workerId,
                  error,
                },
                "source-sync-worker:job-unrecoverable"
              )
            ).then(() => {
              throw new UnrecoverableError(errorMessage(error))
            })
          }

          return runPromise(
            Effect.logWarning(
              {
                queueName: SOURCE_SYNC_QUEUE_NAME,
                queueJobId: job.id ?? null,
                workerId: config.workerId,
                error,
              },
              "source-sync-worker:job-retry-scheduled"
            )
          ).then(() => {
            throw toJobFailure(error)
          })
        })

      const worker = yield* Effect.acquireRelease(
        startupRepair.repair.pipe(Effect.andThen(acquireWorker(config, processor))),
        (workerToClose) =>
          workerToClose.close.pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                { operation: error.operation, cause: error.cause },
                "source-sync-worker:worker-close-failed"
              )
            )
          )
      )

      const dispatchPending = startupRepair.dispatchPending.pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            { operation: error.operation, cause: error.cause },
            "source-sync-worker:pending-dispatch-failed"
          )
        ),
        Effect.asVoid
      )

      yield* dispatchPending.pipe(
        Effect.repeat(Schedule.spaced(config.pendingDispatchIntervalMs)),
        Effect.forkScoped
      )

      yield* Effect.logInfo(
        {
          queueName: SOURCE_SYNC_QUEUE_NAME,
          workerId: config.workerId,
          concurrency: config.concurrency,
          lockDurationMs: config.lockDurationMs,
          pendingDispatchIntervalMs: config.pendingDispatchIntervalMs,
          queuePrefix: config.queuePrefix,
        },
        "source-sync-worker:started"
      )

      return worker
    })
  )

/**
 * WorkerBullMqSourceSyncConsumerLive - Live BullMQ source sync consumer.
 */
export const WorkerBullMqSourceSyncConsumerLive = makeWorkerBullMqSourceSyncConsumerLive()
