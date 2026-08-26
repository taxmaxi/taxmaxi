/**
 * ProviderAssetRepository - Durable provider asset identity and mapping persistence contract.
 *
 * @module ProviderAssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { ProviderAssetMappingStatus } from "@my/core/assets"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProviderAssetMappingKind - Target mapping kind for a provider asset.
 */
export type ProviderAssetMappingKind = "asset" | "fiat"

export type { ProviderAssetMappingStatus }

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

/** Result of atomically recording and applying an automatic exclusion. */
export interface ProviderAssetExclusionResult extends ProviderAssetApprovalResult {
  readonly decisionRecorded: boolean
}

/** Outcome of an automatic policy decision, recorded as immutable audit history. */
export type AssetResolutionAuditOutcome =
  | "attach"
  | "create_standalone"
  | "excluded"
  | "pending"
  | "fail_closed"

/**
 * One evidence snapshot to store behind a decision, scoped to the authority
 * that provided it and the kind of claim it makes. The decoded claim is what
 * the policy read; the raw payload is what the authority actually returned.
 */
export interface AssetResolutionEvidenceRecord {
  readonly authority: string
  readonly claimKind: string
  readonly sourceLocator: string | null
  readonly retrievedAt: Date
  readonly evidenceRevision: number
  readonly decodedClaim: unknown
  readonly rawPayload: unknown
}

/** One stored evidence snapshot as read back from a decision. */
export interface AssetResolutionEvidenceEntry extends AssetResolutionEvidenceRecord {
  readonly id: string
  readonly decisionId: string
}

/** One immutable automatic policy decision to append to resolution audit history. */
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
  readonly evidence: ReadonlyArray<AssetResolutionEvidenceRecord>
  readonly actor: string
}

/** Result of appending one decision to resolution audit history. */
export interface AssetResolutionDecisionRecordResult {
  readonly recorded: boolean
}

/** Lifecycle status of one recorded resolution decision. */
export type AssetResolutionDecisionStatus = "active" | "superseded"

/** One recorded resolution decision as read back from audit history. */
export interface AssetResolutionDecisionHistoryEntry {
  readonly id: string
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly policyRevision: string
  readonly outcome: AssetResolutionAuditOutcome
  readonly status: AssetResolutionDecisionStatus
  readonly supersedesDecisionId: string | null
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly reason: string | null
  readonly actor: string
  readonly createdAt: Date
}

/**
 * Result of appending a superseding decision.
 *
 * - superseded: the new decision is active and the replaced one is marked superseded.
 * - conflict: the named decision does not exist or is no longer active, so
 *   nothing changed; the caller must re-read and decide again.
 */
export type AssetResolutionSupersedeResult =
  | { readonly _tag: "superseded"; readonly decisionId: string }
  | { readonly _tag: "conflict" }

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
    /** Human authority used only when this approval supersedes an exclusion. */
    readonly exclusionReversal?: {
      readonly actor: string
      readonly policyRevision: string
    }
  }) => Effect.Effect<ProviderAssetApprovalResult, SyncEngineStorageError>

  /**
   * Exclude an observation from derived accounting as a final answer and
   * atomically request replay for every source that uses it, so affected
   * pending counts re-evaluate. The mapping keeps no canonical target.
   * Retrying an already-excluded observation is a successful no-op.
   */
  readonly excludeProviderAssetMappingAndRequestReplay: (params: {
    readonly providerAssetRowId: string
    readonly decision: AssetResolutionDecisionRecord
    readonly sourceNotes: string | null
    readonly expectedObservedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly expectedProviderAssetRetrievedAt: Date
  }) => Effect.Effect<ProviderAssetExclusionResult, SyncEngineStorageError>

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
   * Load the asset chosen by the principal's active identity override for one
   * provider asset row. Returns none when there is no active identity
   * override, or when the principal's active inclusion override excludes the
   * asset. Providers use this during normalization so an override replay can
   * rebuild movements whose system mapping is still unresolved.
   */
  readonly findPrincipalIdentityOverrideAssetId: (params: {
    readonly principalId: string
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<string>, SyncEngineStorageError>

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
   * Append one automatic policy decision to resolution audit history as
   * the active decision for its provider asset and evidence revision. When
   * an active decision already exists for that pair, nothing is written and
   * the result reports recorded: false, so replaying a resolution job never
   * rewrites history.
   */
  readonly recordAssetResolutionDecision: (params: {
    readonly decision: AssetResolutionDecisionRecord
  }) => Effect.Effect<AssetResolutionDecisionRecordResult, SyncEngineStorageError>

  /**
   * Append a superseding decision that replaces the named active decision.
   * The replaced decision keeps its content and flips to superseded; the new
   * decision becomes active and records which decision it replaced. Fails
   * with a conflict result when the named decision is missing or no longer
   * active, so concurrent supersessions cannot overwrite each other.
   */
  readonly appendSupersedingAssetResolutionDecision: (params: {
    readonly supersedesDecisionId: string
    readonly decision: AssetResolutionDecisionRecord
  }) => Effect.Effect<AssetResolutionSupersedeResult, SyncEngineStorageError>

  /**
   * Read the active decision for one provider asset and evidence revision.
   */
  readonly findActiveAssetResolutionDecision: (params: {
    readonly providerAssetRowId: string
    readonly evidenceRevision: number
  }) => Effect.Effect<Option.Option<AssetResolutionDecisionHistoryEntry>, SyncEngineStorageError>

  /**
   * Read every recorded decision for one provider asset in the order they
   * were appended, including superseded ones.
   */
  readonly listAssetResolutionDecisions: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<AssetResolutionDecisionHistoryEntry>, SyncEngineStorageError>

  /**
   * Read the evidence snapshots stored behind one decision, so the decision
   * can be reproduced without reading any provider payload table.
   */
  readonly listAssetResolutionEvidence: (params: {
    readonly decisionId: string
  }) => Effect.Effect<ReadonlyArray<AssetResolutionEvidenceEntry>, SyncEngineStorageError>
}

/**
 * ProviderAssetRepository - Context tag for provider asset persistence.
 */
export class ProviderAssetRepository extends Context.Service<
  ProviderAssetRepository,
  ProviderAssetRepositoryShape
>()("ProviderAssetRepository") {}
