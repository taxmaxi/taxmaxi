/**
 * TransferReconciliationService - User-scoped orchestration for matching provider-side
 * transfers against canonical onchain receipts.
 *
 * @module TransferReconciliationService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { DeterministicTransferCanonicalizationSummary } from "./TransferReconciliationRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ReconcileTransferCandidatesParams - Scope reconciliation to one user-owned source.
 */
export interface ReconcileTransferCandidatesParams {
  readonly userId: string
  readonly sourceId: string
}

/**
 * ApplyDeterministicInternalTransferCanonicalizationParams - Scope canonicalization
 * to a source, optionally narrowed to one reviewed reconciliation.
 */
export interface ApplyDeterministicInternalTransferCanonicalizationParams extends ReconcileTransferCandidatesParams {
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
   * Evaluate provider-side transfer candidates for one user-owned source and persist
   * deterministic, ambiguous, or pending reconciliation state.
   */
  readonly reconcileTransferCandidates: (
    params: ReconcileTransferCandidatesParams
  ) => Effect.Effect<TransferReconciliationSummary, SyncEngineStorageError>

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
export class TransferReconciliationService extends Context.Tag("TransferReconciliationService")<
  TransferReconciliationService,
  TransferReconciliationServiceShape
>() {}
