import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { UnrecoverableError } from "bullmq"
import { describe, expect, it } from "vitest"
import {
  makeWorkerBullMqSourceSyncConsumerLive,
  type BullMqSourceSyncWorker,
  type WorkerBullMqSourceSyncConsumerConfig,
  type WorkerBullMqSourceSyncJob,
  type WorkerBullMqSourceSyncProcessor,
} from "../src/layers/WorkerBullMqSourceSyncConsumerLive.ts"
import { WorkerSourceSyncStartupRepair } from "../src/layers/WorkerSourceSyncStartupRepairLive.ts"
import {
  SOURCE_SYNC_JOB_NAME,
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

const summary = ({ jobId, status }: { readonly jobId: string; readonly status: "completed" }) =>
  ({
    sourceId: "source-1",
    jobId,
    status,
    message: null,
  }) satisfies SourceSyncJobSummary

const makeConfigProvider = (overrides: Record<string, string> = {}) =>
  ConfigProvider.fromMap(
    new Map(
      Object.entries({
        QUEUE_REDIS_URL: "redis://localhost:6379",
        SOURCE_SYNC_QUEUE_PREFIX: "test-prefix",
        SYNC_WORKER_CONCURRENCY: "3",
        WORKER_ID: "worker-test-1",
        ...overrides,
      })
    )
  )

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
}: {
  readonly effect: Effect.Effect<A>
  readonly executor: SourceSyncJobExecutorShape
  readonly acquireWorker: (
    config: WorkerBullMqSourceSyncConsumerConfig,
    processor: WorkerBullMqSourceSyncProcessor
  ) => Effect.Effect<BullMqSourceSyncWorker>
  readonly configOverrides?: Record<string, string>
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
                  repair: Effect.succeed({
                    scannedJobs: 0,
                    requeuedPending: 0,
                    failedProcessing: 0,
                    skippedJobs: 0,
                    erroredJobs: 0,
                    stoppedAfterErrors: false,
                  }),
                })
              )
            )
          )
        ),
        Effect.withConfigProvider(makeConfigProvider(configOverrides))
      )
    )
  )

describe("WorkerBullMqSourceSyncConsumerLive", () => {
  it("decodes valid sync and replay payloads and passes the DB job id to the executor", async () => {
    const executed: Array<ExecuteSourceSyncJobParams> = []
    let processor: WorkerBullMqSourceSyncProcessor | null = null

    const executor: SourceSyncJobExecutorShape = {
      execute: (params) =>
        Effect.sync(() => {
          executed.push(params)
          return summary({ jobId: params.jobId, status: "completed" })
        }),
    }

    await runWithConsumer({
      executor,
      acquireWorker: (_config, acquiredProcessor) =>
        Effect.sync(() => {
          processor = acquiredProcessor
          return { close: Effect.void }
        }),
      effect: Effect.gen(function* () {
        if (processor === null) {
          return yield* Effect.dieMessage("Processor was not acquired")
        }
        const acquiredProcessor = processor

        yield* Effect.promise(() => acquiredProcessor(makeJob({ data: syncPayload })))
        yield* Effect.promise(() =>
          acquiredProcessor(makeJob({ data: replayPayload, attemptsMade: 1 }))
        )
      }),
    })

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

  it("fails malformed payloads terminally without calling the executor", async () => {
    let processor: WorkerBullMqSourceSyncProcessor | null = null
    let executeCount = 0

    const executor: SourceSyncJobExecutorShape = {
      execute: () =>
        Effect.sync(() => {
          executeCount += 1
          return summary({ jobId: "unused", status: "completed" })
        }),
    }

    await runWithConsumer({
      executor,
      acquireWorker: (_config, acquiredProcessor) =>
        Effect.sync(() => {
          processor = acquiredProcessor
          return { close: Effect.void }
        }),
      effect: Effect.gen(function* () {
        if (processor === null) {
          return yield* Effect.dieMessage("Processor was not acquired")
        }
        const acquiredProcessor = processor

        const result = yield* Effect.tryPromise({
          try: () => acquiredProcessor(makeJob({ data: { jobId: "job-1" } })),
          catch: toPromiseRejectionError,
        }).pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.cause).toBeInstanceOf(UnrecoverableError)
        }
      }),
    })

    expect(executeCount).toBe(0)
  })

  it("propagates executor failures to BullMQ so retry policy remains transport-owned", async () => {
    let processor: WorkerBullMqSourceSyncProcessor | null = null
    const retryError = new SourceSyncJobRetryableExecutionError({
      jobId: "job-1",
      message: "provider unavailable",
      attemptNumber: 1,
      maxAttempts: 3,
      nextRetryAt: new Date("2026-01-01T00:05:00.000Z"),
    })

    const executor: SourceSyncJobExecutorShape = {
      execute: () => Effect.fail(retryError),
    }

    await runWithConsumer({
      executor,
      acquireWorker: (_config, acquiredProcessor) =>
        Effect.sync(() => {
          processor = acquiredProcessor
          return { close: Effect.void }
        }),
      effect: Effect.gen(function* () {
        if (processor === null) {
          return yield* Effect.dieMessage("Processor was not acquired")
        }
        const acquiredProcessor = processor

        const result = yield* Effect.tryPromise({
          try: () => acquiredProcessor(makeJob({ data: syncPayload })),
          catch: toPromiseRejectionError,
        }).pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.cause).toBeInstanceOf(Error)
          expect(result.left.cause).not.toBeInstanceOf(UnrecoverableError)
          if (result.left.cause instanceof Error) {
            expect(result.left.cause.message).toContain("provider unavailable")
          }
        }
      }),
    })
  })

  it("marks unrecoverable executor state errors terminal for BullMQ", async () => {
    let processor: WorkerBullMqSourceSyncProcessor | null = null

    const executor: SourceSyncJobExecutorShape = {
      execute: ({ jobId }) => Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId })),
    }

    await runWithConsumer({
      executor,
      acquireWorker: (_config, acquiredProcessor) =>
        Effect.sync(() => {
          processor = acquiredProcessor
          return { close: Effect.void }
        }),
      effect: Effect.gen(function* () {
        if (processor === null) {
          return yield* Effect.dieMessage("Processor was not acquired")
        }
        const acquiredProcessor = processor

        const result = yield* Effect.tryPromise({
          try: () => acquiredProcessor(makeJob({ data: syncPayload })),
          catch: toPromiseRejectionError,
        }).pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.cause).toBeInstanceOf(UnrecoverableError)
        }
      }),
    })
  })

  it("closes the BullMQ worker when the scope finalizes", async () => {
    let closeCount = 0

    const executor: SourceSyncJobExecutorShape = {
      execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
    }

    await runWithConsumer({
      executor,
      acquireWorker: () =>
        Effect.succeed({
          close: Effect.sync(() => {
            closeCount += 1
          }),
        }),
      effect: Effect.void,
    })

    expect(closeCount).toBe(1)
  })

  it("loads worker concurrency and queue prefix from Effect Config", async () => {
    let acquiredConfig: WorkerBullMqSourceSyncConsumerConfig | null = null

    const executor: SourceSyncJobExecutorShape = {
      execute: ({ jobId }) => Effect.succeed(summary({ jobId, status: "completed" })),
    }

    await runWithConsumer({
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

    expect(acquiredConfig).toMatchObject({
      queuePrefix: "custom-prefix",
      concurrency: 7,
      workerId: "worker-custom",
    })
  })
})
