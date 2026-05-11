/**
 * SourceNormalizationRepository - Canonical persistence contract for normalized source artifacts.
 *
 * @module SourceNormalizationRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { ResolvedProviderTransactionTypeMapping } from "./ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SourceTransferType - Canonical transfer types persisted during normalization.
 */
export type SourceTransferType =
  | "erc20"
  | "erc721"
  | "erc1155"
  | "internal"
  | "native"
  | "spl"
  | "utxo"
  | "cex"
  | "dex"
  | "fiat"
  | "funding"
  | "reward"
  | "fee"

/**
 * SourceLegKind - Accounting kind for canonical transaction legs.
 */
export type SourceLegKind = "acquisition" | "disposal" | "income" | "fee"

/**
 * SourceLegProvenance - Derivation provenance for canonical transaction legs.
 */
export type SourceLegProvenance = "deterministic" | "rule" | "ai" | "manual"

/**
 * SourceProviderTransferDirection - Direction for durable provider-side movements.
 */
export type SourceProviderTransferDirection = "inbound" | "outbound"

/**
 * ReviewStatus - Canonical review lifecycle values used when persisting transaction reviews.
 */
export type ReviewStatus = "auto_applied" | "needs_review" | "approved" | "changed"

/**
 * SourceTransactionDraft - Canonical transaction envelope upsert payload.
 */
export interface SourceTransactionDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly timestamp: Date
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly providerStatus: string | null
  readonly providerResourcePath: string | null
  readonly providerDescription: string | null
  readonly providerCreatedAt: Date | null
  readonly providerUpdatedAt: Date | null
  readonly metadata: unknown
  readonly userId: string | null
}

/**
 * SourceVenueContextDraft - Canonical venue context upsert payload.
 */
export interface SourceVenueContextDraft {
  readonly venueType: "cex" | "dex"
  readonly cexAccountId: string | null
  readonly externalAccountId: string | null
  readonly externalOrderId: string | null
  readonly externalFillId: string | null
  readonly side: string | null
  readonly instrument: string | null
  readonly fillPrice: string | null
  readonly commissionAmount: string | null
  readonly commissionCurrency: string | null
  readonly metadata: unknown
}

/**
 * SourceTransferDraft - Canonical transfer upsert payload.
 */
export interface SourceTransferDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly addressId: string | null
  readonly blockchainId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly type: SourceTransferType
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromPartyType: string | null
  readonly fromPartyResourcePath: string | null
  readonly toPartyType: string | null
  readonly toPartyResourcePath: string | null
  readonly assetId: string
  readonly amount: string
  readonly tokenId: string | null
  readonly notes: string | null
  readonly metadata: unknown
}

/**
 * SourceProviderTransferDraft - Provider-side principal movement payload persisted
 * before canonical asset mapping or reconciliation is complete.
 */
export interface SourceProviderTransferDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerAssetId: string | null
  readonly timestamp: Date
  readonly direction: SourceProviderTransferDirection
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly amount: string
  readonly metadata: unknown
}

/**
 * SourceTransactionLegDraft - Canonical transaction leg upsert payload.
 */
export interface SourceTransactionLegDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly userId: string | null
  readonly addressId: string | null
  readonly assetId: string
  readonly amount: string
  readonly kind: SourceLegKind
  readonly provenance: SourceLegProvenance
  readonly derivationRule: string | null
  readonly metadata: unknown
  readonly transactionId: string | null
  readonly sourceTransferId: string | null
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly feeForTransactionId: string | null
}

/**
 * SourceTransactionReviewDraft - Review row upsert payload for ambiguous records.
 */
export interface SourceTransactionReviewDraft {
  readonly userId: string
  readonly reviewStatus: ReviewStatus
  readonly originalTypeKey: string | null
  readonly originalConfidence: string | null
  readonly currentTypeKey: string | null
  readonly legalRuleSetVersion: string | null
  readonly categorizationReason: string | null
  readonly matchedLayer: string | null
  readonly needsReview: boolean
  readonly userNotes: string | null
  readonly reviewedAt: Date | null
}

/**
 * PersistedSourceTransaction - Persisted transaction projection required by follow-up steps.
 */
export interface PersistedSourceTransaction {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly timestamp: Date
  readonly providerTransactionType: string | null
  readonly metadata: unknown
  readonly userId: string | null
}

/**
 * PersistedSourceVenueContext - Persisted venue context projection required by leg derivation.
 */
export interface PersistedSourceVenueContext {
  readonly transactionId: string
  readonly side: string | null
  readonly instrument: string | null
  readonly fillPrice: string | null
}

/**
 * PersistedSourceTransfer - Persisted fee transfer projection required by leg derivation.
 */
export interface PersistedSourceTransfer {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly addressId: string | null
  readonly assetId: string
  readonly amount: string
  readonly type: SourceTransferType
}

/**
 * PersistedSourceProviderTransfer - Persisted provider-side movement projection required
 * by reconciliation and review flows.
 */
export interface PersistedSourceProviderTransfer {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly transactionId: string
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerAssetId: string | null
  readonly timestamp: Date
  readonly direction: SourceProviderTransferDirection
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly amount: string
  readonly metadata: unknown
}

/**
 * PersistedSourceLeg - Persisted leg projection used for FIFO side effects.
 */
export interface PersistedSourceLeg {
  readonly id: string
  readonly sourceId: string
  readonly timestamp: Date
  readonly userId: string | null
  readonly assetId: string
  readonly amount: string
  readonly kind: SourceLegKind
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
}

/**
 * PersistNormalizedSourceArtifactsResult - Persisted projections returned by the repository.
 */
export interface PersistNormalizedSourceArtifactsResult {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext
  readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  readonly feeTransfers: ReadonlyArray<PersistedSourceTransfer>
  readonly legs: ReadonlyArray<PersistedSourceLeg>
}

/**
 * PersistNormalizedSourceArtifactsContext - Persisted pre-leg artifacts available
 * to provider-specific leg derivation inside the repository transaction.
 */
export interface PersistNormalizedSourceArtifactsContext {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext
  readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  readonly feeTransfers: ReadonlyArray<PersistedSourceTransfer>
}

/**
 * PersistNormalizedSourceArtifactsParamsBase - Shared normalized artifact inputs.
 */
export interface PersistNormalizedSourceArtifactsParamsBase {
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
}

/**
 * PersistNormalizedSourceArtifactsWithLegsParams - Direct leg payload variant used
 * by repository-focused tests and pre-derived call sites.
 */
export interface PersistNormalizedSourceArtifactsWithLegsParams extends PersistNormalizedSourceArtifactsParamsBase {
  readonly legs: ReadonlyArray<SourceTransactionLegDraft>
}

/**
 * PersistNormalizedSourceArtifactsWithDerivationParams - Callback variant used by
 * orchestrators that must derive legs from persisted transaction and transfer ids.
 */
export interface PersistNormalizedSourceArtifactsWithDerivationParams<
  E,
> extends PersistNormalizedSourceArtifactsParamsBase {
  readonly deriveLegs: (
    context: PersistNormalizedSourceArtifactsContext
  ) => Effect.Effect<ReadonlyArray<SourceTransactionLegDraft>, E>
}

/**
 * PersistNormalizedSourceArtifactsParams - Atomic normalized artifact persistence input.
 */
export type PersistNormalizedSourceArtifactsParams<E> =
  | PersistNormalizedSourceArtifactsWithLegsParams
  | PersistNormalizedSourceArtifactsWithDerivationParams<E>

/**
 * SourceNormalizationRepositoryShape - Atomic canonical write surface for normalized source artifacts.
 */
export interface SourceNormalizationRepositoryShape {
  /**
   * Persist normalized canonical artifacts for one raw row, including review rows and FIFO side effects.
   */
  readonly persistNormalizedArtifacts: <E>(
    params: PersistNormalizedSourceArtifactsParams<E>
  ) => Effect.Effect<PersistNormalizedSourceArtifactsResult, E | SyncEngineStorageError>
}

/**
 * SourceNormalizationRepository - Context tag for normalized artifact persistence.
 */
export class SourceNormalizationRepository extends Context.Tag("SourceNormalizationRepository")<
  SourceNormalizationRepository,
  SourceNormalizationRepositoryShape
>() {}
