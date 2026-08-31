import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "@effect/vitest"
import { SourceSyncServiceLive } from "../../src/layers/SourceSyncServiceLive.ts"
import {
  CalculationRunOrchestrator,
  SourceRepository,
  SourceSyncJobPrerequisitesPendingError,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceSyncService,
  SyncEngineTransaction,
  type CreateOrReuseSourceSyncJobResult,
  type SourceSyncActiveJob,
  type SourceSyncJobMode,
  type SourceSyncQueuePayload,
  type SourceSyncSource,
} from "../../src/services/index.ts"

const source: SourceSyncSource = {
  id: "source-1",
  principalId: "principal-1",
  providerKey: "coinbase",
  cexAccountId: "cex-account-1",
  addressId: null,
  walletAddress: null,
}

const unusedJobLifecycleMethods = {
  attachQueueMetadata: () => Effect.die("attachQueueMetadata should not be called"),
  claimJob: () => Effect.die("claimJob should not be called"),
  heartbeatJob: () => Effect.die("heartbeatJob should not be called"),
  recordRetryableFailure: () => Effect.die("recordRetryableFailure should not be called"),
  listStaleActiveJobs: () => Effect.die("listStaleActiveJobs should not be called"),
  listRepairableActiveJobs: () => Effect.die("listRepairableActiveJobs should not be called"),
  listPendingJobsNeedingDispatch: () =>
    Effect.die("listPendingJobsNeedingDispatch should not be called"),
}

const makeActiveJob = ({
  id,
  mode = "sync",
  status = "pending",
  updatedAt = DateTime.toDateUtc(DateTime.nowUnsafe()),
  queueName = null,
  queueJobId = null,
}: {
  readonly id: string
  readonly mode?: SourceSyncJobMode
  readonly status?: "pending" | "processing"
  readonly updatedAt?: Date
  readonly queueName?: string | null
  readonly queueJobId?: string | null
}): SourceSyncActiveJob => ({
  id,
  sourceId: source.id,
  principalId: source.principalId,
  mode,
  status,
  updatedAt,
  queueName,
  queueJobId,
})

const makeServiceLayer = ({
  activeJobs = [],
  createResult,
  enqueued,
  repositoryEvents,
  enqueueFailure = false,
  dispatchBlocked = false,
}: {
  readonly activeJobs?: ReadonlyArray<SourceSyncActiveJob>
  readonly createResult?: CreateOrReuseSourceSyncJobResult
  readonly enqueued: Array<SourceSyncQueuePayload>
  readonly repositoryEvents: Array<string>
  readonly enqueueFailure?: boolean
  readonly dispatchBlocked?: boolean
}) => {
  const SourceRepositoryTestLive = Layer.succeed(SourceRepository, {
    findOwnedSourceSyncContext: () => Effect.succeed(Option.some(source)),
    listPrincipalSourceSyncContexts: () => Effect.succeed([source]),
  })

  const SourceSyncJobRepositoryTestLive = Layer.succeed(SourceSyncJobRepository, {
    findActiveJob: () => Effect.succeed(activeJobs),
    createOrReuseJob: ({ mode }) =>
      Effect.sync(() => {
        repositoryEvents.push(`create:${mode}`)
        return (
          createResult ?? {
            _tag: "CreatedSourceSyncJob",
            id: `job-${mode}`,
          }
        )
      }),
    recoverStaleActiveJob: ({ jobId }) =>
      Effect.sync(() => {
        repositoryEvents.push(`recover:${jobId}`)
      }),
    attachQueueMetadata: unusedJobLifecycleMethods.attachQueueMetadata,
    claimJob: unusedJobLifecycleMethods.claimJob,
    heartbeatJob: unusedJobLifecycleMethods.heartbeatJob,
    recordRetryableFailure: unusedJobLifecycleMethods.recordRetryableFailure,
    listStaleActiveJobs: unusedJobLifecycleMethods.listStaleActiveJobs,
    listRepairableActiveJobs: unusedJobLifecycleMethods.listRepairableActiveJobs,
    listPendingJobsNeedingDispatch: unusedJobLifecycleMethods.listPendingJobsNeedingDispatch,
    failJob: () => Effect.die("failJob should not be called"),
    failCreditRequiredJob: () => Effect.die("failCreditRequiredJob should not be called"),
    completeJob: () => Effect.die("completeJob should not be called"),
    getJob: () => Effect.die("getJob should not be called"),
    getExecutionJob: ({ jobId }) =>
      dispatchBlocked
        ? Effect.fail(
            new SourceSyncJobPrerequisitesPendingError({
              jobId,
              sourceId: source.id,
            })
          )
        : Effect.succeed({
            id: jobId,
            sourceId: source.id,
            principalId: source.principalId,
            mode: "replay" as const,
            status: "pending" as const,
          }),
  })

  const SourceSyncQueueTestLive = Layer.succeed(SourceSyncQueue, {
    enqueueSourceSyncJob: (payload) =>
      enqueueFailure
        ? Effect.fail(
            new SourceSyncQueueError({
              operation: "test.enqueue",
              cause: "queue unavailable",
            })
          )
        : Effect.sync(() => {
            enqueued.push(payload)
          }),
  })

  const CalculationRunOrchestratorTestLive = Layer.succeed(CalculationRunOrchestrator, {
    withPrincipalSyncLock: ({ effect }) => effect,
    withPrincipalCalculationLock: ({ effect }) => effect,
    runAfterSync: () => Effect.die("runAfterSync should not be called"),
    resumeAfterTerminalSync: () => Effect.die("resumeAfterTerminalSync should not be called"),
    runAfterPrincipalTerminal: () =>
      Effect.sync(() => {
        repositoryEvents.push("calculation-after-terminal")
      }),
    recoverTerminalCalculations: () =>
      Effect.succeed({ scannedPrincipals: 0, recoveredPrincipals: 0, failedPrincipals: 0 }),
  })

  const SyncEngineTransactionTestLive = Layer.succeed(SyncEngineTransaction, {
    run: (effect) => effect,
  })

  return SourceSyncServiceLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncJobRepositoryTestLive),
    Layer.provide(SourceSyncQueueTestLive),
    Layer.provide(CalculationRunOrchestratorTestLive),
    Layer.provide(SyncEngineTransactionTestLive)
  )
}

const runStart = ({
  layer,
  mode,
}: {
  readonly layer: Layer.Layer<SourceSyncService>
  readonly mode: SourceSyncJobMode
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SourceSyncService
      if (mode === "sync") {
        return yield* service.startSourceSyncJob({
          principalId: source.principalId,
          sourceId: source.id,
        })
      }

      return yield* service.replaySourceSyncJob({
        principalId: source.principalId,
        sourceId: source.id,
      })
    }).pipe(Effect.provide(layer))
  )

describe("SourceSyncService queue orchestration", () => {
  it.effect("creates a fresh sync job and enqueues it once", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({ enqueued, repositoryEvents }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-sync",
        status: "queued",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual(["create:sync"])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-sync",
        sourceId: source.id,
        principalId: source.principalId,
        mode: "sync",
      })
    })
  )

  it.effect("creates a fresh replay job and enqueues replay payload", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "replay",
          layer: makeServiceLayer({ enqueued, repositoryEvents }),
        })
      )

      expect(result.status).toBe("queued")
      expect(repositoryEvents).toEqual(["create:replay"])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-replay",
        mode: "replay",
      })
    })
  )

  it.effect("enqueues a reused pending job when queue metadata is missing", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            createResult: {
              _tag: "ReusedSourceSyncJob",
              id: "job-reused-pending",
              sourceId: source.id,
              principalId: source.principalId,
              mode: "sync",
              status: "pending",
              queueName: null,
              queueJobId: null,
            },
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-reused-pending",
        status: "queued",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual(["create:sync"])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-reused-pending",
        sourceId: source.id,
        principalId: source.principalId,
        mode: "sync",
      })
    })
  )

  it.effect("leaves a reused replay unqueued until its prerequisites complete", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "replay",
          layer: makeServiceLayer({
            createResult: {
              _tag: "ReusedSourceSyncJob",
              id: "job-dependent-replay",
              sourceId: source.id,
              principalId: source.principalId,
              mode: "replay",
              status: "pending",
              queueName: null,
              queueJobId: null,
            },
            enqueued,
            repositoryEvents,
            dispatchBlocked: true,
          }),
        })
      )

      expect(result).toMatchObject({ jobId: "job-dependent-replay", status: "queued" })
      expect(enqueued).toEqual([])
    })
  )

  it.effect("does not enqueue a reused processing job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            createResult: {
              _tag: "ReusedSourceSyncJob",
              id: "job-reused-processing",
              sourceId: source.id,
              principalId: source.principalId,
              mode: "sync",
              status: "processing",
              queueName: "source-sync",
              queueJobId: "job-reused-processing",
            },
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-reused-processing",
        status: "running",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual(["create:sync"])
      expect(enqueued).toEqual([])
    })
  )

  it.effect("returns an active pending job without enqueueing when queue metadata exists", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            activeJobs: [
              makeActiveJob({
                id: "job-active",
                queueName: "source-sync",
                queueJobId: "job-active",
              }),
            ],
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-active",
        status: "queued",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual([])
      expect(enqueued).toEqual([])
    })
  )

  it.effect("re-enqueues an active pending job when queue metadata is missing", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            activeJobs: [makeActiveJob({ id: "job-pending-unqueued" })],
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result.status).toBe("queued")
      expect(repositoryEvents).toEqual([])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-pending-unqueued",
        mode: "sync",
      })
    })
  )

  it.effect("returns an active processing job without enqueueing", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            activeJobs: [makeActiveJob({ id: "job-processing", status: "processing" })],
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-processing",
        status: "running",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual([])
      expect(enqueued).toEqual([])
    })
  )

  it.effect("preserves a replay request while a sync job is processing", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []
      const id = "job-processing"

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "replay",
          layer: makeServiceLayer({
            activeJobs: [makeActiveJob({ id, status: "processing" })],
            createResult: {
              _tag: "ReusedSourceSyncJob",
              id,
              sourceId: source.id,
              principalId: source.principalId,
              mode: "sync",
              status: "processing",
              queueName: "source-sync",
              queueJobId: id,
            },
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toMatchObject({ jobId: "job-processing", status: "running" })
      expect(repositoryEvents).toEqual(["create:replay"])
      expect(enqueued).toEqual([])
    })
  )

  it.effect("uses the replacement job that owns the replay follow-up", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "replay",
          layer: makeServiceLayer({
            activeJobs: [makeActiveJob({ id: "job-finished", status: "processing" })],
            createResult: {
              _tag: "ReusedSourceSyncJob",
              id: "job-replacement",
              sourceId: source.id,
              principalId: source.principalId,
              mode: "sync",
              status: "pending",
              queueName: null,
              queueJobId: null,
            },
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-replacement",
        status: "queued",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual(["create:replay"])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-replacement",
        mode: "sync",
      })
    })
  )

  it.effect("reports enqueue failure after creating the pending DB job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []

      const result = yield* Effect.gen(function* () {
        const service = yield* SourceSyncService
        return yield* service
          .startSourceSyncJob({ principalId: source.principalId, sourceId: source.id })
          .pipe(Effect.result)
      }).pipe(
        Effect.provide(
          makeServiceLayer({
            enqueued,
            repositoryEvents,
            enqueueFailure: true,
          })
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourceSyncQueueError")
      }
      expect(repositoryEvents).toEqual(["create:sync"])
      expect(enqueued).toEqual([])
    })
  )

  it.effect("recovers a stale processing job before creating and enqueueing a new job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const repositoryEvents: Array<string> = []
      const staleUpdatedAt = DateTime.toDateUtc(
        DateTime.subtractDuration(yield* DateTime.now, "31 seconds")
      )

      const result = yield* Effect.promise(() =>
        runStart({
          mode: "sync",
          layer: makeServiceLayer({
            activeJobs: [
              makeActiveJob({
                id: "job-stale",
                status: "processing",
                updatedAt: staleUpdatedAt,
              }),
            ],
            enqueued,
            repositoryEvents,
          }),
        })
      )

      expect(result).toEqual({
        sourceId: source.id,
        jobId: "job-sync",
        status: "queued",
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(repositoryEvents).toEqual([
        "recover:job-stale",
        "calculation-after-terminal",
        "create:sync",
      ])
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({
        jobId: "job-sync",
        mode: "sync",
      })
    })
  )
})
