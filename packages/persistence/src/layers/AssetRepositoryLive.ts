/**
 * AssetRepositoryLive - Economic asset and network representation persistence for sync-engine.
 *
 * @module AssetRepositoryLive
 */

import { and, eq, ne, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetRepository,
  type AssetRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { schema } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const normalizeAddress = ({
  chainType,
  address,
}: {
  readonly chainType: string
  readonly address: string | null
}): string | null => (chainType === "evm" && address !== null ? address.toLowerCase() : address)

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const findAssetById: AssetRepositoryShape["findAssetById"] = ({
    assetId,
    lockForApproval = false,
  }) =>
    Effect.gen(function* () {
      const query = db
        .select({ id: schema.assets.id, symbol: schema.assets.symbol, type: schema.assets.type })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
      const [asset] = yield* (lockForApproval ? query.for("share") : query)
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findAssetById"))

      return Option.fromNullishOr(asset)
    })

  const findAssetByCoinGeckoId: AssetRepositoryShape["findAssetByCoinGeckoId"] = ({
    coingeckoCoinId,
  }) =>
    Effect.gen(function* () {
      const [asset] = yield* db
        .select({ id: schema.assets.id, symbol: schema.assets.symbol, type: schema.assets.type })
        .from(schema.assets)
        .where(eq(schema.assets.coingeckoCoinId, coingeckoCoinId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findAssetByCoinGeckoId"))

      return Option.fromNullishOr(asset)
    })

  const findRepresentationById: AssetRepositoryShape["findRepresentationById"] = ({
    assetRepresentationId,
    lockForApproval = false,
  }) =>
    Effect.gen(function* () {
      const query = db
        .select({
          id: schema.assetRepresentations.id,
          assetId: schema.assetRepresentations.assetId,
          symbol: schema.assets.symbol,
          blockchainName: schema.blockchains.name,
          representationType: schema.assetRepresentations.type,
          contractAddress: schema.assetRepresentations.contractAddress,
          mintAddress: schema.assetRepresentations.mintAddress,
          decimals: schema.assetRepresentations.decimals,
        })
        .from(schema.assetRepresentations)
        .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
        .innerJoin(
          schema.blockchains,
          eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
        )
        .where(eq(schema.assetRepresentations.id, assetRepresentationId))
      const [representation] = yield* (
        lockForApproval ? query.for("share", { of: schema.assetRepresentations }) : query
      )
        .limit(1)
        .pipe(wrapSyncEngineSqlError("assetRepository.findRepresentationById"))

      return Option.fromNullishOr(representation)
    })

  const findNativeRepresentationForBlockchain: AssetRepositoryShape["findNativeRepresentationForBlockchain"] =
    ({ blockchainName }) =>
      Effect.gen(function* () {
        const [representation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            assetId: schema.assetRepresentations.assetId,
            symbol: schema.assets.symbol,
            blockchainName: schema.blockchains.name,
            representationType: schema.assetRepresentations.type,
            contractAddress: schema.assetRepresentations.contractAddress,
            mintAddress: schema.assetRepresentations.mintAddress,
            decimals: schema.assetRepresentations.decimals,
          })
          .from(schema.assetRepresentations)
          .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
          .innerJoin(
            schema.blockchains,
            eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
          )
          .where(
            and(
              eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase()),
              eq(schema.assetRepresentations.type, "native")
            )
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("assetRepository.findNativeRepresentationForBlockchain"))

        return Option.fromNullishOr(representation)
      })

  const findRepresentationByBlockchainAndAddress: AssetRepositoryShape["findRepresentationByBlockchainAndAddress"] =
    ({ blockchainName, address }) =>
      Effect.gen(function* () {
        const [representation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            assetId: schema.assetRepresentations.assetId,
            symbol: schema.assets.symbol,
            blockchainName: schema.blockchains.name,
            representationType: schema.assetRepresentations.type,
            contractAddress: schema.assetRepresentations.contractAddress,
            mintAddress: schema.assetRepresentations.mintAddress,
            decimals: schema.assetRepresentations.decimals,
          })
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
                    address.toLowerCase()
                  )
                ),
                and(
                  ne(schema.blockchains.chainType, "evm"),
                  eq(schema.assetRepresentations.contractAddress, address)
                ),
                eq(schema.assetRepresentations.mintAddress, address)
              )
            )
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("assetRepository.findRepresentationByBlockchainAndAddress"))

        return Option.fromNullishOr(representation)
      })

  const listBlockchains: AssetRepositoryShape["listBlockchains"] = () =>
    db
      .select({ id: schema.blockchains.id, name: schema.blockchains.name })
      .from(schema.blockchains)
      .pipe(wrapSyncEngineSqlError("assetRepository.listBlockchains"))

  const upsertEconomicAssetRepresentation: AssetRepositoryShape["upsertEconomicAssetRepresentation"] =
    ({ blockchain, asset, representation }) =>
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
                  explorerUrl: sql`coalesce(excluded.explorer_url, ${schema.blockchains.explorerUrl})`,
                  logoUrl: sql`coalesce(excluded.logo_url, ${schema.blockchains.logoUrl})`,
                  coingeckoPlatformId: sql.raw("excluded.coingecko_platform_id"),
                  updatedAt: now,
                },
              })
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.blockchain"
                )
              )

            const [persistedBlockchain] = yield* tx
              .select({
                id: schema.blockchains.id,
                name: schema.blockchains.name,
                chainType: schema.blockchains.chainType,
              })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, blockchain.name))
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.loadBlockchain"
                )
              )

            if (persistedBlockchain === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.upsertEconomicAssetRepresentation.loadBlockchain",
                cause: {
                  blockchainName: blockchain.name,
                  message: "Blockchain missing after upsert.",
                },
              })
            }

            const contractAddress = normalizeAddress({
              chainType: persistedBlockchain.chainType,
              address: representation.contractAddress,
            })
            const mintAddress = representation.mintAddress

            if (
              representation.type !== "native" &&
              contractAddress === null &&
              mintAddress === null
            ) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateRepresentation",
                cause: {
                  message: "Token and NFT representations require a contract or mint address.",
                },
              })
            }

            const representationFilter =
              representation.type === "native"
                ? and(
                    eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                    eq(schema.assetRepresentations.type, "native")
                  )
                : contractAddress !== null
                  ? and(
                      eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                      eq(schema.assetRepresentations.contractAddress, contractAddress)
                    )
                  : mintAddress !== null
                    ? and(
                        eq(schema.assetRepresentations.blockchainId, persistedBlockchain.id),
                        eq(schema.assetRepresentations.mintAddress, mintAddress)
                      )
                    : undefined

            const [existingRepresentation] = yield* tx
              .select({
                id: schema.assetRepresentations.id,
                assetId: schema.assetRepresentations.assetId,
                assetCoingeckoCoinId: schema.assets.coingeckoCoinId,
                assetType: schema.assets.type,
                decimals: schema.assetRepresentations.decimals,
                representationType: schema.assetRepresentations.type,
              })
              .from(schema.assetRepresentations)
              .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
              .where(representationFilter)
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.findRepresentation"
                )
              )

            const economicAssetFilter =
              asset.coingeckoCoinId === null
                ? and(
                    eq(sql<string>`upper(${schema.assets.symbol})`, asset.symbol.toUpperCase()),
                    eq(sql<string>`lower(${schema.assets.name})`, asset.name.toLowerCase()),
                    eq(schema.assets.type, asset.type)
                  )
                : eq(schema.assets.coingeckoCoinId, asset.coingeckoCoinId)

            const [existingAssetByIdentity] = yield* tx
              .select({ id: schema.assets.id, type: schema.assets.type })
              .from(schema.assets)
              .where(economicAssetFilter)
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.findEconomicAsset"
                )
              )

            const representationOwnerConflicts =
              existingRepresentation !== undefined &&
              ((existingAssetByIdentity !== undefined &&
                existingAssetByIdentity.id !== existingRepresentation.assetId) ||
                (asset.coingeckoCoinId !== null &&
                  existingRepresentation.assetCoingeckoCoinId !== null &&
                  existingRepresentation.assetCoingeckoCoinId !== asset.coingeckoCoinId))

            if (representationOwnerConflicts) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateRepresentationOwner",
                cause: {
                  assetCoingeckoCoinId: asset.coingeckoCoinId,
                  existingAssetId: existingRepresentation.assetId,
                  existingAssetCoingeckoCoinId: existingRepresentation.assetCoingeckoCoinId,
                  representationId: existingRepresentation.id,
                  message: "Representation belongs to a different economic asset.",
                },
              })
            }

            const existingAsset =
              existingAssetByIdentity ??
              (existingRepresentation === undefined
                ? undefined
                : { id: existingRepresentation.assetId, type: existingRepresentation.assetType })

            if (existingAsset !== undefined && existingAsset.type !== asset.type) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateEconomicAssetType",
                cause: {
                  assetId: existingAsset.id,
                  existingType: existingAsset.type,
                  incomingType: asset.type,
                  message: "Economic asset type cannot change after the identity is created.",
                },
              })
            }

            if (
              existingRepresentation !== undefined &&
              (existingRepresentation.representationType !== representation.type ||
                existingRepresentation.decimals !== representation.decimals)
            ) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateRepresentationIdentity",
                cause: {
                  existingDecimals: existingRepresentation.decimals,
                  existingType: existingRepresentation.representationType,
                  incomingDecimals: representation.decimals,
                  incomingType: representation.type,
                  representationId: existingRepresentation.id,
                  message:
                    "Representation type and decimals cannot change after the identity is created.",
                },
              })
            }

            const assetValues = {
              name: asset.name,
              symbol: asset.symbol.toUpperCase(),
              ...(asset.coingeckoCoinId === null ? {} : { coingeckoCoinId: asset.coingeckoCoinId }),
              ...(asset.logoUrl === null ? {} : { logoUrl: asset.logoUrl }),
              type: asset.type,
              updatedAt: now,
            } as const
            const [persistedAsset] =
              existingAsset === undefined
                ? yield* tx
                    .insert(schema.assets)
                    .values({ ...assetValues, createdAt: now })
                    .onConflictDoUpdate({
                      target: schema.assets.coingeckoCoinId,
                      set: {
                        name: assetValues.name,
                        symbol: assetValues.symbol,
                        ...(asset.coingeckoCoinId === null
                          ? {}
                          : { coingeckoCoinId: asset.coingeckoCoinId }),
                        ...(asset.logoUrl === null ? {} : { logoUrl: asset.logoUrl }),
                        updatedAt: now,
                      },
                    })
                    .returning({
                      id: schema.assets.id,
                      name: schema.assets.name,
                      symbol: schema.assets.symbol,
                      type: schema.assets.type,
                    })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "assetRepository.upsertEconomicAssetRepresentation.insertEconomicAsset"
                      )
                    )
                : yield* tx
                    .update(schema.assets)
                    .set(assetValues)
                    .where(eq(schema.assets.id, existingAsset.id))
                    .returning({
                      id: schema.assets.id,
                      name: schema.assets.name,
                      symbol: schema.assets.symbol,
                      type: schema.assets.type,
                    })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "assetRepository.upsertEconomicAssetRepresentation.updateEconomicAsset"
                      )
                    )

            if (persistedAsset === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.upsertEconomicAssetRepresentation.persistEconomicAsset",
                cause: {
                  assetSymbol: asset.symbol,
                  message: "Economic asset missing after upsert.",
                },
              })
            }

            if (persistedAsset.type !== asset.type) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateEconomicAssetType",
                cause: {
                  assetId: persistedAsset.id,
                  existingType: persistedAsset.type,
                  incomingType: asset.type,
                  message: "Economic asset type cannot change after the identity is created.",
                },
              })
            }

            const representationValues = {
              assetId: persistedAsset.id,
              blockchainId: persistedBlockchain.id,
              type: representation.type,
              contractAddress,
              mintAddress: representation.mintAddress,
              decimals: representation.decimals,
              ...(representation.logoUrl === null ? {} : { logoUrl: representation.logoUrl }),
              isSpam: representation.isSpam,
              metadata: representation.metadata,
              updatedAt: now,
            } as const

            if (existingRepresentation === undefined) {
              const insert = tx
                .insert(schema.assetRepresentations)
                .values({ ...representationValues, createdAt: now })
              const conflictSafeInsert =
                representation.type === "native"
                  ? insert.onConflictDoNothing({
                      target: schema.assetRepresentations.blockchainId,
                      where: sql`${schema.assetRepresentations.type} = 'native'`,
                    })
                  : contractAddress !== null
                    ? insert.onConflictDoNothing({
                        target: [
                          schema.assetRepresentations.blockchainId,
                          schema.assetRepresentations.contractAddress,
                        ],
                        where: sql`${schema.assetRepresentations.contractAddress} is not null`,
                      })
                    : insert.onConflictDoNothing({
                        target: [
                          schema.assetRepresentations.blockchainId,
                          schema.assetRepresentations.mintAddress,
                        ],
                        where: sql`${schema.assetRepresentations.mintAddress} is not null`,
                      })

              yield* conflictSafeInsert.pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.insertRepresentation"
                )
              )
            }

            const representationAfterInsert =
              existingRepresentation === undefined
                ? (yield* tx
                    .select({
                      id: schema.assetRepresentations.id,
                      assetId: schema.assetRepresentations.assetId,
                      decimals: schema.assetRepresentations.decimals,
                      representationType: schema.assetRepresentations.type,
                    })
                    .from(schema.assetRepresentations)
                    .where(representationFilter)
                    .limit(1)
                    .pipe(
                      wrapSyncEngineSqlError(
                        "assetRepository.upsertEconomicAssetRepresentation.reloadRepresentation"
                      )
                    ))[0]
                : undefined
            const representationToPersist = existingRepresentation ?? representationAfterInsert

            if (representationToPersist === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.upsertEconomicAssetRepresentation.reloadRepresentation",
                cause: {
                  assetId: persistedAsset.id,
                  message: "Representation missing after conflict-safe insert.",
                },
              })
            }

            if (representationToPersist.assetId !== persistedAsset.id) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateRepresentationOwner",
                cause: {
                  assetId: persistedAsset.id,
                  existingAssetId: representationToPersist.assetId,
                  representationId: representationToPersist.id,
                  message: "Representation belongs to a different economic asset.",
                },
              })
            }

            if (
              representationToPersist.representationType !== representation.type ||
              representationToPersist.decimals !== representation.decimals
            ) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.validateRepresentationIdentity",
                cause: {
                  existingDecimals: representationToPersist.decimals,
                  existingType: representationToPersist.representationType,
                  incomingDecimals: representation.decimals,
                  incomingType: representation.type,
                  representationId: representationToPersist.id,
                  message:
                    "Representation type and decimals cannot change after the identity is created.",
                },
              })
            }

            const [persistedRepresentation] = yield* tx
              .update(schema.assetRepresentations)
              .set(representationValues)
              .where(eq(schema.assetRepresentations.id, representationToPersist.id))
              .returning({
                id: schema.assetRepresentations.id,
                blockchainId: schema.assetRepresentations.blockchainId,
                decimals: schema.assetRepresentations.decimals,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
                representationType: schema.assetRepresentations.type,
              })
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.upsertEconomicAssetRepresentation.updateRepresentation"
                )
              )

            if (persistedRepresentation === undefined) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.upsertEconomicAssetRepresentation.persistRepresentation",
                cause: {
                  assetId: persistedAsset.id,
                  message: "Representation missing after upsert.",
                },
              })
            }

            return {
              ...persistedAsset,
              representationId: persistedRepresentation.id,
              blockchainId: persistedRepresentation.blockchainId,
              blockchainName: persistedBlockchain.name,
              decimals: persistedRepresentation.decimals,
              contractAddress: persistedRepresentation.contractAddress,
              mintAddress: persistedRepresentation.mintAddress,
              representationType: persistedRepresentation.representationType,
            }
          })
        )
        .pipe(wrapSyncEngineSqlError("assetRepository.upsertEconomicAssetRepresentation"))

  const findAssetResolutionCandidatesBySymbol: AssetRepositoryShape["findAssetResolutionCandidatesBySymbol"] =
    ({ symbol }) =>
      db
        .select({
          id: schema.assets.id,
          symbol: schema.assets.symbol,
          type: schema.assets.type,
          coingeckoCoinId: schema.assets.coingeckoCoinId,
        })
        .from(schema.assets)
        .where(eq(sql<string>`lower(${schema.assets.symbol})`, symbol.toLowerCase()))
        .pipe(wrapSyncEngineSqlError("assetRepository.findAssetResolutionCandidatesBySymbol"))

  const attachRepresentationToExistingAsset: AssetRepositoryShape["attachRepresentationToExistingAsset"] =
    ({ assetId, blockchainName, representation }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [blockchain] = yield* tx
              .select({ id: schema.blockchains.id, chainType: schema.blockchains.chainType })
              .from(schema.blockchains)
              .where(
                eq(sql<string>`lower(${schema.blockchains.name})`, blockchainName.toLowerCase())
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "assetRepository.attachRepresentationToExistingAsset.blockchain"
                )
              )

            if (blockchain === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.attachRepresentationToExistingAsset.blockchain",
                cause: { blockchainName, message: "Blockchain does not exist." },
              })
            }

            const contractAddress = normalizeAddress({
              chainType: blockchain.chainType,
              address: representation.contractAddress,
            })
            const mintAddress = representation.mintAddress

            if (
              representation.type !== "native" &&
              contractAddress === null &&
              mintAddress === null
            ) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.attachRepresentationToExistingAsset.identity",
                cause: {
                  assetId,
                  blockchainName,
                  message: "Token and NFT representations require a contract or mint address.",
                },
              })
            }

            const representationFilter =
              representation.type === "native"
                ? and(
                    eq(schema.assetRepresentations.blockchainId, blockchain.id),
                    eq(schema.assetRepresentations.type, "native")
                  )
                : contractAddress !== null
                  ? and(
                      eq(schema.assetRepresentations.blockchainId, blockchain.id),
                      eq(schema.assetRepresentations.contractAddress, contractAddress)
                    )
                  : and(
                      eq(schema.assetRepresentations.blockchainId, blockchain.id),
                      eq(schema.assetRepresentations.mintAddress, mintAddress ?? "")
                    )

            const insert = tx.insert(schema.assetRepresentations).values({
              assetId,
              blockchainId: blockchain.id,
              type: representation.type,
              contractAddress,
              mintAddress: representation.mintAddress,
              decimals: representation.decimals,
              logoUrl: representation.logoUrl,
              isSpam: representation.isSpam,
              metadata: representation.metadata,
            })
            const conflictSafeInsert =
              representation.type === "native"
                ? insert.onConflictDoNothing({
                    target: schema.assetRepresentations.blockchainId,
                    where: sql`${schema.assetRepresentations.type} = 'native'`,
                  })
                : contractAddress !== null
                  ? insert.onConflictDoNothing({
                      target: [
                        schema.assetRepresentations.blockchainId,
                        schema.assetRepresentations.contractAddress,
                      ],
                      where: sql`${schema.assetRepresentations.contractAddress} is not null`,
                    })
                  : insert.onConflictDoNothing({
                      target: [
                        schema.assetRepresentations.blockchainId,
                        schema.assetRepresentations.mintAddress,
                      ],
                      where: sql`${schema.assetRepresentations.mintAddress} is not null`,
                    })

            yield* conflictSafeInsert.pipe(
              wrapSyncEngineSqlError("assetRepository.attachRepresentationToExistingAsset.insert")
            )

            const [persisted] = yield* tx
              .select({
                id: schema.assetRepresentations.id,
                assetId: schema.assetRepresentations.assetId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
                decimals: schema.assetRepresentations.decimals,
                symbol: schema.assets.symbol,
              })
              .from(schema.assetRepresentations)
              .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
              .where(representationFilter)
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError("assetRepository.attachRepresentationToExistingAsset.reload")
              )

            if (persisted === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "assetRepository.attachRepresentationToExistingAsset.reload",
                cause: {
                  assetId,
                  blockchainName,
                  message: "Representation missing after conflict-safe insert.",
                },
              })
            }

            if (persisted.assetId !== assetId) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.attachRepresentationToExistingAsset.validateRepresentationOwner",
                cause: {
                  assetId,
                  existingAssetId: persisted.assetId,
                  representationId: persisted.id,
                  message: "Representation belongs to a different economic asset.",
                },
              })
            }

            if (
              persisted.representationType !== representation.type ||
              persisted.decimals !== representation.decimals
            ) {
              return yield* new SyncEngineStorageError({
                operation:
                  "assetRepository.attachRepresentationToExistingAsset.validateRepresentationIdentity",
                cause: {
                  existingDecimals: persisted.decimals,
                  existingType: persisted.representationType,
                  incomingDecimals: representation.decimals,
                  incomingType: representation.type,
                  representationId: persisted.id,
                  message: "Representation type and decimals do not match the exact evidence.",
                },
              })
            }

            return {
              id: persisted.id,
              assetId: persisted.assetId,
              symbol: persisted.symbol,
              blockchainName,
              representationType: persisted.representationType,
              contractAddress: persisted.contractAddress,
              mintAddress: persisted.mintAddress,
              decimals: persisted.decimals,
            }
          })
        )
        .pipe(wrapSyncEngineSqlError("assetRepository.attachRepresentationToExistingAsset"))

  return AssetRepository.of({
    findAssetById,
    findAssetByCoinGeckoId,
    findRepresentationById,
    findNativeRepresentationForBlockchain,
    findRepresentationByBlockchainAndAddress,
    listBlockchains,
    upsertEconomicAssetRepresentation,
    findAssetResolutionCandidatesBySymbol,
    attachRepresentationToExistingAsset,
  } satisfies AssetRepositoryShape)
})

export const AssetRepositoryLive = Layer.effect(AssetRepository, make)
