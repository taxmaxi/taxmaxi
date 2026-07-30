/**
 * AssetCatalogRepositoryLive - Drizzle-backed economic asset catalog reads.
 *
 * @module AssetCatalogRepositoryLive
 */

import { and, asc, eq, ilike, inArray, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import {
  AssetCatalogRepository,
  type AssetCatalogAssetRecord,
  type AssetCatalogRepositoryShape,
} from "../services/AssetCatalogRepository.ts"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"

const assetCatalogColumns = {
  id: schema.assets.id,
  name: schema.assets.name,
  symbol: schema.assets.symbol,
  coingeckoCoinId: schema.assets.coingeckoCoinId,
  logoUrl: schema.assets.logoUrl,
  isSpam: schema.assets.isSpam,
  representationId: schema.assetRepresentations.id,
  blockchainId: schema.blockchains.id,
  blockchainName: schema.blockchains.name,
  blockchainChainType: schema.blockchains.chainType,
  blockchainChainId: schema.blockchains.chainId,
  blockchainExplorerUrl: schema.blockchains.explorerUrl,
  blockchainLogoUrl: schema.blockchains.logoUrl,
  contractAddress: schema.assetRepresentations.contractAddress,
  decimals: schema.assetRepresentations.decimals,
  representationType: schema.assetRepresentations.type,
  representationMetadata: schema.assetRepresentations.metadata,
}

type AssetCatalogRow = {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
  readonly isSpam: boolean
  readonly representationId: string | null
  readonly blockchainId: string | null
  readonly blockchainName: string | null
  readonly blockchainChainType: string | null
  readonly blockchainChainId: number | null
  readonly blockchainExplorerUrl: string | null
  readonly blockchainLogoUrl: string | null
  readonly contractAddress: string | null
  readonly decimals: number | null
  readonly representationType: "native" | "token" | "nft" | null
  readonly representationMetadata: unknown
}

const toAssetRecords = (rows: ReadonlyArray<AssetCatalogRow>) => {
  const records = new Map<string, AssetCatalogAssetRecord>()

  for (const row of rows) {
    const current = records.get(row.id) ?? {
      id: row.id,
      name: row.name,
      symbol: row.symbol,
      coingeckoCoinId: row.coingeckoCoinId,
      logoUrl: row.logoUrl,
      isSpam: row.isSpam,
      representations: [],
    }
    const representation =
      row.representationId === null ||
      row.blockchainId === null ||
      row.blockchainName === null ||
      row.blockchainChainType === null ||
      row.decimals === null ||
      row.representationType === null
        ? []
        : [
            {
              id: row.representationId,
              blockchainId: row.blockchainId,
              blockchainName: row.blockchainName,
              blockchainChainType: row.blockchainChainType,
              blockchainChainId: row.blockchainChainId,
              blockchainExplorerUrl: row.blockchainExplorerUrl,
              blockchainLogoUrl: row.blockchainLogoUrl,
              contractAddress: row.contractAddress,
              decimals: row.decimals,
              type: row.representationType,
              metadata: row.representationMetadata,
            },
          ]

    records.set(row.id, {
      ...current,
      representations: [...current.representations, ...representation],
    })
  }

  return [...records.values()]
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const loadAssets = (assetIds: ReadonlyArray<string>) =>
    assetIds.length === 0
      ? Effect.succeed([])
      : db
          .select(assetCatalogColumns)
          .from(schema.assets)
          .leftJoin(
            schema.assetRepresentations,
            eq(schema.assetRepresentations.assetId, schema.assets.id)
          )
          .leftJoin(
            schema.blockchains,
            eq(schema.blockchains.id, schema.assetRepresentations.blockchainId)
          )
          .where(inArray(schema.assets.id, assetIds))
          .orderBy(
            asc(schema.assets.symbol),
            asc(schema.assets.id),
            asc(schema.blockchains.name),
            asc(schema.assetRepresentations.id)
          )
          .pipe(wrapSqlError("assetCatalogRepository.loadAssets"), Effect.map(toAssetRecords))

  const listAssets: AssetCatalogRepositoryShape["listAssets"] = ({ limit, query }) =>
    Effect.gen(function* () {
      const trimmedQuery = query?.trim() ?? ""
      const searchFilter =
        trimmedQuery.length > 0
          ? or(
              ilike(schema.assets.name, `%${trimmedQuery}%`),
              ilike(schema.assets.symbol, `%${trimmedQuery}%`),
              ilike(schema.assetRepresentations.contractAddress, `%${trimmedQuery}%`),
              ilike(schema.blockchains.name, `%${trimmedQuery}%`)
            )
          : undefined
      const visibilityFilter = eq(schema.assets.isSpam, false)
      const whereClause =
        searchFilter === undefined ? visibilityFilter : and(visibilityFilter, searchFilter)
      const assetRows = yield* db
        .selectDistinct({
          id: schema.assets.id,
          symbol: schema.assets.symbol,
        })
        .from(schema.assets)
        .leftJoin(
          schema.assetRepresentations,
          eq(schema.assetRepresentations.assetId, schema.assets.id)
        )
        .leftJoin(
          schema.blockchains,
          eq(schema.blockchains.id, schema.assetRepresentations.blockchainId)
        )
        .where(whereClause)
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.id))
        .limit(limit)
        .pipe(wrapSqlError("assetCatalogRepository.listAssets"))

      return yield* loadAssets(assetRows.map((row) => row.id))
    })

  const findAssetById: AssetCatalogRepositoryShape["findAssetById"] = ({ assetId }) =>
    loadAssets([assetId]).pipe(
      Effect.map((records) =>
        records[0]?.isSpam === false ? Option.some(records[0]) : Option.none()
      )
    )

  return AssetCatalogRepository.of({
    findAssetById,
    listAssets,
  } satisfies AssetCatalogRepositoryShape)
})

/**
 * AssetCatalogRepositoryLive - Live economic asset catalog persistence.
 */
export const AssetCatalogRepositoryLive = Layer.effect(AssetCatalogRepository, make)
