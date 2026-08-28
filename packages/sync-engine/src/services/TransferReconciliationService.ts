/**
 * TransferReconciliationService - Principal-scoped orchestration for matching provider-side
 * transfers against canonical onchain receipts.
 *
 * @module TransferReconciliationService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { DeterministicTransferCanonicalizationSummary } from "./TransferReconciliationRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ReconcileTransferCandidatesParams - Scope reconciliation to one principal-owned source.
 */
export interface ReconcileTransferCandidatesParams {
  readonly principalId: string
  readonly sourceId: string
  readonly affectedAssetIds?: ReadonlyArray<string>
  readonly rebuildFrom?: Date
}

/**
 * ApplyDeterministicInternalTransferCanonicalizationParams - Scope canonicalization
 * to one source or one principal-wide ordered rebuild, optionally narrowed to one review.
 */
export interface ApplyDeterministicInternalTransferCanonicalizationParams {
  readonly principalId: string
  /** One CEX source for normal sync, or null for a principal-wide ordered rebuild pass. */
  readonly sourceId: string | null
  readonly affectedAssetIds?: ReadonlyArray<string>
  readonly rebuildFrom?: Date
  readonly reconciliationId?: string
}

/**
 * TransferReconciliationSummary - High-level counters for one reconciliation pass.
 */
export interface TransferReconciliationSummary {
  readonly evaluatedProviderTransfers: number
  readonly pending: number
  readonly needsReview: number
  readonly autoApplied: number
}

/**
 * TransferReconciliationServiceShape - Reconciliation orchestration contract.
 */
export interface TransferReconciliationServiceShape {
  /**
   * Evaluate provider-side transfer candidates for one principal-owned source and persist
   * deterministic, ambiguous, or pending reconciliation state.
   */
  readonly reconcileTransferCandidates: (
    params: ReconcileTransferCandidatesParams
  ) => Effect.Effect<TransferReconciliationSummary, SyncEngineStorageError>

  /** Unapply cross-source reconciliation effects before replay resets a source. */
  readonly rollbackReconciliationsForSourceReplay: (params: {
    readonly sourceId: string
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Rewrite deterministic provider/onchain matches into canonical internal-transfer
   * tax state after reconciliation has been persisted for the current pass.
   */
  readonly applyDeterministicInternalTransferCanonicalization: (
    params: ApplyDeterministicInternalTransferCanonicalizationParams
  ) => Effect.Effect<DeterministicTransferCanonicalizationSummary, SyncEngineStorageError>
}

/**
 * TransferReconciliationService - Context tag for reconciliation orchestration.
 */
export class TransferReconciliationService extends Context.Service<
  TransferReconciliationService,
  TransferReconciliationServiceShape
>()("TransferReconciliationService") {}
