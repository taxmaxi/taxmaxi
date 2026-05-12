/**
 * WorkerBullMqSourceSyncConsumerLive - BullMQ consumer for source sync jobs.
 *
 * @module WorkerBullMqSourceSyncConsumerLive
 */

import { Config, Effect, Layer, Runtime, Schema } from "effect"
import { UnrecoverableError, Worker, type Job, type JobsOptions, type Processor } from "bullmq"
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
import { WorkerSourceSyncStartupRepair } from "./WorkerSourceSyncStartupRepairLive.ts"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_SYNC_WORKER_CONCURRENCY = 1
const DEFAULT_SYNC_WORKER_LOCK_DURATION_MS = 30_000
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
}

/**
 * WorkerBullMqSourceSyncProcessor - Job processor installed into BullMQ.
 */
export type WorkerBullMqSourceSyncProcessor = (
  job: WorkerBullMqSourceSyncJob
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

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("SOURCE_SYNC_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
    concurrency: yield* positiveConfig({
      name: "SYNC_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_SYNC_WORKER_CONCURRENCY,
    }),
    lockDurationMs: yield* positiveConfig({
      name: "SYNC_WORKER_LOCK_DURATION_MS",
      defaultValue: DEFAULT_SYNC_WORKER_LOCK_DURATION_MS,
    }),
    workerId: yield* Config.string("WORKER_ID").pipe(
      Config.withDefault(PROCESS_WORKER_ID),
      Config.validate({
        message: "WORKER_ID must not be empty",
        validation: (value) => value.trim().length > 0,
      })
    ),
  } satisfies WorkerBullMqSourceSyncConsumerConfig
})

const currentDate = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(currentTimeMillis)
)

const decodePayload = Schema.decodeUnknown(SourceSyncQueuePayload)

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
  message: Schema.NonEmptyTrimmedString,
})

const decodeUnknownErrorMessage = Schema.decodeUnknownEither(UnknownErrorMessageSchema)

const errorMessage = (error: unknown): string => {
  const decoded = decodeUnknownErrorMessage(error)

  if (decoded._tag === "Right") {
    return decoded.right.message
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

const processJob = ({
  job,
  config,
}: {
  readonly job: WorkerBullMqSourceSyncJob
  readonly config: WorkerBullMqSourceSyncConsumerConfig
}) =>
  Effect.gen(function* () {
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
    const now = yield* currentDate
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = resolveMaxAttempts(job)
    const nextRetryAt = new Date(now.getTime() + resolveBackoffDelayMs(job))

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
    } else {
      yield* Effect.logInfo(logPayload, "source-sync-worker:job-succeeded")
    }

    return summary
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
        > = (job: Job<unknown, SourceSyncJobSummary, typeof SOURCE_SYNC_JOB_NAME>) => processor(job)

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
        try: async () => {
          try {
            await worker.close()
          } finally {
            connection.disconnect()
          }
        },
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
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const config = yield* loadConfig
      const startupRepair = yield* WorkerSourceSyncStartupRepair
      const runtime = yield* Effect.runtime<SourceSyncJobExecutor>()
      const runPromise = Runtime.runPromise(runtime)
      const acquireWorker = options.acquireWorker ?? acquireLiveWorker
      const processor: WorkerBullMqSourceSyncProcessor = async (job) => {
        const result = await runPromise(processJob({ job, config }).pipe(Effect.either))

        if (result._tag === "Right") {
          return result.right
        }

        const error = result.left

        if (error._tag === "WorkerBullMqMalformedSourceSyncPayloadError") {
          await runPromise(
            Effect.logError(
              {
                queueName: SOURCE_SYNC_QUEUE_NAME,
                queueJobId: error.queueJobId,
                workerId: config.workerId,
                cause: error.cause,
              },
              "source-sync-worker:malformed-payload"
            )
          )
          throw new UnrecoverableError("Malformed source sync queue payload")
        }

        if (!isRetryableWorkerError(error)) {
          await runPromise(
            Effect.logError(
              {
                queueName: SOURCE_SYNC_QUEUE_NAME,
                queueJobId: job.id ?? null,
                workerId: config.workerId,
                error,
              },
              "source-sync-worker:job-unrecoverable"
            )
          )
          throw new UnrecoverableError(errorMessage(error))
        }

        await runPromise(
          Effect.logWarning(
            {
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId: job.id ?? null,
              workerId: config.workerId,
              error,
            },
            "source-sync-worker:job-retry-scheduled"
          )
        )
        throw toJobFailure(error)
      }
      const worker = yield* Effect.acquireRelease(
        startupRepair.repair.pipe(Effect.zipRight(acquireWorker(config, processor))),
        (workerToClose) =>
          workerToClose.close.pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                { operation: error.operation, cause: error.cause },
                "source-sync-worker:worker-close-failed"
              )
            )
          )
      )

      yield* Effect.logInfo(
        {
          queueName: SOURCE_SYNC_QUEUE_NAME,
          workerId: config.workerId,
          concurrency: config.concurrency,
          lockDurationMs: config.lockDurationMs,
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
