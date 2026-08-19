import { ConfigProvider, Effect, Layer } from "effect"
import { UnrecoverableError } from "bullmq"
import { describe, expect, it } from "vitest"
import {
  makeWorkerBullMqAssetResolutionConsumerLive,
  type BullMqAssetResolutionQueue,
  type BullMqAssetResolutionWorker,
  type WorkerBullMqAssetResolutionConsumerConfig,
  type WorkerBullMqAssetResolutionJob,
  type WorkerBullMqAssetResolutionProcessor,
} from "../src/layers/WorkerBullMqAssetResolutionConsumerLive.ts"
import {
  ASSET_RESOLUTION_JOB_NAME,
  AssetResolutionJobExecutor,
  AssetResolutionQueuePayload,
  ProviderAssetRepository,
  SyncEngineStorageError,
  type AssetResolutionJobExecutionResult,
  type AssetResolutionJobExecutorShape,
  type DispatchableResolutionJob,
  type ProviderAssetRepositoryShape,
} from "@my/sync-engine/services"

const attachedResult = (jobId: string): AssetResolutionJobExecutionResult => ({
  outcome: "attached",
  providerAssetRowId: `provider-asset-for-${jobId}`,
  evidenceRevision: 1,
})

const makeConfigProvider = (overrides: Record<string, string> = {}) =>
  ConfigProvider.fromEnvRecord({
    QUEUE_REDIS_URL: "redis://localhost:6379",
    ASSET_RESOLUTION_QUEUE_PREFIX: "test-prefix",
    WORKER_ID: "worker-test-1",
    ...overrides,
  })

const makeJob = (data: unknown): WorkerBullMqAssetResolutionJob => ({
  id: "queue-job-1",
  name: ASSET_RESOLUTION_JOB_NAME,
  data,
})

const dieRepository = (
  listDispatchableResolutionJobs: ProviderAssetRepositoryShape["listDispatchableResolutionJobs"]
): ProviderAssetRepositoryShape =>
  ProviderAssetRepository.of({
    upsertProviderAssets: () => Effect.die("upsertProviderAssets should not be called"),
    upsertProviderAssetMappings: () =>
      Effect.die("upsertProviderAssetMappings should not be called"),
    approveProviderAssetMappingAndRequestReplay: () =>
      Effect.die("approveProviderAssetMappingAndRequestReplay should not be called"),
    lockProviderAssetApprovalSnapshot: () =>
      Effect.die("lockProviderAssetApprovalSnapshot should not be called"),
    recordProviderAssetSourceUses: () =>
      Effect.die("recordProviderAssetSourceUses should not be called"),
    seedProviderAssetMappingsIfMissing: () =>
      Effect.die("seedProviderAssetMappingsIfMissing should not be called"),
    findProviderAssetByProviderAssetId: () =>
      Effect.die("findProviderAssetByProviderAssetId should not be called"),
    findProviderAssetByNaturalKey: () =>
      Effect.die("findProviderAssetByNaturalKey should not be called"),
    findProviderAssetByCurrencyCode: () =>
      Effect.die("findProviderAssetByCurrencyCode should not be called"),
    findProviderAssetReviewById: () =>
      Effect.die("findProviderAssetReviewById should not be called"),
    listProviderAssetReviews: () => Effect.die("listProviderAssetReviews should not be called"),
    listProviderAssetObservedRepresentations: () =>
      Effect.die("listProviderAssetObservedRepresentations should not be called"),
    findProviderAssetMapping: () => Effect.die("findProviderAssetMapping should not be called"),
    scheduleUnresolvedResolutionJob: () =>
      Effect.die("scheduleUnresolvedResolutionJob should not be called"),
    claimResolutionJob: () => Effect.die("claimResolutionJob should not be called"),
    listDispatchableResolutionJobs,
    heartbeatResolutionJob: () => Effect.die("heartbeatResolutionJob should not be called"),
    releaseResolutionJobAfterFailure: () =>
      Effect.die("releaseResolutionJobAfterFailure should not be called"),
    finishResolutionJob: () => Effect.die("finishResolutionJob should not be called"),
    appendSupersedingAssetResolutionDecision: () =>
      Effect.die("appendSupersedingAssetResolutionDecision should not be called"),
    findActiveAssetResolutionDecision: () =>
      Effect.die("findActiveAssetResolutionDecision should not be called"),
    listAssetResolutionDecisions: () =>
      Effect.die("listAssetResolutionDecisions should not be called"),
    recordAssetResolutionDecision: () =>
      Effect.die("recordAssetResolutionDecision should not be called"),
  })

const runWithConsumer = <A>({
  effect,
  executor,
  listDispatchableResolutionJobs,
  acquireWorker,
  acquireQueue,
  configOverrides,
}: {
  readonly effect: Effect.Effect<A>
  readonly executor: AssetResolutionJobExecutorShape
  readonly listDispatchableResolutionJobs?: ProviderAssetRepositoryShape["listDispatchableResolutionJobs"]
  readonly acquireWorker?: (
    config: WorkerBullMqAssetResolutionConsumerConfig,
    processor: WorkerBullMqAssetResolutionProcessor
  ) => Effect.Effect<BullMqAssetResolutionWorker>
  readonly acquireQueue?: (
    config: WorkerBullMqAssetResolutionConsumerConfig
  ) => Effect.Effect<BullMqAssetResolutionQueue>
  readonly configOverrides?: Record<string, string>
}) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          makeWorkerBullMqAssetResolutionConsumerLive({
            acquireWorker: acquireWorker ?? (() => Effect.succeed({ close: Effect.void })),
            acquireQueue:
              acquireQueue ??
              (() =>
                Effect.succeed({
                  add: () => Promise.resolve({ id: "ignored" }),
                  close: Effect.void,
                })),
          }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(AssetResolutionJobExecutor, executor),
                Layer.succeed(
                  ProviderAssetRepository,
                  dieRepository(listDispatchableResolutionJobs ?? (() => Effect.succeed([])))
                )
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider(configOverrides))
      )
    )
  )

describe("WorkerBullMqAssetResolutionConsumerLive", () => {
  it("keeps enqueueing dispatchable database jobs while the worker is running", async () => {
    const added: Array<{ readonly name: string; readonly jobId: string | undefined }> = []
    let listCount = 0

    await runWithConsumer({
      executor: {
        executeJob: ({ jobId }) => Effect.succeed(attachedResult(jobId)),
      },
      listDispatchableResolutionJobs: () =>
        Effect.sync(() => {
          listCount += 1
          return [{ jobId: "db-job-1" }] satisfies ReadonlyArray<DispatchableResolutionJob>
        }),
      acquireQueue: () =>
        Effect.succeed({
          add: (name, payload, options) => {
            added.push({ name, jobId: options.jobId })
            expect(payload.jobId).toBe("db-job-1")
            return Promise.resolve({ id: options.jobId ?? payload.jobId })
          },
          close: Effect.void,
        }),
      configOverrides: { ASSET_RESOLUTION_PENDING_DISPATCH_INTERVAL_MS: "1" },
      effect: Effect.sleep("20 millis"),
    })

    expect(listCount).toBeGreaterThan(1)
    expect(added.length).toBeGreaterThan(1)
    expect(added[0]).toEqual({ name: ASSET_RESOLUTION_JOB_NAME, jobId: "db-job-1" })
  })

  it("executes a scheduled job to a terminal state without a manual trigger", async () => {
    const executed: Array<{ readonly jobId: string; readonly workerId?: string }> = []
    let processor: WorkerBullMqAssetResolutionProcessor | null = null
    const results: Array<AssetResolutionJobExecutionResult> = []

    await runWithConsumer({
      executor: {
        executeJob: (params) =>
          Effect.sync(() => {
            executed.push(params)
            return attachedResult(params.jobId)
          }),
      },
      listDispatchableResolutionJobs: () => Effect.succeed([{ jobId: "db-job-7" }]),
      acquireWorker: (_config, boundProcessor) =>
        Effect.sync(() => {
          processor = boundProcessor
          return { close: Effect.void }
        }),
      acquireQueue: () =>
        Effect.succeed({
          add: async (_name, payload) => {
            // Simulate BullMQ delivering the enqueued job to the consumer.
            if (processor !== null) {
              results.push(await processor(makeJob({ jobId: payload.jobId })))
            }
            return { id: payload.jobId }
          },
          close: Effect.void,
        }),
      configOverrides: { ASSET_RESOLUTION_PENDING_DISPATCH_INTERVAL_MS: "1" },
      effect: Effect.sleep("20 millis"),
    })

    expect(executed.length).toBeGreaterThan(0)
    expect(executed[0]).toEqual({ jobId: "db-job-7", workerId: "worker-test-1" })
    expect(results[0]).toEqual(attachedResult("db-job-7"))
  })

  it("treats a duplicate dispatch as a no-op when the executor reports already_claimed", async () => {
    let processor: WorkerBullMqAssetResolutionProcessor | null = null

    await runWithConsumer({
      executor: {
        executeJob: () =>
          Effect.succeed({
            outcome: "already_claimed",
            providerAssetRowId: null,
            evidenceRevision: null,
          } satisfies AssetResolutionJobExecutionResult),
      },
      acquireWorker: (_config, boundProcessor) =>
        Effect.sync(() => {
          processor = boundProcessor
          return { close: Effect.void }
        }),
      effect: Effect.void,
    })

    const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
    if (boundProcessor === null) {
      throw new Error("processor was not bound")
    }

    const result = await boundProcessor(
      makeJob(AssetResolutionQueuePayload.make({ jobId: "db-job-1" }))
    )

    expect(result.outcome).toBe("already_claimed")
  })

  it("surfaces an execution failure without a queue retry and keeps the worker alive", async () => {
    let processor: WorkerBullMqAssetResolutionProcessor | null = null
    let calls = 0

    await runWithConsumer({
      executor: {
        executeJob: ({ jobId }) =>
          Effect.sync(() => {
            calls += 1
            return jobId
          }).pipe(
            Effect.flatMap((id) =>
              calls === 1
                ? Effect.fail(
                    new SyncEngineStorageError({
                      operation: "test.executeJob",
                      cause: "boom",
                    })
                  )
                : Effect.succeed(attachedResult(id))
            )
          ),
      },
      acquireWorker: (_config, boundProcessor) =>
        Effect.sync(() => {
          processor = boundProcessor
          return { close: Effect.void }
        }),
      effect: Effect.void,
    })

    const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
    if (boundProcessor === null) {
      throw new Error("processor was not bound")
    }

    const payload = AssetResolutionQueuePayload.make({ jobId: "db-job-1" })

    await expect(boundProcessor(makeJob(payload))).rejects.toBeInstanceOf(UnrecoverableError)

    // The database owns the retry; a later dispatch still executes normally.
    const retried = await boundProcessor(makeJob(payload))
    expect(retried.outcome).toBe("attached")
  })

  it("rejects a malformed payload as unrecoverable", async () => {
    let processor: WorkerBullMqAssetResolutionProcessor | null = null

    await runWithConsumer({
      executor: {
        executeJob: () => Effect.die("executeJob should not be called"),
      },
      acquireWorker: (_config, boundProcessor) =>
        Effect.sync(() => {
          processor = boundProcessor
          return { close: Effect.void }
        }),
      effect: Effect.void,
    })

    const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
    if (boundProcessor === null) {
      throw new Error("processor was not bound")
    }

    await expect(boundProcessor(makeJob({ nonsense: true }))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
  })

  it("logs and keeps polling when listing dispatchable jobs fails", async () => {
    let listCount = 0

    await runWithConsumer({
      executor: {
        executeJob: ({ jobId }) => Effect.succeed(attachedResult(jobId)),
      },
      listDispatchableResolutionJobs: () =>
        Effect.sync(() => {
          listCount += 1
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new SyncEngineStorageError({
                operation: "test.listDispatchableResolutionJobs",
                cause: "boom",
              })
            )
          )
        ),
      configOverrides: { ASSET_RESOLUTION_PENDING_DISPATCH_INTERVAL_MS: "1" },
      effect: Effect.sleep("20 millis"),
    })

    expect(listCount).toBeGreaterThan(1)
  })
})
