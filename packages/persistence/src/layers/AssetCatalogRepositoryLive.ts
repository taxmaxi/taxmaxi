/**
 * AssetCatalogRepositoryLive - Drizzle-backed economic asset catalog reads.
 *
 * @module AssetCatalogRepositoryLive
 */

import { and, asc, eq, exists, gt, ilike, or, sql } from "drizzle-orm"
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
import { getAssetCatalogSearchPatterns } from "../query/AssetCatalogSearch.ts"
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

  const listAssets: AssetCatalogRepositoryShape["listAssets"] = ({ cursor, limit, query }) =>
    Effect.gen(function* () {
      const searchFilters = getAssetCatalogSearchPatterns(query ?? "").map((pattern) =>
        or(
          ilike(schema.assets.name, pattern),
          ilike(schema.assets.symbol, pattern),
          ilike(schema.assets.coingeckoCoinId, pattern),
          sql<boolean>`${schema.assets.id}::text ilike ${pattern}`,
          exists(
            db
              .select({ id: schema.assetRepresentations.id })
              .from(schema.assetRepresentations)
              .leftJoin(
                schema.blockchains,
                eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
              )
              .where(
                and(
                  eq(schema.assetRepresentations.assetId, schema.assets.id),
                  eq(schema.assetRepresentations.isSpam, false),
                  or(
                    ilike(schema.assetRepresentations.contractAddress, pattern),
                    ilike(schema.assetRepresentations.mintAddress, pattern),
                    ilike(schema.blockchains.name, pattern),
                    ilike(schema.blockchains.chainType, pattern)
                  )
                )
              )
          )
        )
      )
      const cursorFilter = cursor === null ? undefined : gt(schema.assets.id, cursor.assetId)
      const rows = yield* db
        .select({
          id: schema.assets.id,
          name: schema.assets.name,
          symbol: schema.assets.symbol,
          coingeckoCoinId: schema.assets.coingeckoCoinId,
          logoUrl: schema.assets.logoUrl,
          type: schema.assets.type,
        })
        .from(schema.assets)
        .where(and(...searchFilters, cursorFilter))
        .orderBy(asc(schema.assets.id))
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
          coingeckoCoinId: schema.assets.coingeckoCoinId,
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
