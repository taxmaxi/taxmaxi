/**
 * ApiBullMqCalculationRecomputeQueueLive - BullMQ producer for calculation jobs.
 *
 * @module ApiBullMqCalculationRecomputeQueueLive
 */

import { Queue } from "bullmq"
import { Config, Effect, Layer, Schema } from "effect"
import { Redis } from "ioredis"
import {
  CALCULATION_RECOMPUTE_JOB_NAME,
  CALCULATION_RECOMPUTE_QUEUE_NAME,
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  CalculationRecomputeQueuePayload,
} from "@my/sync-engine/services"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 1_000
const DEFAULT_REMOVE_ON_FAIL_COUNT = 5_000

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("CALCULATION_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
  }
})

const decodePayload = Schema.decodeUnknownEffect(CalculationRecomputeQueuePayload)

/** BullMQ calculation producer used by principal-claim HTTP handlers. */
export const ApiBullMqCalculationRecomputeQueueLive = Layer.effect(
  CalculationRecomputeQueue,
  Effect.gen(function* () {
    const config = yield* loadConfig
    const connection = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Redis(config.redisUrl.toString()),
        catch: (cause) =>
          new CalculationRecomputeQueueError({
            operation: "apiCalculationRecomputeQueue.acquireConnection",
            cause,
          }),
      }),
      (redis) => Effect.sync(() => redis.disconnect())
    )
    const queue = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new Queue(CALCULATION_RECOMPUTE_QUEUE_NAME, {
            connection,
            prefix: config.queuePrefix,
          }),
        catch: (cause) =>
          new CalculationRecomputeQueueError({
            operation: "apiCalculationRecomputeQueue.acquireQueue",
            cause,
          }),
      }),
      (queueToClose) =>
        Effect.tryPromise({
          try: () => queueToClose.close(),
          catch: (cause) =>
            new CalculationRecomputeQueueError({
              operation: "apiCalculationRecomputeQueue.close",
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.logError(
              { operation: error.operation, cause: error.cause },
              "calculation-queue:close-failed"
            )
          )
        )
    )

    return CalculationRecomputeQueue.of({
      enqueuePrincipalRecompute: (principalId) =>
        Effect.gen(function* () {
          const payload = yield* decodePayload({ principalId }).pipe(
            Effect.mapError(
              (cause) =>
                new CalculationRecomputeQueueError({
                  operation: "apiCalculationRecomputeQueue.decode",
                  cause,
                })
            )
          )

          yield* Effect.tryPromise({
            try: () =>
              queue.add(CALCULATION_RECOMPUTE_JOB_NAME, payload, {
                attempts: 1,
                deduplication: { id: principalId, keepLastIfActive: true },
                removeOnComplete: { count: DEFAULT_REMOVE_ON_COMPLETE_COUNT },
                removeOnFail: { count: DEFAULT_REMOVE_ON_FAIL_COUNT },
              }),
            catch: (cause) =>
              new CalculationRecomputeQueueError({
                operation: "apiCalculationRecomputeQueue.enqueue",
                cause,
              }),
          })

          yield* Effect.logInfo(
            { queueName: CALCULATION_RECOMPUTE_QUEUE_NAME, principalId },
            "calculation-queue:enqueued"
          )
        }).pipe(Effect.asVoid),
    })
  })
)
