/**
 * ProviderAssetRepositoryLive - Provider asset identity and mapping persistence.
 *
 * @module ProviderAssetRepositoryLive
 */

import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProviderAssetRepository,
  type ProviderAssetObservedRepresentationRecord,
  type ProviderAssetRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

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

const observationKey = (observation: ProviderAssetObservedRepresentationRecord) =>
  JSON.stringify([
    observation.blockchainName,
    observation.representationType,
    observation.contractAddress,
    observation.mintAddress,
    observation.decimals,
  ])

const observationSnapshotMatches = ({
  expected,
  current,
}: {
  readonly expected: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
  readonly current: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
}) => {
  const expectedKeys = expected.map(observationKey).sort()
  const currentKeys = current.map(observationKey).sort()

  return (
    expectedKeys.length === currentKeys.length &&
    expectedKeys.every((key, index) => key === currentKeys[index])
  )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

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

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const mappingsRequiringLock = mappings.filter(
              (mapping) =>
                mapping.expectedObservedRepresentations !== undefined ||
                mapping.expectedApprovedTarget !== undefined
            )
            if (mappingsRequiringLock.length > 0) {
              const mappingIds = [
                ...new Set(
                  mappingsRequiringLock.map(({ providerAssetRowId }) => providerAssetRowId)
                ),
              ].sort()
              const lockedMappings = yield* tx
                .select({
                  providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
                  mappingKind: schema.providerAssetMappings.mappingKind,
                  canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                  assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
                  canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
                  mappingStatus: schema.providerAssetMappings.mappingStatus,
                })
                .from(schema.providerAssetMappings)
                .where(inArray(schema.providerAssetMappings.providerAssetRowId, mappingIds))
                .orderBy(asc(schema.providerAssetMappings.providerAssetRowId))
                .for("update")

              if (lockedMappings.length !== mappingIds.length) {
                return yield* Effect.fail(
                  new SyncEngineStorageError({
                    operation:
                      "providerAssetRepository.upsertProviderAssetMappings.observationSnapshot",
                    cause: "Provider asset mapping changed before approval.",
                  })
                )
              }

              const lockedMappingById = new Map(
                lockedMappings.map((mapping) => [mapping.providerAssetRowId, mapping])
              )

              yield* Effect.forEach(
                mappingsRequiringLock,
                (mapping) => {
                  const expectedTarget = mapping.expectedApprovedTarget
                  if (expectedTarget === undefined) {
                    return Effect.void
                  }

                  const current = lockedMappingById.get(mapping.providerAssetRowId)
                  return current?.mappingStatus === "approved" &&
                    current.mappingKind === expectedTarget.mappingKind &&
                    current.canonicalAssetId === expectedTarget.canonicalAssetId &&
                    current.assetRepresentationId === expectedTarget.assetRepresentationId &&
                    current.canonicalFiatCurrency === expectedTarget.canonicalFiatCurrency
                    ? Effect.void
                    : Effect.fail(
                        new SyncEngineStorageError({
                          operation:
                            "providerAssetRepository.upsertProviderAssetMappings.approvedTargetSnapshot",
                          cause: "Approved provider asset mapping changed before correction.",
                        })
                      )
                },
                { discard: true }
              )

              yield* Effect.forEach(
                mappingsRequiringLock.filter(
                  (mapping) => mapping.expectedObservedRepresentations !== undefined
                ),
                (mapping) =>
                  Effect.gen(function* () {
                    const currentObservations = yield* tx
                      .selectDistinct({
                        blockchainName: schema.blockchains.name,
                        representationType: sql<
                          "native" | "token" | "nft"
                        >`${schema.providerTransfers.observedRepresentationType}`,
                        contractAddress: schema.providerTransfers.observedContractAddress,
                        mintAddress: schema.providerTransfers.observedMintAddress,
                        decimals: schema.providerTransfers.observedDecimals,
                      })
                      .from(schema.providerTransfers)
                      .innerJoin(
                        schema.blockchains,
                        eq(schema.blockchains.id, schema.providerTransfers.observedBlockchainId)
                      )
                      .where(
                        and(
                          eq(schema.providerTransfers.providerAssetId, mapping.providerAssetRowId),
                          sql`${schema.providerTransfers.observedRepresentationType} is not null`
                        )
                      )

                    if (
                      !observationSnapshotMatches({
                        expected: mapping.expectedObservedRepresentations ?? [],
                        current: currentObservations,
                      })
                    ) {
                      return yield* Effect.fail(
                        new SyncEngineStorageError({
                          operation:
                            "providerAssetRepository.upsertProviderAssetMappings.observationSnapshot",
                          cause: "Provider asset observations changed before approval.",
                        })
                      )
                    }
                  }),
                { discard: true }
              )
            }

            const approvedCorrectionIds = mappings
              .filter((mapping) => mapping.expectedApprovedTarget !== undefined)
              .map(({ providerAssetRowId }) => providerAssetRowId)
            const approvedCorrectionCondition =
              approvedCorrectionIds.length === 0
                ? sql`false`
                : inArray(schema.providerAssetMappings.providerAssetRowId, approvedCorrectionIds)

            const persistedMappings = yield* tx
              .insert(schema.providerAssetMappings)
              .values(
                mappings.map((mapping) => ({
                  providerAssetRowId: mapping.providerAssetRowId,
                  mappingKind: mapping.mappingKind,
                  canonicalAssetId: mapping.canonicalAssetId,
                  assetRepresentationId: mapping.assetRepresentationId,
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
                  assetRepresentationId: sql.raw("excluded.asset_representation_id"),
                  canonicalFiatCurrency: sql.raw("excluded.canonical_fiat_currency"),
                  mappingStatus: sql.raw("excluded.mapping_status"),
                  reviewerNotes: sql.raw("excluded.reviewer_notes"),
                  sourceNotes: sql.raw("excluded.source_notes"),
                  updatedAt: now,
                },
                setWhere: sql`
                  ${schema.providerAssetMappings.mappingStatus} <> 'approved'
                  or (
                    excluded.mapping_status = 'approved'
                    and ${schema.providerAssetMappings.mappingKind} = excluded.mapping_kind
                    and ${schema.providerAssetMappings.canonicalAssetId} is not distinct from excluded.canonical_asset_id
                    and ${schema.providerAssetMappings.assetRepresentationId} is not distinct from excluded.asset_representation_id
                    and ${schema.providerAssetMappings.canonicalFiatCurrency} is not distinct from excluded.canonical_fiat_currency
                  )
                  or ${approvedCorrectionCondition}
                `,
              })
              .returning({ providerAssetRowId: schema.providerAssetMappings.providerAssetRowId })

            if (persistedMappings.length !== mappings.length) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation: "providerAssetRepository.upsertProviderAssetMappings.approvedTarget",
                  cause: "Approved provider asset mappings cannot change target.",
                })
              )
            }
          })
        )

        return mappings.length
      }).pipe(wrapSyncEngineStorageError("providerAssetRepository.upsertProviderAssetMappings"))

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
              assetRepresentationId: mapping.assetRepresentationId,
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
      assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
      canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
      mappingStatus: schema.providerAssetMappings.mappingStatus,
      reviewerNotes: schema.providerAssetMappings.reviewerNotes,
      sourceNotes: schema.providerAssetMappings.sourceNotes,
    },
  } as const

  const findProviderAssetReviewById: ProviderAssetRepositoryShape["findProviderAssetReviewById"] =
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
          .pipe(wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetReviewById"))

        return Option.fromNullable(row)
      })

  const listProviderAssetReviews: ProviderAssetRepositoryShape["listProviderAssetReviews"] = ({
    providerKey,
    mappingStatus,
    cursorProviderAssetRowId,
    limit,
  }) =>
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
                wrapSyncEngineSqlError("providerAssetRepository.listProviderAssetReviews.cursor")
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
        .pipe(wrapSyncEngineSqlError("providerAssetRepository.listProviderAssetReviews"))
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
          assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
          canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
          mappingStatus: schema.providerAssetMappings.mappingStatus,
        })
        .from(schema.providerAssetMappings)
        .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("providerAssetRepository.findProviderAssetMapping"))

      return Option.fromNullable(row)
    })

  const listProviderAssetSources: ProviderAssetRepositoryShape["listProviderAssetSources"] = ({
    providerAssetRowId,
  }) =>
    db
      .selectDistinct({
        principalId: schema.sources.principalId,
        sourceId: schema.sources.id,
      })
      .from(schema.providerTransfers)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.providerTransfers.sourceId))
      .where(eq(schema.providerTransfers.providerAssetId, providerAssetRowId))
      .orderBy(asc(schema.sources.id))
      .pipe(wrapSyncEngineSqlError("providerAssetRepository.listProviderAssetSources"))

  const listProviderAssetObservedRepresentations: ProviderAssetRepositoryShape["listProviderAssetObservedRepresentations"] =
    ({ providerAssetRowId }) =>
      db
        .selectDistinct({
          blockchainName: schema.blockchains.name,
          representationType: sql<
            "native" | "token" | "nft"
          >`${schema.providerTransfers.observedRepresentationType}`,
          contractAddress: schema.providerTransfers.observedContractAddress,
          mintAddress: schema.providerTransfers.observedMintAddress,
          decimals: schema.providerTransfers.observedDecimals,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.blockchains,
          eq(schema.blockchains.id, schema.providerTransfers.observedBlockchainId)
        )
        .where(
          and(
            eq(schema.providerTransfers.providerAssetId, providerAssetRowId),
            sql`${schema.providerTransfers.observedRepresentationType} is not null`
          )
        )
        .orderBy(
          asc(schema.blockchains.name),
          asc(schema.providerTransfers.observedRepresentationType),
          asc(schema.providerTransfers.observedContractAddress),
          asc(schema.providerTransfers.observedMintAddress),
          asc(schema.providerTransfers.observedDecimals)
        )
        .pipe(
          wrapSyncEngineSqlError("providerAssetRepository.listProviderAssetObservedRepresentations")
        )

  return ProviderAssetRepository.of({
    upsertProviderAssets,
    upsertProviderAssetMappings,
    seedProviderAssetMappingsIfMissing,
    findProviderAssetByProviderAssetId,
    findProviderAssetByNaturalKey,
    findProviderAssetByCurrencyCode,
    findProviderAssetReviewById,
    listProviderAssetReviews,
    listProviderAssetSources,
    listProviderAssetObservedRepresentations,
    findProviderAssetMapping,
  } satisfies ProviderAssetRepositoryShape)
})

export const ProviderAssetRepositoryLive = Layer.effect(ProviderAssetRepository, make)
