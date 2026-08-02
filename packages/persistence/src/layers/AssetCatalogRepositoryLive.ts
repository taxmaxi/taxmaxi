/**
 * AssetCatalogRepositoryLive - Drizzle-backed economic asset catalog reads.
 *
 * @module AssetCatalogRepositoryLive
 */

import { and, asc, eq, ilike, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetCatalogRepository,
  type AssetCatalogAssetRecord,
  type AssetCatalogRepositoryShape,
  type AssetCatalogRepresentationRecord,
} from "../services/AssetCatalogRepository.ts"
import { schema } from "../schema/index.ts"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { drizzle } from "./PgClientLive.ts"

const representationColumns = {
  id: schema.assetRepresentations.id,
  blockchainId: schema.assetRepresentations.blockchainId,
  blockchainName: schema.blockchains.name,
  blockchainChainType: schema.blockchains.chainType,
  blockchainChainId: schema.blockchains.chainId,
  blockchainExplorerUrl: schema.blockchains.explorerUrl,
  blockchainLogoUrl: schema.blockchains.logoUrl,
  type: schema.assetRepresentations.type,
  contractAddress: schema.assetRepresentations.contractAddress,
  mintAddress: schema.assetRepresentations.mintAddress,
  decimals: schema.assetRepresentations.decimals,
  logoUrl: schema.assetRepresentations.logoUrl,
  metadata: schema.assetRepresentations.metadata,
} as const

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const loadRepresentations = ({ assetIds }: { readonly assetIds: ReadonlyArray<string> }) =>
    Effect.gen(function* () {
      if (assetIds.length === 0) {
        return new Map<string, ReadonlyArray<AssetCatalogRepresentationRecord>>()
      }

      const rows = yield* db
        .select({ assetId: schema.assetRepresentations.assetId, ...representationColumns })
        .from(schema.assetRepresentations)
        .innerJoin(
          schema.blockchains,
          eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
        )
        .where(
          and(
            eq(schema.assetRepresentations.isSpam, false),
            or(...assetIds.map((assetId) => eq(schema.assetRepresentations.assetId, assetId)))
          )
        )
        .orderBy(asc(schema.blockchains.name), asc(schema.assetRepresentations.id))
        .pipe(wrapSqlError("assetCatalogRepository.loadRepresentations"))
      const byAssetId = new Map<string, ReadonlyArray<AssetCatalogRepresentationRecord>>()

      for (const { assetId, ...representation } of rows) {
        byAssetId.set(assetId, [...(byAssetId.get(assetId) ?? []), representation])
      }

      return byAssetId
    })

  const listAssets: AssetCatalogRepositoryShape["listAssets"] = ({ limit, query }) =>
    Effect.gen(function* () {
      const trimmedQuery = query?.trim() ?? ""
      const searchFilter =
        trimmedQuery.length === 0
          ? undefined
          : or(
              ilike(schema.assets.name, `%${trimmedQuery}%`),
              ilike(schema.assets.symbol, `%${trimmedQuery}%`),
              ilike(schema.assets.coingeckoCoinId, `%${trimmedQuery}%`),
              ilike(schema.assetRepresentations.contractAddress, `%${trimmedQuery}%`),
              ilike(schema.assetRepresentations.mintAddress, `%${trimmedQuery}%`),
              ilike(schema.blockchains.name, `%${trimmedQuery}%`)
            )
      const rows = yield* db
        .selectDistinct({
          id: schema.assets.id,
          name: schema.assets.name,
          symbol: schema.assets.symbol,
          logoUrl: schema.assets.logoUrl,
          type: schema.assets.type,
        })
        .from(schema.assets)
        .leftJoin(
          schema.assetRepresentations,
          and(
            eq(schema.assetRepresentations.assetId, schema.assets.id),
            eq(schema.assetRepresentations.isSpam, false)
          )
        )
        .leftJoin(
          schema.blockchains,
          eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
        )
        .where(searchFilter)
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.name), asc(schema.assets.id))
        .limit(limit)
        .pipe(wrapSqlError("assetCatalogRepository.listAssets"))
      const representations = yield* loadRepresentations({ assetIds: rows.map(({ id }) => id) })

      return rows.map((asset) => ({
        ...asset,
        representations: representations.get(asset.id) ?? [],
      }))
    })

  const findAssetById: AssetCatalogRepositoryShape["findAssetById"] = ({ assetId }) =>
    Effect.gen(function* () {
      const [asset] = yield* db
        .select({
          id: schema.assets.id,
          name: schema.assets.name,
          symbol: schema.assets.symbol,
          logoUrl: schema.assets.logoUrl,
          type: schema.assets.type,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1)
        .pipe(wrapSqlError("assetCatalogRepository.findAssetById"))

      if (asset === undefined) {
        return Option.none<AssetCatalogAssetRecord>()
      }

      const representations = yield* loadRepresentations({ assetIds: [asset.id] })

      return Option.some({
        ...asset,
        representations: representations.get(asset.id) ?? [],
      })
    })

  return AssetCatalogRepository.of({
    findAssetById,
    listAssets,
  } satisfies AssetCatalogRepositoryShape)
})

/** Live layer for public economic asset catalog persistence. */
export const AssetCatalogRepositoryLive = Layer.effect(AssetCatalogRepository, make)
