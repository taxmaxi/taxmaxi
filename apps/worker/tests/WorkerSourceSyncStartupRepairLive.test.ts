import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeWorkerSourceSyncStartupRepairLive,
  WorkerSourceSyncStartupRepair,
  type WorkerSourceSyncStartupRepairConfig,
  type WorkerSourceSyncStartupRepairQueue,
} from "../src/layers/WorkerSourceSyncStartupRepairLive.ts"
import {
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  type AttachSourceSyncQueueMetadataParams,
  type SourceSyncExecutionJob,
  type SourceSyncJobDetails,
  type SourceSyncPendingDispatchJob,
  type RecoverStaleSourceSyncJobParams,
  type SourceSyncJobRepositoryShape,
  type SourceSyncQueuePayload,
  type SourceSyncRepairableActiveJob,
} from "@my/sync-engine/services"

type RepairFailureKind = "not-found" | "conflict"

const makeConfigProvider = (overrides: Record<string, string> = {}) =>
  ConfigProvider.fromEnvRecord({
    QUEUE_REDIS_URL: "redis://localhost:6379",
    SOURCE_SYNC_QUEUE_PREFIX: "test-prefix",
    SOURCE_SYNC_REPAIR_STALE_AFTER_MS: "1000",
    SOURCE_SYNC_REPAIR_BATCH_SIZE: "10",
    SYNC_WORKER_MAX_ATTEMPTS: "3",
    ...overrides,
  })

const baseUpdatedAt = new Date("2026-01-01T00:00:00.000Z")

const isPendingDispatchJob = (
  job: SourceSyncRepairableActiveJob
): job is SourceSyncPendingDispatchJob => job.status === "pending"

const makeRepairableJob = ({
  id,
  status,
  queueName = null,
  queueJobId = null,
}: {
  readonly id: string
  readonly status: "pending" | "processing"
  readonly queueName?: string | null
  readonly queueJobId?: string | null
}): SourceSyncRepairableActiveJob => ({
  id,
  sourceId: "source-1",
  principalId: "principal-1",
  mode: "sync",
  status,
  startedAt: status === "processing" ? baseUpdatedAt : null,
  heartbeatAt: status === "processing" ? baseUpdatedAt : null,
  updatedAt: baseUpdatedAt,
  workerId: status === "processing" ? "worker-old" : null,
  queueName,
  queueJobId,
})

const makeRepositoryLayer = ({
  repairableJobs,
  attached,
  recovered,
  attachFailureJobId,
  attachFailureKind = "not-found",
  recoverFailureJobId,
  recoverFailureKind = "conflict",
  materializedOnRecover,
  blockedDispatchJobIds = new Set(),
  visibleJob,
  executionJob,
}: {
  readonly repairableJobs: ReadonlyArray<SourceSyncRepairableActiveJob>
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly recovered: Array<RecoverStaleSourceSyncJobParams>
  readonly attachFailureJobId?: string
  readonly attachFailureKind?: RepairFailureKind
  readonly recoverFailureJobId?: string
  readonly recoverFailureKind?: RepairFailureKind
  readonly materializedOnRecover?: SourceSyncRepairableActiveJob
  readonly blockedDispatchJobIds?: ReadonlySet<string>
  readonly visibleJob?: SourceSyncJobDetails
  readonly executionJob?: SourceSyncExecutionJob
}) => {
  let remainingJobs = [...repairableJobs]
  const removeRepairableJob = (jobId: string): void => {
    remainingJobs = remainingJobs.filter((job) => job.id !== jobId)
  }
  const makeFailure = ({
    jobId,
    kind,
  }: {
    readonly jobId: string
    readonly kind: RepairFailureKind
  }) =>
    kind === "not-found"
      ? new SourceSyncJobExecutionRecordNotFoundError({ jobId })
      : new SourceSyncJobExecutionRecordConflictError({
          jobId,
          reason: "test repair conflict",
        })

  return Layer.succeed(SourceSyncJobRepository, {
    findActiveJob: () => Effect.die(new Error("findActiveJob should not be called")),
    createOrReuseJob: () => Effect.die(new Error("createOrReuseJob should not be called")),
    attachQueueMetadata: (params) => {
      if (params.jobId === attachFailureJobId) {
        removeRepairableJob(params.jobId)
        return Effect.fail(makeFailure({ jobId: params.jobId, kind: attachFailureKind }))
      }

      return Effect.sync(() => {
        attached.push(params)
        removeRepairableJob(params.jobId)
      })
    },
    claimJob: () => Effect.die(new Error("claimJob should not be called")),
    heartbeatJob: () => Effect.die(new Error("heartbeatJob should not be called")),
    recordRetryableFailure: () =>
      Effect.die(new Error("recordRetryableFailure should not be called")),
    recoverStaleActiveJob: (params) => {
      if (params.jobId === recoverFailureJobId) {
        removeRepairableJob(params.jobId)
        return Effect.fail(makeFailure({ jobId: params.jobId, kind: recoverFailureKind }))
      }

      return Effect.sync(() => {
        recovered.push(params)
        removeRepairableJob(params.jobId)
        if (materializedOnRecover !== undefined) {
          remainingJobs.push(materializedOnRecover)
        }
      })
    },
    failJob: () => Effect.die(new Error("failJob should not be called")),
    failCreditRequiredJob: () =>
      Effect.die(new Error("failCreditRequiredJob should not be called")),
    completeJob: () => Effect.die(new Error("completeJob should not be called")),
    getJob: () =>
      visibleJob === undefined
        ? Effect.die(new Error("getJob should not be called"))
        : Effect.succeed(visibleJob),
    getExecutionJob: () =>
      executionJob === undefined
        ? Effect.die(new Error("getExecutionJob should not be called"))
        : Effect.succeed(executionJob),
    listStaleActiveJobs: () => Effect.die(new Error("listStaleActiveJobs should not be called")),
    listRepairableActiveJobs: ({ limit }) => Effect.sync(() => remainingJobs.slice(0, limit)),
    listPendingJobsNeedingDispatch: ({ jobId, limit }) =>
      Effect.sync(() =>
        remainingJobs
          .filter(isPendingDispatchJob)
          .filter((job) => jobId === undefined || job.id === jobId)
          .filter((job) => !blockedDispatchJobIds.has(job.id))
          .slice(0, limit)
      ),
  } satisfies SourceSyncJobRepositoryShape)
}

const makeQueue = (
  enqueued: Array<SourceSyncQueuePayload>,
  options: {
    readonly rejectJobIds?: ReadonlySet<string>
    readonly returnedJobIds?: ReadonlyMap<string, string>
  } = {}
): WorkerSourceSyncStartupRepairQueue => ({
  add: async (name, payload) => {
    expect(name).toBe(SOURCE_SYNC_JOB_NAME)
    if (options.rejectJobIds?.has(payload.jobId) === true) {
      return Promise.reject("queue unavailable")
    }

    enqueued.push(payload)
    return { id: options.returnedJobIds?.get(payload.jobId) ?? payload.jobId }
  },
  close: Effect.void,
})

const runRepair = ({
  repairableJobs,
  enqueued,
  attached,
  recovered,
  attachFailureJobId,
  attachFailureKind,
  recoverFailureJobId,
  recoverFailureKind,
  materializedOnRecover,
  queueOptions,
  configOverrides,
}: {
  readonly repairableJobs: ReadonlyArray<SourceSyncRepairableActiveJob>
  readonly enqueued: Array<SourceSyncQueuePayload>
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly recovered: Array<RecoverStaleSourceSyncJobParams>
  readonly attachFailureJobId?: string
  readonly attachFailureKind?: RepairFailureKind
  readonly recoverFailureJobId?: string
  readonly recoverFailureKind?: RepairFailureKind
  readonly materializedOnRecover?: SourceSyncRepairableActiveJob
  readonly queueOptions?: {
    readonly rejectJobIds?: ReadonlySet<string>
    readonly returnedJobIds?: ReadonlyMap<string, string>
  }
  readonly configOverrides?: Record<string, string>
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repair = yield* WorkerSourceSyncStartupRepair
        return yield* repair.repair
      }).pipe(
        Effect.provide(
          makeWorkerSourceSyncStartupRepairLive({
            acquireQueue: (_config: WorkerSourceSyncStartupRepairConfig) =>
              Effect.succeed(makeQueue(enqueued, queueOptions)),
          }).pipe(
            Layer.provideMerge(
              makeRepositoryLayer({
                repairableJobs,
                attached,
                recovered,
                ...(attachFailureJobId === undefined ? {} : { attachFailureJobId }),
                ...(attachFailureKind === undefined ? {} : { attachFailureKind }),
                ...(recoverFailureJobId === undefined ? {} : { recoverFailureJobId }),
                ...(recoverFailureKind === undefined ? {} : { recoverFailureKind }),
                ...(materializedOnRecover === undefined ? {} : { materializedOnRecover }),
              })
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider(configOverrides))
      )
    )
  )

const runPendingDispatch = ({
  repairableJobs,
  enqueued,
  attached,
  recovered,
}: {
  readonly repairableJobs: ReadonlyArray<SourceSyncRepairableActiveJob>
  readonly enqueued: Array<SourceSyncQueuePayload>
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
  readonly recovered: Array<RecoverStaleSourceSyncJobParams>
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repair = yield* WorkerSourceSyncStartupRepair
        return yield* repair.dispatchPending
      }).pipe(
        Effect.provide(
          makeWorkerSourceSyncStartupRepairLive({
            acquireQueue: () => Effect.succeed(makeQueue(enqueued)),
          }).pipe(Layer.provideMerge(makeRepositoryLayer({ repairableJobs, attached, recovered })))
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
      )
    )
  )

const runDispatchFollowUp = ({
  blocked = false,
  enqueued,
  attached,
}: {
  readonly blocked?: boolean
  readonly enqueued: Array<SourceSyncQueuePayload>
  readonly attached: Array<AttachSourceSyncQueueMetadataParams>
}) => {
  const visibleJob = {
    sourceId: "source-1",
    jobId: "job-follow-up",
    status: "queued",
    phase: null,
    processedRecords: null,
    totalRecords: null,
    progressPercent: null,
    fetchedRecords: null,
    normalizedRecords: null,
    failedRecords: null,
    message: null,
    resumable: false,
    creditOutcome: null,
  } satisfies SourceSyncJobDetails

  const executionJob = {
    id: "job-follow-up",
    sourceId: "source-1",
    principalId: "principal-1",
    mode: "replay",
    status: "pending",
  } satisfies SourceSyncExecutionJob

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repair = yield* WorkerSourceSyncStartupRepair
        yield* repair.dispatchFollowUp({
          jobId: "job-completed",
          sourceId: "source-1",
          principalId: "principal-1",
        })
      }).pipe(
        Effect.provide(
          makeWorkerSourceSyncStartupRepairLive({
            acquireQueue: () => Effect.succeed(makeQueue(enqueued)),
          }).pipe(
            Layer.provideMerge(
              makeRepositoryLayer({
                repairableJobs: [makeRepairableJob({ id: "job-follow-up", status: "pending" })],
                attached,
                recovered: [],
                blockedDispatchJobIds: blocked ? new Set(["job-follow-up"]) : new Set(),
                visibleJob,
                executionJob,
              })
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
      )
    )
  )
}

describe("WorkerSourceSyncStartupRepairLive", () => {
  it("reuses one queue connection across pending dispatch passes", async () => {
    let acquireCount = 0
    let closeCount = 0
    const enqueued: Array<SourceSyncQueuePayload> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repair = yield* WorkerSourceSyncStartupRepair
          yield* repair.dispatchPending
          yield* repair.dispatchPending
        }).pipe(
          Effect.provide(
            makeWorkerSourceSyncStartupRepairLive({
              acquireQueue: () =>
                Effect.sync(() => {
                  acquireCount += 1
                  return {
                    ...makeQueue(enqueued),
                    close: Effect.sync(() => {
                      closeCount += 1
                    }),
                  }
                }),
            }).pipe(
              Layer.provideMerge(
                makeRepositoryLayer({ repairableJobs: [], attached: [], recovered: [] })
              )
            )
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
        )
      )
    )

    expect(acquireCount).toBe(1)
    expect(closeCount).toBe(1)
  })

  it("dispatches pending jobs without recovering processing jobs", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runPendingDispatch({
      repairableJobs: [
        makeRepairableJob({ id: "job-pending", status: "pending" }),
        makeRepairableJob({ id: "job-processing", status: "processing" }),
      ],
      enqueued,
      attached,
      recovered,
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-pending"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-pending"])
    expect(recovered).toEqual([])
    expect(summary).toMatchObject({ scannedJobs: 1, requeuedPending: 1, failedProcessing: 0 })
  })

  it("dispatches only the follow-up linked to a completed job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []

    await runDispatchFollowUp({ enqueued, attached })

    expect(enqueued).toEqual([
      {
        jobId: "job-follow-up",
        sourceId: "source-1",
        principalId: "principal-1",
        mode: "replay",
      },
    ])
    expect(attached).toEqual([
      expect.objectContaining({
        jobId: "job-follow-up",
        queueName: SOURCE_SYNC_QUEUE_NAME,
        queueJobId: "job-follow-up",
      }),
    ])
  })

  it("does not dispatch a linked follow-up while an owner replay is pending", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []

    await runDispatchFollowUp({ blocked: true, enqueued, attached })

    expect(enqueued).toEqual([])
    expect(attached).toEqual([])
  })

  it("requeues a pending job without queue metadata and records durable metadata", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [makeRepairableJob({ id: "job-pending", status: "pending" })],
      enqueued,
      attached,
      recovered,
    })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      jobId: "job-pending",
      sourceId: "source-1",
      principalId: "principal-1",
      mode: "sync",
    })
    expect(attached).toEqual([
      expect.objectContaining({
        jobId: "job-pending",
        queueName: SOURCE_SYNC_QUEUE_NAME,
        queueJobId: "job-pending",
      }),
    ])
    expect(recovered).toEqual([])
    expect(summary).toMatchObject({
      scannedJobs: 1,
      requeuedPending: 1,
      failedProcessing: 0,
      skippedJobs: 0,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("uses deterministic job ids when reconciling a pending job that already has metadata", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    await runRepair({
      repairableJobs: [
        makeRepairableJob({
          id: "job-pending-with-metadata",
          status: "pending",
          queueName: SOURCE_SYNC_QUEUE_NAME,
          queueJobId: "job-pending-with-metadata",
        }),
      ],
      enqueued,
      attached,
      recovered,
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-pending-with-metadata"])
    expect(attached.map((params) => params.queueJobId)).toEqual(["job-pending-with-metadata"])
    expect(recovered).toEqual([])
  })

  it("records BullMQ-assigned ids when enqueue returns a different id", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    await runRepair({
      repairableJobs: [makeRepairableJob({ id: "job-pending", status: "pending" })],
      enqueued,
      attached,
      recovered,
      queueOptions: {
        returnedJobIds: new Map([["job-pending", "bull-generated-job-id"]]),
      },
    })

    expect(attached).toEqual([
      expect.objectContaining({
        jobId: "job-pending",
        queueJobId: "bull-generated-job-id",
      }),
    ])
  })

  it("logs attach metadata failures and continues repairing later jobs", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [
        makeRepairableJob({ id: "job-attach-fails", status: "pending" }),
        makeRepairableJob({ id: "job-next", status: "pending" }),
      ],
      enqueued,
      attached,
      recovered,
      attachFailureJobId: "job-attach-fails",
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-attach-fails", "job-next"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-next"])
    expect(summary).toMatchObject({
      scannedJobs: 2,
      requeuedPending: 1,
      skippedJobs: 1,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("logs attach metadata conflicts and continues repairing later jobs", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [
        makeRepairableJob({ id: "job-attach-conflict", status: "pending" }),
        makeRepairableJob({ id: "job-next", status: "pending" }),
      ],
      enqueued,
      attached,
      recovered,
      attachFailureJobId: "job-attach-conflict",
      attachFailureKind: "conflict",
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-attach-conflict", "job-next"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-next"])
    expect(summary).toMatchObject({
      scannedJobs: 2,
      requeuedPending: 1,
      skippedJobs: 1,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("logs enqueue failures and continues repairing later jobs", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [
        makeRepairableJob({ id: "job-enqueue-fails", status: "pending" }),
        makeRepairableJob({ id: "job-next", status: "pending" }),
      ],
      enqueued,
      attached,
      recovered,
      queueOptions: {
        rejectJobIds: new Set(["job-enqueue-fails"]),
      },
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-next"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-next"])
    expect(summary).toMatchObject({
      scannedJobs: 2,
      requeuedPending: 1,
      skippedJobs: 0,
      erroredJobs: 1,
      stoppedAfterErrors: false,
    })
  })

  it("fails stale processing jobs instead of enqueueing duplicate work", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [makeRepairableJob({ id: "job-processing", status: "processing" })],
      enqueued,
      attached,
      recovered,
    })

    expect(enqueued).toEqual([])
    expect(attached).toEqual([])
    expect(recovered).toEqual([
      expect.objectContaining({
        sourceId: "source-1",
        jobId: "job-processing",
        message: "Startup repair failed stale processing source sync job.",
      }),
    ])
    expect(summary).toMatchObject({
      scannedJobs: 1,
      requeuedPending: 0,
      failedProcessing: 1,
      skippedJobs: 0,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("repairs follow-up work materialized while recovering a stale job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [makeRepairableJob({ id: "job-processing", status: "processing" })],
      materializedOnRecover: makeRepairableJob({ id: "job-follow-up", status: "pending" }),
      enqueued,
      attached,
      recovered,
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-follow-up"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-follow-up"])
    expect(summary).toMatchObject({
      scannedJobs: 2,
      requeuedPending: 1,
      failedProcessing: 1,
    })
  })

  it("logs stale processing conflicts and continues repairing later jobs", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [
        makeRepairableJob({ id: "job-processing-conflict", status: "processing" }),
        makeRepairableJob({ id: "job-processing-next", status: "processing" }),
      ],
      enqueued,
      attached,
      recovered,
      recoverFailureJobId: "job-processing-conflict",
      recoverFailureKind: "conflict",
    })

    expect(enqueued).toEqual([])
    expect(attached).toEqual([])
    expect(recovered.map((params) => params.jobId)).toEqual(["job-processing-next"])
    expect(summary).toMatchObject({
      scannedJobs: 2,
      requeuedPending: 0,
      failedProcessing: 1,
      skippedJobs: 1,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("drains multiple clean batches until the repair backlog is below batch size", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []
    const jobs = Array.from({ length: 5 }, (_value, index) =>
      makeRepairableJob({ id: `job-${index + 1}`, status: "pending" })
    )

    const summary = await runRepair({
      repairableJobs: jobs,
      enqueued,
      attached,
      recovered,
      configOverrides: {
        SOURCE_SYNC_REPAIR_BATCH_SIZE: "2",
      },
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
      "job-4",
      "job-5",
    ])
    expect(attached.map((params) => params.jobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
      "job-4",
      "job-5",
    ])
    expect(summary).toEqual({
      scannedJobs: 5,
      requeuedPending: 5,
      failedProcessing: 0,
      skippedJobs: 0,
      erroredJobs: 0,
      stoppedAfterErrors: false,
    })
  })

  it("stops draining after a full batch has an errored job", async () => {
    const enqueued: Array<SourceSyncQueuePayload> = []
    const attached: Array<AttachSourceSyncQueueMetadataParams> = []
    const recovered: Array<RecoverStaleSourceSyncJobParams> = []

    const summary = await runRepair({
      repairableJobs: [
        makeRepairableJob({ id: "job-enqueue-fails", status: "pending" }),
        makeRepairableJob({ id: "job-in-first-batch", status: "pending" }),
        makeRepairableJob({ id: "job-left-for-next-repair", status: "pending" }),
      ],
      enqueued,
      attached,
      recovered,
      queueOptions: {
        rejectJobIds: new Set(["job-enqueue-fails"]),
      },
      configOverrides: {
        SOURCE_SYNC_REPAIR_BATCH_SIZE: "2",
      },
    })

    expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-in-first-batch"])
    expect(attached.map((params) => params.jobId)).toEqual(["job-in-first-batch"])
    expect(summary).toEqual({
      scannedJobs: 2,
      requeuedPending: 1,
      failedProcessing: 0,
      skippedJobs: 0,
      erroredJobs: 1,
      stoppedAfterErrors: true,
    })
  })
})
