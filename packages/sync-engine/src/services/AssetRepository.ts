/**
 * AssetRepository - Canonical asset and blockchain lookup contract for sync normalization.
 *
 * @module AssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SyncEngineAsset - Minimal asset projection required by the sync engine.
 */
export interface SyncEngineAsset {
  readonly id: string
  readonly symbol: string
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
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /** Load a canonical asset by its stable CoinGecko coin id. */
  readonly findAssetByCoinGeckoId: (params: {
    readonly coingeckoCoinId: string
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /** Load a network representation by id. */
  readonly findRepresentationById: (params: {
    readonly assetRepresentationId: string
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
}

/**
 * AssetRepository - Context tag for asset and blockchain lookup persistence.
 */
export class AssetRepository extends Context.Tag("AssetRepository")<
  AssetRepository,
  AssetRepositoryShape
>() {}
