import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { SourceSyncServiceLive } from "../../src/layers/SourceSyncServiceLive.ts"
import {
  SourceRepository,
  SourceSyncJobRepository,
  SourceSyncService,
  type CreateOrReuseSourceSyncJobResult,
  type SourceSyncActiveJob,
  type SourceSyncJobMode,
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
  claimJob: () => Effect.die("claimJob should not be called"),
  heartbeatJob: () => Effect.die("heartbeatJob should not be called"),
  recordRetryableFailure: () => Effect.die("recordRetryableFailure should not be called"),
  listStaleActiveJobs: () => Effect.die("listStaleActiveJobs should not be called"),
  listClaimableJobs: () => Effect.die("listClaimableJobs should not be called"),
}

const makeActiveJob = ({
  id,
  mode = "sync",
  status = "pending",
  updatedAt = new Date(),
}: {
  readonly id: string
  readonly mode?: SourceSyncJobMode
  readonly status?: "pending" | "processing"
  readonly updatedAt?: Date
}): SourceSyncActiveJob => ({
  id,
  sourceId: source.id,
  principalId: source.principalId,
  mode,
  status,
  updatedAt,
})

const makeServiceLayer = ({
  activeJobs = [],
  createResult,
  repositoryEvents,
}: {
  readonly activeJobs?: ReadonlyArray<SourceSyncActiveJob>
  readonly createResult?: CreateOrReuseSourceSyncJobResult
  readonly repositoryEvents: Array<string>
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
    claimJob: unusedJobLifecycleMethods.claimJob,
    heartbeatJob: unusedJobLifecycleMethods.heartbeatJob,
    recordRetryableFailure: unusedJobLifecycleMethods.recordRetryableFailure,
    listStaleActiveJobs: unusedJobLifecycleMethods.listStaleActiveJobs,
    listClaimableJobs: unusedJobLifecycleMethods.listClaimableJobs,
    failJob: () => Effect.die("failJob should not be called"),
    failCreditRequiredJob: () => Effect.die("failCreditRequiredJob should not be called"),
    completeJob: () => Effect.die("completeJob should not be called"),
    getJob: () => Effect.die("getJob should not be called"),
    getExecutionJob: () => Effect.die("getExecutionJob should not be called"),
  })

  return SourceSyncServiceLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncJobRepositoryTestLive),
    Layer.orDie
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

describe("SourceSyncService job orchestration", () => {
  it("creates a fresh sync job whose pending row is the whole hand-off", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({ repositoryEvents }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-sync",
      status: "queued",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
  })

  it("creates a fresh replay job", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "replay",
      layer: makeServiceLayer({ repositoryEvents }),
    })

    expect(result).toMatchObject({ jobId: "job-replay", status: "queued" })
    expect(repositoryEvents).toEqual(["create:replay"])
  })

  it("returns a reused pending job as queued without touching it", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        createResult: {
          _tag: "ReusedSourceSyncJob",
          id: "job-reused-pending",
          sourceId: source.id,
          principalId: source.principalId,
          mode: "sync",
          status: "pending",
        },
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-reused-pending",
      status: "queued",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
  })

  it("returns a reused processing job as running", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        createResult: {
          _tag: "ReusedSourceSyncJob",
          id: "job-reused-processing",
          sourceId: source.id,
          principalId: source.principalId,
          mode: "sync",
          status: "processing",
        },
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-reused-processing",
      status: "running",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual(["create:sync"])
  })

  it("returns an active pending job without creating a new one", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        activeJobs: [makeActiveJob({ id: "job-active" })],
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-active",
      status: "queued",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual([])
  })

  it("returns an active processing job as running", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "sync",
      layer: makeServiceLayer({
        activeJobs: [makeActiveJob({ id: "job-processing", status: "processing" })],
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-processing",
      status: "running",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual([])
  })

  it("preserves a replay request while a sync job is processing", async () => {
    const repositoryEvents: Array<string> = []
    const id = "job-processing"

    const result = await runStart({
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
        },
        repositoryEvents,
      }),
    })

    expect(result).toMatchObject({ jobId: "job-processing", status: "running" })
    expect(repositoryEvents).toEqual(["create:replay"])
  })

  it("uses the replacement job that owns the replay follow-up", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
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
        },
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-replacement",
      status: "queued",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual(["create:replay"])
  })

  it("returns the replay created directly when the active job finished mid-request", async () => {
    const repositoryEvents: Array<string> = []

    const result = await runStart({
      mode: "replay",
      layer: makeServiceLayer({
        activeJobs: [makeActiveJob({ id: "job-finished", status: "processing" })],
        repositoryEvents,
      }),
    })

    expect(result).toMatchObject({ jobId: "job-replay", status: "queued" })
    expect(repositoryEvents).toEqual(["create:replay"])
  })

  it("recovers a stale processing job before creating a new job", async () => {
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
        repositoryEvents,
      }),
    })

    expect(result).toEqual({
      sourceId: source.id,
      jobId: "job-sync",
      status: "queued",
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(repositoryEvents).toEqual(["recover:job-stale", "create:sync"])
  })
})
