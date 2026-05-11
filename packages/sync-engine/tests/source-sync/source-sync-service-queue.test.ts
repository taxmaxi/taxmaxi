import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { SourceSyncServiceLive } from "../../src/layers/SourceSyncServiceLive.ts"
import {
  SourceRepository,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceSyncService,
  type CreateOrReuseSourceSyncJobResult,
  type SourceSyncActiveJob,
  type SourceSyncJobMode,
  type SourceSyncQueuePayload,
  type SourceSyncSource,
} from "../../src/services/index.ts"

const source: SourceSyncSource = {
  id: "source-1",
  userId: "user-1",
  providerKey: "coinbase",
  cexAccountId: "cex-account-1",
  addressId: null,
}

const unusedJobLifecycleMethods = {
  attachQueueMetadata: () => Effect.dieMessage("attachQueueMetadata should not be called"),
  claimJob: () => Effect.dieMessage("claimJob should not be called"),
  heartbeatJob: () => Effect.dieMessage("heartbeatJob should not be called"),
  recordRetryableFailure: () => Effect.dieMessage("recordRetryableFailure should not be called"),
  listStaleActiveJobs: () => Effect.dieMessage("listStaleActiveJobs should not be called"),
  listRepairableActiveJobs: () =>
    Effect.dieMessage("listRepairableActiveJobs should not be called"),
}

const makeActiveJob = ({
  id,
  mode = "sync",
  status = "pending",
  updatedAt = new Date(),
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
  userId: source.userId,
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
}: {
  readonly activeJobs?: ReadonlyArray<SourceSyncActiveJob>
  readonly createResult?: CreateOrReuseSourceSyncJobResult
  readonly enqueued: Array<SourceSyncQueuePayload>
  readonly repositoryEvents: Array<string>
  readonly enqueueFailure?: boolean
}) => {
  const SourceRepositoryTestLive = Layer.succeed(SourceRepository, {
    findOwnedSourceSyncContext: () => Effect.succeed(Option.some(source)),
    listUserSourceSyncContexts: () => Effect.succeed([source]),
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
    failJob: () => Effect.dieMessage("failJob should not be called"),
    completeJob: () => Effect.dieMessage("completeJob should not be called"),
    getJob: () => Effect.dieMessage("getJob should not be called"),
    getExecutionJob: () => Effect.dieMessage("getExecutionJob should not be called"),
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

  return SourceSyncServiceLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncJobRepositoryTestLive),
    Layer.provide(SourceSyncQueueTestLive)
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
        return yield* service.startSourceSyncJob({ userId: source.userId, sourceId: source.id })
      }

      return yield* service.replaySourceSyncJob({ userId: source.userId, sourceId: source.id })
    }).pipe(Effect.provide(layer))
  )

describe("SourceSyncService queue orchestration", () => {
  it("creates a fresh sync job and enqueues it once", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({ enqueued, repositoryEvents }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-sync",
      status: "queued",
      message: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-sync",
      sourceId: source.id,
      userId: source.userId,
      mode: "sync",
    })
  })

  it("creates a fresh replay job and enqueues replay payload", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "replay",
      layer: makeServiceLayer({ enqueued, repositoryEvents }),
    })

    expect(result.status).toBe("queued")
    expect(repositoryEvents).toEqual(["create:replay"])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-replay",
      mode: "replay",
    })
  })

  it("enqueues a reused pending job when queue metadata is missing", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        createResult: {
          _tag: "ReusedSourceSyncJob",
          id: "job-reused-pending",
          sourceId: source.id,
          userId: source.userId,
          mode: "sync",
          status: "pending",
          queueName: null,
          queueJobId: null,
        },
        enqueued,
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-reused-pending",
      status: "queued",
      message: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-reused-pending",
      sourceId: source.id,
      userId: source.userId,
      mode: "sync",
    })
  })

  it("does not enqueue a reused processing job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        createResult: {
          _tag: "ReusedSourceSyncJob",
          id: "job-reused-processing",
          sourceId: source.id,
          userId: source.userId,
          mode: "sync",
          status: "processing",
          queueName: "source-sync",
          queueJobId: "job-reused-processing",
        },
        enqueued,
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-reused-processing",
      status: "running",
      message: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
    expect(enqueued).toEqual([])
  })

  it("returns an active pending job without enqueueing when queue metadata exists", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
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

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-active",
      status: "queued",
      message: null,
    })
    expect(repositoryEvents).toEqual([])
    expect(enqueued).toEqual([])
  })

  it("re-enqueues an active pending job when queue metadata is missing", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        activeJobs: [makeActiveJob({ id: "job-pending-unqueued" })],
        enqueued,
        repositoryEvents,
      }),
    })

    expect(result.status).toBe("queued")
    expect(repositoryEvents).toEqual([])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-pending-unqueued",
      mode: "sync",
    })
  })

  it("returns an active processing job without enqueueing", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        activeJobs: [makeActiveJob({ id: "job-processing", status: "processing" })],
        enqueued,
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-processing",
      status: "running",
      message: null,
    })
    expect(repositoryEvents).toEqual([])
    expect(enqueued).toEqual([])
  })

  it("reports enqueue failure after creating the pending DB job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SourceSyncService
        return yield* service
          .startSourceSyncJob({ userId: source.userId, sourceId: source.id })
          .pipe(Effect.either)
      }).pipe(
        Effect.provide(
          makeServiceLayer({
            enqueued,
            repositoryEvents,
            enqueueFailure: true,
          })
        )
      )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SourceSyncQueueError")
    }
    expect(repositoryEvents).toEqual(["create:sync"])
    expect(enqueued).toEqual([])
  })

  it("recovers a stale processing job before creating and enqueueing a new job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        activeJobs: [
          makeActiveJob({
            id: "job-stale",
            status: "processing",
            updatedAt: new Date(Date.now() - 31_000),
          }),
        ],
        enqueued,
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-sync",
      status: "queued",
      message: null,
    })
    expect(repositoryEvents).toEqual(["recover:job-stale", "create:sync"])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-sync",
      mode: "sync",
    })
  })
})
