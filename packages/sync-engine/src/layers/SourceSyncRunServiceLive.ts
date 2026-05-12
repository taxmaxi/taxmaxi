/**
 * SourceSyncRunServiceLive - API-facing principal-wide sync run orchestration.
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
    principalId,
    sourceId,
    errorTag,
    message,
  }: {
    readonly runId: string
    readonly principalId: string
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
              principalId,
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
    principalId,
  }: {
    readonly runId: string
    readonly principalId?: string
  }): ReturnType<SourceSyncRunServiceShape["getSyncRun"]> =>
    Effect.gen(function* () {
      const refreshParams = principalId === undefined ? { runId } : { runId, principalId }
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

  const startSyncRun: SourceSyncRunServiceShape["startSyncRun"] = ({ principalId }) =>
    Effect.gen(function* () {
      const sources = yield* sourceRepository.listPrincipalSourceSyncContexts({ principalId })
      const run = yield* sourceSyncRunRepository.createRun({
        principalId,
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
                principalId,
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
                      principalId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  SourceSyncJobNotFoundError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      principalId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  SourceSyncQueueError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      principalId,
                      sourceId: source.id,
                      errorTag: error._tag,
                      message: sourceStartFailureMessage(error),
                    }),
                  UnsupportedProviderError: (error) =>
                    recordRunItemDispatchFailure({
                      runId: run.id,
                      principalId,
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
          principalId,
          sourceCount: sources.length,
        },
        "source-sync-run:started"
      )

      return yield* refreshRunDetails({ runId: run.id, principalId })
    }).pipe(sourceSyncSpan({ name: "source-sync-run.start", attributes: { principalId } }))

  const getSyncRun: SourceSyncRunServiceShape["getSyncRun"] = ({ principalId, runId }) =>
    refreshRunDetails({ runId, principalId }).pipe(
      sourceSyncSpan({ name: "source-sync-run.get", attributes: { principalId, runId } })
    )

  return SourceSyncRunService.of({
    startSyncRun,
    getSyncRun,
  } satisfies SourceSyncRunServiceShape)
})

/**
 * SourceSyncRunServiceLive - Live principal-wide source sync run orchestration layer.
 */
export const SourceSyncRunServiceLive = Layer.effect(SourceSyncRunService, make)
