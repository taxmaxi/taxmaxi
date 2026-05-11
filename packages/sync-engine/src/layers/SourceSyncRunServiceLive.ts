/**
 * SourceSyncRunServiceLive - API-facing user-wide sync run orchestration.
 *
 * @module SourceSyncRunServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  SourceRepository,
  SourceSyncRunNotFoundError,
  SourceSyncRunRepository,
  SourceSyncRunService,
  SourceSyncService,
  type SourceSyncRunDetails,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceError,
} from "../services/index.ts"
import { sourceSyncSpan } from "./internal/SourceSyncTelemetry.ts"

const makeRunDetails = ({
  run,
  items,
}: {
  readonly run: Omit<SourceSyncRunDetails, "items">
  readonly items: SourceSyncRunDetails["items"]
}): SourceSyncRunDetails => ({
  ...run,
  items,
})

const sourceStartFailureMessage = (
  error: Exclude<SourceSyncServiceError, { readonly _tag: "SyncEngineStorageError" }>
) => {
  switch (error._tag) {
    case "UnsupportedProviderError":
      return `Unsupported provider: ${error.provider}`
    case "SourceNotFoundError":
      return "Source was not found while starting the sync run."
    case "SourceSyncJobNotFoundError":
      return "Source sync job was not found while starting the sync run."
    case "SourceSyncQueueError":
      return "Failed to enqueue source sync job."
  }
}

const make = Effect.gen(function* () {
  const sourceRepository = yield* SourceRepository
  const sourceSyncRunRepository = yield* SourceSyncRunRepository
  const sourceSyncService = yield* SourceSyncService

  const recordRunItemDispatchFailure = ({
    runId,
    userId,
    sourceId,
    errorTag,
    message,
  }: {
    readonly runId: string
    readonly userId: string
    readonly sourceId: string
    readonly errorTag: string
    readonly message: string
  }) =>
    sourceSyncRunRepository
      .recordRunItemFailure({
        runId,
        sourceId,
        message,
      })
      .pipe(
        Effect.tap(() =>
          Effect.logError(
            {
              runId,
              userId,
              sourceId,
              errorTag,
            },
            "source-sync-run:item-dispatch-failed"
          )
        ),
        Effect.asVoid
      )

  const refreshRunDetails = ({
    runId,
    userId,
  }: {
    readonly runId: string
    readonly userId?: string
  }): ReturnType<SourceSyncRunServiceShape["getSyncRun"]> =>
    Effect.gen(function* () {
      const refreshParams = userId === undefined ? { runId } : { runId, userId }
      const run = yield* sourceSyncRunRepository
        .refreshRunStatus(refreshParams)
        .pipe(
          Effect.catchTag("SourceSyncRunRecordNotFoundError", (error) =>
            Effect.fail(new SourceSyncRunNotFoundError({ runId: error.runId }))
          )
        )
      const items = yield* sourceSyncRunRepository.listRunItems({ runId })

      return makeRunDetails({ run, items })
    })

  const startSyncRun: SourceSyncRunServiceShape["startSyncRun"] = ({ userId }) =>
    Effect.gen(function* () {
      const sources = yield* sourceRepository.listUserSourceSyncContexts({ userId })
      const run = yield* sourceSyncRunRepository.createRun({
        userId,
        requestedSourceCount: sources.length,
      })

      if (sources.length === 0) {
        return makeRunDetails({ run, items: [] })
      }

      yield* Effect.forEach(
        sources,
        (source) =>
          Effect.gen(function* () {
            yield* sourceSyncService
              .startSourceSyncJob({
                userId,
                sourceId: source.id,
              })
              .pipe(
                Effect.flatMap((started) =>
                  sourceSyncRunRepository.attachRunItem({
                    runId: run.id,
                    sourceId: source.id,
                    processingJobId: started.jobId,
                  })
                ),
                Effect.catchTags({
                  SourceNotFoundError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      userId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  SourceSyncJobNotFoundError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      userId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  SourceSyncQueueError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      userId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  UnsupportedProviderError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      userId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                })
              )
          }),
        { concurrency: 4 }
      )

      yield* Effect.logInfo(
        {
          runId: run.id,
          userId,
          sourceCount: sources.length,
        },
        "source-sync-run:started"
      )

      return yield* refreshRunDetails({ runId: run.id, userId })
    }).pipe(sourceSyncSpan({ name: "source-sync-run.start", attributes: { userId } }))

  const getSyncRun: SourceSyncRunServiceShape["getSyncRun"] = ({ userId, runId }) =>
    refreshRunDetails({ runId, userId }).pipe(
      sourceSyncSpan({ name: "source-sync-run.get", attributes: { userId, runId } })
    )

  return SourceSyncRunService.of({
    startSyncRun,
    getSyncRun,
  } satisfies SourceSyncRunServiceShape)
})

/**
 * SourceSyncRunServiceLive - Live user-wide source sync run orchestration layer.
 */
export const SourceSyncRunServiceLive = Layer.effect(SourceSyncRunService, make)
