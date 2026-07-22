/**
 * ProviderAssetRepository - Durable provider asset identity and mapping persistence contract.
 *
 * @module ProviderAssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type {
  CanonicalAssetDraft,
  CanonicalAssetRecord,
  CanonicalBlockchainDraft,
} from "./AssetRepository.ts"
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
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * ProviderAssetMappingState - Provider-asset mapping target and review status.
 */
export interface ProviderAssetMappingState {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
}

/**
 * ProviderAssetReviewMapping - Provider-asset mapping state plus review notes.
 */
export interface ProviderAssetReviewMapping extends ProviderAssetMappingState {
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly reviewedBy: string | null
  readonly reviewedAt: Date | null
}

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
  readonly mappingStatus: "approved" | "rejected"
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly reviewedBy: string
  readonly reviewedAt: Date
  readonly createReplayJobs: boolean
}

/** Asset-target approval or rejection decision. */
export interface DecideProviderAssetMappingAsAsset extends DecideProviderAssetMappingBase {
  readonly mappingKind: "asset"
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalAssetDraft: {
    readonly blockchain: CanonicalBlockchainDraft
    readonly asset: CanonicalAssetDraft
  } | null
}

/** Fiat-target approval decision. */
export interface DecideProviderAssetMappingAsFiat extends DecideProviderAssetMappingBase {
  readonly mappingKind: "fiat"
  readonly canonicalFiatCurrency: string
}

/** Atomic provider asset review decision input. */
export type DecideProviderAssetMappingParams =
  | DecideProviderAssetMappingAsAsset
  | DecideProviderAssetMappingAsFiat

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

/**
 * ProviderAssetRepositoryShape - Provider asset persistence and lookup operations.
 */
export interface ProviderAssetRepositoryShape {
  /**
   * Persist provider asset catalog rows.
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
   * Seed provider asset mappings keyed by providerAssetRowId only when no row
   * exists yet. Existing mappings are never updated, preserving admin-reviewed
   * rows. Returns the number of newly inserted rows.
   */
  readonly seedProviderAssetMappingsIfMissing: (params: {
    readonly mappings: ReadonlyArray<ProviderAssetMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Backfill canonical ids for approved asset mappings that still only carry a
   * matching canonical symbol from older default seeds.
   */
  readonly backfillApprovedSymbolMappingsCanonicalAssetIds: (params: {
    readonly mappings: ReadonlyArray<{
      readonly providerAssetRowId: string
      readonly canonicalAssetId: string
      readonly canonicalAssetSymbol: string
    }>
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
    readonly query: string | null
    readonly cursorProviderAssetRowId: string | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReviewRecord>, SyncEngineStorageError>

  readonly countProviderAssetReviews: (params: {
    readonly providerKey: string | null
    readonly mappingStatus: ProviderAssetMappingStatus
    readonly query: string | null
  }) => Effect.Effect<number, SyncEngineStorageError>

  readonly decideProviderAssetMapping: (
    params: DecideProviderAssetMappingParams
  ) => Effect.Effect<ProviderAssetDecisionResult, SyncEngineStorageError>

  /** Resolve a reviewed provider asset replay through its durable processing job. */
  readonly findProviderAssetReplaySource: (params: {
    readonly providerAssetRowId: string
    readonly sourceId: string
    readonly jobId: string
  }) => Effect.Effect<Option.Option<ProviderAssetAffectedSource>, SyncEngineStorageError>

  /**
   * Load the current mapping for one provider asset.
   */
  readonly findProviderAssetMapping: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ResolvedProviderAssetMapping>, SyncEngineStorageError>
}

/**
 * ProviderAssetRepository - Context tag for provider asset persistence.
 */
export class ProviderAssetRepository extends Context.Tag("ProviderAssetRepository")<
  ProviderAssetRepository,
  ProviderAssetRepositoryShape
>() {}
