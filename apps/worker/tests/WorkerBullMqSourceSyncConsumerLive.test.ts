import * as DateTime from "effect/DateTime"
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect"
import { DelayedError, UnrecoverableError } from "bullmq"
import { describe, expect, it } from "@effect/vitest"
import {
  makeWorkerBullMqSourceSyncConsumerLive,
  type BullMqSourceSyncWorker,
  type WorkerBullMqSourceSyncConsumerConfig,
  type WorkerBullMqSourceSyncJob,
  type WorkerBullMqSourceSyncProcessor,
} from "../src/layers/WorkerBullMqSourceSyncConsumerLive.ts"
import {
  WorkerSourceSyncStartupRepair,
  type WorkerSourceSyncStartupRepairError,
  type WorkerSourceSyncStartupRepairSummary,
} from "../src/layers/WorkerSourceSyncStartupRepairLive.ts"
import {
  SOURCE_SYNC_JOB_NAME,
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  SourceSyncJobExecutionNotFoundError,
  SourceSyncJobExecutor,
  SourceSyncQueuePayload,
  type ExecuteSourceSyncJobParams,
  type SourceSyncJobExecutorShape,
  type SourceSyncJobSummary,
  SourceSyncJobRetryableExecutionError,
} from "@my/sync-engine/services"

class WorkerTestPromiseRejectionError extends Schema.TaggedError<WorkerTestPromiseRejectionError>()(
  "WorkerTestPromiseRejectionError",
  {
    cause: Schema.Unknown,
  }
) {}

const toPromiseRejectionError = (cause: unknown): WorkerTestPromiseRejectionError =>
  new WorkerTestPromiseRejectionError({ cause })

const syncPayload = SourceSyncQueuePayload.make({
  jobId: "job-1",
  sourceId: "source-1",
  principalId: "principal-1",
  mode: "sync",
})

const replayPayload = SourceSyncQueuePayload.make({
  jobId: "job-2",
  sourceId: "source-1",
  principalId: "principal-1",
  mode: "replay",
})

const summary = ({
  jobId,
  status,
}: {
  readonly jobId: string
  readonly status: "completed" | "credit_required" | "queued"
}) =>
  ({
    sourceId: "source-1",
    jobId,
    status,
    message: null,
    resumable: status === "credit_required",
    creditOutcome:
      status === "credit_required"
        ? {
            reasonCode: "no_usable_credits",
            availableCredits: 0,
            creditsConsumed: 3,
            additionalCreditsRequired: 2,
          }
        : null,
  }) satisfies SourceSyncJobSummary

const makeConfigProvider = (overrides: Record<string, string> = {}) =>
  ConfigProvider.fromEnvRecord({
    QUEUE_REDIS_URL: "redis://localhost:6379",
    SOURCE_SYNC_QUEUE_PREFIX: "test-prefix",
    SYNC_WORKER_CONCURRENCY: "3",
    WORKER_ID: "worker-test-1",
    ...overrides,
  })

const makeJob = ({
  data,
  attemptsMade = 0,
  attempts = 5,
}: {
  readonly data: unknown
  readonly attemptsMade?: number
  readonly attempts?: number
}): WorkerBullMqSourceSyncJob => ({
  id: "queue-job-1",
  name: SOURCE_SYNC_JOB_NAME,
  data,
  attemptsMade,
  opts: {
    attempts,
    backoff: {
      type: "exponential",
      delay: 2_500,
    },
  },
})

const runWithConsumer = <A>({
  effect,
  executor,
  acquireWorker,
  configOverrides,
  repair,
  dispatchFollowUp,
  dispatchPending,
  enqueuePrincipalRecompute,
}: {
  readonly effect: Effect.Effect<A>
  readonly executor: SourceSyncJobExecutorShape
  readonly acquireWorker: (
    config: WorkerBullMqSourceSyncConsumerConfig,
    processor: WorkerBullMqSourceSyncProcessor
  ) => Effect.Effect<BullMqSourceSyncWorker>
  readonly configOverrides?: Record<string, string>
  readonly repair?: Effect.Effect<
    WorkerSourceSyncStartupRepairSummary,
    WorkerSourceSyncStartupRepairError
  >
  readonly dispatchFollowUp?: (params: {
    readonly jobId: string
    readonly sourceId: string
    readonly principalId: string
  }) => Effect.Effect<void, WorkerSourceSyncStartupRepairError>
  readonly dispatchPending?: Effect.Effect<
    WorkerSourceSyncStartupRepairSummary,
    WorkerSourceSyncStartupRepairError
  >
  readonly enqueuePrincipalRecompute?: (
    principalId: string
  ) => Effect.Effect<void, CalculationRecomputeQueueError>
}) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          makeWorkerBullMqSourceSyncConsumerLive({ acquireWorker }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(SourceSyncJobExecutor, executor),
                Layer.succeed(WorkerSourceSyncStartupRepair, {
                  repair:
                    repair ??
                    Effect.succeed({
                      scannedJobs: 0,
                      requeuedPending: 0,
                      failedProcessing: 0,
                      skippedJobs: 0,
                      erroredJobs: 0,
                      stoppedAfterErrors: false,
                    }),
                  dispatchFollowUp: dispatchFollowUp ?? (() => Effect.void),
                  dispatchPending:
                    dispatchPending ??
                    Effect.succeed({
                      scannedJobs: 0,
                      requeuedPending: 0,
                      failedProcessing: 0,
                      skippedJobs: 0,
                      erroredJobs: 0,
                      stoppedAfterErrors: false,
                    }),
                }),
                Layer.succeed(CalculationRecomputeQueue, {
                  enqueuePrincipalRecompute: enqueuePrincipalRecompute ?? (() => Effect.void),
                })
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider(configOverrides))
      )
    )
  )

describe("WorkerBullMqSourceSyncConsumerLive", () => {
  it.effect("keeps dispatching pending database jobs while the worker is running", () =>
    Effect.gen(function* () {
      let dispatchCount = 0

      yield* Effect.promise(() =>
        runWithConsumer({
          executor: {
            execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
          },
          dispatchPending: Effect.sync(() => {
            dispatchCount += 1
            return {
              scannedJobs: 0,
              requeuedPending: 0,
              failedProcessing: 0,
              skippedJobs: 0,
              erroredJobs: 0,
              stoppedAfterErrors: false,
            }
          }),
          configOverrides: { SOURCE_SYNC_PENDING_DISPATCH_INTERVAL_MS: "1" },
          acquireWorker: () => Effect.succeed({ close: Effect.void }),
          effect: Effect.sleep("10 millis"),
        })
      )

      expect(dispatchCount).toBeGreaterThan(1)
    })
  )

  it.effect("decodes valid sync and replay payloads and passes the DB job id to the executor", () =>
    Effect.gen(function* () {
      const executed: Array<ExecuteSourceSyncJobParams> = []
      let processor: WorkerBullMqSourceSyncProcessor | null = null

      const executor: SourceSyncJobExecutorShape = {
        execute: (params) =>
          Effect.sync(() => {
            executed.push(params)
            return summary({ jobId: params.jobId, status: "completed" })
          }),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            yield* Effect.promise(() => acquiredProcessor(makeJob({ data: syncPayload })))
            yield* Effect.promise(() =>
              acquiredProcessor(makeJob({ data: replayPayload, attemptsMade: 1 }))
            )
          }),
        })
      )

      expect(executed).toHaveLength(2)
      const syncExecution = executed.at(0)
      const replayExecution = executed.at(1)

      if (syncExecution === undefined || replayExecution === undefined) {
        throw new Error("Expected sync and replay executions")
      }

      expect(syncExecution).toMatchObject({
        jobId: "job-1",
        workerId: "worker-test-1",
        retryPolicy: {
          attemptNumber: 1,
          maxAttempts: 5,
        },
      })
      expect(replayExecution).toMatchObject({
        jobId: "job-2",
        workerId: "worker-test-1",
        retryPolicy: {
          attemptNumber: 2,
          maxAttempts: 5,
        },
      })
      expect(syncExecution.retryPolicy?.nextRetryAt).toBeInstanceOf(Date)
    })
  )

  it.effect("enqueues a principal recompute after completed sync and replay jobs", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null
      const enqueuedPrincipalIds: Array<string> = []

      yield* Effect.promise(() =>
        runWithConsumer({
          executor: {
            execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
          },
          enqueuePrincipalRecompute: (principalId) =>
            Effect.sync(() => {
              enqueuedPrincipalIds.push(principalId)
            }),
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            yield* Effect.promise(() => acquiredProcessor(makeJob({ data: syncPayload })))
            yield* Effect.promise(() => acquiredProcessor(makeJob({ data: replayPayload })))
          }),
        })
      )

      expect(enqueuedPrincipalIds).toEqual(["principal-1", "principal-1"])
    })
  )

  it.effect("keeps a completed source outcome when calculation enqueue fails", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null

      yield* Effect.promise(() =>
        runWithConsumer({
          executor: {
            execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
          },
          enqueuePrincipalRecompute: () =>
            Effect.fail(
              new CalculationRecomputeQueueError({
                operation: "test.enqueue",
                cause: "redis unavailable",
              })
            ),
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            const result = yield* Effect.promise(() =>
              acquiredProcessor(makeJob({ data: syncPayload }))
            )

            expect(result.status).toBe("completed")
          }),
        })
      )
    })
  )

  it.effect("dispatches only the completed job's materialized follow-up work", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null
      let repairCount = 0
      const dispatched: Array<{ jobId: string; sourceId: string; principalId: string }> = []

      yield* Effect.promise(() =>
        runWithConsumer({
          executor: {
            execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
          },
          repair: Effect.sync(() => {
            repairCount += 1
            return {
              scannedJobs: 0,
              requeuedPending: 0,
              failedProcessing: 0,
              skippedJobs: 0,
              erroredJobs: 0,
              stoppedAfterErrors: false,
            }
          }),
          dispatchFollowUp: (params) =>
            Effect.sync(() => {
              dispatched.push(params)
            }),
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null)
              return yield* Effect.die(new Error("Processor was not acquired"))
            const acquiredProcessor = processor
            yield* Effect.promise(() => acquiredProcessor(makeJob({ data: syncPayload })))
          }),
        })
      )

      expect(repairCount).toBe(1)
      expect(dispatched).toEqual([
        { jobId: "job-1", sourceId: "source-1", principalId: "principal-1" },
      ])
    })
  )

  it.effect("fails malformed payloads terminally without calling the executor", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null
      let executeCount = 0

      const executor: SourceSyncJobExecutorShape = {
        execute: () =>
          Effect.sync(() => {
            executeCount += 1
            return summary({ jobId: "unused", status: "completed" })
          }),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(makeJob({ data: { jobId: "job-1" } })),
              catch: toPromiseRejectionError,
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(UnrecoverableError)
            }
          }),
        })
      )

      expect(executeCount).toBe(0)
    })
  )

  it.effect("propagates executor failures to BullMQ so retry policy remains transport-owned", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null
      const retryError = new SourceSyncJobRetryableExecutionError({
        jobId: "job-1",
        message: "provider unavailable",
        attemptNumber: 1,
        maxAttempts: 3,
        nextRetryAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")),
      })

      const executor: SourceSyncJobExecutorShape = {
        execute: () => Effect.fail(retryError),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(makeJob({ data: syncPayload })),
              catch: toPromiseRejectionError,
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(Error)
              expect(result.failure.cause).not.toBeInstanceOf(UnrecoverableError)
              if (result.failure.cause instanceof Error) {
                expect(result.failure.cause.message).toContain("provider unavailable")
              }
            }
          }),
        })
      )
    })
  )

  it.effect("moves a waiting database job to BullMQ delayed state without consuming it", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null
      const delayedCalls: Array<{ timestamp: number; token?: string }> = []

      yield* Effect.promise(() =>
        runWithConsumer({
          executor: {
            execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "queued" })),
          },
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null)
              return yield* Effect.die(new Error("Processor was not acquired"))
            const acquiredProcessor = processor
            const job = {
              ...makeJob({ data: replayPayload }),
              moveToDelayed: (timestamp: number, token?: string) => {
                delayedCalls.push({ timestamp, ...(token === undefined ? {} : { token }) })
                return Promise.resolve()
              },
            }
            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(job, "lock-token"),
              catch: toPromiseRejectionError,
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(DelayedError)
              expect(result.failure.cause).not.toBeInstanceOf(UnrecoverableError)
            }
          }),
        })
      )

      expect(delayedCalls).toHaveLength(1)
      expect(delayedCalls[0]).toMatchObject({ token: "lock-token" })
      expect(delayedCalls[0]?.timestamp).toBeGreaterThan(
        DateTime.toEpochMillis(yield* DateTime.now)
      )
    })
  )

  it.effect("marks unrecoverable executor state errors terminal for BullMQ", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null

      const executor: SourceSyncJobExecutorShape = {
        execute: ({ jobId }) => Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId })),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(makeJob({ data: syncPayload })),
              catch: toPromiseRejectionError,
            }).pipe(Effect.result)

            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.cause).toBeInstanceOf(UnrecoverableError)
            }
          }),
        })
      )
    })
  )

  it.effect("treats a credit-required job outcome as terminal for BullMQ, not a throw", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqSourceSyncProcessor | null = null

      const executor: SourceSyncJobExecutorShape = {
        execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "credit_required" })),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (_config, acquiredProcessor) =>
            Effect.sync(() => {
              processor = acquiredProcessor
              return { close: Effect.void }
            }),
          effect: Effect.gen(function* () {
            if (processor === null) {
              return yield* Effect.die(new Error("Processor was not acquired"))
            }
            const acquiredProcessor = processor

            const result = yield* Effect.tryPromise({
              try: () => acquiredProcessor(makeJob({ data: syncPayload })),
              catch: toPromiseRejectionError,
            }).pipe(Effect.result)

            expect(Result.isSuccess(result)).toBe(true)
            if (Result.isSuccess(result)) {
              expect(result.success.status).toBe("credit_required")
              expect(result.success.resumable).toBe(true)
            }
          }),
        })
      )
    })
  )

  it.effect("closes the BullMQ worker when the scope finalizes", () =>
    Effect.gen(function* () {
      let closeCount = 0

      const executor: SourceSyncJobExecutorShape = {
        execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: () =>
            Effect.succeed({
              close: Effect.sync(() => {
                closeCount += 1
              }),
            }),
          effect: Effect.void,
        })
      )

      expect(closeCount).toBe(1)
    })
  )

  it.effect("loads worker concurrency and queue prefix from Effect Config", () =>
    Effect.gen(function* () {
      let acquiredConfig: WorkerBullMqSourceSyncConsumerConfig | null = null

      const executor: SourceSyncJobExecutorShape = {
        execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
      }

      yield* Effect.promise(() =>
        runWithConsumer({
          executor,
          acquireWorker: (config) =>
            Effect.sync(() => {
              acquiredConfig = config
              return { close: Effect.void }
            }),
          configOverrides: {
            SOURCE_SYNC_QUEUE_PREFIX: "custom-prefix",
            SYNC_WORKER_CONCURRENCY: "7",
            WORKER_ID: "worker-custom",
          },
          effect: Effect.void,
        })
      )

      expect(acquiredConfig).toMatchObject({
        queuePrefix: "custom-prefix",
        concurrency: 7,
        workerId: "worker-custom",
      })
    })
  )
})
