import { ConfigProvider, Effect, Layer } from "effect"
import { UnrecoverableError } from "bullmq"
import { describe, expect, it } from "@effect/vitest"
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
  AssetResolutionJobRepository,
  AssetResolutionQueuePayload,
  SyncEngineStorageError,
  type AssetResolutionJobExecutionResult,
  type AssetResolutionJobExecutorShape,
  type AssetResolutionJobRepositoryShape,
  type DispatchableResolutionJob,
} from "@my/sync-engine/services"

const attachedResult = (jobId: string): AssetResolutionJobExecutionResult => ({
  outcome: "attached",
  providerAssetRowId: `provider-asset-for-${jobId}`,
  evidenceRevision: 1,
})

const runQueueEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

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
  listDispatchableResolutionJobs: AssetResolutionJobRepositoryShape["listDispatchableResolutionJobs"]
): AssetResolutionJobRepositoryShape =>
  AssetResolutionJobRepository.of({
    scheduleUnresolvedResolutionJob: () =>
      Effect.die("scheduleUnresolvedResolutionJob should not be called"),
    claimResolutionJob: () => Effect.die("claimResolutionJob should not be called"),
    listDispatchableResolutionJobs,
    heartbeatResolutionJob: () => Effect.die("heartbeatResolutionJob should not be called"),
    releaseResolutionJobAfterFailure: () =>
      Effect.die("releaseResolutionJobAfterFailure should not be called"),
    finishResolutionJob: () => Effect.die("finishResolutionJob should not be called"),
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
  readonly listDispatchableResolutionJobs?: AssetResolutionJobRepositoryShape["listDispatchableResolutionJobs"]
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
                  AssetResolutionJobRepository,
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
  it.effect("keeps enqueueing dispatchable database jobs while the worker is running", () =>
    Effect.gen(function* () {
      const added: Array<{ readonly name: string; readonly jobId: string | undefined }> = []
      let listCount = 0

      yield* Effect.promise(() =>
        runWithConsumer({
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
      )

      expect(listCount).toBeGreaterThan(1)
      expect(added.length).toBeGreaterThan(1)
      expect(added[0]).toEqual({ name: ASSET_RESOLUTION_JOB_NAME, jobId: "db-job-1" })
    })
  )

  it.effect("executes a scheduled job to a terminal state without a manual trigger", () =>
    Effect.gen(function* () {
      const executed: Array<{ readonly jobId: string; readonly workerId?: string }> = []
      let processor: WorkerBullMqAssetResolutionProcessor | null = null
      const results: Array<AssetResolutionJobExecutionResult> = []

      yield* Effect.promise(() =>
        runWithConsumer({
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
              add: (_name, payload) =>
                runQueueEffect(
                  Effect.gen(function* () {
                    // Simulate BullMQ delivering the enqueued job to the consumer.
                    const activeProcessor = processor
                    if (activeProcessor !== null) {
                      results.push(
                        yield* Effect.promise(() =>
                          activeProcessor(makeJob({ jobId: payload.jobId }))
                        )
                      )
                    }
                    return { id: payload.jobId }
                  })
                ),
              close: Effect.void,
            }),
          configOverrides: { ASSET_RESOLUTION_PENDING_DISPATCH_INTERVAL_MS: "1" },
          effect: Effect.sleep("20 millis"),
        })
      )

      expect(executed.length).toBeGreaterThan(0)
      expect(executed[0]).toEqual({ jobId: "db-job-7", workerId: "worker-test-1" })
      expect(results[0]).toEqual(attachedResult("db-job-7"))
    })
  )

  it.effect(
    "treats a duplicate dispatch as a no-op when the executor reports already_claimed",
    () =>
      Effect.gen(function* () {
        let processor: WorkerBullMqAssetResolutionProcessor | null = null

        yield* Effect.promise(() =>
          runWithConsumer({
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
        )

        const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
        if (boundProcessor === null) {
          throw new Error("processor was not bound")
        }

        const result = yield* Effect.promise(() =>
          boundProcessor(makeJob(AssetResolutionQueuePayload.make({ jobId: "db-job-1" })))
        )

        expect(result.outcome).toBe("already_claimed")
      })
  )

  it.effect("surfaces an execution failure without a queue retry and keeps the worker alive", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqAssetResolutionProcessor | null = null
      let calls = 0

      yield* Effect.promise(() =>
        runWithConsumer({
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
      )

      const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
      if (boundProcessor === null) {
        throw new Error("processor was not bound")
      }

      const payload = AssetResolutionQueuePayload.make({ jobId: "db-job-1" })

      yield* Effect.promise(() =>
        expect(boundProcessor(makeJob(payload))).rejects.toBeInstanceOf(UnrecoverableError)
      )

      // The database owns the retry; a later dispatch still executes normally.
      const retried = yield* Effect.promise(() => boundProcessor(makeJob(payload)))
      expect(retried.outcome).toBe("attached")
    })
  )

  it.effect("rejects a malformed payload as unrecoverable", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqAssetResolutionProcessor | null = null

      yield* Effect.promise(() =>
        runWithConsumer({
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
      )

      const boundProcessor = processor as WorkerBullMqAssetResolutionProcessor | null
      if (boundProcessor === null) {
        throw new Error("processor was not bound")
      }

      yield* Effect.promise(() =>
        expect(boundProcessor(makeJob({ nonsense: true }))).rejects.toBeInstanceOf(
          UnrecoverableError
        )
      )
    })
  )

  it.effect("logs and keeps polling when listing dispatchable jobs fails", () =>
    Effect.gen(function* () {
      let listCount = 0

      yield* Effect.promise(() =>
        runWithConsumer({
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
      )

      expect(listCount).toBeGreaterThan(1)
    })
  )
})
