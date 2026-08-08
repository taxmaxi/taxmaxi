/**
 * ProviderAssetRepositoryLive - Provider asset identity and mapping persistence.
 *
 * @module ProviderAssetRepositoryLive
 */

import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import * as Data from "effect/Data"
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

class ReplaySourceSetChanged extends Data.TaggedError("ReplaySourceSetChanged")<{
  readonly sourceIds: ReadonlyArray<string>
}> {}

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

        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const mappingsRequiringLock = mappings.filter(
                (mapping) =>
                  mapping.expectedMappingStatus !== undefined ||
                  mapping.expectedObservedRepresentations !== undefined ||
                  mapping.expectedProviderAssetRetrievedAt !== undefined ||
                  mapping.expectedApprovedTarget !== undefined ||
                  mapping.requestReplayOnApproval === true
              )
              const replayRequestedProviderAssetIds = [
                ...new Set(
                  mappings
                    .filter(
                      (mapping) =>
                        mapping.requestReplayOnApproval === true &&
                        mapping.mappingStatus === "approved"
                    )
                    .map(({ providerAssetRowId }) => providerAssetRowId)
                ),
              ].sort()
              const replaySourcePairsBeforeLock =
                replayRequestedProviderAssetIds.length === 0
                  ? []
                  : yield* tx
                      .selectDistinct({
                        providerAssetRowId: schema.providerTransfers.providerAssetId,
                        sourceId: schema.providerTransfers.sourceId,
                      })
                      .from(schema.providerTransfers)
                      .where(
                        inArray(
                          schema.providerTransfers.providerAssetId,
                          replayRequestedProviderAssetIds
                        )
                      )
                      .orderBy(asc(schema.providerTransfers.sourceId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetRepository.upsertProviderAssetMappings.listReplaySourcesBeforeLock"
                        )
                      )
              const replaySourceIdsBeforeLock = [
                ...new Set(replaySourcePairsBeforeLock.map(({ sourceId }) => sourceId)),
              ].sort()
              const lockedReplaySources =
                replaySourceIdsBeforeLock.length === 0
                  ? []
                  : yield* tx
                      .select({
                        principalId: schema.sources.principalId,
                        sourceId: schema.sources.id,
                      })
                      .from(schema.sources)
                      .where(inArray(schema.sources.id, replaySourceIdsBeforeLock))
                      .orderBy(asc(schema.sources.id))
                      .for("update")
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetRepository.upsertProviderAssetMappings.lockReplaySources"
                        )
                      )

              if (lockedReplaySources.length !== replaySourceIdsBeforeLock.length) {
                return yield* Effect.fail(
                  new SyncEngineStorageError({
                    operation:
                      "providerAssetRepository.upsertProviderAssetMappings.lockReplaySources",
                    cause: "A replay source changed before mapping approval.",
                  })
                )
              }
              const providerAssetSnapshotMappings = mappings.filter(
                (mapping) => mapping.expectedProviderAssetRetrievedAt !== undefined
              )
              const providerAssetSnapshotIds = [
                ...new Set([
                  ...providerAssetSnapshotMappings.map(
                    ({ providerAssetRowId }) => providerAssetRowId
                  ),
                  ...replayRequestedProviderAssetIds,
                ]),
              ].sort()
              const lockedProviderAssets =
                providerAssetSnapshotIds.length === 0
                  ? []
                  : yield* tx
                      .select({
                        id: schema.providerAssets.id,
                        retrievedAt: schema.providerAssets.retrievedAt,
                      })
                      .from(schema.providerAssets)
                      .where(inArray(schema.providerAssets.id, providerAssetSnapshotIds))
                      .orderBy(asc(schema.providerAssets.id))
                      .for("update")

              if (lockedProviderAssets.length !== providerAssetSnapshotIds.length) {
                return yield* Effect.fail(
                  new SyncEngineStorageError({
                    operation:
                      "providerAssetRepository.upsertProviderAssetMappings.providerAssetSnapshot",
                    cause: "Provider asset metadata changed before approval.",
                  })
                )
              }
              const lockedProviderAssetById = new Map(
                lockedProviderAssets.map((providerAsset) => [providerAsset.id, providerAsset])
              )
              yield* Effect.forEach(
                providerAssetSnapshotMappings,
                (mapping) => {
                  const current = lockedProviderAssetById.get(mapping.providerAssetRowId)
                  return current !== undefined &&
                    current.retrievedAt.getTime() ===
                      mapping.expectedProviderAssetRetrievedAt?.getTime()
                    ? Effect.void
                    : Effect.fail(
                        new SyncEngineStorageError({
                          operation:
                            "providerAssetRepository.upsertProviderAssetMappings.providerAssetSnapshot",
                          cause: "Provider asset metadata changed before approval.",
                        })
                      )
                },
                { discard: true }
              )
              const replaySourcePairsAfterProviderAssetLock =
                replayRequestedProviderAssetIds.length === 0
                  ? []
                  : yield* tx
                      .selectDistinct({
                        providerAssetRowId: schema.providerTransfers.providerAssetId,
                        sourceId: schema.providerTransfers.sourceId,
                      })
                      .from(schema.providerTransfers)
                      .where(
                        inArray(
                          schema.providerTransfers.providerAssetId,
                          replayRequestedProviderAssetIds
                        )
                      )
                      .orderBy(asc(schema.providerTransfers.sourceId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetRepository.upsertProviderAssetMappings.listReplaySourcesAfterProviderAssetLock"
                        )
                      )
              const replaySourceIdsAfterProviderAssetLock = [
                ...new Set(replaySourcePairsAfterProviderAssetLock.map(({ sourceId }) => sourceId)),
              ].sort()
              const previouslyLockedReplaySourceIds = new Set(replaySourceIdsBeforeLock)
              const newlyObservedReplaySourceIds = replaySourceIdsAfterProviderAssetLock.filter(
                (sourceId) => !previouslyLockedReplaySourceIds.has(sourceId)
              )
              if (newlyObservedReplaySourceIds.length > 0) {
                return yield* Effect.fail(
                  new ReplaySourceSetChanged({ sourceIds: newlyObservedReplaySourceIds })
                )
              }
              const allLockedReplaySources = lockedReplaySources

              if (allLockedReplaySources.length !== replaySourceIdsAfterProviderAssetLock.length) {
                return yield* Effect.fail(
                  new SyncEngineStorageError({
                    operation:
                      "providerAssetRepository.upsertProviderAssetMappings.lockReplaySources",
                    cause: "A replay source changed before mapping approval.",
                  })
                )
              }
              const mappingIds = [
                ...new Set(
                  mappingsRequiringLock.map(({ providerAssetRowId }) => providerAssetRowId)
                ),
              ].sort()
              const lockedMappings =
                mappingIds.length === 0
                  ? []
                  : yield* tx
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

              if (mappingsRequiringLock.length > 0) {
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
                    const expectedMappingStatus = mapping.expectedMappingStatus
                    if (expectedMappingStatus !== undefined) {
                      const current = lockedMappingById.get(mapping.providerAssetRowId)
                      if (current?.mappingStatus !== expectedMappingStatus) {
                        return Effect.fail(
                          new SyncEngineStorageError({
                            operation:
                              "providerAssetRepository.upsertProviderAssetMappings.mappingStatusSnapshot",
                            cause: "Provider asset mapping status changed before update.",
                          })
                        )
                      }
                    }

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
                            "native" | "token" | "nft" | null
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
                            eq(
                              schema.providerTransfers.providerAssetId,
                              mapping.providerAssetRowId
                            ),
                            or(
                              sql`${schema.providerTransfers.observedRepresentationType} is not null`,
                              sql`${schema.providerTransfers.observedMintAddress} is not null`,
                              sql`${schema.providerTransfers.observedContractAddress} is not null`
                            )
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

              const replayApprovalIds = mappings.flatMap((mapping) => {
                const previous = lockedMappings.find(
                  ({ providerAssetRowId }) => providerAssetRowId === mapping.providerAssetRowId
                )
                const approvedTargetChanged =
                  previous?.mappingStatus === "approved" &&
                  (previous.mappingKind !== mapping.mappingKind ||
                    previous.canonicalAssetId !== mapping.canonicalAssetId ||
                    previous.assetRepresentationId !== mapping.assetRepresentationId ||
                    previous.canonicalFiatCurrency !== mapping.canonicalFiatCurrency)

                return mapping.requestReplayOnApproval === true &&
                  mapping.mappingStatus === "approved" &&
                  (previous?.mappingStatus !== "approved" || approvedTargetChanged)
                  ? [mapping.providerAssetRowId]
                  : []
              })

              if (replayApprovalIds.length > 0) {
                const replayApprovalIdSet = new Set(replayApprovalIds)
                const replaySourceIdSet = new Set(
                  replaySourcePairsAfterProviderAssetLock.flatMap(
                    ({ providerAssetRowId, sourceId }) =>
                      providerAssetRowId !== null && replayApprovalIdSet.has(providerAssetRowId)
                        ? [sourceId]
                        : []
                  )
                )
                const affectedSources = allLockedReplaySources.filter(({ sourceId }) =>
                  replaySourceIdSet.has(sourceId)
                )

                yield* Effect.forEach(
                  affectedSources,
                  ({ principalId, sourceId }) =>
                    Effect.gen(function* () {
                      const requestReplay = (
                        attemptsRemaining: number
                      ): Effect.Effect<void, SyncEngineStorageError> =>
                        Effect.gen(function* () {
                          const [activeJob] = yield* tx
                            .update(schema.processingJobs)
                            .set({ followUpMode: "replay", updatedAt: now })
                            .where(
                              and(
                                eq(schema.processingJobs.sourceId, sourceId),
                                eq(schema.processingJobs.principalId, principalId),
                                inArray(schema.processingJobs.status, ["pending", "processing"])
                              )
                            )
                            .returning({ id: schema.processingJobs.id })
                            .pipe(
                              wrapSyncEngineSqlError(
                                "providerAssetRepository.upsertProviderAssetMappings.requestActiveReplay"
                              )
                            )

                          if (activeJob !== undefined) return

                          const [createdJob] = yield* tx
                            .insert(schema.processingJobs)
                            .values({
                              sourceId,
                              principalId,
                              mode: "replay",
                              status: "pending",
                              attemptCount: 0,
                              maxAttempts: 3,
                              createdAt: now,
                              updatedAt: now,
                            })
                            .onConflictDoNothing()
                            .returning({ id: schema.processingJobs.id })
                            .pipe(
                              wrapSyncEngineSqlError(
                                "providerAssetRepository.upsertProviderAssetMappings.createReplay"
                              )
                            )

                          if (createdJob !== undefined) return
                          if (attemptsRemaining > 1) {
                            return yield* Effect.suspend(() => requestReplay(attemptsRemaining - 1))
                          }

                          return yield* Effect.fail(
                            new SyncEngineStorageError({
                              operation:
                                "providerAssetRepository.upsertProviderAssetMappings.requestReplay",
                              cause: {
                                sourceId,
                                principalId,
                                message: "Active replay owner changed repeatedly.",
                              },
                            })
                          )
                        })

                      yield* requestReplay(3)
                    }),
                  { discard: true }
                )
              }
            })
          )
          .pipe(
            Effect.retry({
              times: 2,
              while: (error) => error instanceof ReplaySourceSetChanged,
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
            "native" | "token" | "nft" | null
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
            or(
              sql`${schema.providerTransfers.observedRepresentationType} is not null`,
              sql`${schema.providerTransfers.observedMintAddress} is not null`,
              sql`${schema.providerTransfers.observedContractAddress} is not null`
            )
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
