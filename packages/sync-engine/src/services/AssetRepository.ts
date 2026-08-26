/**
 * AssetRepository - Canonical asset and blockchain lookup contract for sync normalization.
 *
 * @module AssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { AssetResolutionPolicyEvaluationRecord } from "./ProviderAssetRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SyncEngineAsset - Minimal asset projection required by the sync engine.
 */
export interface SyncEngineAsset {
  readonly id: string
  readonly symbol: string
  readonly type: "fungible" | "nft"
}

/** Network representation resolved from exact chain reference data. */
export interface SyncEngineAssetRepresentation {
  readonly id: string
  readonly assetId: string
  readonly symbol: string
  readonly blockchainName: string
  readonly representationType: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
}

/**
 * SyncEngineBlockchain - Minimal blockchain projection used for network lookups.
 */
export interface SyncEngineBlockchain {
  readonly id: string
  readonly name: string
}

/**
 * CanonicalBlockchainDraft - Blockchain reference data to create or refresh.
 */
export interface CanonicalBlockchainDraft {
  readonly name: string
  readonly chainType: string
  readonly chainId: number | null
  readonly nativeAssetSymbol: string
  readonly explorerUrl: string | null
  readonly logoUrl: string | null
  readonly coingeckoPlatformId: string
}

/**
 * EconomicAssetDraft - Chain-independent economic asset data to create or refresh.
 */
export interface EconomicAssetDraft {
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
  readonly type: "fungible" | "nft"
}

/**
 * AssetRepresentationDraft - Concrete native asset, contract, or mint on one blockchain.
 */
export interface AssetRepresentationDraft {
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
  readonly logoUrl: string | null
  readonly type: "native" | "token" | "nft"
  readonly isSpam: boolean
  readonly metadata: unknown
}

/** Existing economic asset considered as a resolution display candidate. */
export interface AssetResolutionCandidateAsset {
  readonly id: string
  readonly symbol: string
  readonly type: "fungible" | "nft"
  readonly coingeckoCoinId: string | null
}

/** One audited conclusion that an economic asset owns a network representation. */
export interface RepresentationOwnershipDecisionEntry {
  readonly id: string
  readonly assetRepresentationId: string
  readonly assetId: string
  readonly supersedesOwnershipDecisionId: string | null
  readonly policyRevision: string
  readonly reason: string | null
  readonly actor: string
  readonly createdAt: Date
}

/** Result of recording a representation ownership decision. */
export interface RepresentationOwnershipRecordResult {
  readonly recorded: boolean
}

/** Economic asset and the exact network representation created for it. */
export interface EconomicAssetRepresentationRecord {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly type: "fungible" | "nft"
  readonly representationId: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly decimals: number
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly representationType: "native" | "token" | "nft"
}

/**
 * AssetRepositoryShape - Canonical asset/network resolution operations.
 */
export interface AssetRepositoryShape {
  /**
   * Load a canonical asset by id.
   */
  readonly findAssetById: (params: {
    readonly assetId: string
    readonly lockForApproval?: boolean
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /** Load a canonical asset by its stable CoinGecko coin id. */
  readonly findAssetByCoinGeckoId: (params: {
    readonly coingeckoCoinId: string
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /** Load a network representation by id. */
  readonly findRepresentationById: (params: {
    readonly assetRepresentationId: string
    readonly lockForApproval?: boolean
  }) => Effect.Effect<Option.Option<SyncEngineAssetRepresentation>, SyncEngineStorageError>

  /**
   * Load the native representation for one blockchain by blockchain name.
   */
  readonly findNativeRepresentationForBlockchain: (params: {
    readonly blockchainName: string
  }) => Effect.Effect<Option.Option<SyncEngineAssetRepresentation>, SyncEngineStorageError>

  /**
   * Load a token/NFT asset by blockchain name and mint/contract address.
   */
  readonly findRepresentationByBlockchainAndAddress: (params: {
    readonly blockchainName: string
    readonly address: string
  }) => Effect.Effect<Option.Option<SyncEngineAssetRepresentation>, SyncEngineStorageError>

  /**
   * Load all blockchains used for provider network-name resolution.
   */
  readonly listBlockchains: () => Effect.Effect<
    ReadonlyArray<SyncEngineBlockchain>,
    SyncEngineStorageError
  >

  /**
   * Create or refresh an economic asset and one network representation as one durable operation.
   */
  readonly upsertEconomicAssetRepresentation: (params: {
    readonly blockchain: CanonicalBlockchainDraft
    readonly asset: EconomicAssetDraft
    readonly representation: AssetRepresentationDraft
  }) => Effect.Effect<EconomicAssetRepresentationRecord, SyncEngineStorageError>

  /**
   * List existing economic assets whose display symbol or name matches a
   * provider observation's display metadata. Matching is unicode-normalized
   * (NFKC) and case-insensitive, so trivial lookalikes collide. A match can
   * only raise a possible duplicate for the policy; it never proves one.
   */
  readonly findAssetResolutionCandidatesByDisplay: (params: {
    readonly symbol: string
    readonly name: string | null
  }) => Effect.Effect<ReadonlyArray<AssetResolutionCandidateAsset>, SyncEngineStorageError>

  /**
   * Attach a new exact network representation to an already-existing economic
   * asset, without creating or modifying the asset or blockchain rows. Retrying
   * with the same identity on the same asset is a successful no-op; attaching
   * an identity already owned by a different asset fails.
   */
  readonly attachRepresentationToExistingAsset: (params: {
    readonly assetId: string
    readonly blockchainName: string
    readonly representation: AssetRepresentationDraft
  }) => Effect.Effect<SyncEngineAssetRepresentation, SyncEngineStorageError>

  /**
   * Create a standalone economic asset owning one new exact network
   * representation, and record the create_standalone audit decision, in one
   * transaction. The decision is passed with null asset ids; the repository
   * fills in the created ids before writing it, so a created asset can never
   * exist without the decision that created it. The blockchain must already
   * exist; standalone creation never invents reference data. Losing a race
   * for the representation identity, the CoinGecko coin id, or the active
   * decision slot fails the transaction so no orphan asset survives; the
   * retrying job then finds the winner's rows and attaches instead, so
   * concurrent attempts cannot create duplicate economic assets or assign
   * one representation to two owners.
   */
  readonly createStandaloneAssetRepresentation: (params: {
    readonly blockchainName: string
    readonly asset: EconomicAssetDraft
    readonly representation: AssetRepresentationDraft
    readonly decision: AssetResolutionPolicyEvaluationRecord
  }) => Effect.Effect<EconomicAssetRepresentationRecord, SyncEngineStorageError>

  /**
   * Record the audited conclusion that an economic asset owns a network
   * representation, keyed on the representation so any provider can reuse it.
   * Repeating the same policy result reports recorded: false. Changing the
   * owner is reserved for the revision-bound human correction transaction.
   */
  readonly recordRepresentationOwnershipDecision: (params: {
    readonly assetRepresentationId: string
    readonly assetId: string
    readonly policyRevision: string
    readonly actor: string
  }) => Effect.Effect<RepresentationOwnershipRecordResult, SyncEngineStorageError>

  /**
   * Read the latest ownership decision for one network representation.
   */
  readonly findCurrentRepresentationOwnership: (params: {
    readonly assetRepresentationId: string
  }) => Effect.Effect<Option.Option<RepresentationOwnershipDecisionEntry>, SyncEngineStorageError>
}

/**
 * AssetRepository - Context tag for asset and blockchain lookup persistence.
 */
export class AssetRepository extends Context.Service<AssetRepository, AssetRepositoryShape>()(
  "AssetRepository"
) {}
