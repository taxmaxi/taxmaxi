import { describe, expect, it } from "vitest"
import { ProviderAssetReplayServiceLive } from "@my/sync-engine/layers"
import {
  ProviderAssetReplayService,
  ProviderAssetRepository,
  SourceSyncQueueError,
  SourceSyncService,
  type ProviderAssetRepositoryShape,
  type ProviderAssetReviewReplay,
  type SourceSyncServiceShape,
} from "@my/sync-engine/services"
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

const unexpected = () => Effect.die("Unexpected test call")

describe("ProviderAssetReplayService", () => {
  it("returns independent statuses when one source fails to queue", async () => {
    const failedReplay: ProviderAssetReviewReplay = {
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      jobId: JOB_ID,
      dispatchState: "queued",
      errorMessage: null,
    }
    const queuedReplay: ProviderAssetReviewReplay = {
      sourceId: SECOND_SOURCE_ID,
      principalId: SECOND_PRINCIPAL_ID,
      jobId: SECOND_JOB_ID,
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
      markProviderAssetReviewReplayDispatch: ({ sourceId, dispatchState }) =>
        Effect.sync(() => {
          dispatchStates.set(sourceId, dispatchState)
          return true
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
          ? Effect.fail(
              new SourceSyncQueueError({ operation: "test.replay", cause: "queue unavailable" })
            )
          : Effect.succeed({
              sourceId: SECOND_SOURCE_ID,
              jobId: SECOND_JOB_ID,
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

    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.scheduleReplays({
          providerAssetRowId: PROVIDER_ASSET_ID,
          replays: [failedReplay, queuedReplay],
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
    ])
    expect(dispatchStates).toEqual(
      new Map([
        [SOURCE_ID, "failed_to_queue"],
        [SECOND_SOURCE_ID, "queued"],
      ])
    )
  })

  it("keeps a durable failed-to-queue link and retries it", async () => {
    let queueShouldFail = true
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
      markProviderAssetReviewReplayDispatch: ({ dispatchState, errorMessage }) =>
        Effect.sync(() => {
          replay = { ...replay, dispatchState, errorMessage }
          return true
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
              jobId: NEXT_JOB_ID,
              status: "queued",
              message: null,
            }),
      getSourceSyncJob: () =>
        Effect.succeed({
          sourceId: SOURCE_ID,
          jobId: NEXT_JOB_ID,
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
    const retryCompleted = run(
      Effect.flatMap(ProviderAssetReplayService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: NEXT_JOB_ID,
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
    expect(replay.jobId).toBe(NEXT_JOB_ID)
    expect(replay.dispatchState).toBe("queued")
    await expect(retryCompleted).rejects.toMatchObject({
      _tag: "ProviderAssetReplayError",
      kind: "conflict",
    })
  })
})
