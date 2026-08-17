import { Config, ConfigProvider, Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeApiBullMqSourceSyncQueueLive,
  type ApiBullMqSourceSyncQueueConfig,
  type BullMqSourceSyncQueue,
} from "../src/layers/ApiBullMqSourceSyncQueueLive.ts"
import {
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceSyncQueuePayload,
  type AttachSourceSyncQueueMetadataParams,
  type SourceSyncJobRepositoryShape,
} from "@my/sync-engine/services"
import type { JobsOptions } from "bullmq"

interface AddCall {
  readonly name: typeof SOURCE_SYNC_JOB_NAME
  readonly payload: SourceSyncQueuePayload
  readonly options: JobsOptions
}

interface ConfigProviderOptions {
  readonly overrides?: Record<string, unknown>
  readonly omittedKeys?: ReadonlyArray<string>
}

const payload = SourceSyncQueuePayload.make({
  jobId: "job-1",
  sourceId: "source-1",
  principalId: "principal-1",
  mode: "sync",
})

const makeConfigProvider = (options: ConfigProviderOptions = {}) =>
  ConfigProvider.fromEnvRecord(Object.fromEntries(makeConfigMap(options)))

const makeConfigMap = ({ overrides = {}, omittedKeys = [] }: ConfigProviderOptions) => {
  const values: Record<string, unknown> = {
    QUEUE_REDIS_URL: "redis://localhost:6379",
    SOURCE_SYNC_QUEUE_PREFIX: "test-prefix",
    SOURCE_SYNC_QUEUE_ATTEMPTS: "5",
    SOURCE_SYNC_QUEUE_BACKOFF_DELAY_MS: "2500",
    SOURCE_SYNC_QUEUE_REMOVE_ON_COMPLETE_COUNT: "25",
    SOURCE_SYNC_QUEUE_REMOVE_ON_FAIL_COUNT: "50",
    ...overrides,
  }

  for (const key of omittedKeys) {
    delete values[key]
  }

  return new Map(Object.entries(values).map(([key, value]) => [key, String(value)]))
}

const makeRepositoryLayer = ({
  attached,
  attachQueueMetadata,
}: {
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly attachQueueMetadata?: SourceSyncJobRepositoryShape["attachQueueMetadata"]
}) =>
  Layer.succeed(SourceSyncJobRepository, {
    findActiveJob: () => Effect.die(new Error("findActiveJob should not be called")),
    createOrReuseJob: () => Effect.die(new Error("createOrReuseJob should not be called")),
    attachQueueMetadata:
      attachQueueMetadata ??
      ((params) =>
        Effect.sync(() => {
          attached.push(params)
        })),
    claimJob: () => Effect.die(new Error("claimJob should not be called")),
    heartbeatJob: () => Effect.die(new Error("heartbeatJob should not be called")),
    recordRetryableFailure: () =>
      Effect.die(new Error("recordRetryableFailure should not be called")),
    recoverStaleActiveJob: () =>
      Effect.die(new Error("recoverStaleActiveJob should not be called")),
    failJob: () => Effect.die(new Error("failJob should not be called")),
    completeJob: () => Effect.die(new Error("completeJob should not be called")),
    getJob: () => Effect.die(new Error("getJob should not be called")),
    getExecutionJob: () => Effect.die(new Error("getExecutionJob should not be called")),
    listStaleActiveJobs: () => Effect.die(new Error("listStaleActiveJobs should not be called")),
    listRepairableActiveJobs: () =>
      Effect.die(new Error("listRepairableActiveJobs should not be called")),
    listPendingJobsNeedingDispatch: () =>
      Effect.die(new Error("listPendingJobsNeedingDispatch should not be called")),
  } satisfies SourceSyncJobRepositoryShape)

const makeProducerLayer = ({
  queue,
  attached,
  attachQueueMetadata,
}: {
  readonly queue: BullMqSourceSyncQueue
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly attachQueueMetadata?: SourceSyncJobRepositoryShape["attachQueueMetadata"]
}) =>
  makeApiBullMqSourceSyncQueueLive({
    acquireQueue: () => Effect.succeed(queue),
  }).pipe(
    Layer.provideMerge(
      makeRepositoryLayer({
        attached,
        ...(attachQueueMetadata === undefined ? {} : { attachQueueMetadata }),
      })
    )
  )

const runWithProducer = <A, E>({
  effect,
  queue,
  attached,
  configOverrides,
  attachQueueMetadata,
}: {
  readonly effect: Effect.Effect<A, E, SourceSyncQueue>
  readonly queue: BullMqSourceSyncQueue
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly configOverrides?: ConfigProviderOptions
  readonly attachQueueMetadata?: SourceSyncJobRepositoryShape["attachQueueMetadata"]
}) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          makeProducerLayer({
            queue,
            attached,
            ...(attachQueueMetadata === undefined ? {} : { attachQueueMetadata }),
          })
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider(configOverrides))
      )
    )
  )

describe("ApiBullMqSourceSyncQueueLive", () => {
  it("uses the DB job id as the BullMQ job id and records queue metadata", async () => {
    const addCalls: Array<AddCall> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []

    const queue: BullMqSourceSyncQueue = {
      add: (name, queuedPayload, options) => {
        addCalls.push({ name, payload: queuedPayload, options })
        return Promise.resolve({ id: "bull-job-1" })
      },
      close: Effect.void,
    }

    await runWithProducer({
      attached,
      queue,
      effect: Effect.gen(function* () {
        const producer = yield* SourceSyncQueue
        yield* producer.enqueueSourceSyncJob(payload)
      }),
    })

    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]).toMatchObject({
      name: SOURCE_SYNC_JOB_NAME,
      payload,
      options: {
        jobId: payload.jobId,
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 2500,
        },
        removeOnComplete: {
          count: 25,
        },
        removeOnFail: {
          count: 50,
        },
      },
    })
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({
      jobId: payload.jobId,
      queueName: SOURCE_SYNC_QUEUE_NAME,
      queueJobId: "bull-job-1",
    })
    expect(attached[0]?.queuedAt).toBeInstanceOf(Date)
  })

  it("closes the queue when the scope finalizes", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const events: Array<string> = []
    let closeCount = 0

    const queue: BullMqSourceSyncQueue = {
      add: () => {
        events.push("add")
        return Promise.resolve({ id: payload.jobId })
      },
      close: Effect.sync(() => {
        events.push("close")
        closeCount += 1
      }),
    }

    await runWithProducer({
      attached,
      queue,
      effect: Effect.gen(function* () {
        const producer = yield* SourceSyncQueue
        yield* producer.enqueueSourceSyncJob(payload)
      }),
    })

    expect(closeCount).toBe(1)
    expect(events).toEqual(["add", "close"])
  })

  it("does not propagate queue close failures during scope finalization", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    let closeCount = 0

    const queue: BullMqSourceSyncQueue = {
      add: () => Promise.resolve({ id: payload.jobId }),
      close: Effect.sync(() => {
        closeCount += 1
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new SourceSyncQueueError({
              operation: "test.close",
              cause: new Error("close failed"),
            })
          )
        )
      ),
    }

    await runWithProducer({
      attached,
      queue,
      effect: Effect.gen(function* () {
        const producer = yield* SourceSyncQueue
        yield* producer.enqueueSourceSyncJob(payload)
      }),
    })

    expect(closeCount).toBe(1)
  })

  it("maps queue.add rejection to a source sync queue error", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []

    const queue: BullMqSourceSyncQueue = {
      add: () => Promise.reject(new Error("redis unavailable")),
      close: Effect.void,
    }

    const result = await runWithProducer({
      attached,
      queue,
      effect: Effect.gen(function* () {
        const producer = yield* SourceSyncQueue
        yield* producer.enqueueSourceSyncJob(payload)
      }).pipe(Effect.result),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("SourceSyncQueueError")
      expect(result.failure.operation).toBe("apiBullMqSourceSyncQueue.enqueue")
    }
    expect(attached).toHaveLength(0)
  })

  it("maps queue metadata persistence failure to a source sync queue error", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []

    const queue: BullMqSourceSyncQueue = {
      add: () => Promise.resolve({ id: payload.jobId }),
      close: Effect.void,
    }

    const result = await runWithProducer({
      attached,
      queue,
      attachQueueMetadata: () =>
        Effect.fail(
          new SourceSyncJobExecutionRecordConflictError({
            jobId: payload.jobId,
            reason: "Only active jobs can receive queue metadata.",
          })
        ),
      effect: Effect.gen(function* () {
        const producer = yield* SourceSyncQueue
        yield* producer.enqueueSourceSyncJob(payload)
      }).pipe(Effect.result),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("SourceSyncQueueError")
      expect(result.failure.operation).toBe("apiBullMqSourceSyncQueue.attachQueueMetadata")
    }
  })

  it("fails layer construction for invalid queue config before acquiring the queue", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const configCases: Array<{
      readonly configOverrides: ConfigProviderOptions
    }> = [
      {
        configOverrides: { overrides: { QUEUE_REDIS_URL: "not-a-url" } },
      },
      {
        configOverrides: { overrides: { SOURCE_SYNC_QUEUE_ATTEMPTS: "0" } },
      },
      { configOverrides: { omittedKeys: ["QUEUE_REDIS_URL"] } },
    ]

    for (const { configOverrides } of configCases) {
      let acquiredConfig: ApiBullMqSourceSyncQueueConfig | null = null

      const queue: BullMqSourceSyncQueue = {
        add: () => Promise.resolve({ id: payload.jobId }),
        close: Effect.void,
      }

      const result = await Effect.runPromise(
        Effect.scoped(
          SourceSyncQueue.pipe(
            Effect.asVoid,
            Effect.provide(
              makeApiBullMqSourceSyncQueueLive({
                acquireQueue: (config) =>
                  Effect.sync(() => {
                    acquiredConfig = config
                    return queue
                  }),
              }).pipe(Layer.provideMerge(makeRepositoryLayer({ attached })))
            ),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              makeConfigProvider(configOverrides)
            ),
            Effect.result
          )
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      expect(acquiredConfig).toBeNull()
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(Config.ConfigError)
      }
    }
  })

  it("allows zero BullMQ retention counts", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    let acquiredConfig: ApiBullMqSourceSyncQueueConfig | null = null

    const queue: BullMqSourceSyncQueue = {
      add: () => Promise.resolve({ id: payload.jobId }),
      close: Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        SourceSyncQueue.pipe(
          Effect.asVoid,
          Effect.provide(
            makeApiBullMqSourceSyncQueueLive({
              acquireQueue: (config) =>
                Effect.sync(() => {
                  acquiredConfig = config
                  return queue
                }),
            }).pipe(Layer.provideMerge(makeRepositoryLayer({ attached })))
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            makeConfigProvider({
              overrides: {
                SOURCE_SYNC_QUEUE_REMOVE_ON_COMPLETE_COUNT: "0",
                SOURCE_SYNC_QUEUE_REMOVE_ON_FAIL_COUNT: "0",
              },
            })
          ),
          Effect.result
        )
      )
    )

    expect(Result.isSuccess(result)).toBe(true)
    expect(acquiredConfig).toMatchObject({
      removeOnCompleteCount: 0,
      removeOnFailCount: 0,
    })
  })
})
