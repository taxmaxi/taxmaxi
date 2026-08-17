/**
 * ProviderAssetReviewService - Small public interface for provider asset decisions.
 *
 * @module ProviderAssetReviewService
 */

import {
  ProviderAssetMappingKindSchema,
  ProviderAssetMappingStatusSchema,
  type ProviderAssetEvidenceState,
  type ProviderAssetMappingStatus,
  type ProviderAssetObservedRepresentationRecord,
  type ProviderAssetReviewRecord,
  type ProviderAssetReplayStatus,
} from "@my/sync-engine/services"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Validated investigation destinations returned by review reads and proposals. */
export type ProviderAssetInvestigationLink =
  | {
      readonly _tag: "chain_explorer"
      readonly label: string
      readonly source: string
      readonly url: string
    }
  | {
      readonly _tag: "market_data" | "market_registry" | "provider_page"
      readonly label: string
      readonly source: string
      readonly url: string
    }

/** Queue row returned by the public review module. */
export interface ProviderAssetReviewSummary {
  readonly id: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly symbol: string
  readonly name: string | null
  readonly assetType: string | null
  readonly source: { readonly _tag: "cex" | "chain"; readonly name: string }
  readonly imageUrl: string | null
  readonly evidenceState: ProviderAssetEvidenceState
  readonly affectedSourceCount: number
  readonly discoveredAt: Date
  readonly reviewRevision: string
  readonly investigationLinks: ReadonlyArray<ProviderAssetInvestigationLink>
}

/** Complete review evidence and decision state for one provider observation. */
export interface ProviderAssetReviewDetail extends ProviderAssetReviewSummary {
  readonly rawEvidence: unknown
  readonly observedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
  readonly mapping: ProviderAssetReviewRecord["mapping"]
  readonly replays: ReadonlyArray<ProviderAssetReplayStatus>
}

/** The exact canonical mutation selected by an administrator. */
export type ProviderAssetResolutionEffect =
  | {
      readonly _tag: "UseExistingAsset"
      readonly canonicalAssetId: string
    }
  | {
      readonly _tag: "UseExistingRepresentation"
      readonly canonicalAssetId: string
      readonly assetRepresentationId: string
    }
  | {
      readonly _tag: "AddRepresentation"
      readonly canonicalAssetId: string
      readonly selectedCoinGeckoCoinId: string
    }
  | {
      readonly _tag: "CreateEconomicAsset"
      readonly selectedCoinGeckoCoinId: string
    }
  | {
      readonly _tag: "CreateAssetWithRepresentation"
      readonly selectedCoinGeckoCoinId: string
    }

/** One evidence-backed action offered to the review client. */
export interface ProviderAssetResolutionProposal {
  readonly id: string
  readonly effect: ProviderAssetResolutionEffect
  readonly economicAsset:
    | {
        readonly _tag: "existing"
        readonly id: string
        readonly name: string
        readonly symbol: string
        readonly coinGeckoCoinId: string | null
      }
    | {
        readonly _tag: "proposed"
        readonly coinGeckoCoinId: string
        readonly name: string
        readonly symbol: string
      }
  readonly representation:
    | {
        readonly _tag: "existing"
        readonly id: string
        readonly blockchainName: string
        readonly representationType: "native" | "token" | "nft"
        readonly contractAddress: string | null
        readonly mintAddress: string | null
        readonly decimals: number
      }
    | {
        readonly _tag: "proposed"
        readonly blockchainName: string
        readonly representationType: "native" | "token" | "nft"
        readonly contractAddress: string | null
        readonly mintAddress: string | null
        readonly decimals: number | null
      }
    | null
  readonly evidenceStrength: "exact" | "name_and_symbol" | "symbol_only"
  readonly matchReasons: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly investigationLinks: ReadonlyArray<ProviderAssetInvestigationLink>
}

/** Resolution search result with an optional deterministic recommendation. */
export interface ProviderAssetResolutionProposalSearchResult {
  readonly evidenceState: ProviderAssetEvidenceState
  readonly recommendedProposalId: string | null
  readonly proposals: ReadonlyArray<ProviderAssetResolutionProposal>
}

/** JSON-safe mapping state returned with stale-decision conflicts. */
export const ProviderAssetLatestDecisionSchema = Schema.Struct({
  providerAssetRowId: Schema.String,
  mappingKind: ProviderAssetMappingKindSchema,
  canonicalAssetId: Schema.NullOr(Schema.String),
  assetRepresentationId: Schema.NullOr(Schema.String),
  canonicalFiatCurrency: Schema.NullOr(Schema.String),
  mappingStatus: ProviderAssetMappingStatusSchema,
  reviewerNotes: Schema.NullOr(Schema.String),
  sourceNotes: Schema.NullOr(Schema.String),
  reviewedBy: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})

export type ProviderAssetLatestDecision = typeof ProviderAssetLatestDecisionSchema.Type

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
  {
    message: Schema.String,
    latestDecision: Schema.optional(Schema.NullOr(ProviderAssetLatestDecisionSchema)),
  }
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
      readonly _tag: "Resolve"
      readonly proposalId: string
      readonly effect: ProviderAssetResolutionEffect
    }
  | { readonly _tag: "Reject" }

/** Applied decision and its per-source replay states. */
export interface ProviderAssetReviewDecisionResult {
  readonly resolutionEffect: ProviderAssetResolutionEffect | null
  readonly replays: ReadonlyArray<ProviderAssetReplayStatus>
}

/** Public review contract used by REST handlers and tests. */
export interface ProviderAssetReviewServiceShape {
  readonly listReviews: (params: {
    readonly provider: string | null
    readonly status: ProviderAssetMappingStatus | null
    readonly evidenceState: ProviderAssetEvidenceState | null
    readonly query: string | null
    readonly cursor: {
      readonly discoveredAt: Date
      readonly providerAssetRowId: string
    } | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReviewSummary>, ProviderAssetReviewError>

  readonly getReview: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ProviderAssetReviewDetail, ProviderAssetReviewError>

  readonly searchProposals: (params: {
    readonly providerAssetRowId: string
    readonly query: string | null
  }) => Effect.Effect<ProviderAssetResolutionProposalSearchResult, ProviderAssetReviewError>

  readonly decide: (params: {
    readonly providerAssetRowId: string
    readonly decision: ProviderAssetDecision
    readonly reviewRevision: string
    readonly reviewerNotes: string | null
    readonly reviewedBy: string
  }) => Effect.Effect<ProviderAssetReviewDecisionResult, ProviderAssetReviewError>

  readonly getReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReviewError>

  readonly retryReplay: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<ProviderAssetReplayStatus, ProviderAssetReviewError>
}

/** Context tag for provider-asset review operations. */
export class ProviderAssetReviewService extends Context.Service<
  ProviderAssetReviewService,
  ProviderAssetReviewServiceShape
>()("ProviderAssetReviewService") {}
