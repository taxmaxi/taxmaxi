import { describe, expect, it } from "vitest"
import { ProviderAssetReplayServiceLive } from "@my/sync-engine/layers"
import {
  ProviderAssetReplayService,
  ProviderAssetRepository,
  SourceNotFoundError,
  SourceSyncJobNotFoundError,
  SourceSyncQueueError,
  SourceSyncService,
  SyncEngineStorageError,
  UnsupportedProviderError,
  type ProviderAssetRepositoryShape,
  type ProviderAssetReviewReplay,
  type SourceSyncServiceShape,
} from "@my/sync-engine/services"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000001"
const SOURCE_ID = "00000000-0000-4000-8000-000000000002"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000003"
const JOB_ID = "00000000-0000-4000-8000-000000000004"
const NEXT_JOB_ID = "00000000-0000-4000-8000-000000000005"
const SECOND_SOURCE_ID = "00000000-0000-4000-8000-000000000006"
const SECOND_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000007"
const SECOND_JOB_ID = "00000000-0000-4000-8000-000000000008"
const THIRD_JOB_ID = "00000000-0000-4000-8000-000000000009"
const DISPATCHED_SOURCE_ID = "00000000-0000-4000-8000-000000000010"
const DISPATCHED_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000011"
const DISPATCHED_JOB_ID = "00000000-0000-4000-8000-000000000012"

const unexpected = () => Effect.die("Unexpected test call")

const dispatchFailures = [
  {
    name: "queue failure",
    error: new SourceSyncQueueError({ operation: "test.replay", cause: "queue unavailable" }),
  },
  {
    name: "deleted source",
    error: new SourceNotFoundError({ sourceId: SOURCE_ID }),
  },
  {
    name: "unsupported provider",
    error: new UnsupportedProviderError({ provider: "unsupported" }),
  },
  {
    name: "storage failure",
    error: new SyncEngineStorageError({ operation: "test.replay", cause: "storage unavailable" }),
  },
] as const

describe("ProviderAssetReplayService", () => {
  it.each(dispatchFailures)(
    "returns independent statuses when one source has a $name",
    async ({ error }) => {
      const failedReplay: ProviderAssetReviewReplay = {
        sourceId: SOURCE_ID,
        principalId: PRINCIPAL_ID,
        jobId: JOB_ID,
        dispatchState: "failed_to_queue",
        errorMessage: null,
      }
      const queuedReplay: ProviderAssetReviewReplay = {
        sourceId: SECOND_SOURCE_ID,
        principalId: SECOND_PRINCIPAL_ID,
        jobId: SECOND_JOB_ID,
        dispatchState: "failed_to_queue",
        errorMessage: null,
      }
      const dispatchedReplay: ProviderAssetReviewReplay = {
        sourceId: DISPATCHED_SOURCE_ID,
        principalId: DISPATCHED_PRINCIPAL_ID,
        jobId: DISPATCHED_JOB_ID,
        dispatchState: "queued",
        errorMessage: null,
      }
      const dispatchStates = new Map<string, "queued" | "failed_to_queue">()

      const repository: ProviderAssetRepositoryShape = {
        upsertProviderAssets: unexpected,
        upsertProviderAssetMappings: unexpected,
        approveProviderAssetMappingAndRequestReplay: unexpected,
        rejectProviderAssetMapping: unexpected,
        findProviderAssetReviewReplay: unexpected,
        listProviderAssetReviewReplays: unexpected,
        replaceProviderAssetReviewReplay: unexpected,
        reserveProviderAssetReviewReplayRetry: unexpected,
        markProviderAssetReviewReplayDispatch: ({ sourceId, dispatchState }) =>
          Effect.sync(() => {
            dispatchStates.set(sourceId, dispatchState)
            return sourceId === SOURCE_ID ? JOB_ID : SECOND_JOB_ID
          }),
        lockProviderAssetApprovalSnapshot: unexpected,
        recordProviderAssetSourceUses: unexpected,
        seedProviderAssetMappingsIfMissing: unexpected,
        findProviderAssetByProviderAssetId: unexpected,
        findProviderAssetByNaturalKey: unexpected,
        findProviderAssetByCurrencyCode: unexpected,
        findProviderAssetReviewById: unexpected,
        listProviderAssetReviews: unexpected,
        listProviderAssetObservedRepresentations: unexpected,
        findProviderAssetMapping: unexpected,
      }
      const sourceSync: SourceSyncServiceShape = {
        startSourceSyncJob: unexpected,
        replaySourceSyncJob: ({ sourceId }) =>
          sourceId === SOURCE_ID
            ? Effect.fail(error)
            : Effect.succeed({
                sourceId: SECOND_SOURCE_ID,
                jobId: SECOND_JOB_ID,
                status: "queued",
                message: null,
              }),
        getSourceSyncJob: ({ sourceId, jobId }) =>
          Effect.succeed({
            sourceId,
            jobId,
            status: "completed",
            message: null,
            phase: null,
            processedRecords: null,
            totalRecords: null,
            progressPercent: null,
            importedRecords: null,
            normalizedRecords: null,
            failedRecords: null,
          }),
      }
      const layer = ProviderAssetReplayServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderAssetRepository, repository),
            Layer.succeed(SourceSyncService, sourceSync)
          )
        )
      )

      const result = await Effect.runPromise(
        Effect.flatMap(ProviderAssetReplayService, (service) =>
          service.scheduleReplays({
            providerAssetRowId: PROVIDER_ASSET_ID,
            replays: [failedReplay, queuedReplay, dispatchedReplay],
          })
        ).pipe(Effect.provide(layer))
      )

      expect(result).toEqual([
        {
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
          status: "failed_to_queue",
          message: "Failed to queue replay.",
        },
        {
          sourceId: SECOND_SOURCE_ID,
          jobId: SECOND_JOB_ID,
          status: "queued",
          message: null,
        },
        {
          sourceId: DISPATCHED_SOURCE_ID,
          jobId: DISPATCHED_JOB_ID,
          status: "completed",
          message: null,
        },
      ])
      expect(dispatchStates).toEqual(
        new Map([
          [SOURCE_ID, "failed_to_queue"],
          [SECOND_SOURCE_ID, "queued"],
        ])
      )
    }
  )

  it("returns a conflict when the replay dispatch compare-and-set misses", async () => {
    const replay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "failed_to_queue",
      errorMessage: null,
    }
    const repository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: unexpected,
      upsertProviderAssetMappings: unexpected,
      approveProviderAssetMappingAndRequestReplay: unexpected,
      rejectProviderAssetMapping: unexpected,
      findProviderAssetReviewReplay: unexpected,
      listProviderAssetReviewReplays: unexpected,
      replaceProviderAssetReviewReplay: unexpected,
      reserveProviderAssetReviewReplayRetry: unexpected,
      markProviderAssetReviewReplayDispatch: () => Effect.succeed(null),
      lockProviderAssetApprovalSnapshot: unexpected,
      recordProviderAssetSourceUses: unexpected,
      seedProviderAssetMappingsIfMissing: unexpected,
      findProviderAssetByProviderAssetId: unexpected,
      findProviderAssetByNaturalKey: unexpected,
      findProviderAssetByCurrencyCode: unexpected,
      findProviderAssetReviewById: unexpected,
      listProviderAssetReviews: unexpected,
      listProviderAssetObservedRepresentations: unexpected,
      findProviderAssetMapping: unexpected,
    }
    const sourceSync: SourceSyncServiceShape = {
      startSourceSyncJob: unexpected,
      replaySourceSyncJob: () =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
          status: "queued",
          message: null,
        }),
      getSourceSyncJob: unexpected,
    }
    const layer = ProviderAssetReplayServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(SourceSyncService, sourceSync)
        )
      )
    )

    const result = Effect.flatMap(ProviderAssetReplayService, (service) =>
      service.scheduleReplays({ providerAssetRowId: PROVIDER_ASSET_ID, replays: [replay] })
    ).pipe(Effect.provide(layer), Effect.runPromise)

    await expect(result).rejects.toMatchObject({
      _tag: "ProviderAssetReplayError",
      kind: "conflict",
    })
  })

  it("returns the follow-up job when dispatch completion advances the replay link", async () => {
    const replay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "failed_to_queue",
      errorMessage: null,
    }
    const advancedReplay: ProviderAssetReviewReplay = {
      ...replay,
      jobId: NEXT_JOB_ID,
      dispatchState: "queued",
    }
    const repository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: unexpected,
      upsertProviderAssetMappings: unexpected,
      approveProviderAssetMappingAndRequestReplay: unexpected,
      rejectProviderAssetMapping: unexpected,
      findProviderAssetReviewReplay: ({ jobId }) =>
        Effect.succeed(jobId === NEXT_JOB_ID ? Option.some(advancedReplay) : Option.none()),
      listProviderAssetReviewReplays: unexpected,
      replaceProviderAssetReviewReplay: unexpected,
      reserveProviderAssetReviewReplayRetry: unexpected,
      markProviderAssetReviewReplayDispatch: () => Effect.succeed(NEXT_JOB_ID),
      lockProviderAssetApprovalSnapshot: unexpected,
      recordProviderAssetSourceUses: unexpected,
      seedProviderAssetMappingsIfMissing: unexpected,
      findProviderAssetByProviderAssetId: unexpected,
      findProviderAssetByNaturalKey: unexpected,
      findProviderAssetByCurrencyCode: unexpected,
      findProviderAssetReviewById: unexpected,
      listProviderAssetReviews: unexpected,
      listProviderAssetObservedRepresentations: unexpected,
      findProviderAssetMapping: unexpected,
    }
    const sourceSync: SourceSyncServiceShape = {
      startSourceSyncJob: unexpected,
      replaySourceSyncJob: () =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
          status: "queued",
          message: null,
        }),
      getSourceSyncJob: ({ jobId }) =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId,
          status: "queued",
          message: null,
          phase: null,
          processedRecords: null,
          totalRecords: null,
          progressPercent: null,
          importedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
    }
    const layer = ProviderAssetReplayServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(SourceSyncService, sourceSync)
        )
      )
    )

    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.scheduleReplays({ providerAssetRowId: PROVIDER_ASSET_ID, replays: [replay] })
      ).pipe(Effect.provide(layer))
    )

    expect(result).toEqual([
      {
        sourceId: SOURCE_ID,
        jobId: NEXT_JOB_ID,
        status: "queued",
        message: null,
      },
    ])
  })

  it("returns a stable failed status when a queued replay job no longer exists", async () => {
    const replay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "queued",
      errorMessage: null,
    }
    const repository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: unexpected,
      upsertProviderAssetMappings: unexpected,
      approveProviderAssetMappingAndRequestReplay: unexpected,
      rejectProviderAssetMapping: unexpected,
      findProviderAssetReviewReplay: () => Effect.succeed(Option.some(replay)),
      listProviderAssetReviewReplays: unexpected,
      replaceProviderAssetReviewReplay: unexpected,
      reserveProviderAssetReviewReplayRetry: unexpected,
      markProviderAssetReviewReplayDispatch: unexpected,
      lockProviderAssetApprovalSnapshot: unexpected,
      recordProviderAssetSourceUses: unexpected,
      seedProviderAssetMappingsIfMissing: unexpected,
      findProviderAssetByProviderAssetId: unexpected,
      findProviderAssetByNaturalKey: unexpected,
      findProviderAssetByCurrencyCode: unexpected,
      findProviderAssetReviewById: unexpected,
      listProviderAssetReviews: unexpected,
      listProviderAssetObservedRepresentations: unexpected,
      findProviderAssetMapping: unexpected,
    }
    const sourceSync: SourceSyncServiceShape = {
      startSourceSyncJob: unexpected,
      replaySourceSyncJob: unexpected,
      getSourceSyncJob: () =>
        Effect.fail(new SourceSyncJobNotFoundError({ sourceId: SOURCE_ID, jobId: JOB_ID })),
    }
    const layer = ProviderAssetReplayServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(SourceSyncService, sourceSync)
        )
      )
    )

    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.getReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      ).pipe(Effect.provide(layer))
    )

    expect(result).toEqual({
      sourceId: SOURCE_ID,
      jobId: JOB_ID,
      status: "failed",
      message: "Replay job no longer exists.",
    })
  })

  it("lets only one concurrent failed-job retry reserve, link, and dispatch", async () => {
    const initialReplay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "queued",
      errorMessage: null,
    }
    let linkedReplay: ProviderAssetReviewReplay = initialReplay
    let loadCount = 0
    let reservationCount = 0
    let dispatchCount = 0
    let linkCount = 0
    const bothRequestsLoaded = await Effect.runPromise(Deferred.make<void>())

    const repository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: unexpected,
      upsertProviderAssetMappings: unexpected,
      approveProviderAssetMappingAndRequestReplay: unexpected,
      rejectProviderAssetMapping: unexpected,
      findProviderAssetReviewReplay: () =>
        Effect.gen(function* () {
          loadCount += 1
          if (loadCount === 2) {
            yield* Deferred.succeed(bothRequestsLoaded, undefined)
          }
          yield* Deferred.await(bothRequestsLoaded)
          return Option.some(initialReplay)
        }),
      listProviderAssetReviewReplays: unexpected,
      replaceProviderAssetReviewReplay: unexpected,
      reserveProviderAssetReviewReplayRetry: () =>
        Effect.sync(() => {
          reservationCount += 1
          if (linkedReplay.jobId !== JOB_ID) return Option.none()

          linkedReplay = {
            ...initialReplay,
            jobId: NEXT_JOB_ID,
            dispatchState: "failed_to_queue",
          }
          linkCount += 1
          return Option.some(linkedReplay)
        }),
      markProviderAssetReviewReplayDispatch: ({ jobId, dispatchState, errorMessage }) =>
        Effect.sync(() => {
          if (linkedReplay.jobId !== jobId) return null
          linkedReplay = { ...linkedReplay, dispatchState, errorMessage }
          return linkedReplay.jobId
        }),
      lockProviderAssetApprovalSnapshot: unexpected,
      recordProviderAssetSourceUses: unexpected,
      seedProviderAssetMappingsIfMissing: unexpected,
      findProviderAssetByProviderAssetId: unexpected,
      findProviderAssetByNaturalKey: unexpected,
      findProviderAssetByCurrencyCode: unexpected,
      findProviderAssetReviewById: unexpected,
      listProviderAssetReviews: unexpected,
      listProviderAssetObservedRepresentations: unexpected,
      findProviderAssetMapping: unexpected,
    }
    const sourceSync: SourceSyncServiceShape = {
      startSourceSyncJob: unexpected,
      replaySourceSyncJob: () =>
        Effect.sync(() => {
          dispatchCount += 1
          return {
            sourceId: SOURCE_ID,
            jobId: NEXT_JOB_ID,
            status: "queued" as const,
            message: null,
          }
        }),
      getSourceSyncJob: ({ jobId }) =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId,
          status: "failed",
          message: "Replay processing failed.",
          phase: null,
          processedRecords: null,
          totalRecords: null,
          progressPercent: null,
          importedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
    }
    const layer = ProviderAssetReplayServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(SourceSyncService, sourceSync)
        )
      )
    )
    const retry = Effect.flatMap(ProviderAssetReplayService, (service) =>
      service.retryReplay({
        providerAssetRowId: PROVIDER_ASSET_ID,
        sourceId: SOURCE_ID,
        jobId: JOB_ID,
      })
    ).pipe(Effect.result)

    const results = await Effect.runPromise(
      Effect.all([retry, retry], { concurrency: "unbounded" }).pipe(Effect.provide(layer))
    )
    const success = results.find((result) => result._tag === "Success")
    const conflict = results.find((result) => result._tag === "Failure")
    if (success?._tag !== "Success" || conflict?._tag !== "Failure") {
      expect.fail("Expected one successful retry and one retry conflict")
    }

    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
    expect(success.success).toEqual({
      sourceId: SOURCE_ID,
      jobId: NEXT_JOB_ID,
      status: "queued",
      message: null,
    })
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
    expect(conflict.failure).toMatchObject({
      _tag: "ProviderAssetReplayError",
      kind: "conflict",
    })
    expect({ reservationCount, dispatchCount, linkCount }).toEqual({
      reservationCount: 2,
      dispatchCount: 1,
      linkCount: 1,
    })
    expect(linkedReplay).toMatchObject({
      jobId: NEXT_JOB_ID,
      dispatchState: "queued",
      errorMessage: null,
    })
  })

  it("retries both failed-to-queue and queued jobs that later fail", async () => {
    let queueShouldFail = true
    let queuedJobId = NEXT_JOB_ID
    let jobStatus: "failed" | "completed" = "failed"
    let replay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "failed_to_queue",
      errorMessage: null,
    }

    const repository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: unexpected,
      upsertProviderAssetMappings: unexpected,
      approveProviderAssetMappingAndRequestReplay: unexpected,
      rejectProviderAssetMapping: unexpected,
      findProviderAssetReviewReplay: () => Effect.sync(() => Option.some(replay)),
      listProviderAssetReviewReplays: unexpected,
      replaceProviderAssetReviewReplay: ({ nextJobId }) =>
        Effect.sync(() => {
          replay = {
            ...replay,
            jobId: nextJobId,
            dispatchState: "queued",
            errorMessage: null,
          }
          return true
        }),
      reserveProviderAssetReviewReplayRetry: () =>
        Effect.sync(() => {
          replay = {
            ...replay,
            jobId: queuedJobId,
            dispatchState: "failed_to_queue",
            errorMessage: null,
          }
          return Option.some(replay)
        }),
      markProviderAssetReviewReplayDispatch: ({ dispatchState, errorMessage }) =>
        Effect.sync(() => {
          replay = { ...replay, dispatchState, errorMessage }
          return replay.jobId
        }),
      lockProviderAssetApprovalSnapshot: unexpected,
      recordProviderAssetSourceUses: unexpected,
      seedProviderAssetMappingsIfMissing: unexpected,
      findProviderAssetByProviderAssetId: unexpected,
      findProviderAssetByNaturalKey: unexpected,
      findProviderAssetByCurrencyCode: unexpected,
      findProviderAssetReviewById: unexpected,
      listProviderAssetReviews: unexpected,
      listProviderAssetObservedRepresentations: unexpected,
      findProviderAssetMapping: unexpected,
    }
    const sourceSync: SourceSyncServiceShape = {
      startSourceSyncJob: unexpected,
      replaySourceSyncJob: () =>
        queueShouldFail
          ? Effect.fail(
              new SourceSyncQueueError({ operation: "test.replay", cause: "queue unavailable" })
            )
          : Effect.succeed({
              sourceId: SOURCE_ID,
              jobId: queuedJobId,
              status: "queued",
              message: null,
            }),
      getSourceSyncJob: () =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId: replay.jobId,
          status: jobStatus,
          message: jobStatus === "failed" ? "Replay processing failed." : null,
          phase: null,
          processedRecords: null,
          totalRecords: null,
          progressPercent: null,
          importedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
    }
    const layer = ProviderAssetReplayServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(SourceSyncService, sourceSync)
        )
      )
    )
    const run = <A>(effect: Effect.Effect<A, unknown, ProviderAssetReplayService>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))

    const failedToQueue = await run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.scheduleReplays({ providerAssetRowId: PROVIDER_ASSET_ID, replays: [replay] })
      )
    )
    const persistedFailure = await run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.getReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      )
    )

    queueShouldFail = false
    const retried = await run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      )
    )
    const persistedJobFailure = await run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.getReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: NEXT_JOB_ID,
        })
      )
    )

    queuedJobId = THIRD_JOB_ID
    const retriedJobFailure = await run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: NEXT_JOB_ID,
        })
      )
    )

    jobStatus = "completed"
    const retryCompleted = run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: THIRD_JOB_ID,
        })
      )
    )

    expect(failedToQueue).toEqual([
      {
        sourceId: SOURCE_ID,
        jobId: JOB_ID,
        status: "failed_to_queue",
        message: "Failed to queue replay.",
      },
    ])
    expect(persistedFailure).toEqual(failedToQueue[0])
    expect(retried).toEqual({
      sourceId: SOURCE_ID,
      jobId: NEXT_JOB_ID,
      status: "queued",
      message: null,
    })
    expect(persistedJobFailure).toEqual({
      sourceId: SOURCE_ID,
      jobId: NEXT_JOB_ID,
      status: "failed",
      message: "Replay processing failed.",
    })
    expect(retriedJobFailure).toEqual({
      sourceId: SOURCE_ID,
      jobId: THIRD_JOB_ID,
      status: "queued",
      message: null,
    })
    expect(replay.jobId).toBe(THIRD_JOB_ID)
    expect(replay.dispatchState).toBe("queued")
    await expect(retryCompleted).rejects.toMatchObject({
      _tag: "ProviderAssetReplayError",
      kind: "conflict",
    })
  })
})
