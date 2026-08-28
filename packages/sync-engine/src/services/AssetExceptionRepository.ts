/**
 * AssetExceptionRepository - Human asset-exception review persistence contract.
 *
 * @module AssetExceptionRepository
 */

import type {
  AssetExceptionClaim,
  AssetExceptionReason,
  AssetExceptionRematerializationStatus,
  AssetExceptionSeverity,
} from "@my/core/assets"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

export interface AssetExceptionImpact {
  readonly blockedReports: number
  readonly affectedPrincipals: number
  readonly affectedTransactions: number
  readonly affectedSources: number
  readonly affectedCalculations: number
  readonly existingGeneratedReportSnapshots: number
  readonly affectedTransactionValueEur: string | null
}

export interface AssetExceptionRankCursor extends AssetExceptionImpact {
  readonly severity: AssetExceptionSeverity
  /**
   * Creation time of the current actionable evaluation. A later actionable
   * evidence revision creates a new case, so its age starts over.
   */
  readonly oldestAt: Date
  readonly providerAssetRowId: string
}

export interface AssetExceptionListRow extends AssetExceptionRankCursor {
  readonly provider: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly providerType: string | null
  readonly reason: AssetExceptionReason
  readonly evidenceRevision: number
  readonly policyRevision: string
  readonly currentConclusionRevision: string
  readonly currentPolicyEvaluationRevision: string
}

export interface AssetExceptionEvidenceSnapshot {
  readonly id: string
  readonly authority: string
  readonly claimKind: string
  readonly sourceLocator: string | null
  readonly retrievedAt: Date
  readonly evidenceRevision: number
  readonly decodedClaim: unknown
  readonly rawPayload: unknown
}

export interface AssetExceptionDecisionHistory {
  readonly id: string
  readonly supersedesConclusionId: string | null
  readonly isCurrentConclusion: boolean
  readonly isCurrentPolicyEvaluation: boolean
  readonly outcome:
    | "attach"
    | "create_standalone"
    | "identity"
    | "excluded"
    | "pending"
    | "fail_closed"
  readonly claim: AssetExceptionClaim | null
  readonly rationale: string | null
  readonly reason: string | null
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly actorId: string
  readonly policyRevision: string
  readonly evidenceRevision: number
  readonly evidenceSnapshotIds: ReadonlyArray<string>
  readonly createdAt: Date
}

export interface AssetExceptionRematerializationSummary {
  readonly status: AssetExceptionRematerializationStatus
  readonly affectedSourceCount: number
  readonly pendingSourceCount: number
  readonly runningSourceCount: number
  readonly completedSourceCount: number
  readonly failedSourceCount: number
  readonly retryingSourceCount: number
  readonly remainingSourceCount: number
  readonly lastFailureAt: Date | null
  readonly failureCode: string | null
}

export interface AssetExceptionDetail {
  readonly providerAssetRowId: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly rawProviderPayload: unknown
  readonly evidenceRevision: number
  readonly currentConclusionRevision: string
  readonly currentPolicyEvaluationRevision: string
  readonly reviewStatus: "unresolved" | "approved" | "excluded"
  readonly currentConclusion: AssetExceptionDecisionHistory | null
  readonly currentPolicyEvaluation: AssetExceptionDecisionHistory | null
  readonly decisionHistory: ReadonlyArray<AssetExceptionDecisionHistory>
  readonly evidence: ReadonlyArray<AssetExceptionEvidenceSnapshot>
  readonly impact: AssetExceptionImpact
  readonly rematerialization: AssetExceptionRematerializationSummary
}

export type AssetExceptionLookup =
  | { readonly _tag: "row_id"; readonly providerAssetRowId: string }
  | {
      readonly _tag: "provider_asset_id"
      readonly provider: string
      readonly providerAssetId: string
    }
  | { readonly _tag: "natural_key"; readonly provider: string; readonly naturalKey: string }

export interface AssetExceptionDecisionInput {
  readonly providerAssetRowId: string
  readonly claim: AssetExceptionClaim
  readonly evidenceRevision: number
  readonly currentConclusionRevision: string
  readonly currentPolicyEvaluationRevision: string
  readonly evidenceSnapshotIds: ReadonlyArray<string>
  /** Optional for exclusions whose structured reason already explains the decision. */
  readonly rationale: string | null
}

export interface AssetExceptionObservationRevision {
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly currentConclusionRevision: string
  readonly currentPolicyEvaluationRevision: string
}

export interface AssetExceptionDecisionPreview {
  readonly claim: AssetExceptionClaim
  readonly decisionAction: "initial" | "supersession" | "reversal"
  readonly resultingAssetId: string | null
  readonly assetOutcome: "none" | "reuse" | "create"
  readonly representationOutcome: "none" | "reuse" | "create" | "reassign"
  readonly supersededConclusion: AssetExceptionDecisionHistory | null
  readonly impact: AssetExceptionImpact
  readonly rematerializationSourceCount: number
  readonly evidenceRevision: number
  readonly currentConclusionRevision: string
  readonly currentPolicyEvaluationRevision: string
  readonly affectedObservationRevisions: ReadonlyArray<AssetExceptionObservationRevision>
}

export interface AssetExceptionDecisionConfirmationInput extends AssetExceptionDecisionInput {
  readonly expectedResultingAssetId: string | null
  readonly expectedAssetOutcome: "none" | "reuse" | "create"
  readonly expectedRepresentationOutcome: "none" | "reuse" | "create" | "reassign"
  /** Required when one decision can update more than the focal observation. */
  readonly expectedAffectedObservationRevisions?: ReadonlyArray<AssetExceptionObservationRevision>
}

export type AssetExceptionPreviewResult =
  | { readonly _tag: "ready"; readonly preview: AssetExceptionDecisionPreview }
  | { readonly _tag: "not_found" }
  | {
      readonly _tag: "stale_revision"
      readonly evidenceRevision: number
      readonly currentConclusionRevision: string
      readonly currentPolicyEvaluationRevision: string
    }
  | { readonly _tag: "ambiguous_identity" }
  | { readonly _tag: "invalid_evidence" }
  | { readonly _tag: "invalid_claim" }

export type AssetExceptionDecisionResult =
  | { readonly _tag: "accepted"; readonly detail: AssetExceptionDetail }
  | { readonly _tag: "not_found" }
  | {
      readonly _tag: "stale_revision"
      readonly evidenceRevision: number
      readonly currentConclusionRevision: string
      readonly currentPolicyEvaluationRevision: string
    }
  | { readonly _tag: "ambiguous_identity" }
  | { readonly _tag: "identity_changed" }
  | { readonly _tag: "invalid_evidence" }
  | { readonly _tag: "invalid_claim" }

/** Ranked lookup, preview, and atomic decision operations for asset exceptions. */
export interface AssetExceptionRepositoryShape {
  readonly listExceptions: (params: {
    readonly cursor: AssetExceptionRankCursor | null
    readonly limit: number
    readonly query: string | null
  }) => Effect.Effect<ReadonlyArray<AssetExceptionListRow>, SyncEngineStorageError>

  readonly findDetail: (
    lookup: AssetExceptionLookup
  ) => Effect.Effect<Option.Option<AssetExceptionDetail>, SyncEngineStorageError>

  readonly previewDecision: (
    input: AssetExceptionDecisionInput
  ) => Effect.Effect<AssetExceptionPreviewResult, SyncEngineStorageError>

  readonly submitDecision: (params: {
    readonly input: AssetExceptionDecisionConfirmationInput
    readonly actorId: string
  }) => Effect.Effect<AssetExceptionDecisionResult, SyncEngineStorageError>
}

/** Persistence boundary for ranked asset exceptions and atomic human decisions. */
export class AssetExceptionRepository extends Context.Service<
  AssetExceptionRepository,
  AssetExceptionRepositoryShape
>()("AssetExceptionRepository") {}
