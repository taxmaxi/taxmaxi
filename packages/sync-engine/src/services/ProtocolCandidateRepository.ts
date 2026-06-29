/**
 * ProtocolCandidateRepository - Durable protocol candidate review queue.
 *
 * @module ProtocolCandidateRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { ProviderMappingStatus } from "./ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProtocolCandidateSubjectKind - Chain subject shape found during research.
 */
export type ProtocolCandidateSubjectKind = "program" | "contract" | "protocol"

/**
 * ProtocolCandidateObservationSourceMetadata - Source-specific observation metadata.
 */
export type ProtocolCandidateObservationSourceMetadata = {
  readonly source: "dune"
  readonly queryId: number
  readonly queryName: string
  readonly queryVersion: number
}

/**
 * ProtocolCandidateObservationDraft - One discovered candidate observation ready for import.
 */
export interface ProtocolCandidateObservationDraft {
  readonly blockchainName: string
  readonly subjectKind: ProtocolCandidateSubjectKind
  readonly subjectIdentifier: string
  readonly protocolNameHint: string | null
  readonly categoryHint: string | null
  /** Source-defined stable idempotency key for this candidate observation. */
  readonly sourceObservationKey: string
  readonly observedWindowStart: Date
  readonly observedWindowEnd: Date
  readonly interactionCount: number
  readonly transactionCount: number | null
  readonly uniqueActorCount: number | null
  /**
   * Additional chain subject identifiers linked to this observation.
   *
   * The candidate's own subjectIdentifier is stored separately. This field is
   * for related subjects found by the source, such as Solana programs grouped
   * under a protocol slug.
   */
  readonly relatedSubjectIdentifiers: ReadonlyArray<string>
  readonly sampleTransactionHashes: ReadonlyArray<string>
  readonly retrievedAt: Date
  readonly rawPayload: Record<string, unknown>
  readonly sourceMetadata: ProtocolCandidateObservationSourceMetadata
}

/**
 * PersistedProtocolCandidate - Candidate row returned after import.
 */
export interface PersistedProtocolCandidate {
  readonly id: string
  readonly blockchainId: string
  readonly subjectKind: ProtocolCandidateSubjectKind
  readonly subjectIdentifier: string
  readonly protocolNameHint: string | null
  readonly categoryHint: string | null
  readonly mappingStatus: ProviderMappingStatus
  readonly firstSeenAt: Date
  readonly lastSeenAt: Date
}

/**
 * ProtocolCandidateImportResult - Summary of a candidate import.
 */
export interface ProtocolCandidateImportResult {
  readonly candidates: ReadonlyArray<PersistedProtocolCandidate>
  readonly observationCount: number
}

/**
 * ProtocolCandidateReviewListRow - Candidate summary for admin review queues.
 */
export interface ProtocolCandidateReviewListRow extends PersistedProtocolCandidate {
  readonly blockchainName: string
  readonly observationCount: number
}

/**
 * ProtocolCandidateReviewObservation - Evidence row shown to reviewers.
 */
export interface ProtocolCandidateReviewObservation {
  readonly id: string
  readonly onchainDataSource: "dune"
  readonly onchainDataSourceObservationKey: string
  readonly observedWindowStart: Date
  readonly observedWindowEnd: Date
  readonly interactionCount: string
  readonly transactionCount: string | null
  readonly uniqueActorCount: string | null
  readonly relatedSubjectIdentifiers: ReadonlyArray<string>
  readonly sampleTransactionHashes: ReadonlyArray<string>
  readonly retrievedAt: Date
  readonly rawPayload: Record<string, unknown>
  readonly sourceMetadata: ProtocolCandidateObservationSourceMetadata
}

/**
 * ProtocolCandidateReviewDetail - Candidate details and observations for admin review.
 */
export interface ProtocolCandidateReviewDetail {
  readonly candidate: ProtocolCandidateReviewListRow
  readonly observations: ReadonlyArray<ProtocolCandidateReviewObservation>
}

/**
 * ProtocolCandidateReviewCursor - Stable pagination boundary for candidate review lists.
 */
export interface ProtocolCandidateReviewCursor {
  readonly lastSeenAt: Date
  readonly id: string
}

/**
 * ProtocolCandidateObservationCursor - Stable pagination boundary for candidate observations.
 */
export interface ProtocolCandidateObservationCursor {
  readonly retrievedAt: Date
  readonly id: string
}

/**
 * TaxMaxiTransactionTypeReference - Canonical TaxMaxi transaction type reference row.
 */
export interface TaxMaxiTransactionTypeReference {
  readonly typeKey: string
  readonly categoryKey: string | null
  readonly subcategoryKey: string | null
  readonly labelEn: string
  readonly labelDe: string
}

/**
 * ProtocolCandidateRepositoryShape - Protocol candidate persistence operations.
 */
export interface ProtocolCandidateRepositoryShape {
  /**
   * Import discovered observations as review candidates and evidence rows.
   */
  readonly importObservations: (params: {
    readonly observations: ReadonlyArray<ProtocolCandidateObservationDraft>
  }) => Effect.Effect<ProtocolCandidateImportResult, SyncEngineStorageError>

  /**
   * List protocol candidates waiting for admin review.
   */
  readonly listPendingReviewCandidates: (params: {
    readonly cursor: ProtocolCandidateReviewCursor | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProtocolCandidateReviewListRow>, SyncEngineStorageError>

  /**
   * Load one protocol candidate with its source observations.
   */
  readonly getReviewDetail: (params: {
    readonly candidateId: string
    readonly observationCursor: ProtocolCandidateObservationCursor | null
    readonly observationLimit: number
  }) => Effect.Effect<Option.Option<ProtocolCandidateReviewDetail>, SyncEngineStorageError>

  /**
   * List TaxMaxi transaction types available for later protocol mapping work.
   */
  readonly listTransactionTypes: () => Effect.Effect<
    ReadonlyArray<TaxMaxiTransactionTypeReference>,
    SyncEngineStorageError
  >
}

/**
 * ProtocolCandidateRepository - Context tag for protocol candidate persistence.
 */
export class ProtocolCandidateRepository extends Context.Tag("ProtocolCandidateRepository")<
  ProtocolCandidateRepository,
  ProtocolCandidateRepositoryShape
>() {}
