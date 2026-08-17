/**
 * AssetCatalogRepository - Public canonical asset catalog read model.
 *
 * @module AssetCatalogRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * AssetCatalogAssetType - Economic asset category persisted in the asset table.
 */
export type AssetCatalogAssetType = "fungible" | "nft"

/** Public network representation projection with blockchain metadata. */
export interface AssetCatalogRepresentationRecord {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly blockchainChainType: string
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly type: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
  readonly logoUrl: string | null
  readonly metadata: unknown
  /** Internal identity searches may include hidden spam representations. */
  readonly isSpam?: boolean
}

/**
 * AssetCatalogAssetRecord - Economic asset with its known network representations.
 */
export interface AssetCatalogAssetRecord {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
  readonly type: AssetCatalogAssetType
  readonly representations: ReadonlyArray<AssetCatalogRepresentationRecord>
}

/** Public pending provider asset projection. */
export interface PendingAssetCatalogRecord {
  readonly id: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly symbol: string
  readonly name: string | null
  readonly providerType: string | null
}

/**
 * AssetCatalogListParams - Search and limit options for public asset catalog reads.
 */
export interface AssetCatalogListParams {
  readonly cursor: {
    readonly assetId: string
  } | null
  readonly query: string | null
  readonly limit: number
  /** Include hidden representations for internal identity ownership checks. */
  readonly includeSpamRepresentations?: boolean
}

/** Search and paging options for public pending asset reads. */
export interface PendingAssetCatalogListParams {
  readonly cursor: {
    readonly providerAssetRowId: string
  } | null
  readonly provider: string | null
  readonly query: string | null
  readonly limit: number
}

/**
 * AssetCatalogRepositoryShape - Read operations for canonical assets.
 */
export interface AssetCatalogRepositoryShape {
  /**
   * List non-spam canonical assets, optionally filtered by a search query.
   */
  readonly listAssets: (
    params: AssetCatalogListParams
  ) => Effect.Effect<ReadonlyArray<AssetCatalogAssetRecord>, PersistenceError>

  /**
   * List pending crypto provider observations using only public catalog fields.
   */
  readonly listPendingAssets: (
    params: PendingAssetCatalogListParams
  ) => Effect.Effect<ReadonlyArray<PendingAssetCatalogRecord>, PersistenceError>

  /**
   * Find one non-spam canonical asset by database id.
   */
  readonly findAssetById: (params: {
    readonly assetId: string
  }) => Effect.Effect<Option.Option<AssetCatalogAssetRecord>, PersistenceError>

  /**
   * Find one canonical asset by its stable CoinGecko coin id.
   */
  readonly findAssetByCoinGeckoId: (params: {
    readonly coingeckoCoinId: string
  }) => Effect.Effect<Option.Option<AssetCatalogAssetRecord>, PersistenceError>
}

/**
 * AssetCatalogRepository - Context tag for public asset catalog persistence.
 */
export class AssetCatalogRepository extends Context.Service<
  AssetCatalogRepository,
  AssetCatalogRepositoryShape
>()("AssetCatalogRepository") {}
