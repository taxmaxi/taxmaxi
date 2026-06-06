/**
 * ProtocolCandidateRepository - Durable protocol candidate review queue.
 *
 * @module ProtocolCandidateRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { ProviderMappingStatus } from "./ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProtocolCandidateSubjectKind - Chain subject shape found during research.
 */
export type ProtocolCandidateSubjectKind = "program" | "contract" | "protocol"

/**
 * DuneProtocolCandidateObservationDraft - One Dune ranking row ready for import.
 */
export interface DuneProtocolCandidateObservationDraft {
  readonly blockchainId: string
  readonly subjectKind: ProtocolCandidateSubjectKind
  readonly subjectIdentifier: string
  readonly protocolNameHint: string | null
  readonly categoryHint: string | null
  readonly observedWindowStart: Date
  readonly observedWindowEnd: Date
  readonly interactionCount: number
  readonly transactionCount: number | null
  readonly uniqueActorCount: number | null
  readonly sampleTransactionHashes: ReadonlyArray<string>
  readonly retrievedAt: Date
  readonly rawPayload: Record<string, unknown>
  readonly queryId: number
  readonly queryName: string
  readonly queryVersion: number
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
 * ProtocolCandidateRepositoryShape - Protocol candidate persistence operations.
 */
export interface ProtocolCandidateRepositoryShape {
  /**
   * Import Dune ranking rows as review candidates and observations.
   */
  readonly importDuneObservations: (params: {
    readonly observations: ReadonlyArray<DuneProtocolCandidateObservationDraft>
  }) => Effect.Effect<ProtocolCandidateImportResult, SyncEngineStorageError>
}

/**
 * ProtocolCandidateRepository - Context tag for protocol candidate persistence.
 */
export class ProtocolCandidateRepository extends Context.Tag("ProtocolCandidateRepository")<
  ProtocolCandidateRepository,
  ProtocolCandidateRepositoryShape
>() {}
