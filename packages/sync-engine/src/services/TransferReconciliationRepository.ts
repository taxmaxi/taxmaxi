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
  readonly principalId: string
  readonly providerTransferId: string
  readonly providerSourceId: string
  readonly providerTransactionId: string
  readonly providerAssetId: string | null
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
  readonly timestamp: Date
  readonly direction: "inbound" | "outbound"
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly amount: string
}

/**
 * OnchainTransferReconciliationCandidate - Canonical onchain transfer candidate owned by the principal.
 */
export interface OnchainTransferReconciliationCandidate {
  readonly transferId: string | null
  readonly observedProviderTransferId: string | null
  readonly transactionId: string
  readonly sourceId: string
  readonly addressId: string
  readonly blockchainId: string | null
  readonly blockchainName: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly providerAssetRowId: string | null
  readonly providerAssetMappingStatus: "approved" | "pending_review" | "rejected" | null
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
  readonly amount: string
}

/** Admin-facing unresolved reconciliation evidence and its provider movement. */
export interface UnresolvedTransferReconciliationRecord {
  readonly id: string
  readonly principalId: string
  readonly providerTransferId: string
  readonly providerSourceId: string
  readonly providerTimestamp: Date
  readonly providerDirection: "inbound" | "outbound"
  readonly providerAmount: string
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly canonicalTransferId: string | null
  readonly canonicalTransactionId: string | null
  readonly status: "pending" | "needs_review"
  readonly matchReason: string
  readonly confidence: string
  readonly deterministic: boolean
  readonly reviewMetadata: unknown
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * TransferReconciliationRecordDraft - Upsert payload for one durable reconciliation row.
 */
export interface TransferReconciliationRecordDraft {
  readonly principalId: string
  readonly providerTransferId: string
  readonly canonicalTransferId: string | null
  readonly canonicalTransactionId: string | null
  readonly status: TransferReconciliationStatus
  readonly matchReason: string
  readonly confidence: string
  readonly deterministic: boolean
  readonly reviewMetadata: unknown
  /** Physical exact-amount candidate set observed before source locks are acquired. */
  readonly candidateSnapshot?: TransferReconciliationCandidateSnapshot
}

/** Candidate search and exact matches that must still hold while source rows are locked. */
export interface TransferReconciliationCandidateSnapshot {
  readonly search: FindOnchainTransferReconciliationCandidatesParams
  readonly providerAmount: string
  readonly candidateFingerprints: ReadonlyArray<string>
}

/** Outcome of one reconciliation-state write. */
export interface UpsertTransferReconciliationResult {
  readonly candidateSnapshotChanged: boolean
  /** Existing automatic claim that must also be moved to review and rolled back. */
  readonly conflictingProviderTransferId: string | null
  readonly status: TransferReconciliationStatus
}

/**
 * DeterministicTransferCanonicalizationSummary - Counts for reconciliation-driven
 * internal-transfer canonicalization applied after a sync or replay pass.
 */
export interface DeterministicTransferCanonicalizationSummary {
  readonly canonicalizedPairs: number
}

/**
 * ListProviderTransfersForReconciliationParams - Scope reconciliation to one principal and source.
 */
export interface ListProviderTransfersForReconciliationParams {
  readonly principalId: string
  readonly sourceId: string
}

/**
 * FindOnchainTransferReconciliationCandidatesParams - Candidate search inputs for one provider transfer.
 */
export interface FindOnchainTransferReconciliationCandidatesParams {
  readonly principalId: string
  readonly direction: "inbound" | "outbound"
  readonly walletAddress: string | null
  readonly timestampStart: Date
  readonly timestampEnd: Date
  readonly networkName: string | null
  readonly networkHash: string | null
}

/** Strong movement evidence for a first-seen destination representation. */
export interface RecordOnchainRepresentationEvidenceParams {
  readonly providerAssetRowId: string
  readonly sourceProviderTransferId: string
  readonly destinationProviderTransferId: string
  readonly proposedCanonicalAssetId: string
}

/**
 * TransferReconciliationRepositoryShape - Persistence operations needed by the
 * reconciliation service.
 */
export interface TransferReconciliationRepositoryShape {
  /** List unresolved reconciliation rows for the admin review queue. */
  readonly listUnresolvedTransferReconciliations: (params: {
    readonly status: "pending" | "needs_review" | null
    readonly cursorId: string | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<UnresolvedTransferReconciliationRecord>, SyncEngineStorageError>

  /**
   * List provider transfers for one principal-owned source, including any approved canonical asset mapping.
   */
  readonly listProviderTransfersForReconciliation: (
    params: ListProviderTransfersForReconciliationParams
  ) => Effect.Effect<ReadonlyArray<ProviderTransferReconciliationCandidate>, SyncEngineStorageError>

  /**
   * Find principal-owned canonical onchain transfers that are plausible matches for a provider movement.
   */
  readonly findOnchainTransferCandidates: (
    params: FindOnchainTransferReconciliationCandidatesParams
  ) => Effect.Effect<ReadonlyArray<OnchainTransferReconciliationCandidate>, SyncEngineStorageError>

  /**
   * Keep first-seen exact representation evidence pending for review. This does
   * not approve a provider-asset mapping or assign its canonical target.
   */
  readonly recordOnchainRepresentationEvidence: (
    params: RecordOnchainRepresentationEvidenceParams
  ) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Persist or update the durable reconciliation state for one provider transfer.
   */
  readonly upsertTransferReconciliation: (
    params: TransferReconciliationRecordDraft
  ) => Effect.Effect<UpsertTransferReconciliationResult, SyncEngineStorageError>

  /**
   * Unapply reconciliation effects connected to a source before its derived rows
   * are deleted and rebuilt by replay.
   */
  readonly rollbackReconciliationsForSourceReplay: (params: {
    readonly sourceId: string
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Replace false provider/onchain tax-visible state with canonical internal-transfer
   * legs and review rows for deterministic reconciliations belonging to one source.
   */
  readonly applyDeterministicInternalTransferCanonicalization: (params: {
    readonly principalId: string
    readonly sourceId: string
    readonly reconciliationId?: string
  }) => Effect.Effect<DeterministicTransferCanonicalizationSummary, SyncEngineStorageError>
}

/**
 * TransferReconciliationRepository - Context tag for reconciliation persistence.
 */
export class TransferReconciliationRepository extends Context.Service<
  TransferReconciliationRepository,
  TransferReconciliationRepositoryShape
>()("TransferReconciliationRepository") {}
