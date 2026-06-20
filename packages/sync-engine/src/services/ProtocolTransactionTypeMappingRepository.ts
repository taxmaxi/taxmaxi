/**
 * ProtocolTransactionTypeMappingRepository - Durable reviewed protocol mapping persistence.
 *
 * @module ProtocolTransactionTypeMappingRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type {
  ProviderInventoryEffect,
  ProviderMappingStatus,
  ProviderTaxTreatment,
} from "./ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProtocolMovementPattern - Supported normalized movement shapes for protocol mappings.
 */
export type ProtocolMovementPattern = "token_out_and_token_in"

/**
 * ProtocolMappingEvidenceKind - Review evidence retained for a protocol mapping.
 */
export type ProtocolMappingEvidenceKind =
  | "sample_signature"
  | "normalized_fixture"
  | "dune_observation"
  | "review_note"

/**
 * PersistedProtocolTransactionTypeMapping - Reviewed protocol mapping row.
 */
export interface PersistedProtocolTransactionTypeMapping {
  readonly id: string
  readonly candidateId: string | null
  readonly blockchainId: string
  readonly subjectIdentifier: string
  readonly protocolName: string
  readonly movementPattern: ProtocolMovementPattern
  readonly transactionTypeKey: string | null
  readonly inventoryEffect: ProviderInventoryEffect
  readonly taxTreatment: ProviderTaxTreatment
  readonly confidence: string
  readonly mappingStatus: ProviderMappingStatus
  readonly version: number
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * PersistedProtocolMappingEvidence - Evidence row linked to a reviewed protocol mapping.
 */
export interface PersistedProtocolMappingEvidence {
  readonly id: string
  readonly mappingId: string
  readonly candidateObservationId: string | null
  readonly evidenceKind: ProtocolMappingEvidenceKind
  readonly sampleSignature: string | null
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
}

/**
 * CreatePendingProtocolMappingFromCandidateParams - Candidate-backed pending mapping draft.
 */
export interface CreatePendingProtocolMappingFromCandidateParams {
  readonly candidateId: string
  readonly subjectIdentifier: string
  readonly protocolName: string
  readonly movementPattern: ProtocolMovementPattern
  readonly transactionTypeKey: string | null
  readonly inventoryEffect: ProviderInventoryEffect
  readonly taxTreatment: ProviderTaxTreatment
  readonly confidence: string
  readonly version: number
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * AddProtocolMappingEvidenceParams - Evidence draft for a reviewed protocol mapping.
 */
export interface AddProtocolMappingEvidenceParams {
  readonly mappingId: string
  readonly candidateObservationId: string | null
  readonly evidenceKind: ProtocolMappingEvidenceKind
  readonly sampleSignature: string | null
  readonly payload: Record<string, unknown>
}

/**
 * ApproveProtocolMappingParams - Approval changes applied after evidence validation.
 */
export interface ApproveProtocolMappingParams {
  readonly mappingId: string
  readonly transactionTypeKey: string
  readonly reviewerNotes: string | null
}

/**
 * RejectProtocolMappingParams - Review rejection changes.
 */
export interface RejectProtocolMappingParams {
  readonly mappingId: string
  readonly reviewerNotes: string | null
}

/**
 * FindLatestApprovedProtocolMappingParams - Runtime subject lookup key for approved mappings.
 */
export interface FindLatestApprovedProtocolMappingParams {
  readonly blockchainId: string
  readonly subjectIdentifier: string
  readonly movementPattern: ProtocolMovementPattern
}

/**
 * ProtocolTransactionTypeMappingRepositoryShape - Reviewed protocol mapping operations.
 */
export interface ProtocolTransactionTypeMappingRepositoryShape {
  /**
   * Create a pending reviewed mapping linked to a discovery candidate.
   */
  readonly createPendingMappingFromCandidate: (
    params: CreatePendingProtocolMappingFromCandidateParams
  ) => Effect.Effect<PersistedProtocolTransactionTypeMapping, SyncEngineStorageError>

  /**
   * Attach review evidence to a protocol mapping.
   */
  readonly addEvidence: (
    params: AddProtocolMappingEvidenceParams
  ) => Effect.Effect<PersistedProtocolMappingEvidence, SyncEngineStorageError>

  /**
   * Approve a mapping after proving it has evidence and a valid transaction type.
   */
  readonly approveMapping: (
    params: ApproveProtocolMappingParams
  ) => Effect.Effect<PersistedProtocolTransactionTypeMapping, SyncEngineStorageError>

  /**
   * Reject a mapping without deleting discovery candidates or observations.
   */
  readonly rejectMapping: (
    params: RejectProtocolMappingParams
  ) => Effect.Effect<PersistedProtocolTransactionTypeMapping, SyncEngineStorageError>

  /**
   * Load the newest approved mapping for a runtime subject and movement shape.
   */
  readonly findLatestApprovedMapping: (
    params: FindLatestApprovedProtocolMappingParams
  ) => Effect.Effect<Option.Option<PersistedProtocolTransactionTypeMapping>, SyncEngineStorageError>
}

/**
 * ProtocolTransactionTypeMappingRepository - Context tag for reviewed protocol mappings.
 */
export class ProtocolTransactionTypeMappingRepository extends Context.Tag(
  "ProtocolTransactionTypeMappingRepository"
)<ProtocolTransactionTypeMappingRepository, ProtocolTransactionTypeMappingRepositoryShape>() {}
