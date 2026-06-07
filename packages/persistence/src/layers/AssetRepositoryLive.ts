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
import {
  AssetRepository,
  type AssetRepositoryShape,
  type SyncEngineChainType,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const normalizeContractAddress = ({
  chainType,
  contractAddress,
}: {
  readonly chainType: SyncEngineChainType
  readonly contractAddress: string | null
}): string | null =>
  chainType === "evm" && contractAddress !== null ? contractAddress.toLowerCase() : contractAddress

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

  const upsertCanonicalAsset: AssetRepositoryShape["upsertCanonicalAsset"] = ({
    blockchain,
    asset,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const now = new Date()

          yield* tx
            .insert(schema.blockchains)
            .values({
              name: blockchain.name,
              chainType: blockchain.chainType,
              chainId: blockchain.chainId,
              nativeAssetSymbol: blockchain.nativeAssetSymbol,
              explorerUrl: blockchain.explorerUrl,
              logoUrl: blockchain.logoUrl,
              coingeckoPlatformId: blockchain.coingeckoPlatformId,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.blockchains.name,
              set: {
                chainType: sql.raw("excluded.chain_type"),
                chainId: sql.raw("excluded.chain_id"),
                coingeckoPlatformId: sql.raw("excluded.coingecko_platform_id"),
                updatedAt: now,
              },
            })
            .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.blockchain"))

          const [persistedBlockchain] = yield* tx
            .select({
              id: schema.blockchains.id,
              name: schema.blockchains.name,
            })
            .from(schema.blockchains)
            .where(eq(schema.blockchains.name, blockchain.name))
            .limit(1)
            .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.loadBlockchain"))

          if (persistedBlockchain === undefined) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "assetRepository.upsertCanonicalAsset.loadBlockchain",
                cause: {
                  blockchainName: blockchain.name,
                  message: "Canonical blockchain was not available after upsert.",
                },
              })
            )
          }

          const contractAddress = normalizeContractAddress({
            chainType: blockchain.chainType,
            contractAddress: asset.contractAddress,
          })
          const assetFilter =
            contractAddress === null
              ? and(
                  eq(schema.assets.blockchainId, persistedBlockchain.id),
                  eq(sql<string>`upper(${schema.assets.symbol})`, asset.symbol.toUpperCase()),
                  eq(schema.assets.type, asset.type),
                  isNull(schema.assets.contractAddress)
                )
              : blockchain.chainType === "evm"
                ? and(
                    eq(schema.assets.blockchainId, persistedBlockchain.id),
                    eq(sql<string>`lower(${schema.assets.contractAddress})`, contractAddress)
                  )
                : and(
                    eq(schema.assets.blockchainId, persistedBlockchain.id),
                    eq(schema.assets.contractAddress, contractAddress)
                  )

          const [existingAsset] = yield* tx
            .select({ id: schema.assets.id })
            .from(schema.assets)
            .where(assetFilter)
            .limit(1)
            .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.findAsset"))

          const assetValues = {
            blockchainId: persistedBlockchain.id,
            contractAddress,
            name: asset.name,
            symbol: asset.symbol.toUpperCase(),
            decimals: asset.decimals,
            type: asset.type,
            isSpam: asset.isSpam,
            updatedAt: now,
          } as const
          const assetInsertValues = {
            ...assetValues,
            logoUrl: asset.logoUrl,
          } as const
          const assetUpdateValues =
            asset.logoUrl === null
              ? assetValues
              : {
                  ...assetValues,
                  logoUrl: asset.logoUrl,
                }

          const [persistedAsset] =
            existingAsset === undefined
              ? yield* tx
                  .insert(schema.assets)
                  .values({
                    ...assetInsertValues,
                    createdAt: now,
                  })
                  .returning({
                    id: schema.assets.id,
                    blockchainId: schema.assets.blockchainId,
                    name: schema.assets.name,
                    symbol: schema.assets.symbol,
                    decimals: schema.assets.decimals,
                    contractAddress: schema.assets.contractAddress,
                    type: schema.assets.type,
                  })
                  .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.insertAsset"))
              : yield* tx
                  .update(schema.assets)
                  .set(assetUpdateValues)
                  .where(eq(schema.assets.id, existingAsset.id))
                  .returning({
                    id: schema.assets.id,
                    blockchainId: schema.assets.blockchainId,
                    name: schema.assets.name,
                    symbol: schema.assets.symbol,
                    decimals: schema.assets.decimals,
                    contractAddress: schema.assets.contractAddress,
                    type: schema.assets.type,
                  })
                  .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.updateAsset"))

          if (persistedAsset === undefined) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "assetRepository.upsertCanonicalAsset.persistAsset",
                cause: {
                  assetSymbol: asset.symbol,
                  blockchainName: blockchain.name,
                  message: "Canonical asset was not available after upsert.",
                },
              })
            )
          }

          return {
            ...persistedAsset,
            blockchainName: persistedBlockchain.name,
          }
        })
      )
      .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset"))

  return AssetRepository.of({
    findAssetById,
    findAssetBySymbol,
    findNativeAssetForBlockchain,
    findAssetByBlockchainAndContractAddress,
    listBlockchains,
    upsertCanonicalAsset,
  } satisfies AssetRepositoryShape)
})

export const AssetRepositoryLive = Layer.effect(AssetRepository, make)
