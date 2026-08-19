/**
 * ProviderAssetRepository - Durable provider asset identity and mapping persistence contract.
 *
 * @module ProviderAssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProviderAssetMappingKind - Target mapping kind for a provider asset.
 */
export type ProviderAssetMappingKind = "asset" | "fiat"

/**
 * ProviderAssetMappingStatus - Review lifecycle for provider asset mappings.
 */
export type ProviderAssetMappingStatus = "approved" | "pending_review" | "rejected"

/**
 * ProviderAssetCatalogEntry - Durable provider asset catalog row.
 */
export interface ProviderAssetCatalogEntry {
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly payload: unknown
}

/**
 * ProviderAssetRecord - Persisted provider asset identity row.
 */
export interface ProviderAssetRecord {
  readonly id: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly rawProviderPayload: unknown
  readonly discoveredAt: Date
  readonly retrievedAt: Date
}

/**
 * ProviderAssetMappingDraft - Default or reviewed provider-asset mapping upsert.
 */
export interface ProviderAssetMappingDraft {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/** Result of an idempotent provider-asset approval. */
export interface ProviderAssetApprovalResult {
  readonly mappingChanged: boolean
}

/** Result of scheduling one durable resolution job for an unresolved observation. */
export interface AssetResolutionJobScheduleResult {
  readonly created: boolean
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
}

/** Outcome of an attach-only policy decision, recorded as immutable audit history. */
export type AssetResolutionAuditOutcome = "attach" | "pending" | "fail_closed"

/** One immutable attach-only policy decision to append to resolution audit history. */
export interface AssetResolutionDecisionRecord {
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly policyRevision: string
  readonly outcome: AssetResolutionAuditOutcome
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly blockchain: string | null
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
  readonly reason: string | null
  readonly chainEvidence: unknown
  readonly coinGeckoEvidence: unknown
  readonly actor: string
}

/** Result of appending one decision to resolution audit history. */
export interface AssetResolutionDecisionRecordResult {
  readonly recorded: boolean
}

/** Outcome of attempting to claim a durable resolution job for execution. */
export type AssetResolutionJobClaim =
  | {
      readonly _tag: "claimed"
      readonly providerAssetRowId: string
      readonly evidenceRevision: number
    }
  | { readonly _tag: "not_claimable" }
  | { readonly _tag: "stale" }

/** Terminal status a resolution job execution attempt can leave the job in. */
export type AssetResolutionJobFinishStatus = "completed" | "pending" | "failed"

/**
 * ProviderAssetMappingState - Provider-asset mapping target and review status.
 */
export interface ProviderAssetMappingState {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
}

/**
 * ProviderAssetReviewMapping - Provider-asset mapping state plus review notes.
 */
export interface ProviderAssetReviewMapping extends ProviderAssetMappingState {
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * ResolvedProviderAssetMapping - Deterministic provider-asset mapping result.
 */
export type ResolvedProviderAssetMapping = ProviderAssetMappingState

/**
 * ProviderAssetReviewRecord - Provider asset plus current review mapping state.
 */
export interface ProviderAssetReviewRecord {
  readonly providerAsset: ProviderAssetRecord
  readonly mapping: ProviderAssetReviewMapping | null
}

/** Exact on-chain identity observed on a movement using one provider asset. */
export interface ProviderAssetObservedRepresentationRecord {
  readonly blockchainName: string
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}

/** Representation evidence prepared for a provider-asset source use; null fields are unknown. */
export interface ProviderAssetSourceUseObservation {
  readonly providerAssetRowId: string
  readonly observedBlockchainId: string
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}

/**
 * ProviderAssetRepositoryShape - Provider asset persistence and lookup operations.
 */
export interface ProviderAssetRepositoryShape {
  /**
   * Persist provider asset catalog rows. When stored observation facts change,
   * increment evidenceRevision and schedule one unresolved resolution job for
   * the new revision. Retrieved-at-only refreshes leave the revision in place.
   */
  readonly upsertProviderAssets: (params: {
    readonly providerKey: string
    readonly entries: ReadonlyArray<ProviderAssetCatalogEntry>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Persist provider asset mappings.
   */
  readonly upsertProviderAssetMappings: (params: {
    readonly mappings: ReadonlyArray<ProviderAssetMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Approve a reviewed asset mapping and atomically request replay for every
   * source that uses it. Retrying the same target is a successful no-op.
   */
  readonly approveProviderAssetMappingAndRequestReplay: (params: {
    readonly mapping: ProviderAssetMappingDraft
    readonly expectedObservedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly expectedProviderAssetRetrievedAt: Date
  }) => Effect.Effect<ProviderAssetApprovalResult, SyncEngineStorageError>

  /**
   * Lock and reload the provider-asset decision snapshot before a caller writes
   * related canonical rows in the same transaction.
   */
  readonly lockProviderAssetApprovalSnapshot: (params: {
    readonly providerAssetRowId: string
    readonly expectedObservedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly expectedProviderAssetRetrievedAt: Date
  }) => Effect.Effect<ProviderAssetReviewRecord, SyncEngineStorageError>

  /**
   * Reserve and record that normalization artifacts use this provider asset.
   * The caller must invoke this after taking the normalized artifact locks and keep the
   * reservation plus artifact persistence in one transaction. This makes approval either
   * observe the evidence or win before the evidence is written.
   * If the asset is already approved, request a replay in the same transaction.
   */
  readonly recordProviderAssetSourceUses: (params: {
    readonly sourceId: string
    readonly providerAssetRowIds: ReadonlyArray<string>
    readonly observations: ReadonlyArray<ProviderAssetSourceUseObservation>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Seed provider asset mappings keyed by providerAssetRowId only when no row
   * exists yet. Existing mappings are never updated, preserving admin-reviewed
   * rows. Returns the number of newly inserted rows.
   */
  readonly seedProviderAssetMappingsIfMissing: (params: {
    readonly mappings: ReadonlyArray<ProviderAssetMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Load one provider asset by stable provider asset id.
   */
  readonly findProviderAssetByProviderAssetId: (params: {
    readonly providerKey: string
    readonly providerAssetId: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load one provider asset by provider-scoped natural key.
   */
  readonly findProviderAssetByNaturalKey: (params: {
    readonly providerKey: string
    readonly naturalKey: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load the preferred provider asset row for one provider-scoped currency code.
   *
   * Existing mapping decisions take precedence over newer unmapped provider
   * facts so review state is not orphaned when a provider later starts
   * returning a stable provider asset id for a currency initially discovered
   * through a natural key.
   */
  readonly findProviderAssetByCurrencyCode: (params: {
    readonly providerKey: string
    readonly currencyCode: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load one provider asset row with its mapping review state.
   */
  readonly findProviderAssetReviewById: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /**
   * List provider asset rows that need mapping review.
   */
  readonly listProviderAssetReviews: (params: {
    readonly providerKey: string | null
    readonly mappingStatus: ProviderAssetMappingStatus
    readonly cursor: {
      readonly providerAssetRowId: string
    } | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /** List exact on-chain identities observed on movements for one provider asset. */
  readonly listProviderAssetObservedRepresentations: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<
    ReadonlyArray<ProviderAssetObservedRepresentationRecord>,
    SyncEngineStorageError
  >

  /**
   * Load the current mapping for one provider asset.
   */
  readonly findProviderAssetMapping: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ResolvedProviderAssetMapping>, SyncEngineStorageError>

  /**
   * Persist one durable resolution job for an unresolved provider observation
   * and its current evidence revision. A second schedule for the same pair is
   * a no-op. Approved local mappings do not create a job.
   */
  readonly scheduleUnresolvedResolutionJob: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<AssetResolutionJobScheduleResult, SyncEngineStorageError>

  /**
   * Claim one durable resolution job for execution. Locks the job row and
   * compares its evidence revision against the provider asset's current
   * evidence revision in the same transaction: a stale job is completed
   * without a decision and reported as stale rather than claimed. A job that
   * is not pending (already claimed, completed, or failed) is reported
   * not_claimable, making duplicate execution attempts a safe no-op.
   */
  readonly claimResolutionJob: (params: {
    readonly jobId: string
  }) => Effect.Effect<AssetResolutionJobClaim, SyncEngineStorageError>

  /**
   * Move a resolution job to a terminal or retryable status after an
   * execution attempt.
   */
  readonly finishResolutionJob: (params: {
    readonly jobId: string
    readonly status: AssetResolutionJobFinishStatus
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Append one immutable attach-only policy decision to resolution audit
   * history. A second decision for the same provider asset and evidence
   * revision is a no-op so replaying a resolution job never rewrites history.
   */
  readonly recordAssetResolutionDecision: (params: {
    readonly decision: AssetResolutionDecisionRecord
  }) => Effect.Effect<AssetResolutionDecisionRecordResult, SyncEngineStorageError>
}

/**
 * ProviderAssetRepository - Context tag for provider asset persistence.
 */
export class ProviderAssetRepository extends Context.Service<
  ProviderAssetRepository,
  ProviderAssetRepositoryShape
>()("ProviderAssetRepository") {}
