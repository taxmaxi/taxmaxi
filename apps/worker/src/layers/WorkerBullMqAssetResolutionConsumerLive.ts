/**
 * WorkerBullMqAssetResolutionConsumerLive - BullMQ consumer for asset resolution jobs.
 *
 * The database row in `asset_resolution_jobs` is the source of truth: the
 * executor claims, releases, and finishes jobs there, and retry timing lives
 * in `next_retry_at`. This layer only moves job ids: a poller enqueues every
 * dispatchable job on an interval, and the consumer hands each one to the
 * executor. Duplicate dispatches are safe because a claim on an already
 * claimed job is a no-op.
 *
 * @module WorkerBullMqAssetResolutionConsumerLive
 */

import { Config, DateTime, Effect, Layer, Result, Schedule, Schema } from "effect"
import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
} from "bullmq"
import { Redis } from "ioredis"
import { randomUUID } from "node:crypto"
import {
  ASSET_RESOLUTION_JOB_NAME,
  ASSET_RESOLUTION_QUEUE_NAME,
  AssetResolutionJobExecutor,
  AssetResolutionJobRepository,
  AssetResolutionQueuePayload,
  type AssetResolutionJobExecutionResult,
} from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_RESOLUTION_WORKER_CONCURRENCY = 1
const DEFAULT_RESOLUTION_WORKER_LOCK_DURATION_MS = 30_000
const DEFAULT_PENDING_DISPATCH_INTERVAL_MS = 5_000
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const DEFAULT_DISPATCH_BATCH_SIZE = 100
const PROCESS_WORKER_ID = `worker-${randomUUID()}`

/**
 * WorkerBullMqAssetResolutionConsumerConfig - Runtime configuration for the consumer.
 */
export interface WorkerBullMqAssetResolutionConsumerConfig {
  readonly redisUrl: URL
  readonly queuePrefix: string
  readonly concurrency: number
  readonly lockDurationMs: number
  readonly pendingDispatchIntervalMs: number
  readonly staleAfterMs: number
  readonly dispatchBatchSize: number
  readonly workerId: string
}

/**
 * WorkerBullMqAssetResolutionJob - Minimal BullMQ job surface consumed by the processor.
 */
export interface WorkerBullMqAssetResolutionJob {
  readonly id?: string
  readonly name: string
  readonly data: unknown
}

/**
 * WorkerBullMqAssetResolutionProcessor - Job processor installed into BullMQ.
 */
export type WorkerBullMqAssetResolutionProcessor = (
  job: WorkerBullMqAssetResolutionJob
) => Promise<AssetResolutionJobExecutionResult>

/**
 * BullMqAssetResolutionWorker - Small test seam over BullMQ's worker lifecycle.
 */
export interface BullMqAssetResolutionWorker {
  readonly close: Effect.Effect<void, WorkerBullMqAssetResolutionConsumerError>
}

/**
 * BullMqAssetResolutionQueue - Small test seam over the poller's queue producer.
 */
export interface BullMqAssetResolutionQueue {
  readonly add: (
    name: typeof ASSET_RESOLUTION_JOB_NAME,
    payload: AssetResolutionQueuePayload,
    options: JobsOptions
  ) => Promise<{ readonly id?: string }>
  readonly close: Effect.Effect<void, WorkerBullMqAssetResolutionConsumerError>
}

/**
 * WorkerBullMqAssetResolutionConsumerOptions - Optional dependency injection hooks for tests.
 */
export interface WorkerBullMqAssetResolutionConsumerOptions {
  readonly acquireWorker?: (
    config: WorkerBullMqAssetResolutionConsumerConfig,
    processor: WorkerBullMqAssetResolutionProcessor
  ) => Effect.Effect<BullMqAssetResolutionWorker, WorkerBullMqAssetResolutionConsumerError>
  readonly acquireQueue?: (
    config: WorkerBullMqAssetResolutionConsumerConfig
  ) => Effect.Effect<BullMqAssetResolutionQueue, WorkerBullMqAssetResolutionConsumerError>
}

/**
 * WorkerBullMqAssetResolutionConsumerError - Consumer lifecycle failure.
 */
export class WorkerBullMqAssetResolutionConsumerError extends Schema.TaggedError<WorkerBullMqAssetResolutionConsumerError>()(
  "WorkerBullMqAssetResolutionConsumerError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

class WorkerBullMqMalformedAssetResolutionPayloadError extends Schema.TaggedError<WorkerBullMqMalformedAssetResolutionPayloadError>()(
  "WorkerBullMqMalformedAssetResolutionPayloadError",
  {
    queueJobId: Schema.NullOr(Schema.String),
    cause: Schema.Unknown,
  }
) {}

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("ASSET_RESOLUTION_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
    concurrency: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_RESOLUTION_WORKER_CONCURRENCY,
    }),
    lockDurationMs: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_WORKER_LOCK_DURATION_MS",
      defaultValue: DEFAULT_RESOLUTION_WORKER_LOCK_DURATION_MS,
    }),
    pendingDispatchIntervalMs: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_PENDING_DISPATCH_INTERVAL_MS",
      defaultValue: DEFAULT_PENDING_DISPATCH_INTERVAL_MS,
    }),
    staleAfterMs: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_STALE_AFTER_MS",
      defaultValue: DEFAULT_STALE_AFTER_MS,
    }),
    dispatchBatchSize: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_DISPATCH_BATCH_SIZE",
      defaultValue: DEFAULT_DISPATCH_BATCH_SIZE,
    }),
    workerId: yield* Config.schema(
      Schema.Trimmed.check(Schema.isNonEmpty({ message: "WORKER_ID must not be empty" })),
      "WORKER_ID"
    ).pipe(Config.withDefault(PROCESS_WORKER_ID)),
  } satisfies WorkerBullMqAssetResolutionConsumerConfig
})

const decodePayload = Schema.decodeUnknownEffect(AssetResolutionQueuePayload)

const processJob = Effect.fn("worker.asset-resolution.process", {
  attributes: {
    queueName: ASSET_RESOLUTION_QUEUE_NAME,
  },
  kind: "consumer",
})(function* ({
  job,
  config,
}: {
  readonly job: WorkerBullMqAssetResolutionJob
  readonly config: WorkerBullMqAssetResolutionConsumerConfig
}) {
  const executor = yield* AssetResolutionJobExecutor
  const payload = yield* decodePayload(job.data).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerBullMqMalformedAssetResolutionPayloadError({
          queueJobId: job.id ?? null,
          cause,
        })
    )
  )

  yield* Effect.logInfo(
    {
      queueName: ASSET_RESOLUTION_QUEUE_NAME,
      queueJobId: job.id ?? null,
      workerId: config.workerId,
      jobId: payload.jobId,
    },
    "asset-resolution-worker:job-started"
  )

  const result = yield* executor.executeJob({
    jobId: payload.jobId,
    workerId: config.workerId,
  })

  yield* Effect.logInfo(
    {
      queueName: ASSET_RESOLUTION_QUEUE_NAME,
      queueJobId: job.id ?? null,
      workerId: config.workerId,
      jobId: payload.jobId,
      outcome: result.outcome,
      providerAssetRowId: result.providerAssetRowId,
      evidenceRevision: result.evidenceRevision,
    },
    "asset-resolution-worker:job-finished"
  )

  return result
})

const acquireLiveWorker = (
  config: WorkerBullMqAssetResolutionConsumerConfig,
  processor: WorkerBullMqAssetResolutionProcessor
): Effect.Effect<BullMqAssetResolutionWorker, WorkerBullMqAssetResolutionConsumerError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(config.redisUrl.toString(), { maxRetriesPerRequest: null }),
      catch: (cause) =>
        new WorkerBullMqAssetResolutionConsumerError({
          operation: "workerBullMqAssetResolutionConsumer.acquireConnection",
          cause,
        }),
    })

    const worker = yield* Effect.try({
      try: () => {
        const bullMqProcessor: Processor<
          unknown,
          AssetResolutionJobExecutionResult,
          typeof ASSET_RESOLUTION_JOB_NAME
        > = (
          job: Job<unknown, AssetResolutionJobExecutionResult, typeof ASSET_RESOLUTION_JOB_NAME>
        ) => processor(job)

        return new Worker<
          unknown,
          AssetResolutionJobExecutionResult,
          typeof ASSET_RESOLUTION_JOB_NAME
        >(ASSET_RESOLUTION_QUEUE_NAME, bullMqProcessor, {
          connection,
          concurrency: config.concurrency,
          lockDuration: config.lockDurationMs,
          name: config.workerId,
          prefix: config.queuePrefix,
        })
      },
      catch: (cause) =>
        new WorkerBullMqAssetResolutionConsumerError({
          operation: "workerBullMqAssetResolutionConsumer.acquireWorker",
          cause,
        }),
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      close: Effect.tryPromise({
        try: () => worker.close().finally(() => connection.disconnect()),
        catch: (cause) =>
          new WorkerBullMqAssetResolutionConsumerError({
            operation: "workerBullMqAssetResolutionConsumer.close",
            cause,
          }),
      }),
    } satisfies BullMqAssetResolutionWorker
  })

const acquireLiveQueue = (
  config: WorkerBullMqAssetResolutionConsumerConfig
): Effect.Effect<BullMqAssetResolutionQueue, WorkerBullMqAssetResolutionConsumerError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(config.redisUrl.toString(), { maxRetriesPerRequest: null }),
      catch: (cause) =>
        new WorkerBullMqAssetResolutionConsumerError({
          operation: "workerBullMqAssetResolutionConsumer.acquireQueueConnection",
          cause,
        }),
    })

    const queue = yield* Effect.try({
      try: () =>
        new Queue(ASSET_RESOLUTION_QUEUE_NAME, {
          connection,
          prefix: config.queuePrefix,
        }),
      catch: (cause) =>
        new WorkerBullMqAssetResolutionConsumerError({
          operation: "workerBullMqAssetResolutionConsumer.acquireQueue",
          cause,
        }),
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      add: (name, payload, options) => queue.add(name, payload, options),
      close: Effect.tryPromise({
        try: () => queue.close().finally(() => connection.disconnect()),
        catch: (cause) =>
          new WorkerBullMqAssetResolutionConsumerError({
            operation: "workerBullMqAssetResolutionConsumer.closeQueue",
            cause,
          }),
      }),
    } satisfies BullMqAssetResolutionQueue
  })

/**
 * Construct a BullMQ-backed asset resolution consumer layer.
 */
export const makeWorkerBullMqAssetResolutionConsumerLive = (
  options: WorkerBullMqAssetResolutionConsumerOptions = {}
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* loadConfig
      const assetResolutionJobRepository = yield* AssetResolutionJobRepository
      const context = yield* Effect.context<AssetResolutionJobExecutor>()
      const runPromise = Effect.runPromiseWith(context)
      const acquireWorker = options.acquireWorker ?? acquireLiveWorker
      const acquireQueue = options.acquireQueue ?? acquireLiveQueue

      const processor: WorkerBullMqAssetResolutionProcessor = (job) =>
        runPromise(processJob({ job, config }).pipe(Effect.result)).then((result) => {
          if (Result.isSuccess(result)) {
            return result.success
          }

          const error = result.failure

          if (error._tag === "WorkerBullMqMalformedAssetResolutionPayloadError") {
            return runPromise(
              Effect.logError(
                {
                  queueName: ASSET_RESOLUTION_QUEUE_NAME,
                  queueJobId: error.queueJobId,
                  workerId: config.workerId,
                  cause: error.cause,
                },
                "asset-resolution-worker:malformed-payload"
              )
            ).then(() => {
              throw new UnrecoverableError("Malformed asset resolution queue payload")
            })
          }

          // The executor already released the job with a retry delay or failed
          // it at the attempt cap, so the database owns the retry. Surface the
          // failure to BullMQ for observability without scheduling a queue retry.
          return runPromise(
            Effect.logError(
              {
                queueName: ASSET_RESOLUTION_QUEUE_NAME,
                queueJobId: job.id ?? null,
                workerId: config.workerId,
                error,
              },
              "asset-resolution-worker:job-failed"
            )
          ).then(() => {
            throw new UnrecoverableError(`Asset resolution job execution failed: ${error._tag}`)
          })
        })

      const worker = yield* Effect.acquireRelease(acquireWorker(config, processor), (toClose) =>
        toClose.close.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "asset-resolution-worker:worker-close-failed"
            )
          )
        )
      )

      const queue = yield* Effect.acquireRelease(acquireQueue(config), (toClose) =>
        toClose.close.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "asset-resolution-worker:queue-close-failed"
            )
          )
        )
      )

      const dispatchPending = Effect.gen(function* () {
        const nowDateTime = yield* DateTime.now
        const now = DateTime.toDateUtc(nowDateTime)
        const staleBefore = DateTime.toDateUtc(
          DateTime.subtractDuration(nowDateTime, config.staleAfterMs)
        )
        const jobs = yield* assetResolutionJobRepository.listDispatchableResolutionJobs({
          now,
          staleBefore,
          limit: config.dispatchBatchSize,
        })

        yield* Effect.forEach(
          jobs,
          (job) =>
            Effect.tryPromise({
              try: () =>
                queue.add(
                  ASSET_RESOLUTION_JOB_NAME,
                  AssetResolutionQueuePayload.make({ jobId: job.jobId }),
                  {
                    // The DB job id doubles as the BullMQ job id so concurrent
                    // poller ticks and multiple workers enqueue one delivery.
                    jobId: job.jobId,
                    attempts: 1,
                    removeOnComplete: true,
                    removeOnFail: true,
                  }
                ),
              catch: (cause) =>
                new WorkerBullMqAssetResolutionConsumerError({
                  operation: "workerBullMqAssetResolutionConsumer.enqueue",
                  cause,
                }),
            }),
          { discard: true }
        )
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            {
              queueName: ASSET_RESOLUTION_QUEUE_NAME,
              workerId: config.workerId,
              error,
            },
            "asset-resolution-worker:pending-dispatch-failed"
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
          queueName: ASSET_RESOLUTION_QUEUE_NAME,
          workerId: config.workerId,
          concurrency: config.concurrency,
          lockDurationMs: config.lockDurationMs,
          pendingDispatchIntervalMs: config.pendingDispatchIntervalMs,
          staleAfterMs: config.staleAfterMs,
          dispatchBatchSize: config.dispatchBatchSize,
          queuePrefix: config.queuePrefix,
        },
        "asset-resolution-worker:started"
      )

      return worker
    })
  )

/**
 * WorkerBullMqAssetResolutionConsumerLive - Live BullMQ asset resolution consumer.
 */
export const WorkerBullMqAssetResolutionConsumerLive = makeWorkerBullMqAssetResolutionConsumerLive()
