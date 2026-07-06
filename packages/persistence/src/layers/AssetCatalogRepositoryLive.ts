/**
 * AssetCatalogRepositoryLive - Drizzle-backed public asset catalog reads.
 *
 * @module AssetCatalogRepositoryLive
 */

import { and, asc, eq, ilike, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  AssetCatalogRepository,
  type AssetCatalogRepositoryShape,
} from "../services/AssetCatalogRepository.ts"
import { wrapSqlError } from "../errors/RepositoryError.ts"

const assetCatalogColumns = {
  id: schema.assets.id,
  blockchainId: schema.assets.blockchainId,
  blockchainName: schema.blockchains.name,
  blockchainChainType: schema.blockchains.chainType,
  blockchainChainId: schema.blockchains.chainId,
  blockchainExplorerUrl: schema.blockchains.explorerUrl,
  blockchainLogoUrl: schema.blockchains.logoUrl,
  contractAddress: schema.assets.contractAddress,
  name: schema.assets.name,
  symbol: schema.assets.symbol,
  decimals: schema.assets.decimals,
  logoUrl: schema.assets.logoUrl,
  type: schema.assets.type,
  isSpam: schema.assets.isSpam,
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const listAssets: AssetCatalogRepositoryShape["listAssets"] = ({ limit, query }) => {
    const trimmedQuery = query?.trim() ?? ""
    const searchFilter =
      trimmedQuery.length > 0
        ? or(
            ilike(schema.assets.name, `%${trimmedQuery}%`),
            ilike(schema.assets.symbol, `%${trimmedQuery}%`),
            ilike(schema.assets.contractAddress, `%${trimmedQuery}%`),
            ilike(schema.blockchains.name, `%${trimmedQuery}%`)
          )
        : undefined
    const visibilityFilter = eq(schema.assets.isSpam, false)
    const whereClause =
      searchFilter === undefined ? visibilityFilter : and(visibilityFilter, searchFilter)

    return db
      .select(assetCatalogColumns)
      .from(schema.assets)
      .innerJoin(schema.blockchains, eq(schema.assets.blockchainId, schema.blockchains.id))
      .where(whereClause)
      .orderBy(asc(schema.blockchains.name), asc(schema.assets.symbol), asc(schema.assets.id))
      .limit(limit)
      .pipe(wrapSqlError("assetCatalogRepository.listAssets"))
  }

  const findAssetById: AssetCatalogRepositoryShape["findAssetById"] = ({ assetId }) =>
    db
      .select(assetCatalogColumns)
      .from(schema.assets)
      .innerJoin(schema.blockchains, eq(schema.assets.blockchainId, schema.blockchains.id))
      .where(and(eq(schema.assets.id, assetId), eq(schema.assets.isSpam, false)))
      .limit(1)
      .pipe(
        wrapSqlError("assetCatalogRepository.findAssetById"),
        Effect.map((rows) => Option.fromNullable(rows[0]))
      )

  return AssetCatalogRepository.of({
    findAssetById,
    listAssets,
  } satisfies AssetCatalogRepositoryShape)
})

/**
 * AssetCatalogRepositoryLive - Live layer for public asset catalog persistence.
 */
export const AssetCatalogRepositoryLive = Layer.effect(AssetCatalogRepository, make)
