/**
 * AssetCatalogRepository - Public economic asset catalog read model.
 *
 * @module AssetCatalogRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * AssetCatalogRepresentationRecord - One chain-specific form of an economic asset.
 */
export interface AssetCatalogRepresentationRecord {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly blockchainChainType: string
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly contractAddress: string | null
  readonly decimals: number
  readonly type: "native" | "token" | "nft"
  readonly metadata: unknown
}

/**
 * AssetCatalogAssetRecord - Economic asset with all known network representations.
 */
export interface AssetCatalogAssetRecord {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
  readonly isSpam: boolean
  readonly representations: ReadonlyArray<AssetCatalogRepresentationRecord>
}

export interface AssetCatalogListParams {
  readonly query: string | null
  readonly limit: number
}

/**
 * AssetCatalogRepositoryShape - Read operations for economic assets.
 */
export interface AssetCatalogRepositoryShape {
  readonly listAssets: (
    params: AssetCatalogListParams
  ) => Effect.Effect<ReadonlyArray<AssetCatalogAssetRecord>, PersistenceError>

  readonly findAssetById: (params: {
    readonly assetId: string
  }) => Effect.Effect<Option.Option<AssetCatalogAssetRecord>, PersistenceError>
}

/**
 * AssetCatalogRepository - Context tag for public economic asset catalog persistence.
 */
export class AssetCatalogRepository extends Context.Tag("AssetCatalogRepository")<
  AssetCatalogRepository,
  AssetCatalogRepositoryShape
>() {}
