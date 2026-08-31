import * as DateTime from "effect/DateTime"
import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
  makeWorkerSourceSyncStartupRepairLive,
  WorkerSourceSyncStartupRepair,
  type WorkerSourceSyncStartupRepairConfig,
  type WorkerSourceSyncStartupRepairQueue,
} from "../src/layers/WorkerSourceSyncStartupRepairLive.ts"
import {
  CalculationRunOrchestrationError,
  CalculationRunOrchestrator,
  type CalculationRunOrchestratorShape,
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  SyncEngineTransaction,
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

const baseUpdatedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))

const isPendingDispatchJob = (
  job: SourceSyncRepairableActiveJob
): job is SourceSyncPendingDispatchJob => job.status === "pending"

const makeRepairableJob = ({
  id,
  status,
  sourceId = "source-1",
  principalId = "principal-1",
  queueName = null,
  queueJobId = null,
}: {
  readonly id: string
  readonly status: "pending" | "processing"
  readonly sourceId?: string
  readonly principalId?: string
  readonly queueName?: string | null
  readonly queueJobId?: string | null
}): SourceSyncRepairableActiveJob => ({
  id,
  sourceId,
  principalId,
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
    listPendingJobsNeedingDispatch: ({ limit }) =>
      Effect.sync(() => remainingJobs.filter(isPendingDispatchJob).slice(0, limit)),
  } satisfies SourceSyncJobRepositoryShape)
}

const makeQueue = (
  enqueued: Array<SourceSyncQueuePayload>,
  options: {
    readonly rejectJobIds?: ReadonlySet<string>
    readonly returnedJobIds?: ReadonlyMap<string, string>
  } = {}
): WorkerSourceSyncStartupRepairQueue => ({
  add: (name, payload) =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(name).toBe(SOURCE_SYNC_JOB_NAME)
        if (options.rejectJobIds?.has(payload.jobId) === true) {
          return yield* Effect.fail("queue unavailable")
        }

        enqueued.push(payload)
        return { id: options.returnedJobIds?.get(payload.jobId) ?? payload.jobId }
      })
    ),
  close: Effect.void,
})

const makeCalculationRunOrchestratorLayer = ({
  wokenPrincipals = [],
  wakeFailure = false,
  recoverTerminalCalculations,
}: {
  readonly wokenPrincipals?: Array<string>
  readonly wakeFailure?: boolean
  readonly recoverTerminalCalculations?: CalculationRunOrchestratorShape["recoverTerminalCalculations"]
} = {}) =>
  Layer.succeed(CalculationRunOrchestrator, {
    withPrincipalSyncLock: ({ effect }) => effect,
    withPrincipalCalculationLock: ({ effect }) => effect,
    runAfterSync: () => Effect.die("runAfterSync should not be called"),
    resumeAfterTerminalSync: () => Effect.die("resumeAfterTerminalSync should not be called"),
    runAfterPrincipalTerminal: ({ principalId }) =>
      wakeFailure
        ? Effect.fail(
            new CalculationRunOrchestrationError({
              operation: "test.runAfterPrincipalTerminal",
              cause: "wake unavailable",
              retrySourceJob: false,
            })
          )
        : Effect.sync(() => {
            wokenPrincipals.push(principalId)
          }),
    recoverTerminalCalculations:
      recoverTerminalCalculations ??
      (() => Effect.succeed({ scannedPrincipals: 0, recoveredPrincipals: 0, failedPrincipals: 0 })),
  })

const SyncEngineTransactionTestLive = Layer.succeed(SyncEngineTransaction, {
  run: (effect) => effect,
})

const makeRollbackTrackingTransactionLayer = ({
  recovered,
}: {
  readonly recovered: Array<RecoverStaleSourceSyncJobParams>
}) =>
  Layer.succeed(SyncEngineTransaction, {
    run: (effect) => {
      const recoveredCount = recovered.length
      return effect.pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            recovered.splice(recoveredCount)
          })
        )
      )
    },
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
  wokenPrincipals,
  wakeFailure,
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
  readonly wokenPrincipals?: Array<string>
  readonly wakeFailure?: boolean
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
            Layer.provide(
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
            ),
            Layer.provide(
              makeCalculationRunOrchestratorLayer({
                ...(wokenPrincipals === undefined ? {} : { wokenPrincipals }),
                ...(wakeFailure === undefined ? {} : { wakeFailure }),
              })
            ),
            Layer.provide(makeRollbackTrackingTransactionLayer({ recovered }))
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
          }).pipe(
            Layer.provide(makeRepositoryLayer({ repairableJobs, attached, recovered })),
            Layer.provide(makeCalculationRunOrchestratorLayer()),
            Layer.provide(SyncEngineTransactionTestLive)
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
      )
    )
  )

const runDispatchFollowUp = ({
  enqueued,
  attached,
}: {
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
            Layer.provide(
              makeRepositoryLayer({
                repairableJobs: [],
                attached,
                recovered: [],
                visibleJob,
                executionJob,
              })
            ),
            Layer.provide(makeCalculationRunOrchestratorLayer()),
            Layer.provide(SyncEngineTransactionTestLive)
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
      )
    )
  )
}

describe("WorkerSourceSyncStartupRepairLive", () => {
  it.effect("retries unfinished calculation settlement on a later maintenance pass", () =>
    Effect.gen(function* () {
      let recoveryAttempts = 0
      const enqueued: Array<SourceSyncQueuePayload> = []

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repair = yield* WorkerSourceSyncStartupRepair
          yield* repair.repair
          yield* repair.dispatchPending
        }).pipe(
          Effect.provide(
            makeWorkerSourceSyncStartupRepairLive({
              acquireQueue: () => Effect.succeed(makeQueue(enqueued)),
            }).pipe(
              Layer.provide(
                makeRepositoryLayer({ repairableJobs: [], attached: [], recovered: [] })
              ),
              Layer.provide(
                makeCalculationRunOrchestratorLayer({
                  recoverTerminalCalculations: () =>
                    Effect.sync(() => {
                      recoveryAttempts += 1
                      return recoveryAttempts === 1
                        ? {
                            scannedPrincipals: 1,
                            recoveredPrincipals: 0,
                            failedPrincipals: 1,
                          }
                        : {
                            scannedPrincipals: 1,
                            recoveredPrincipals: 1,
                            failedPrincipals: 0,
                          }
                    }),
                })
              ),
              Layer.provide(SyncEngineTransactionTestLive)
            )
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
        )
      )

      expect(recoveryAttempts).toBe(2)
      expect(enqueued).toEqual([])
    })
  )

  it.effect("reuses one queue connection across pending dispatch passes", () =>
    Effect.gen(function* () {
      let acquireCount = 0
      let closeCount = 0
      const enqueued: Array<SourceSyncQueuePayload> = []

      yield* Effect.scoped(
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
              Layer.provide(
                makeRepositoryLayer({ repairableJobs: [], attached: [], recovered: [] })
              ),
              Layer.provide(makeCalculationRunOrchestratorLayer()),
              Layer.provide(SyncEngineTransactionTestLive)
            )
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider())
        )
      )

      expect(acquireCount).toBe(1)
      expect(closeCount).toBe(1)
    })
  )

  it.effect("dispatches pending jobs and retries stale processing recovery", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runPendingDispatch({
          repairableJobs: [
            makeRepairableJob({ id: "job-pending", status: "pending" }),
            makeRepairableJob({ id: "job-processing", status: "processing" }),
          ],
          enqueued,
          attached,
          recovered,
        })
      )

      expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-pending"])
      expect(attached.map((params) => params.jobId)).toEqual(["job-pending"])
      expect(recovered).toEqual([
        expect.objectContaining({ jobId: "job-processing", sourceId: "source-1" }),
      ])
      expect(summary).toMatchObject({ scannedJobs: 2, requeuedPending: 1, failedProcessing: 1 })
    })
  )

  it.effect("dispatches only the follow-up linked to a completed job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []

      yield* Effect.promise(() => runDispatchFollowUp({ enqueued, attached }))

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
  )

  it.effect("requeues a pending job without queue metadata and records durable metadata", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [makeRepairableJob({ id: "job-pending", status: "pending" })],
          enqueued,
          attached,
          recovered,
        })
      )

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
  )

  it.effect(
    "uses deterministic job ids when reconciling a pending job that already has metadata",
    () =>
      Effect.gen(function* () {
        const enqueued: Array<SourceSyncQueuePayload> = []
        const attached: Array<AttachSourceSyncQueueMetadataParams> = []
        const recovered: Array<RecoverStaleSourceSyncJobParams> = []

        yield* Effect.promise(() =>
          runRepair({
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
        )

        expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-pending-with-metadata"])
        expect(attached.map((params) => params.queueJobId)).toEqual(["job-pending-with-metadata"])
        expect(recovered).toEqual([])
      })
  )

  it.effect("records BullMQ-assigned ids when enqueue returns a different id", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [makeRepairableJob({ id: "job-pending", status: "pending" })],
          enqueued,
          attached,
          recovered,
          queueOptions: {
            returnedJobIds: new Map([["job-pending", "bull-generated-job-id"]]),
          },
        })
      )

      expect(attached).toEqual([
        expect.objectContaining({
          jobId: "job-pending",
          queueJobId: "bull-generated-job-id",
        }),
      ])
    })
  )

  it.effect("logs attach metadata failures and continues repairing later jobs", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [
            makeRepairableJob({ id: "job-attach-fails", status: "pending" }),
            makeRepairableJob({ id: "job-next", status: "pending" }),
          ],
          enqueued,
          attached,
          recovered,
          attachFailureJobId: "job-attach-fails",
        })
      )

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
  )

  it.effect("logs attach metadata conflicts and continues repairing later jobs", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
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
      )

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
  )

  it.effect("logs enqueue failures and continues repairing later jobs", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
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
      )

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
  )

  it.effect("fails stale processing jobs instead of enqueueing duplicate work", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []
      const wokenPrincipals: Array<string> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [makeRepairableJob({ id: "job-processing", status: "processing" })],
          enqueued,
          attached,
          recovered,
          wokenPrincipals,
        })
      )

      expect(enqueued).toEqual([])
      expect(attached).toEqual([])
      expect(recovered).toEqual([
        expect.objectContaining({
          sourceId: "source-1",
          jobId: "job-processing",
          message: "Startup repair failed stale processing source sync job.",
        }),
      ])
      expect(wokenPrincipals).toEqual(["principal-1"])
      expect(summary).toMatchObject({
        scannedJobs: 1,
        requeuedPending: 0,
        failedProcessing: 1,
        skippedJobs: 0,
        erroredJobs: 0,
        stoppedAfterErrors: false,
      })
    })
  )

  it.effect("isolates a stale wake failure and leaves the principal recoverable", () =>
    Effect.gen(function* () {
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [makeRepairableJob({ id: "job-processing", status: "processing" })],
          enqueued: [],
          attached: [],
          recovered,
          wakeFailure: true,
        })
      )

      expect(recovered).toEqual([])
      expect(summary).toMatchObject({ erroredJobs: 1, stoppedAfterErrors: false })
    })
  )

  it.effect("continues with healthy queued work after one principal's stale wake fails", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [
            makeRepairableJob({ id: "job-poison", status: "processing" }),
            makeRepairableJob({
              id: "job-healthy",
              status: "pending",
              sourceId: "source-healthy",
              principalId: "principal-healthy",
            }),
          ],
          enqueued,
          attached,
          recovered,
          wakeFailure: true,
        })
      )

      expect(recovered).toEqual([])
      expect(enqueued.map(({ jobId }) => jobId)).toEqual(["job-healthy"])
      expect(attached.map(({ jobId }) => jobId)).toEqual(["job-healthy"])
      expect(summary).toMatchObject({
        scannedJobs: 2,
        requeuedPending: 1,
        failedProcessing: 0,
        erroredJobs: 1,
      })
    })
  )

  it.effect("repairs follow-up work materialized while recovering a stale job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: [makeRepairableJob({ id: "job-processing", status: "processing" })],
          materializedOnRecover: makeRepairableJob({ id: "job-follow-up", status: "pending" }),
          enqueued,
          attached,
          recovered,
        })
      )

      expect(enqueued.map((payload) => payload.jobId)).toEqual(["job-follow-up"])
      expect(attached.map((params) => params.jobId)).toEqual(["job-follow-up"])
      expect(summary).toMatchObject({
        scannedJobs: 2,
        requeuedPending: 1,
        failedProcessing: 1,
      })
    })
  )

  it.effect("logs stale processing conflicts and continues repairing later jobs", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
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
      )

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
  )

  it.effect("drains multiple clean batches until the repair backlog is below batch size", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []
      const jobs = Array.from({ length: 5 }, (_value, index) =>
        makeRepairableJob({ id: `job-${index + 1}`, status: "pending" })
      )

      const summary = yield* Effect.promise(() =>
        runRepair({
          repairableJobs: jobs,
          enqueued,
          attached,
          recovered,
          configOverrides: {
            SOURCE_SYNC_REPAIR_BATCH_SIZE: "2",
          },
        })
      )

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
  )

  it.effect("stops draining after a full batch has an errored job", () =>
    Effect.gen(function* () {
      const enqueued: Array<SourceSyncQueuePayload> = []
      const attached: Array<AttachSourceSyncQueueMetadataParams> = []
      const recovered: Array<RecoverStaleSourceSyncJobParams> = []

      const summary = yield* Effect.promise(() =>
        runRepair({
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
      )

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
  )
})
