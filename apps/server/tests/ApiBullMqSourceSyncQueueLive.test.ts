import { ConfigProvider, Effect, Layer } from "effect"
import * as ConfigError from "effect/ConfigError"
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
  ConfigProvider.fromMap(makeConfigMap(options))

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
    findActiveJob: () => Effect.dieMessage("findActiveJob should not be called"),
    createOrReuseJob: () => Effect.dieMessage("createOrReuseJob should not be called"),
    attachQueueMetadata:
      attachQueueMetadata ??
      ((params) =>
        Effect.sync(() => {
          attached.push(params)
        })),
    claimJob: () => Effect.dieMessage("claimJob should not be called"),
    heartbeatJob: () => Effect.dieMessage("heartbeatJob should not be called"),
    recordRetryableFailure: () => Effect.dieMessage("recordRetryableFailure should not be called"),
    recoverStaleActiveJob: () => Effect.dieMessage("recoverStaleActiveJob should not be called"),
    failJob: () => Effect.dieMessage("failJob should not be called"),
    completeJob: () => Effect.dieMessage("completeJob should not be called"),
    getJob: () => Effect.dieMessage("getJob should not be called"),
    getExecutionJob: () => Effect.dieMessage("getExecutionJob should not be called"),
    listStaleActiveJobs: () => Effect.dieMessage("listStaleActiveJobs should not be called"),
    listRepairableActiveJobs: () =>
      Effect.dieMessage("listRepairableActiveJobs should not be called"),
  } satisfies SourceSyncJobRepositoryShape)

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
          makeApiBullMqSourceSyncQueueLive({
            acquireQueue: () => Effect.succeed(queue),
          })
        ),
        Effect.provide(makeRepositoryLayer({ attached, attachQueueMetadata })),
        Effect.withConfigProvider(makeConfigProvider(configOverrides))
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
      close: Effect.gen(function* () {
        closeCount += 1
        return yield* Effect.fail(
          new SourceSyncQueueError({
            operation: "test.close",
            cause: new Error("close failed"),
          })
        )
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
      }).pipe(Effect.either),
    })

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SourceSyncQueueError")
      expect(result.left.operation).toBe("apiBullMqSourceSyncQueue.enqueue")
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
      }).pipe(Effect.either),
    })

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SourceSyncQueueError")
      expect(result.left.operation).toBe("apiBullMqSourceSyncQueue.attachQueueMetadata")
    }
  })

  it("fails layer construction for invalid queue config before acquiring the queue", async () => {
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const configCases: Array<{
      readonly configOverrides: ConfigProviderOptions
      readonly expectedError: "invalid" | "missing"
    }> = [
      {
        configOverrides: { overrides: { QUEUE_REDIS_URL: "not-a-url" } },
        expectedError: "invalid",
      },
      {
        configOverrides: { overrides: { SOURCE_SYNC_QUEUE_ATTEMPTS: "0" } },
        expectedError: "invalid",
      },
      { configOverrides: { omittedKeys: ["QUEUE_REDIS_URL"] }, expectedError: "missing" },
    ]

    for (const { configOverrides, expectedError } of configCases) {
      let acquiredConfig: ApiBullMqSourceSyncQueueConfig | null = null

      const queue: BullMqSourceSyncQueue = {
        add: () => Promise.resolve({ id: payload.jobId }),
        close: Effect.void,
      }

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* SourceSyncQueue
          }).pipe(
            Effect.provide(
              makeApiBullMqSourceSyncQueueLive({
                acquireQueue: (config) =>
                  Effect.sync(() => {
                    acquiredConfig = config
                    return queue
                  }),
              })
            ),
            Effect.provide(makeRepositoryLayer({ attached })),
            Effect.withConfigProvider(makeConfigProvider(configOverrides)),
            Effect.either
          )
        )
      )

      expect(result._tag).toBe("Left")
      expect(acquiredConfig).toBeNull()
      if (result._tag === "Left") {
        expect(ConfigError.isConfigError(result.left)).toBe(true)
        if (expectedError === "invalid" && ConfigError.isConfigError(result.left)) {
          expect(ConfigError.isInvalidData(result.left)).toBe(true)
        }
        if (expectedError === "missing" && ConfigError.isConfigError(result.left)) {
          expect(ConfigError.isMissingDataOnly(result.left)).toBe(true)
        }
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
        Effect.gen(function* () {
          yield* SourceSyncQueue
        }).pipe(
          Effect.provide(
            makeApiBullMqSourceSyncQueueLive({
              acquireQueue: (config) =>
                Effect.sync(() => {
                  acquiredConfig = config
                  return queue
                }),
            })
          ),
          Effect.provide(makeRepositoryLayer({ attached })),
          Effect.withConfigProvider(
            makeConfigProvider({
              overrides: {
                SOURCE_SYNC_QUEUE_REMOVE_ON_COMPLETE_COUNT: "0",
                SOURCE_SYNC_QUEUE_REMOVE_ON_FAIL_COUNT: "0",
              },
            })
          ),
          Effect.either
        )
      )
    )

    expect(result._tag).toBe("Right")
    expect(acquiredConfig).toMatchObject({
      removeOnCompleteCount: 0,
      removeOnFailCount: 0,
    })
  })
})
