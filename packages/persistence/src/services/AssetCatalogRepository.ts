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
 * AssetCatalogAssetType - Canonical asset category persisted in the asset table.
 */
export type AssetCatalogAssetType = "native" | "token" | "nft"

/**
 * AssetCatalogAssetRecord - Public asset catalog projection joined with blockchain metadata.
 */
export interface AssetCatalogAssetRecord {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly blockchainChainType: string
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly contractAddress: string | null
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly logoUrl: string | null
  readonly type: AssetCatalogAssetType
  readonly isSpam: boolean
}

/**
 * AssetCatalogListParams - Search and limit options for public asset catalog reads.
 */
export interface AssetCatalogListParams {
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
   * Find one non-spam canonical asset by database id.
   */
  readonly findAssetById: (params: {
    readonly assetId: string
  }) => Effect.Effect<Option.Option<AssetCatalogAssetRecord>, PersistenceError>
}

/**
 * AssetCatalogRepository - Context tag for public asset catalog persistence.
 */
export class AssetCatalogRepository extends Context.Tag("AssetCatalogRepository")<
  AssetCatalogRepository,
  AssetCatalogRepositoryShape
>() {}
