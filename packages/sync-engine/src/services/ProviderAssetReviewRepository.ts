/**
 * ProviderAssetReviewRepository - Durable provider asset review persistence contract.
 *
 * @module ProviderAssetReviewRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type {
  CanonicalAssetDraft,
  CanonicalAssetRecord,
  CanonicalBlockchainDraft,
} from "./AssetRepository.ts"
import type {
  ProviderAssetMappingKind,
  ProviderAssetMappingState,
  ProviderAssetMappingStatus,
  ProviderAssetRecord,
} from "./ProviderAssetRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProviderAssetReviewMapping - Provider-asset mapping state plus review notes.
 */
export interface ProviderAssetReviewMapping extends ProviderAssetMappingState {
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly reviewedBy: string | null
  readonly reviewedAt: Date | null
}

/**
 * ProviderAssetReviewRecord - Provider asset plus current review mapping state.
 */
export interface ProviderAssetReviewRecord {
  readonly providerAsset: ProviderAssetRecord
  readonly mapping: ProviderAssetReviewMapping | null
}

/**
 * ProviderAssetAffectedSource - Source and durable job representing replay work caused by a review.
 */
export interface ProviderAssetAffectedSource {
  readonly sourceId: string
  readonly principalId: string
  readonly jobId: string
}

/**
 * ProviderAssetDecisionResult - Atomic review decision and durable replay work.
 */
export interface ProviderAssetDecisionResult {
  readonly updated: boolean
  readonly canonicalAsset: CanonicalAssetRecord | null
  readonly affectedSources: ReadonlyArray<ProviderAssetAffectedSource>
}

/** Shared audit and replay fields for an atomic provider asset decision. */
export interface DecideProviderAssetMappingBase {
  readonly providerAssetRowId: string
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly reviewedBy: string
  readonly reviewedAt: Date
  readonly createReplayJobs: boolean
}

/** Asset-target approval decision. */
export interface DecideProviderAssetMappingAsAsset extends DecideProviderAssetMappingBase {
  readonly mappingStatus: "approved"
  readonly mappingKind: Extract<ProviderAssetMappingKind, "asset">
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalAssetDraft: {
    readonly blockchain: CanonicalBlockchainDraft
    readonly asset: CanonicalAssetDraft
  } | null
}

/** Fiat-target approval decision. */
export interface DecideProviderAssetMappingAsFiat extends DecideProviderAssetMappingBase {
  readonly mappingStatus: "approved"
  readonly mappingKind: Extract<ProviderAssetMappingKind, "fiat">
  readonly canonicalFiatCurrency: string
}

/** Rejection decision that preserves the pending mapping target kind. */
export interface RejectProviderAssetMapping extends DecideProviderAssetMappingBase {
  readonly mappingStatus: "rejected"
  readonly mappingKind: ProviderAssetMappingKind
}

/** Atomic provider asset review decision input. */
export type DecideProviderAssetMappingParams =
  | DecideProviderAssetMappingAsAsset
  | DecideProviderAssetMappingAsFiat
  | RejectProviderAssetMapping

/**
 * ProviderAssetReviewRepositoryShape - Review queue and atomic decision persistence operations.
 */
export interface ProviderAssetReviewRepositoryShape {
  /** Load one provider asset row with its mapping review state. */
  readonly findProviderAssetReviewById: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /** List provider asset rows by review state. */
  readonly listProviderAssetReviews: (params: {
    readonly providerKey: string | null
    readonly mappingStatus: ProviderAssetMappingStatus
    readonly query: string | null
    readonly cursorProviderAssetRowId: string | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /** Count provider asset rows matching the review queue filters. */
  readonly countProviderAssetReviews: (params: {
    readonly providerKey: string | null
    readonly mappingStatus: ProviderAssetMappingStatus
    readonly query: string | null
  }) => Effect.Effect<number, SyncEngineStorageError>

  /** Atomically apply one pending review decision and persist its replay requests. */
  readonly decideProviderAssetMapping: (
    params: DecideProviderAssetMappingParams
  ) => Effect.Effect<ProviderAssetDecisionResult, SyncEngineStorageError>

  /** Resolve a reviewed provider asset replay through its durable processing job. */
  readonly findProviderAssetReplaySource: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<Option.Option<ProviderAssetAffectedSource>, SyncEngineStorageError>

  /** Replace the exact replay job after an administrator retries it. */
  readonly replaceProviderAssetReplayJob: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly previousJobId: string
    readonly nextJobId: string
  }) => Effect.Effect<boolean, SyncEngineStorageError>
}

/**
 * ProviderAssetReviewRepository - Context tag for provider asset review persistence.
 */
export class ProviderAssetReviewRepository extends Context.Tag("ProviderAssetReviewRepository")<
  ProviderAssetReviewRepository,
  ProviderAssetReviewRepositoryShape
>() {}
