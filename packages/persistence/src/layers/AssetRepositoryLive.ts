/**
 * AssetRepositoryLive - Canonical asset and blockchain lookup persistence for sync-engine.
 *
 * @module AssetRepositoryLive
 */

import { and, eq, isNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { AssetRepository, type AssetRepositoryShape } from "@my/sync-engine/services"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findAssetById: AssetRepositoryShape["findAssetById"] = ({ assetId }) =>
    Effect.gen(function* () {
      const [asset] = yield* db
        .select({
          id: schema.assets.id,
          symbol: schema.assets.symbol,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findAssetById"))

      return Option.fromNullable(asset)
    })

  const findAssetBySymbol: AssetRepositoryShape["findAssetBySymbol"] = ({ symbol }) =>
    Effect.gen(function* () {
      const [asset] = yield* db
        .select({
          id: schema.assets.id,
          symbol: schema.assets.symbol,
        })
        .from(schema.assets)
        .where(eq(sql<string>`upper(${schema.assets.symbol})`, symbol.toUpperCase()))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findAssetBySymbol"))

      return Option.fromNullable(asset)
    })

  const findNativeAssetForBlockchain: AssetRepositoryShape["findNativeAssetForBlockchain"] = ({
    blockchainName,
    symbol,
  }) =>
    Effect.gen(function* () {
      const [asset] = yield* db
        .select({
          id: schema.assets.id,
          symbol: schema.assets.symbol,
        })
        .from(schema.assets)
        .innerJoin(schema.blockchains, eq(schema.assets.blockchainId, schema.blockchains.id))
        .where(
          and(
            eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase()),
            eq(sql<string>`upper(${schema.assets.symbol})`, symbol.toUpperCase()),
            eq(schema.assets.type, "native"),
            isNull(schema.assets.contractAddress)
          )
        )
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findNativeAssetForBlockchain"))

      return Option.fromNullable(asset)
    })

  const findAssetByBlockchainAndContractAddress: AssetRepositoryShape["findAssetByBlockchainAndContractAddress"] =
    ({ blockchainName, contractAddress }) =>
      Effect.gen(function* () {
        const [asset] = yield* db
          .select({
            id: schema.assets.id,
            symbol: schema.assets.symbol,
          })
          .from(schema.assets)
          .innerJoin(schema.blockchains, eq(schema.assets.blockchainId, schema.blockchains.id))
          .where(
            and(
              eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase()),
              eq(schema.assets.contractAddress, contractAddress)
            )
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("assetRepository.findAssetByBlockchainAndContractAddress"))

        return Option.fromNullable(asset)
      })

  const listBlockchains: AssetRepositoryShape["listBlockchains"] = () =>
    db
      .select({
        id: schema.blockchains.id,
        name: schema.blockchains.name,
      })
      .from(schema.blockchains)
      .pipe(wrapSyncEngineSqlError("assetRepository.listBlockchains"))

  return AssetRepository.of({
    findAssetById,
    findAssetBySymbol,
    findNativeAssetForBlockchain,
    findAssetByBlockchainAndContractAddress,
    listBlockchains,
  } satisfies AssetRepositoryShape)
})

export const AssetRepositoryLive = Layer.effect(AssetRepository, make)
