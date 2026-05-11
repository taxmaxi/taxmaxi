/**
 * ApiBullMqSourceSyncQueueLive - BullMQ producer for source sync jobs.
 *
 * @module ApiBullMqSourceSyncQueueLive
 */

import { Queue, type JobsOptions } from "bullmq"
import { Config, Effect, Layer } from "effect"
import { Redis } from "ioredis"
import {
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  type SourceSyncQueuePayload,
  type SourceSyncQueueShape,
} from "@my/sync-engine/services"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_QUEUE_ATTEMPTS = 3
const DEFAULT_BACKOFF_DELAY_MS = 5_000
const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 1_000
const DEFAULT_REMOVE_ON_FAIL_COUNT = 5_000

/**
 * ApiBullMqSourceSyncQueueConfig - Runtime configuration for the API queue producer.
 */
export interface ApiBullMqSourceSyncQueueConfig {
  readonly redisUrl: URL
  readonly queuePrefix: string
  readonly attempts: number
  readonly backoffDelayMs: number
  readonly removeOnCompleteCount: number
  readonly removeOnFailCount: number
}

/**
 * BullMqSourceSyncJob - Minimal BullMQ job surface needed after enqueue.
 */
export interface BullMqSourceSyncJob {
  readonly id?: string
}

/**
 * BullMqSourceSyncQueue - Small test seam over BullMQ's producer API.
 *
 * `add` mirrors BullMQ's promise-returning API while `close` is an Effect so
 * the scoped layer can use the same finalizer shape in tests and production.
 */
export interface BullMqSourceSyncQueue {
  readonly add: (
    name: typeof SOURCE_SYNC_JOB_NAME,
    payload: SourceSyncQueuePayload,
    options: JobsOptions
  ) => Promise<BullMqSourceSyncJob>
  readonly close: Effect.Effect<void, SourceSyncQueueError>
}

/**
 * ApiBullMqSourceSyncQueueOptions - Optional dependency injection hooks for tests.
 */
export interface ApiBullMqSourceSyncQueueOptions {
  readonly acquireQueue?: (
    config: ApiBullMqSourceSyncQueueConfig
  ) => Effect.Effect<BullMqSourceSyncQueue, SourceSyncQueueError>
}

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
  } satisfies ApiBullMqSourceSyncQueueConfig
})

/**
 * Acquire a BullMQ producer queue for source sync jobs.
 *
 * ioredis connects in the background and queues commands until ready, so DNS
 * and connectivity failures surface from `queue.add` as `SourceSyncQueueError`.
 * Producer connections intentionally keep ioredis' bounded
 * `maxRetriesPerRequest` default; worker blocking connections can opt into
 * BullMQ's worker-specific `null` setting in PR-04.
 */
const acquireLiveQueue = ({
  redisUrl,
  queuePrefix,
}: ApiBullMqSourceSyncQueueConfig): Effect.Effect<BullMqSourceSyncQueue, SourceSyncQueueError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(redisUrl.toString()),
      catch: (cause) =>
        new SourceSyncQueueError({
          operation: "apiBullMqSourceSyncQueue.acquire",
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
        new SourceSyncQueueError({
          operation: "apiBullMqSourceSyncQueue.acquire",
          cause,
        }),
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
          new SourceSyncQueueError({
            operation: "apiBullMqSourceSyncQueue.close",
            cause,
          }),
      }),
    } satisfies BullMqSourceSyncQueue
  })

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

const currentDate = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(currentTimeMillis)
)

/**
 * Construct a BullMQ-backed source sync queue producer layer.
 */
export const makeApiBullMqSourceSyncQueueLive = (options: ApiBullMqSourceSyncQueueOptions = {}) =>
  Layer.scoped(
    SourceSyncQueue,
    Effect.gen(function* () {
      const sourceSyncJobRepository = yield* SourceSyncJobRepository
      const config = yield* loadConfig
      const acquireQueue = options.acquireQueue ?? acquireLiveQueue
      const queue = yield* Effect.acquireRelease(acquireQueue(config), (queueToClose) =>
        queueToClose.close.pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "source-sync:queue-close-failed"
            )
          )
        )
      )

      const enqueueSourceSyncJob: SourceSyncQueueShape["enqueueSourceSyncJob"] = (payload) =>
        Effect.gen(function* () {
          // Deterministic job ids make concurrent enqueue attempts idempotent at BullMQ.
          const job = yield* Effect.tryPromise({
            try: () =>
              queue.add(
                SOURCE_SYNC_JOB_NAME,
                payload,
                makeJobOptions({
                  jobId: payload.jobId,
                  attempts: config.attempts,
                  backoffDelayMs: config.backoffDelayMs,
                  removeOnCompleteCount: config.removeOnCompleteCount,
                  removeOnFailCount: config.removeOnFailCount,
                })
              ),
            catch: (cause) =>
              new SourceSyncQueueError({
                operation: "apiBullMqSourceSyncQueue.enqueue",
                cause,
              }),
          })

          const queueJobId = String(job.id ?? payload.jobId)
          const queuedAt = yield* currentDate

          // If metadata attach fails after BullMQ accepts the job, the durable
          // queue item remains keyed by the DB job id. A later API retry will
          // hit BullMQ's duplicate-job success path and try this metadata write
          // again, while the worker can still load execution state by job id.
          yield* sourceSyncJobRepository
            .attachQueueMetadata({
              jobId: payload.jobId,
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId,
              queuedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SourceSyncQueueError({
                    operation: "apiBullMqSourceSyncQueue.attachQueueMetadata",
                    cause,
                  })
              ),
              Effect.tapError((error) =>
                Effect.logWarning(
                  {
                    jobId: payload.jobId,
                    sourceId: payload.sourceId,
                    userId: payload.userId,
                    mode: payload.mode,
                    queueName: SOURCE_SYNC_QUEUE_NAME,
                    queueJobId,
                    operation: error.operation,
                    cause: error.cause,
                  },
                  "source-sync:queue-metadata-attach-failed"
                )
              )
            )

          yield* Effect.logInfo(
            {
              jobId: payload.jobId,
              sourceId: payload.sourceId,
              userId: payload.userId,
              mode: payload.mode,
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId,
            },
            "source-sync:enqueued"
          )
        })

      return SourceSyncQueue.of({
        enqueueSourceSyncJob,
      } satisfies SourceSyncQueueShape)
    })
  )

/**
 * ApiBullMqSourceSyncQueueLive - Live BullMQ source sync producer.
 */
export const ApiBullMqSourceSyncQueueLive = makeApiBullMqSourceSyncQueueLive()
