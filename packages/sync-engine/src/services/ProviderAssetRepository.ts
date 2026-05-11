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
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * ResolvedProviderAssetMapping - Deterministic provider-asset mapping result.
 */
export interface ResolvedProviderAssetMapping {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
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
