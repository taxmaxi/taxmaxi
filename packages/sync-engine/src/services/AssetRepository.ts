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
}

/**
 * AssetRepository - Context tag for asset and blockchain lookup persistence.
 */
export class AssetRepository extends Context.Tag("AssetRepository")<
  AssetRepository,
  AssetRepositoryShape
>() {}
