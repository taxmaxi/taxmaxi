/**
 * ProviderAssetReplayServiceLive - Durable provider-asset replay orchestration.
 *
 * @module ProviderAssetReplayServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProviderAssetReplayError,
  ProviderAssetReplayService,
  ProviderAssetRepository,
  SourceSyncService,
  type ProviderAssetReviewReplay,
  type ProviderAssetReplayStatus,
} from "../services/index.ts"

const make = Effect.gen(function* () {
  const providerAssets = yield* ProviderAssetRepository
  const sourceSync = yield* SourceSyncService

  const loadReplay = ({
    providerAssetRowId,
    sourceId,
    jobId,
  }: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) =>
    providerAssets.findProviderAssetReviewReplay({ providerAssetRowId, sourceId, jobId }).pipe(
      Effect.mapError(
        () => new ProviderAssetReplayError({ kind: "internal", message: "Failed to load replay." })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProviderAssetReplayError({ kind: "not_found", message: "Replay not found." })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const markDispatch = ({
    providerAssetRowId,
    replay,
    dispatchState,
    errorMessage,
  }: {
    readonly providerAssetRowId: string
    readonly replay: ProviderAssetReviewReplay
    readonly dispatchState: "queued" | "failed_to_queue"
    readonly errorMessage: string | null
  }) =>
    providerAssets
      .markProviderAssetReviewReplayDispatch({
        providerAssetRowId,
        sourceId: replay.sourceId,
        jobId: replay.jobId,
        dispatchState,
        errorMessage,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ProviderAssetReplayError({
              kind: "internal",
              message: "Failed to record replay dispatch state.",
            })
        ),
        Effect.flatMap((effectiveJobId) =>
          effectiveJobId === null
            ? Effect.fail(
                new ProviderAssetReplayError({
                  kind: "conflict",
                  message: "Replay was scheduled by another request.",
                })
              )
            : Effect.succeed(effectiveJobId)
        )
      )

  const dispatchReplay = ({
    providerAssetRowId,
    replay,
  }: {
    readonly providerAssetRowId: string
    readonly replay: ProviderAssetReviewReplay
  }): Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReplayError> =>
    sourceSync
      .replaySourceSyncJob({
        principalId: replay.principalId,
        sourceId: replay.sourceId,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: () =>
            markDispatch({
              providerAssetRowId,
              replay,
              dispatchState: "failed_to_queue",
              errorMessage: "Failed to queue replay.",
            }).pipe(
              Effect.map((effectiveJobId) => ({
                sourceId: replay.sourceId,
                jobId: effectiveJobId,
                status: "failed_to_queue" as const,
                message: "Failed to queue replay.",
              }))
            ),
          onSuccess: (job) =>
            Effect.gen(function* () {
              if (job.jobId !== replay.jobId) {
                const replaced = yield* providerAssets
                  .replaceProviderAssetReviewReplay({
                    providerAssetRowId,
                    sourceId: replay.sourceId,
                    previousJobId: replay.jobId,
                    nextJobId: job.jobId,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new ProviderAssetReplayError({
                          kind: "internal",
                          message: "Failed to record replay job.",
                        })
                    )
                  )
                if (!replaced) {
                  return yield* new ProviderAssetReplayError({
                    kind: "conflict",
                    message: "Replay was scheduled by another request.",
                  })
                }
              } else {
                const effectiveJobId = yield* markDispatch({
                  providerAssetRowId,
                  replay,
                  dispatchState: "queued",
                  errorMessage: null,
                })
                if (effectiveJobId !== job.jobId) {
                  const advancedReplay = yield* loadReplay({
                    providerAssetRowId,
                    sourceId: replay.sourceId,
                    jobId: effectiveJobId,
                  })
                  return yield* getReplayStatus({ replay: advancedReplay })
                }
              }

              return {
                sourceId: replay.sourceId,
                jobId: job.jobId,
                status: job.status,
                message: job.message,
              }
            }),
        }),
        Effect.mapError((error) =>
          error instanceof ProviderAssetReplayError
            ? error
            : new ProviderAssetReplayError({
                kind: "internal",
                message: "Failed to schedule replay.",
              })
        )
      )

  const getReplayStatus = ({
    replay,
  }: {
    readonly replay: ProviderAssetReviewReplay
  }): Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReplayError> => {
    if (replay.dispatchState === "failed_to_queue") {
      return Effect.succeed({
        sourceId: replay.sourceId,
        jobId: replay.jobId,
        status: "failed_to_queue" as const,
        message: replay.errorMessage,
      })
    }

    return sourceSync
      .getSourceSyncJob({
        principalId: replay.principalId,
        sourceId: replay.sourceId,
        jobId: replay.jobId,
      })
      .pipe(
        Effect.map((status) => ({
          sourceId: replay.sourceId,
          jobId: replay.jobId,
          status: status.status,
          message: status.message,
        })),
        Effect.catchTag("SourceSyncJobNotFoundError", () =>
          Effect.succeed({
            sourceId: replay.sourceId,
            jobId: replay.jobId,
            status: "failed" as const,
            message: "Replay job no longer exists.",
          })
        ),
        Effect.mapError(
          () =>
            new ProviderAssetReplayError({
              kind: "internal",
              message: "Failed to load replay job.",
            })
        )
      )
  }

  return ProviderAssetReplayService.of({
    scheduleReplays: ({ providerAssetRowId, replays }) =>
      Effect.forEach(
        replays,
        (replay) =>
          replay.dispatchState === "failed_to_queue"
            ? dispatchReplay({ providerAssetRowId, replay })
            : getReplayStatus({ replay }),
        { concurrency: 5 }
      ),
    getReplay: (params) =>
      Effect.gen(function* () {
        const replay = yield* loadReplay(params)
        return yield* getReplayStatus({ replay })
      }),
    retryReplay: (params) =>
      Effect.gen(function* () {
        const replay = yield* loadReplay(params)
        let replayToDispatch = replay
        if (replay.dispatchState !== "failed_to_queue") {
          const status = yield* sourceSync
            .getSourceSyncJob({
              principalId: replay.principalId,
              sourceId: replay.sourceId,
              jobId: replay.jobId,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAssetReplayError({
                    kind: "internal",
                    message: "Failed to load replay job before retry.",
                  })
              )
            )
          if (status.status !== "failed") {
            return yield* new ProviderAssetReplayError({
              kind: "conflict",
              message: "Only failed replays can be retried.",
            })
          }
          replayToDispatch = yield* providerAssets
            .reserveProviderAssetReviewReplayRetry({
              providerAssetRowId: params.providerAssetRowId,
              sourceId: replay.sourceId,
              jobId: replay.jobId,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAssetReplayError({
                    kind: "internal",
                    message: "Failed to reserve replay retry.",
                  })
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new ProviderAssetReplayError({
                        kind: "conflict",
                        message: "Replay was retried by another request.",
                      })
                    ),
                  onSome: Effect.succeed,
                })
              )
            )
        }

        return yield* dispatchReplay({
          providerAssetRowId: params.providerAssetRowId,
          replay: replayToDispatch,
        })
      }),
  })
})

/** Live sync-engine layer for provider-asset replay status and retry. */
export const ProviderAssetReplayServiceLive = Layer.effect(ProviderAssetReplayService, make)
