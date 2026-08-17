/**
 * ProviderAssetReviewService - Small public interface for provider asset decisions.
 *
 * @module ProviderAssetReviewService
 */

import type {
  EconomicAssetRepresentationRecord,
  ProviderAssetReviewRecord,
  ProviderAssetReviewReplay,
  SourceSyncJobDetails,
  SourceSyncJobSummary,
} from "@my/sync-engine/services"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AssetCanonicalizationEvidence } from "./AssetCanonicalizationService.ts"
import type { ProviderAssetCandidate } from "./ProviderAssetCandidateService.ts"

/** The reviewed provider asset or replay link does not exist. */
export class ProviderAssetReviewNotFoundError extends Schema.TaggedError<ProviderAssetReviewNotFoundError>()(
  "ProviderAssetReviewNotFoundError",
  { message: Schema.String }
) {}

/** The requested decision does not match the available evidence. */
export class ProviderAssetReviewBadRequestError extends Schema.TaggedError<ProviderAssetReviewBadRequestError>()(
  "ProviderAssetReviewBadRequestError",
  { message: Schema.String }
) {}

/** Another reviewer or retry request already changed the target row. */
export class ProviderAssetReviewConflictError extends Schema.TaggedError<ProviderAssetReviewConflictError>()(
  "ProviderAssetReviewConflictError",
  { message: Schema.String }
) {}

/** An internal dependency prevented the review operation from completing. */
export class ProviderAssetReviewInternalError extends Schema.TaggedError<ProviderAssetReviewInternalError>()(
  "ProviderAssetReviewInternalError",
  { message: Schema.String }
) {}

/** Failures exposed by the provider-asset review interface. */
export type ProviderAssetReviewError =
  | ProviderAssetReviewBadRequestError
  | ProviderAssetReviewConflictError
  | ProviderAssetReviewInternalError
  | ProviderAssetReviewNotFoundError

/** Explicit administrator choices supported by the review interface. */
export type ProviderAssetDecision =
  | {
      readonly _tag: "MapToExisting"
      readonly canonicalAssetId: string
      readonly assetRepresentationId: string | null
    }
  | { readonly _tag: "CreateFromCoinGecko"; readonly coinId: string }
  | { readonly _tag: "ApproveAsFiat" }
  | { readonly _tag: "Reject"; readonly reason: string }

/** Persisted decision, optional canonical evidence, and triggered replay links. */
export interface ProviderAssetReviewDecisionResult {
  readonly providerAsset: ProviderAssetReviewRecord
  readonly canonicalAsset: EconomicAssetRepresentationRecord | null
  readonly evidence: AssetCanonicalizationEvidence | null
  readonly replays: ReadonlyArray<ProviderAssetReviewReplay>
}

/** Public review contract used by REST handlers and tests. */
export interface ProviderAssetReviewServiceShape {
  readonly listCandidates: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<ProviderAssetCandidate>, ProviderAssetReviewError>

  readonly decide: (params: {
    readonly providerAssetRowId: string
    readonly decision: ProviderAssetDecision
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<ProviderAssetReviewDecisionResult, ProviderAssetReviewError>

  readonly getReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<SourceSyncJobDetails, ProviderAssetReviewError>

  readonly retryReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<SourceSyncJobSummary, ProviderAssetReviewError>
}

/** Context tag for provider-asset review operations. */
export class ProviderAssetReviewService extends Context.Service<
  ProviderAssetReviewService,
  ProviderAssetReviewServiceShape
>()("ProviderAssetReviewService") {}
