/**
 * ProviderReferenceRepository - Durable provider reference-data and mapping persistence contract.
 *
 * @module ProviderReferenceRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProviderMappingStatus - Review lifecycle for provider mappings.
 */
export type ProviderMappingStatus = "approved" | "pending_review" | "rejected"

/**
 * ProviderInventoryEffect - Canonical inventory effect derived from a provider transaction type.
 */
export type ProviderInventoryEffect =
  | "acquisition"
  | "disposal"
  | "income"
  | "internal_transfer"
  | "non_inventory"
  | "unknown"

/**
 * ProviderTaxTreatment - Tax treatment category assigned to a provider transaction type.
 */
export type ProviderTaxTreatment =
  | "taxable_by_default"
  | "non_taxable_by_default"
  | "requires_additional_rule_logic"

/**
 * ProviderResolutionStrategy - Deterministic mapping strategy used for a provider type.
 */
export type ProviderResolutionStrategy =
  | "static"
  | "amount_sign"
  | "venue_side"
  | "amount_sign_fee"
  | "no_leg"

/**
 * ProviderTransactionTypeCatalogEntry - Durable transaction-type catalog row.
 */
export interface ProviderTransactionTypeCatalogEntry {
  readonly providerKey: string
  readonly providerTransactionType: string
  readonly displayName: string | null
  readonly payload: unknown
}

/**
 * ProviderTransactionTypeMappingDraft - Default or reviewed transaction-type mapping upsert.
 */
export interface ProviderTransactionTypeMappingDraft {
  readonly providerKey: string
  readonly providerTransactionType: string
  readonly transactionType: string | null
  readonly inventoryEffect: ProviderInventoryEffect
  readonly taxTreatment: ProviderTaxTreatment
  readonly resolutionStrategy: ProviderResolutionStrategy
  readonly pairedRecordRequired: boolean
  readonly mappingStatus: ProviderMappingStatus
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * ResolvedProviderTransactionTypeMapping - Deterministic transaction-type mapping result.
 */
export interface ResolvedProviderTransactionTypeMapping {
  readonly providerTransactionType: string
  readonly transactionType: string | null
  readonly inventoryEffect: ProviderInventoryEffect
  readonly taxTreatment: ProviderTaxTreatment
  readonly resolutionStrategy: ProviderResolutionStrategy
  readonly pairedRecordRequired: boolean
  readonly mappingStatus: ProviderMappingStatus
}

/**
 * ProviderReferenceRepositoryShape - Reference-data persistence and lookup operations.
 */
export interface ProviderReferenceRepositoryShape {
  /**
   * Persist a provider transaction-type catalog snapshot.
   */
  readonly upsertTransactionTypeCatalog: (params: {
    readonly providerKey: string
    readonly entries: ReadonlyArray<ProviderTransactionTypeCatalogEntry>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Ensure durable default transaction-type mappings exist for supported references.
   */
  readonly ensureTransactionTypeMappings: (params: {
    readonly providerKey: string
    readonly mappings: ReadonlyArray<ProviderTransactionTypeMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Load one resolved provider transaction-type mapping.
   */
  readonly findTransactionTypeMapping: (params: {
    readonly providerKey: string
    readonly providerTransactionType: string
  }) => Effect.Effect<Option.Option<ResolvedProviderTransactionTypeMapping>, SyncEngineStorageError>

  /**
   * Persist a newly discovered provider transaction type that requires review.
   */
  readonly recordPendingTransactionTypeMapping: (
    mapping: ProviderTransactionTypeMappingDraft
  ) => Effect.Effect<void, SyncEngineStorageError>
}

/**
 * ProviderReferenceRepository - Context tag for provider reference-data persistence.
 */
export class ProviderReferenceRepository extends Context.Tag("ProviderReferenceRepository")<
  ProviderReferenceRepository,
  ProviderReferenceRepositoryShape
>() {}
