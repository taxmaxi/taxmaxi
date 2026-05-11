/**
 * TransferReconciliationRepository - Persistence contract for provider-to-onchain
 * reconciliation inputs and durable match state.
 *
 * @module TransferReconciliationRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * TransferReconciliationStatus - Durable lifecycle for one provider transfer reconciliation row.
 */
export type TransferReconciliationStatus =
  | "pending"
  | "needs_review"
  | "approved"
  | "rejected"
  | "auto_applied"

/**
 * ProviderTransferReconciliationCandidate - Provider-side movement plus any approved
 * canonical asset mapping needed for reconciliation.
 */
export interface ProviderTransferReconciliationCandidate {
  readonly userId: string
  readonly providerTransferId: string
  readonly providerSourceId: string
  readonly providerTransactionId: string
  readonly providerAssetId: string | null
  readonly canonicalAssetId: string | null
  readonly timestamp: Date
  readonly direction: "inbound" | "outbound"
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly amount: string
}

/**
 * OnchainTransferReconciliationCandidate - Canonical onchain transfer candidate owned by the user.
 */
export interface OnchainTransferReconciliationCandidate {
  readonly transferId: string
  readonly transactionId: string | null
  readonly sourceId: string
  readonly addressId: string
  readonly blockchainId: string | null
  readonly blockchainName: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly assetId: string
  readonly amount: string
}

/**
 * TransferReconciliationRecordDraft - Upsert payload for one durable reconciliation row.
 */
export interface TransferReconciliationRecordDraft {
  readonly userId: string
  readonly providerTransferId: string
  readonly canonicalTransferId: string | null
  readonly canonicalTransactionId: string | null
  readonly status: TransferReconciliationStatus
  readonly matchReason: string
  readonly confidence: string
  readonly deterministic: boolean
  readonly reviewMetadata: unknown
}

/**
 * DeterministicTransferCanonicalizationSummary - Counts for reconciliation-driven
 * internal-transfer canonicalization applied after a sync or replay pass.
 */
export interface DeterministicTransferCanonicalizationSummary {
  readonly canonicalizedPairs: number
}

/**
 * ListProviderTransfersForReconciliationParams - Scope reconciliation to one user and source.
 */
export interface ListProviderTransfersForReconciliationParams {
  readonly userId: string
  readonly sourceId: string
}

/**
 * FindOnchainTransferReconciliationCandidatesParams - Candidate search inputs for one provider transfer.
 */
export interface FindOnchainTransferReconciliationCandidatesParams {
  readonly userId: string
  readonly canonicalAssetId: string
  readonly direction: "inbound" | "outbound"
  readonly walletAddress: string
  readonly timestampStart: Date
  readonly timestampEnd: Date
  readonly networkName: string | null
  readonly networkHash: string | null
}

/**
 * TransferReconciliationRepositoryShape - Persistence operations needed by the
 * reconciliation service.
 */
export interface TransferReconciliationRepositoryShape {
  /**
   * List provider transfers for one user-owned source, including any approved canonical asset mapping.
   */
  readonly listProviderTransfersForReconciliation: (
    params: ListProviderTransfersForReconciliationParams
  ) => Effect.Effect<ReadonlyArray<ProviderTransferReconciliationCandidate>, SyncEngineStorageError>

  /**
   * Find user-owned canonical onchain transfers that are plausible matches for a provider movement.
   */
  readonly findOnchainTransferCandidates: (
    params: FindOnchainTransferReconciliationCandidatesParams
  ) => Effect.Effect<ReadonlyArray<OnchainTransferReconciliationCandidate>, SyncEngineStorageError>

  /**
   * Persist or update the durable reconciliation state for one provider transfer.
   */
  readonly upsertTransferReconciliation: (
    params: TransferReconciliationRecordDraft
  ) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Replace false provider/onchain tax-visible state with canonical internal-transfer
   * legs and review rows for deterministic reconciliations belonging to one source.
   */
  readonly applyDeterministicInternalTransferCanonicalization: (params: {
    readonly userId: string
    readonly sourceId: string
    readonly reconciliationId?: string
  }) => Effect.Effect<DeterministicTransferCanonicalizationSummary, SyncEngineStorageError>
}

/**
 * TransferReconciliationRepository - Context tag for reconciliation persistence.
 */
export class TransferReconciliationRepository extends Context.Tag(
  "TransferReconciliationRepository"
)<TransferReconciliationRepository, TransferReconciliationRepositoryShape>() {}
