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
 * CanonicalAssetDraft - Canonical asset data to create or refresh.
 */
export interface CanonicalAssetDraft {
  readonly contractAddress: string | null
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly logoUrl: string | null
  readonly type: "native" | "token" | "nft"
  readonly isSpam: boolean
}

/**
 * CanonicalAssetRecord - Canonical asset with its owning blockchain.
 */
export interface CanonicalAssetRecord {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly contractAddress: string | null
  readonly type: "native" | "token" | "nft"
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

  /**
   * Load a canonical asset by symbol.
   */
  readonly findAssetBySymbol: (params: {
    readonly symbol: string
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /**
   * Load the native asset for one blockchain by blockchain name and symbol.
   */
  readonly findNativeAssetForBlockchain: (params: {
    readonly blockchainName: string
    readonly symbol: string
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /**
   * Load a token/NFT asset by blockchain name and mint/contract address.
   */
  readonly findAssetByBlockchainAndContractAddress: (params: {
    readonly blockchainName: string
    readonly contractAddress: string
  }) => Effect.Effect<Option.Option<SyncEngineAsset>, SyncEngineStorageError>

  /**
   * Load all blockchains used for provider network-name resolution.
   */
  readonly listBlockchains: () => Effect.Effect<
    ReadonlyArray<SyncEngineBlockchain>,
    SyncEngineStorageError
  >

  /**
   * Create or refresh a canonical blockchain and asset as one durable operation.
   */
  readonly upsertCanonicalAsset: (params: {
    readonly blockchain: CanonicalBlockchainDraft
    readonly asset: CanonicalAssetDraft
  }) => Effect.Effect<CanonicalAssetRecord, SyncEngineStorageError>
}

/**
 * AssetRepository - Context tag for asset and blockchain lookup persistence.
 */
export class AssetRepository extends Context.Tag("AssetRepository")<
  AssetRepository,
  AssetRepositoryShape
>() {}
