/**
 * ProviderAssetRepositories - Shared provider asset identity and review persistence.
 *
 * @module ProviderAssetRepositories
 */

import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  ProviderAssetRepository,
  ProviderAssetReviewRepository,
  type CanonicalAssetDraft,
  type CanonicalAssetRecord,
  type CanonicalBlockchainDraft,
  type ProviderAssetRepositoryShape,
  type ProviderAssetReviewRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"
import { requestSourceSyncJob } from "./SourceSyncJobRequest.ts"

const makeMissingIdentityError = ({
  providerKey,
  currencyCode,
}: {
  readonly providerKey: string
  readonly currencyCode: string
}) =>
  Effect.fail(
    new SyncEngineStorageError({
      operation: "providerAssetRepository.upsertProviderAssets",
      cause: {
        providerKey,
        currencyCode,
        message: "Provider asset entries require either providerAssetId or naturalKey.",
      },
    })
  )

/**
 * Build the provider asset ingestion and review adapters over one PostgreSQL client.
 */
export const makeProviderAssetRepositories = Effect.gen(function* () {
  const db = yield* drizzle
  type ProviderAssetExecutor = Pick<typeof db, "insert" | "select" | "update">

  const normalizeContractAddress = ({
    chainType,
    contractAddress,
  }: {
    readonly chainType: string
    readonly contractAddress: string | null
  }): string | null =>
    chainType === "evm" && contractAddress !== null
      ? contractAddress.toLowerCase()
      : contractAddress

  const upsertCanonicalAsset = ({
    executor,
    blockchain,
    asset,
    now,
  }: {
    readonly executor: ProviderAssetExecutor
    readonly blockchain: CanonicalBlockchainDraft
    readonly asset: CanonicalAssetDraft
    readonly now: Date
  }): Effect.Effect<CanonicalAssetRecord, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const [persistedBlockchain] = yield* executor
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
        .returning({
          id: schema.blockchains.id,
          name: schema.blockchains.name,
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
        .pipe(
          wrapSyncEngineSqlError(
            "providerAssetReviewRepository.decideProviderAssetMapping.blockchain"
          )
        )

      if (persistedBlockchain === undefined) {
        return yield* Effect.fail(
          new SyncEngineStorageError({
            operation: "providerAssetReviewRepository.decideProviderAssetMapping.checkBlockchain",
            cause: { blockchainName: blockchain.name },
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

      const [existingAsset] = yield* executor
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(assetFilter)
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError(
            "providerAssetReviewRepository.decideProviderAssetMapping.findAsset"
          )
        )
      const assetValues = {
        blockchainId: persistedBlockchain.id,
        contractAddress,
        name: asset.name,
        symbol: asset.symbol.toUpperCase(),
        decimals: asset.decimals,
        coingeckoCoinId: asset.coingeckoCoinId,
        type: asset.type,
        isSpam: asset.isSpam,
        updatedAt: now,
      } as const

      const [persistedAsset] =
        existingAsset === undefined
          ? yield* executor
              .insert(schema.assets)
              .values({ ...assetValues, logoUrl: asset.logoUrl, createdAt: now })
              .onConflictDoUpdate(
                contractAddress === null
                  ? {
                      target: schema.assets.blockchainId,
                      targetWhere: sql`${schema.assets.contractAddress} is null`,
                      set:
                        asset.logoUrl === null
                          ? assetValues
                          : { ...assetValues, logoUrl: asset.logoUrl },
                    }
                  : {
                      target: [schema.assets.blockchainId, schema.assets.contractAddress],
                      set:
                        asset.logoUrl === null
                          ? assetValues
                          : { ...assetValues, logoUrl: asset.logoUrl },
                    }
              )
              .returning({
                id: schema.assets.id,
                blockchainId: schema.assets.blockchainId,
                name: schema.assets.name,
                symbol: schema.assets.symbol,
                decimals: schema.assets.decimals,
                contractAddress: schema.assets.contractAddress,
                type: schema.assets.type,
              })
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetReviewRepository.decideProviderAssetMapping.insertAsset"
                )
              )
          : yield* executor
              .update(schema.assets)
              .set(
                asset.logoUrl === null ? assetValues : { ...assetValues, logoUrl: asset.logoUrl }
              )
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
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetReviewRepository.decideProviderAssetMapping.updateAsset"
                )
              )

      if (persistedAsset === undefined) {
        return yield* Effect.fail(
          new SyncEngineStorageError({
            operation: "providerAssetReviewRepository.decideProviderAssetMapping.persistAsset",
            cause: { assetSymbol: asset.symbol },
          })
        )
      }

      return { ...persistedAsset, blockchainName: persistedBlockchain.name }
    })

  const upsertProviderAssets: ProviderAssetRepositoryShape["upsertProviderAssets"] = ({
    providerKey,
    entries,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (entries.length === 0) {
            return 0
          }

          const now = nowDate()

          return yield* Effect.forEach(entries, (entry) => {
            const values = {
              provider: providerKey,
              providerAssetId: entry.providerAssetId,
              naturalKey: entry.naturalKey,
              currencyCode: entry.currencyCode.toUpperCase(),
              name: entry.name,
              exponent: entry.exponent,
              providerType: entry.providerType,
              rawProviderPayload: entry.payload,
              retrievedAt: now,
              createdAt: now,
              updatedAt: now,
            } as const

            if (entry.providerAssetId !== null) {
              return tx
                .insert(schema.providerAssets)
                .values(values)
                .onConflictDoUpdate({
                  target: [schema.providerAssets.provider, schema.providerAssets.providerAssetId],
                  targetWhere: sql`${schema.providerAssets.providerAssetId} is not null`,
                  set: {
                    naturalKey: sql.raw("excluded.natural_key"),
                    currencyCode: sql.raw("excluded.currency_code"),
                    name: sql.raw("excluded.name"),
                    exponent: sql.raw("excluded.exponent"),
                    providerType: sql.raw("excluded.provider_type"),
                    rawProviderPayload: sql.raw("excluded.raw_provider_payload"),
                    retrievedAt: sql.raw("excluded.retrieved_at"),
                    updatedAt: now,
                  },
                })
                .pipe(wrapSyncEngineSqlError("providerAssetRepository.upsertProviderAssets"))
            }

            if (entry.naturalKey !== null) {
              return tx
                .insert(schema.providerAssets)
                .values(values)
                .onConflictDoUpdate({
                  target: [schema.providerAssets.provider, schema.providerAssets.naturalKey],
                  targetWhere: sql`${schema.providerAssets.naturalKey} is not null`,
                  set: {
                    currencyCode: sql.raw("excluded.currency_code"),
                    name: sql.raw("excluded.name"),
                    exponent: sql.raw("excluded.exponent"),
                    providerType: sql.raw("excluded.provider_type"),
                    rawProviderPayload: sql.raw("excluded.raw_provider_payload"),
                    retrievedAt: sql.raw("excluded.retrieved_at"),
                    updatedAt: now,
                  },
                })
                .pipe(wrapSyncEngineSqlError("providerAssetRepository.upsertProviderAssets"))
            }

            return makeMissingIdentityError({
              providerKey,
              currencyCode: entry.currencyCode,
            })
          }).pipe(Effect.as(entries.length))
        })
      )
      .pipe(wrapSyncEngineStorageError("providerAssetRepository.upsertProviderAssets"))

  const upsertProviderAssetMappings: ProviderAssetRepositoryShape["upsertProviderAssetMappings"] =
    ({ mappings }) =>
      Effect.gen(function* () {
        if (mappings.length === 0) {
          return 0
        }

        const now = nowDate()

        yield* db
          .insert(schema.providerAssetMappings)
          .values(
            mappings.map((mapping) => ({
              providerAssetRowId: mapping.providerAssetRowId,
              mappingKind: mapping.mappingKind,
              canonicalAssetId: mapping.canonicalAssetId,
              canonicalAssetSymbol: mapping.canonicalAssetSymbol,
              canonicalFiatCurrency: mapping.canonicalFiatCurrency,
              mappingStatus: mapping.mappingStatus,
              reviewerNotes: mapping.reviewerNotes,
              sourceNotes: mapping.sourceNotes,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: schema.providerAssetMappings.providerAssetRowId,
            set: {
              mappingKind: sql.raw("excluded.mapping_kind"),
              canonicalAssetId: sql.raw("excluded.canonical_asset_id"),
              canonicalAssetSymbol: sql.raw("excluded.canonical_asset_symbol"),
              canonicalFiatCurrency: sql.raw("excluded.canonical_fiat_currency"),
              mappingStatus: sql.raw("excluded.mapping_status"),
              reviewerNotes: sql.raw("excluded.reviewer_notes"),
              sourceNotes: sql.raw("excluded.source_notes"),
              updatedAt: now,
            },
          })
          .pipe(wrapSyncEngineSqlError("providerAssetRepository.upsertProviderAssetMappings"))

        return mappings.length
      })

  const seedProviderAssetMappingsIfMissing: ProviderAssetRepositoryShape["seedProviderAssetMappingsIfMissing"] =
    ({ mappings }) =>
      Effect.gen(function* () {
        if (mappings.length === 0) {
          return 0
        }

        const now = nowDate()

        const insertedRows = yield* db
          .insert(schema.providerAssetMappings)
          .values(
            mappings.map((mapping) => ({
              providerAssetRowId: mapping.providerAssetRowId,
              mappingKind: mapping.mappingKind,
              canonicalAssetId: mapping.canonicalAssetId,
              canonicalAssetSymbol: mapping.canonicalAssetSymbol,
              canonicalFiatCurrency: mapping.canonicalFiatCurrency,
              mappingStatus: mapping.mappingStatus,
              reviewerNotes: mapping.reviewerNotes,
              sourceNotes: mapping.sourceNotes,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoNothing({
            target: schema.providerAssetMappings.providerAssetRowId,
          })
          .returning({ id: schema.providerAssetMappings.id })
          .pipe(
            wrapSyncEngineSqlError("providerAssetRepository.seedProviderAssetMappingsIfMissing")
          )

        return insertedRows.length
      })

  const backfillApprovedSymbolMappingsCanonicalAssetIds: ProviderAssetRepositoryShape["backfillApprovedSymbolMappingsCanonicalAssetIds"] =
    ({ mappings }) =>
      Effect.gen(function* () {
        if (mappings.length === 0) {
          return 0
        }

        const now = nowDate()

        const updatedCounts = yield* Effect.forEach(mappings, (mapping) =>
          db
            .update(schema.providerAssetMappings)
            .set({
              canonicalAssetId: mapping.canonicalAssetId,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.providerAssetMappings.providerAssetRowId, mapping.providerAssetRowId),
                eq(schema.providerAssetMappings.mappingKind, "asset"),
                eq(schema.providerAssetMappings.mappingStatus, "approved"),
                eq(schema.providerAssetMappings.canonicalAssetSymbol, mapping.canonicalAssetSymbol),
                sql`${schema.providerAssetMappings.canonicalAssetId} is null`
              )
            )
            .returning({ id: schema.providerAssetMappings.id })
            .pipe(
              Effect.map((rows) => rows.length),
              wrapSyncEngineSqlError(
                "providerAssetRepository.backfillApprovedSymbolMappingsCanonicalAssetIds"
              )
            )
        )

        return updatedCounts.reduce((total, count) => total + count, 0)
      })

  const findProviderAssetByProviderAssetId: ProviderAssetRepositoryShape["findProviderAssetByProviderAssetId"] =
    ({ providerKey, providerAssetId }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({
            id: schema.providerAssets.id,
            provider: schema.providerAssets.provider,
            providerAssetId: schema.providerAssets.providerAssetId,
            naturalKey: schema.providerAssets.naturalKey,
            currencyCode: schema.providerAssets.currencyCode,
            name: schema.providerAssets.name,
            exponent: schema.providerAssets.exponent,
            providerType: schema.providerAssets.providerType,
            rawProviderPayload: schema.providerAssets.rawProviderPayload,
            discoveredAt: schema.providerAssets.discoveredAt,
            retrievedAt: schema.providerAssets.retrievedAt,
          })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, providerKey),
              eq(schema.providerAssets.providerAssetId, providerAssetId)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetByProviderAssetId")
          )

        return Option.fromNullable(row)
      })

  const findProviderAssetByNaturalKey: ProviderAssetRepositoryShape["findProviderAssetByNaturalKey"] =
    ({ providerKey, naturalKey }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({
            id: schema.providerAssets.id,
            provider: schema.providerAssets.provider,
            providerAssetId: schema.providerAssets.providerAssetId,
            naturalKey: schema.providerAssets.naturalKey,
            currencyCode: schema.providerAssets.currencyCode,
            name: schema.providerAssets.name,
            exponent: schema.providerAssets.exponent,
            providerType: schema.providerAssets.providerType,
            rawProviderPayload: schema.providerAssets.rawProviderPayload,
            discoveredAt: schema.providerAssets.discoveredAt,
            retrievedAt: schema.providerAssets.retrievedAt,
          })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, providerKey),
              eq(schema.providerAssets.naturalKey, naturalKey)
            )
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetByNaturalKey"))

        return Option.fromNullable(row)
      })

  const findProviderAssetByCurrencyCode: ProviderAssetRepositoryShape["findProviderAssetByCurrencyCode"] =
    ({ providerKey, currencyCode }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({
            id: schema.providerAssets.id,
            provider: schema.providerAssets.provider,
            providerAssetId: schema.providerAssets.providerAssetId,
            naturalKey: schema.providerAssets.naturalKey,
            currencyCode: schema.providerAssets.currencyCode,
            name: schema.providerAssets.name,
            exponent: schema.providerAssets.exponent,
            providerType: schema.providerAssets.providerType,
            rawProviderPayload: schema.providerAssets.rawProviderPayload,
            discoveredAt: schema.providerAssets.discoveredAt,
            retrievedAt: schema.providerAssets.retrievedAt,
          })
          .from(schema.providerAssets)
          .leftJoin(
            schema.providerAssetMappings,
            eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
          )
          .where(
            and(
              eq(schema.providerAssets.provider, providerKey),
              eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
            )
          )
          .orderBy(
            sql`case
              when ${schema.providerAssetMappings.mappingStatus} = 'approved' then 0
              when ${schema.providerAssetMappings.mappingStatus} = 'pending_review' then 1
              when ${schema.providerAssetMappings.mappingStatus} = 'rejected' then 2
              else 3
            end`,
            sql`case when ${schema.providerAssets.providerAssetId} is null then 1 else 0 end`,
            desc(schema.providerAssets.retrievedAt)
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetByCurrencyCode"))

        return Option.fromNullable(row)
      })

  const providerAssetReviewProjection = {
    providerAsset: {
      id: schema.providerAssets.id,
      provider: schema.providerAssets.provider,
      providerAssetId: schema.providerAssets.providerAssetId,
      naturalKey: schema.providerAssets.naturalKey,
      currencyCode: schema.providerAssets.currencyCode,
      name: schema.providerAssets.name,
      exponent: schema.providerAssets.exponent,
      providerType: schema.providerAssets.providerType,
      rawProviderPayload: schema.providerAssets.rawProviderPayload,
      discoveredAt: schema.providerAssets.discoveredAt,
      retrievedAt: schema.providerAssets.retrievedAt,
    },
    mapping: {
      providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
      mappingKind: schema.providerAssetMappings.mappingKind,
      canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
      canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
      mappingStatus: schema.providerAssetMappings.mappingStatus,
      reviewerNotes: schema.providerAssetMappings.reviewerNotes,
      sourceNotes: schema.providerAssetMappings.sourceNotes,
      reviewedBy: schema.providerAssetMappings.reviewedBy,
      reviewedAt: schema.providerAssetMappings.reviewedAt,
    },
  } as const

  const findProviderAssetReviewById: ProviderAssetReviewRepositoryShape["findProviderAssetReviewById"] =
    ({ providerAssetRowId }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select(providerAssetReviewProjection)
          .from(schema.providerAssets)
          .leftJoin(
            schema.providerAssetMappings,
            eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
          )
          .where(eq(schema.providerAssets.id, providerAssetRowId))
          .limit(1)
          .pipe(wrapSyncEngineSqlError("providerAssetReviewRepository.findProviderAssetReviewById"))

        return Option.fromNullable(row)
      })

  const listProviderAssetReviews: ProviderAssetReviewRepositoryShape["listProviderAssetReviews"] =
    ({ providerKey, mappingStatus, query, cursorProviderAssetRowId, limit }) =>
      Effect.gen(function* () {
        const cursorRow =
          cursorProviderAssetRowId === null
            ? Option.none<{
                readonly id: string
                readonly provider: string
                readonly currencyCode: string
              }>()
            : yield* db
                .select({
                  id: schema.providerAssets.id,
                  provider: schema.providerAssets.provider,
                  currencyCode: schema.providerAssets.currencyCode,
                })
                .from(schema.providerAssets)
                .where(eq(schema.providerAssets.id, cursorProviderAssetRowId))
                .limit(1)
                .pipe(
                  Effect.map(([row]) => Option.fromNullable(row)),
                  wrapSyncEngineSqlError(
                    "providerAssetReviewRepository.listProviderAssetReviews.cursor"
                  )
                )

        if (cursorProviderAssetRowId !== null && Option.isNone(cursorRow)) {
          return []
        }

        const cursorPredicate = Option.match(cursorRow, {
          onNone: () => undefined,
          onSome: (row) =>
            or(
              gt(schema.providerAssets.provider, row.provider),
              and(
                eq(schema.providerAssets.provider, row.provider),
                gt(schema.providerAssets.currencyCode, row.currencyCode)
              ),
              and(
                eq(schema.providerAssets.provider, row.provider),
                eq(schema.providerAssets.currencyCode, row.currencyCode),
                gt(schema.providerAssets.id, row.id)
              )
            ),
        })
        const predicates = [
          eq(schema.providerAssetMappings.mappingStatus, mappingStatus),
          ...(providerKey === null ? [] : [eq(schema.providerAssets.provider, providerKey)]),
          ...(query === null || query.trim() === ""
            ? []
            : [
                or(
                  ilike(schema.providerAssets.currencyCode, `%${query.trim()}%`),
                  ilike(schema.providerAssets.name, `%${query.trim()}%`),
                  ilike(schema.providerAssets.providerAssetId, `%${query.trim()}%`),
                  ilike(schema.providerAssets.naturalKey, `%${query.trim()}%`),
                  sql`${schema.providerAssets.rawProviderPayload}::text ilike ${`%${query.trim()}%`}`
                ),
              ]),
          ...(cursorPredicate === undefined ? [] : [cursorPredicate]),
        ]

        return yield* db
          .select(providerAssetReviewProjection)
          .from(schema.providerAssets)
          .innerJoin(
            schema.providerAssetMappings,
            eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
          )
          .where(and(...predicates))
          .orderBy(
            asc(schema.providerAssets.provider),
            asc(schema.providerAssets.currencyCode),
            asc(schema.providerAssets.id)
          )
          .limit(limit)
          .pipe(wrapSyncEngineSqlError("providerAssetReviewRepository.listProviderAssetReviews"))
      })

  const countProviderAssetReviews: ProviderAssetReviewRepositoryShape["countProviderAssetReviews"] =
    ({ providerKey, mappingStatus, query }) => {
      const search = query?.trim() ?? ""
      const predicates = [
        eq(schema.providerAssetMappings.mappingStatus, mappingStatus),
        ...(providerKey === null ? [] : [eq(schema.providerAssets.provider, providerKey)]),
        ...(search === ""
          ? []
          : [
              or(
                ilike(schema.providerAssets.currencyCode, `%${search}%`),
                ilike(schema.providerAssets.name, `%${search}%`),
                ilike(schema.providerAssets.providerAssetId, `%${search}%`),
                ilike(schema.providerAssets.naturalKey, `%${search}%`),
                sql`${schema.providerAssets.rawProviderPayload}::text ilike ${`%${search}%`}`
              ),
            ]),
      ]

      return db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.providerAssets)
        .innerJoin(
          schema.providerAssetMappings,
          eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
        )
        .where(and(...predicates))
        .pipe(
          Effect.map(([row]) => row?.count ?? 0),
          wrapSyncEngineSqlError("providerAssetReviewRepository.countProviderAssetReviews")
        )
    }

  const decideProviderAssetMapping: ProviderAssetReviewRepositoryShape["decideProviderAssetMapping"] =
    (params) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [mapping] = yield* tx
              .select({ mappingStatus: schema.providerAssetMappings.mappingStatus })
              .from(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, params.providerAssetRowId))
              .limit(1)
              .for("update")
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetReviewRepository.decideProviderAssetMapping.lock"
                )
              )

            if (mapping?.mappingStatus !== "pending_review") {
              return { updated: false, canonicalAsset: null, affectedSources: [] }
            }

            const canonicalAsset =
              params.mappingStatus === "rejected" ||
              params.mappingKind === "fiat" ||
              params.canonicalAssetDraft === null
                ? null
                : yield* upsertCanonicalAsset({
                    executor: tx,
                    blockchain: params.canonicalAssetDraft.blockchain,
                    asset: params.canonicalAssetDraft.asset,
                    now: params.reviewedAt,
                  })

            const canonicalAssetId =
              params.mappingStatus === "approved" && params.mappingKind === "asset"
                ? (canonicalAsset?.id ?? params.canonicalAssetId)
                : null

            const canonicalAssetSymbol =
              params.mappingStatus === "approved" && params.mappingKind === "asset"
                ? (canonicalAsset?.symbol ?? params.canonicalAssetSymbol)
                : null

            const canonicalFiatCurrency =
              params.mappingStatus === "approved" && params.mappingKind === "fiat"
                ? params.canonicalFiatCurrency
                : null

            const updated = yield* tx
              .update(schema.providerAssetMappings)
              .set({
                mappingKind: params.mappingKind,
                canonicalAssetId,
                canonicalAssetSymbol,
                canonicalFiatCurrency,
                mappingStatus: params.mappingStatus,
                reviewerNotes: params.reviewerNotes,
                sourceNotes: params.sourceNotes,
                reviewedBy: params.reviewedBy,
                reviewedAt: params.reviewedAt,
                updatedAt: params.reviewedAt,
              })
              .where(
                and(
                  eq(schema.providerAssetMappings.providerAssetRowId, params.providerAssetRowId),
                  eq(schema.providerAssetMappings.mappingStatus, "pending_review")
                )
              )
              .returning({ id: schema.providerAssetMappings.id })
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetReviewRepository.decideProviderAssetMapping.update"
                )
              )

            if (updated.length !== 1) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation: "providerAssetReviewRepository.decideProviderAssetMapping.update",
                  cause: { providerAssetRowId: params.providerAssetRowId },
                })
              )
            }

            const sourceCandidates =
              params.createReplayJobs && params.mappingStatus === "approved"
                ? yield* Effect.gen(function* () {
                    const transferSources = yield* tx
                      .selectDistinct({
                        sourceId: schema.providerTransfers.sourceId,
                        principalId: schema.sources.principalId,
                      })
                      .from(schema.providerTransfers)
                      .innerJoin(
                        schema.sources,
                        eq(schema.sources.id, schema.providerTransfers.sourceId)
                      )
                      .where(
                        eq(schema.providerTransfers.providerAssetId, params.providerAssetRowId)
                      )
                      .orderBy(asc(schema.providerTransfers.sourceId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetReviewRepository.decideProviderAssetMapping.affectedSources"
                        )
                      )

                    const observationSources = yield* tx
                      .selectDistinct({
                        sourceId: schema.providerAssetObservations.sourceId,
                        principalId: schema.sources.principalId,
                      })
                      .from(schema.providerAssetObservations)
                      .innerJoin(
                        schema.sources,
                        eq(schema.sources.id, schema.providerAssetObservations.sourceId)
                      )
                      .where(
                        eq(
                          schema.providerAssetObservations.providerAssetId,
                          params.providerAssetRowId
                        )
                      )
                      .orderBy(asc(schema.providerAssetObservations.sourceId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetReviewRepository.decideProviderAssetMapping.observedSources"
                        )
                      )

                    return [
                      ...new Map(
                        [...transferSources, ...observationSources].map((source) => [
                          source.sourceId,
                          source,
                        ])
                      ).values(),
                    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId))
                  })
                : []

            const affectedSources = yield* Effect.forEach(sourceCandidates, (source) =>
              Effect.gen(function* () {
                const job = yield* requestSourceSyncJob({
                  executor: tx,
                  sourceId: source.sourceId,
                  principalId: source.principalId,
                  mode: "replay",
                  maxAttempts: 3,
                  requestedAt: params.reviewedAt,
                  activeReplayPolicy: "request_follow_up_if_processing",
                })

                return { ...source, jobId: job.id }
              })
            )

            if (affectedSources.length > 0) {
              yield* tx
                .insert(schema.providerAssetReviewReplays)
                .values(
                  affectedSources.map((source) => ({
                    providerAssetRowId: params.providerAssetRowId,
                    sourceId: source.sourceId,
                    principalId: source.principalId,
                    jobId: source.jobId,
                    createdAt: params.reviewedAt,
                    updatedAt: params.reviewedAt,
                  }))
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "providerAssetReviewRepository.decideProviderAssetMapping.linkReplayJobs"
                  )
                )
            }

            return { updated: true, canonicalAsset, affectedSources }
          })
        )
        .pipe(wrapSyncEngineSqlError("providerAssetReviewRepository.decideProviderAssetMapping"))

  const findProviderAssetReplaySource: ProviderAssetReviewRepositoryShape["findProviderAssetReplaySource"] =
    ({ providerAssetRowId, sourceId, jobId }) =>
      Effect.gen(function* () {
        const [replay] = yield* db
          .select({
            sourceId: schema.providerAssetReviewReplays.sourceId,
            principalId: schema.providerAssetReviewReplays.principalId,
            jobId: schema.providerAssetReviewReplays.jobId,
          })
          .from(schema.providerAssetReviewReplays)
          .where(
            and(
              eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
              eq(schema.providerAssetReviewReplays.sourceId, sourceId),
              eq(schema.providerAssetReviewReplays.jobId, jobId)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError("providerAssetReviewRepository.findProviderAssetReplaySource")
          )

        return Option.fromNullable(replay)
      })

  const replaceProviderAssetReplayJob: ProviderAssetReviewRepositoryShape["replaceProviderAssetReplayJob"] =
    ({ providerAssetRowId, sourceId, previousJobId, nextJobId }) =>
      Effect.gen(function* () {
        const [nextJob] = yield* db
          .select({ principalId: schema.processingJobs.principalId })
          .from(schema.processingJobs)
          .where(
            and(
              eq(schema.processingJobs.id, nextJobId),
              eq(schema.processingJobs.sourceId, sourceId),
              or(
                eq(schema.processingJobs.mode, "replay"),
                eq(schema.processingJobs.followUpMode, "replay")
              )
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "providerAssetReviewRepository.replaceProviderAssetReplayJob.load"
            )
          )

        if (nextJob === undefined) return false

        const updated = yield* db
          .update(schema.providerAssetReviewReplays)
          .set({
            principalId: nextJob.principalId,
            jobId: nextJobId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
              eq(schema.providerAssetReviewReplays.sourceId, sourceId),
              eq(schema.providerAssetReviewReplays.jobId, previousJobId)
            )
          )
          .returning({ id: schema.providerAssetReviewReplays.id })
          .pipe(
            wrapSyncEngineSqlError(
              "providerAssetReviewRepository.replaceProviderAssetReplayJob.update"
            )
          )

        return updated.length === 1
      })

  const findProviderAssetMapping: ProviderAssetRepositoryShape["findProviderAssetMapping"] = ({
    providerAssetRowId,
  }) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({
          providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
          mappingKind: schema.providerAssetMappings.mappingKind,
          canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
          canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
          canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
          mappingStatus: schema.providerAssetMappings.mappingStatus,
        })
        .from(schema.providerAssetMappings)
        .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetMapping"))

      return Option.fromNullable(row)
    })

  return {
    providerAssetRepository: ProviderAssetRepository.of({
      upsertProviderAssets,
      upsertProviderAssetMappings,
      seedProviderAssetMappingsIfMissing,
      backfillApprovedSymbolMappingsCanonicalAssetIds,
      findProviderAssetByProviderAssetId,
      findProviderAssetByNaturalKey,
      findProviderAssetByCurrencyCode,
      findProviderAssetMapping,
    } satisfies ProviderAssetRepositoryShape),
    providerAssetReviewRepository: ProviderAssetReviewRepository.of({
      findProviderAssetReviewById,
      listProviderAssetReviews,
      countProviderAssetReviews,
      decideProviderAssetMapping,
      findProviderAssetReplaySource,
      replaceProviderAssetReplayJob,
    } satisfies ProviderAssetReviewRepositoryShape),
  }
})
