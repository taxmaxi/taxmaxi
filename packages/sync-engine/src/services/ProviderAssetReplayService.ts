/**
 * ProviderAssetReplayService - Review-triggered replay orchestration contract.
 *
 * @module ProviderAssetReplayService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ProviderAssetReviewReplay } from "./ProviderAssetRepository.ts"

/** Per-source replay state exposed by the admin review contract. */
export interface ProviderAssetReplayStatus {
  readonly sourceId: string
  readonly jobId: string
  readonly status: "queued" | "running" | "completed" | "failed" | "failed_to_queue"
  readonly message: string | null
}

/** Failure category exposed by provider-asset replay operations. */
export const ProviderAssetReplayErrorKind = Schema.Union([
  Schema.Literal("conflict"),
  Schema.Literal("internal"),
  Schema.Literal("not_found"),
])
export type ProviderAssetReplayErrorKind = typeof ProviderAssetReplayErrorKind.Type

/** Stable failure returned by provider-asset replay orchestration. */
export class ProviderAssetReplayError extends Schema.TaggedError<ProviderAssetReplayError>()(
  "ProviderAssetReplayError",
  {
    kind: ProviderAssetReplayErrorKind,
    message: Schema.String,
  }
) {}

/** Durable identity of a replay requested by a provider-asset decision. */
export interface ProviderAssetReplayParams {
  readonly providerAssetRowId: string
  readonly sourceId: string
  readonly jobId: string
}

/** Sync-engine operations for reading and retrying decision-triggered replays. */
export interface ProviderAssetReplayServiceShape {
  readonly scheduleReplays: (params: {
    readonly providerAssetRowId: string
    readonly replays: ReadonlyArray<ProviderAssetReviewReplay>
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReplayStatus>, ProviderAssetReplayError>

  readonly getReplay: (
    params: ProviderAssetReplayParams
  ) => Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReplayError>

  readonly retryReplay: (
    params: ProviderAssetReplayParams
  ) => Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReplayError>
}

/** Context tag for provider-asset replay orchestration. */
export class ProviderAssetReplayService extends Context.Service<
  ProviderAssetReplayService,
  ProviderAssetReplayServiceShape
>()("ProviderAssetReplayService") {}
