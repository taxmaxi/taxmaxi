/**
 * AssetRepositoryLive - Economic asset and network representation persistence for sync-engine.
 *
 * @module AssetRepositoryLive
 */

import { and, eq, isNull, ne, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetRepository,
  type AssetRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const normalizeContractAddress = ({
  chainType,
  contractAddress,
}: {
  readonly chainType: string
  readonly contractAddress: string | null
}): string | null =>
  chainType === "evm" && contractAddress !== null ? contractAddress.toLowerCase() : contractAddress

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findAssetById: AssetRepositoryShape["findAssetById"] = ({ assetId }) =>
    db
      .select({
        id: schema.assets.id,
        symbol: schema.assets.symbol,
      })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("assetRepository.findAssetById"),
        Effect.map((rows) => Option.fromNullable(rows[0]))
      )

  const findAssetByCoinGeckoId: AssetRepositoryShape["findAssetByCoinGeckoId"] = ({
    coingeckoCoinId,
  }) =>
    db
      .select({
        id: schema.assets.id,
        symbol: schema.assets.symbol,
      })
      .from(schema.assets)
      .where(eq(schema.assets.coingeckoCoinId, coingeckoCoinId))
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("assetRepository.findAssetByCoinGeckoId"),
        Effect.map((rows) => Option.fromNullable(rows[0]))
      )

  const representationColumns = {
    representationId: schema.assetRepresentations.id,
    assetId: schema.assets.id,
    symbol: schema.assets.symbol,
  }

  const findNativeAssetForBlockchain: AssetRepositoryShape["findNativeAssetForBlockchain"] = ({
    blockchainName,
    symbol,
  }) =>
    db
      .select(representationColumns)
      .from(schema.assetRepresentations)
      .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
      .innerJoin(
        schema.blockchains,
        eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
      )
      .where(
        and(
          eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase()),
          eq(sql<string>`upper(${schema.assets.symbol})`, symbol.toUpperCase()),
          eq(schema.assetRepresentations.type, "native"),
          isNull(schema.assetRepresentations.contractAddress)
        )
      )
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("assetRepository.findNativeAssetForBlockchain"),
        Effect.map((rows) => Option.fromNullable(rows[0]))
      )

  const findAssetByBlockchainAndContractAddress: AssetRepositoryShape["findAssetByBlockchainAndContractAddress"] =
    ({ blockchainName, contractAddress }) =>
      db
        .select(representationColumns)
        .from(schema.assetRepresentations)
        .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
        .innerJoin(
          schema.blockchains,
          eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
        )
        .where(
          and(
            eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase()),
            or(
              and(
                eq(schema.blockchains.chainType, "evm"),
                eq(
                  sql<string>`lower(${schema.assetRepresentations.contractAddress})`,
                  contractAddress.toLowerCase()
                )
              ),
              and(
                ne(schema.blockchains.chainType, "evm"),
                eq(schema.assetRepresentations.contractAddress, contractAddress)
              )
            )
          )
        )
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError("assetRepository.findAssetByBlockchainAndContractAddress"),
          Effect.map((rows) => Option.fromNullable(rows[0]))
        )

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
    representation,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const now = new Date()

          yield* tx
            .insert(schema.blockchains)
            .values({
              ...blockchain,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.blockchains.name,
              set: {
                chainType: sql.raw("excluded.chain_type"),
                chainId: sql.raw("excluded.chain_id"),
                nativeAssetSymbol: sql.raw("excluded.native_asset_symbol"),
                explorerUrl: sql.raw("excluded.explorer_url"),
                logoUrl: sql.raw("excluded.logo_url"),
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
            contractAddress: representation.contractAddress,
          })
          const representationFilter =
            contractAddress === null
              ? and(
                  eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                  eq(schema.assetRepresentations.type, "native"),
                  isNull(schema.assetRepresentations.contractAddress)
                )
              : blockchain.chainType === "evm"
                ? and(
                    eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                    eq(
                      sql<string>`lower(${schema.assetRepresentations.contractAddress})`,
                      contractAddress
                    )
                  )
                : and(
                    eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                    eq(schema.assetRepresentations.contractAddress, contractAddress)
                  )

          const [existingRepresentation] = yield* tx
            .select({
              id: schema.assetRepresentations.id,
              assetId: schema.assetRepresentations.assetId,
              coingeckoCoinId: schema.assets.coingeckoCoinId,
            })
            .from(schema.assetRepresentations)
            .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
            .where(representationFilter)
            .limit(1)
            .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.findRepresentation"))

          const [assetByExternalIdentity] =
            asset.coingeckoCoinId !== null
              ? yield* tx
                  .select({ id: schema.assets.id })
                  .from(schema.assets)
                  .where(eq(schema.assets.coingeckoCoinId, asset.coingeckoCoinId))
                  .limit(1)
                  .pipe(
                    wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.findEconomicAsset")
                  )
              : []
          const representationIdentityConflicts =
            existingRepresentation !== undefined &&
            asset.coingeckoCoinId !== null &&
            ((existingRepresentation.coingeckoCoinId !== null &&
              existingRepresentation.coingeckoCoinId !== asset.coingeckoCoinId) ||
              (assetByExternalIdentity !== undefined &&
                assetByExternalIdentity.id !== existingRepresentation.assetId))

          if (representationIdentityConflicts) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "assetRepository.upsertCanonicalAsset.validateEconomicIdentity",
                cause: {
                  blockchainName: blockchain.name,
                  contractAddress,
                  coingeckoCoinId: asset.coingeckoCoinId,
                  message:
                    "The network representation is already assigned to a different economic asset.",
                },
              })
            )
          }

          const existingAssetId = existingRepresentation?.assetId ?? assetByExternalIdentity?.id
          const assetValues = {
            name: asset.name,
            symbol: asset.symbol.toUpperCase(),
            coingeckoCoinId: asset.coingeckoCoinId,
            isSpam: asset.isSpam,
            updatedAt: now,
          } as const
          const assetUpdateValues =
            asset.logoUrl === null ? assetValues : { ...assetValues, logoUrl: asset.logoUrl }

          const [persistedAsset] =
            existingAssetId === undefined
              ? yield* tx
                  .insert(schema.assets)
                  .values({
                    ...assetValues,
                    logoUrl: asset.logoUrl,
                    createdAt: now,
                  })
                  .returning({
                    id: schema.assets.id,
                    name: schema.assets.name,
                    symbol: schema.assets.symbol,
                  })
                  .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset.insertAsset"))
              : yield* tx
                  .update(schema.assets)
                  .set(assetUpdateValues)
                  .where(eq(schema.assets.id, existingAssetId))
                  .returning({
                    id: schema.assets.id,
                    name: schema.assets.name,
                    symbol: schema.assets.symbol,
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

          const representationValues = {
            assetId: persistedAsset.id,
            blockchainId: persistedBlockchain.id,
            contractAddress,
            decimals: representation.decimals,
            type: representation.type,
            metadata: representation.metadata,
            updatedAt: now,
          } as const
          const [persistedRepresentation] =
            existingRepresentation === undefined
              ? yield* tx
                  .insert(schema.assetRepresentations)
                  .values({
                    ...representationValues,
                    createdAt: now,
                  })
                  .returning({
                    id: schema.assetRepresentations.id,
                    blockchainId: schema.assetRepresentations.blockchainId,
                    decimals: schema.assetRepresentations.decimals,
                    contractAddress: schema.assetRepresentations.contractAddress,
                    type: schema.assetRepresentations.type,
                  })
                  .pipe(
                    wrapSyncEngineSqlError(
                      "assetRepository.upsertCanonicalAsset.insertRepresentation"
                    )
                  )
              : yield* tx
                  .update(schema.assetRepresentations)
                  .set(representationValues)
                  .where(eq(schema.assetRepresentations.id, existingRepresentation.id))
                  .returning({
                    id: schema.assetRepresentations.id,
                    blockchainId: schema.assetRepresentations.blockchainId,
                    decimals: schema.assetRepresentations.decimals,
                    contractAddress: schema.assetRepresentations.contractAddress,
                    type: schema.assetRepresentations.type,
                  })
                  .pipe(
                    wrapSyncEngineSqlError(
                      "assetRepository.upsertCanonicalAsset.updateRepresentation"
                    )
                  )

          if (persistedRepresentation === undefined) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "assetRepository.upsertCanonicalAsset.persistRepresentation",
                cause: {
                  assetId: persistedAsset.id,
                  blockchainName: blockchain.name,
                  message: "Asset representation was not available after upsert.",
                },
              })
            )
          }

          return {
            id: persistedAsset.id,
            representationId: persistedRepresentation.id,
            blockchainId: persistedRepresentation.blockchainId,
            blockchainName: persistedBlockchain.name,
            name: persistedAsset.name,
            symbol: persistedAsset.symbol,
            decimals: persistedRepresentation.decimals,
            contractAddress: persistedRepresentation.contractAddress,
            type: persistedRepresentation.type,
          }
        })
      )
      .pipe(wrapSyncEngineSqlError("assetRepository.upsertCanonicalAsset"))

  return AssetRepository.of({
    findAssetById,
    findAssetByCoinGeckoId,
    findNativeAssetForBlockchain,
    findAssetByBlockchainAndContractAddress,
    listBlockchains,
    upsertCanonicalAsset,
  } satisfies AssetRepositoryShape)
})

/**
 * AssetRepositoryLive - Live economic asset and network representation persistence.
 */
export const AssetRepositoryLive = Layer.effect(AssetRepository, make)
