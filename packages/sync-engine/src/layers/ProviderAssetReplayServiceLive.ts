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

  return ProviderAssetReplayService.of({
    getReplay: (params) =>
      Effect.gen(function* () {
        const replay = yield* loadReplay(params)
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
                  message: "Failed to load replay job.",
                })
            )
          )
        return { ...status, jobId: replay.jobId }
      }),
    retryReplay: (params) =>
      Effect.gen(function* () {
        const replay = yield* loadReplay(params)
        const job = yield* sourceSync
          .replaySourceSyncJob({ principalId: replay.principalId, sourceId: replay.sourceId })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderAssetReplayError({
                  kind: "internal",
                  message: "Failed to retry replay.",
                })
            )
          )
        const replaced = yield* providerAssets
          .replaceProviderAssetReviewReplay({
            providerAssetRowId: params.providerAssetRowId,
            sourceId: params.sourceId,
            previousJobId: params.jobId,
            nextJobId: job.jobId,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderAssetReplayError({
                  kind: "internal",
                  message: "Failed to record replay retry.",
                })
            )
          )
        if (!replaced) {
          return yield* new ProviderAssetReplayError({
            kind: "conflict",
            message: "Replay was retried by another request.",
          })
        }
        return job
      }),
  })
})

/** Live sync-engine layer for provider-asset replay status and retry. */
export const ProviderAssetReplayServiceLive = Layer.effect(ProviderAssetReplayService, make)
