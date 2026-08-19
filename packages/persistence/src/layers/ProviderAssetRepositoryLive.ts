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
  type AssetResolutionJobScheduleResult,
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

class ApprovalObservationSourceSetChanged extends Data.TaggedError(
  "ApprovalObservationSourceSetChanged"
)<{
  readonly sourceIds: ReadonlyArray<string>
}> {}

const observationKey = (observation: ProviderAssetObservedRepresentationRecord) =>
  JSON.stringify([
    observation.blockchainName.trim().toLowerCase(),
    observation.representationType,
    observation.contractAddress?.trim().toLowerCase() ?? null,
    observation.mintAddress,
    observation.decimals,
  ])

const observationSnapshotsMatch = ({
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

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type ProviderAssetTransaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0]

  const nextEvidenceRevisionSql = sql`
    case
      when ${schema.providerAssets.naturalKey} is distinct from excluded.natural_key
        or ${schema.providerAssets.currencyCode} is distinct from excluded.currency_code
        or ${schema.providerAssets.name} is distinct from excluded.name
        or ${schema.providerAssets.exponent} is distinct from excluded.exponent
        or ${schema.providerAssets.providerType} is distinct from excluded.provider_type
        or ${schema.providerAssets.rawProviderPayload} is distinct from excluded.raw_provider_payload
      then ${schema.providerAssets.evidenceRevision} + 1
      else ${schema.providerAssets.evidenceRevision}
    end
  `

  const insertUnresolvedResolutionJobs = ({
    tx,
    providerAssetRowIds,
    now,
    mappingStatuses = [null, "pending_review"],
  }: {
    readonly tx: ProviderAssetTransaction
    readonly providerAssetRowIds: ReadonlyArray<string>
    readonly now: Date
    readonly mappingStatuses?: ReadonlyArray<"pending_review" | "approved" | "rejected" | null>
  }) =>
    Effect.gen(function* () {
      if (providerAssetRowIds.length === 0) {
        return [] as ReadonlyArray<{
          readonly providerAssetRowId: string
          readonly evidenceRevision: number
        }>
      }

      const candidates = yield* tx
        .select({
          providerAssetRowId: schema.providerAssets.id,
          evidenceRevision: schema.providerAssets.evidenceRevision,
          mappingStatus: schema.providerAssetMappings.mappingStatus,
        })
        .from(schema.providerAssets)
        .leftJoin(
          schema.providerAssetMappings,
          eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
        )
        .where(inArray(schema.providerAssets.id, providerAssetRowIds))
        .pipe(
          wrapSyncEngineSqlError("providerAssetRepository.scheduleUnresolvedResolutionJob.load")
        )

      const unresolved = candidates.filter((candidate) =>
        mappingStatuses.some((status) => status === candidate.mappingStatus)
      )
      if (unresolved.length === 0) {
        return []
      }

      const inserted = yield* tx
        .insert(schema.assetResolutionJobs)
        .values(
          unresolved.map((candidate) => ({
            providerAssetRowId: candidate.providerAssetRowId,
            evidenceRevision: candidate.evidenceRevision,
            status: "pending" as const,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing({
          target: [
            schema.assetResolutionJobs.providerAssetRowId,
            schema.assetResolutionJobs.evidenceRevision,
          ],
        })
        .returning({
          providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
          evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
        })
        .pipe(
          wrapSyncEngineSqlError("providerAssetRepository.scheduleUnresolvedResolutionJob.insert")
        )

      return inserted
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

          const upserted = yield* Effect.forEach(entries, (entry) => {
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
                    evidenceRevision: nextEvidenceRevisionSql,
                    retrievedAt: sql.raw("excluded.retrieved_at"),
                    updatedAt: now,
                  },
                })
                .returning({ id: schema.providerAssets.id })
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
                    evidenceRevision: nextEvidenceRevisionSql,
                    retrievedAt: sql.raw("excluded.retrieved_at"),
                    updatedAt: now,
                  },
                })
                .returning({ id: schema.providerAssets.id })
                .pipe(wrapSyncEngineSqlError("providerAssetRepository.upsertProviderAssets"))
            }

            return makeMissingIdentityError({
              providerKey,
              currencyCode: entry.currencyCode,
            })
          })

          yield* insertUnresolvedResolutionJobs({
            tx,
            providerAssetRowIds: upserted.flatMap((rows) => rows.map((row) => row.id)),
            now,
            mappingStatuses: ["pending_review"],
          })

          return entries.length
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

  const lockProviderAssetApprovalSnapshot: ProviderAssetRepositoryShape["lockProviderAssetApprovalSnapshot"] =
    ({ providerAssetRowId, expectedObservedRepresentations, expectedProviderAssetRetrievedAt }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const loadObservationSourceIds = () =>
              tx
                .selectDistinct({ sourceId: schema.providerTransfers.sourceId })
                .from(schema.providerTransfers)
                .where(eq(schema.providerTransfers.providerAssetId, providerAssetRowId))
                .orderBy(asc(schema.providerTransfers.sourceId))

            const observationSourceIdsBeforeLock = (yield* loadObservationSourceIds()).map(
              ({ sourceId }) => sourceId
            )
            const lockedObservationSources =
              observationSourceIdsBeforeLock.length === 0
                ? []
                : yield* tx
                    .select({ sourceId: schema.sources.id })
                    .from(schema.sources)
                    .where(inArray(schema.sources.id, observationSourceIdsBeforeLock))
                    .orderBy(asc(schema.sources.id))
                    .for("update")

            const [providerAsset] = yield* tx
              .select(providerAssetReviewProjection.providerAsset)
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.id, providerAssetRowId))
              .for("no key update")
              .limit(1)

            if (
              providerAsset === undefined ||
              providerAsset.retrievedAt.getTime() !== expectedProviderAssetRetrievedAt.getTime()
            ) {
              return yield* new SyncEngineStorageError({
                operation:
                  "providerAssetRepository.lockProviderAssetApprovalSnapshot.providerAsset",
                cause: "Provider asset metadata changed before approval.",
              })
            }

            const [mapping] = yield* tx
              .select(providerAssetReviewProjection.mapping)
              .from(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
              .for("update")
              .limit(1)

            if (lockedObservationSources.length !== observationSourceIdsBeforeLock.length) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.lockProviderAssetApprovalSnapshot.lockSources",
                cause: "A provider asset observation source changed before approval.",
              })
            }

            const lockedSourceIds = new Set(
              lockedObservationSources.map(({ sourceId }) => sourceId)
            )
            const newlyObservedSourceIds = (yield* loadObservationSourceIds())
              .map(({ sourceId }) => sourceId)
              .filter((sourceId) => !lockedSourceIds.has(sourceId))

            if (newlyObservedSourceIds.length > 0) {
              return yield* new ApprovalObservationSourceSetChanged({
                sourceIds: newlyObservedSourceIds,
              })
            }

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
                  eq(schema.providerTransfers.providerAssetId, providerAssetRowId),
                  or(
                    eq(schema.providerTransfers.observedRepresentationType, "native"),
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

            if (
              !observationSnapshotsMatch({
                expected: expectedObservedRepresentations,
                current: currentObservations,
              })
            ) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.lockProviderAssetApprovalSnapshot.observations",
                cause: "Provider asset observations changed before approval.",
              })
            }

            return { providerAsset, mapping: mapping ?? null }
          })
        )
        .pipe(
          Effect.retry({
            times: 2,
            while: (error) => error instanceof ApprovalObservationSourceSetChanged,
          }),
          wrapSyncEngineStorageError("providerAssetRepository.lockProviderAssetApprovalSnapshot")
        )

  const approveProviderAssetMappingAndRequestReplay: ProviderAssetRepositoryShape["approveProviderAssetMappingAndRequestReplay"] =
    ({ mapping, expectedObservedRepresentations, expectedProviderAssetRetrievedAt }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const approvalSnapshot = yield* lockProviderAssetApprovalSnapshot({
              providerAssetRowId: mapping.providerAssetRowId,
              expectedObservedRepresentations,
              expectedProviderAssetRetrievedAt,
            })
            const currentMapping = approvalSnapshot.mapping
            const sameApprovedTarget =
              currentMapping?.mappingStatus === "approved" &&
              currentMapping.mappingKind === mapping.mappingKind &&
              currentMapping.canonicalAssetId === mapping.canonicalAssetId &&
              currentMapping.assetRepresentationId === mapping.assetRepresentationId &&
              currentMapping.canonicalFiatCurrency === mapping.canonicalFiatCurrency

            if (sameApprovedTarget) {
              return { mappingChanged: false }
            }

            if (currentMapping?.mappingStatus !== "pending_review") {
              return yield* new SyncEngineStorageError({
                operation:
                  "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.mappingState",
                cause: "Provider asset mapping cannot be approved from its current state.",
              })
            }

            const recordedReplaySources = yield* tx
              .select({
                principalId: schema.sources.principalId,
                sourceId: schema.sources.id,
              })
              .from(schema.providerAssetSourceUses)
              .innerJoin(
                schema.sources,
                eq(schema.sources.id, schema.providerAssetSourceUses.sourceId)
              )
              .where(
                eq(schema.providerAssetSourceUses.providerAssetRowId, mapping.providerAssetRowId)
              )
              .orderBy(asc(schema.sources.id))
            const observedReplaySources = yield* tx
              .selectDistinct({
                principalId: schema.sources.principalId,
                sourceId: schema.sources.id,
              })
              .from(schema.providerTransfers)
              .innerJoin(schema.sources, eq(schema.sources.id, schema.providerTransfers.sourceId))
              .where(eq(schema.providerTransfers.providerAssetId, mapping.providerAssetRowId))
              .orderBy(asc(schema.sources.id))
            const replaySources = Array.from(
              new Map(
                [...recordedReplaySources, ...observedReplaySources].map((source) => [
                  source.sourceId,
                  source,
                ])
              ).values()
            ).sort((left, right) => left.sourceId.localeCompare(right.sourceId))

            const now = nowDate()
            const [approved] = yield* tx
              .update(schema.providerAssetMappings)
              .set({
                mappingKind: mapping.mappingKind,
                canonicalAssetId: mapping.canonicalAssetId,
                assetRepresentationId: mapping.assetRepresentationId,
                canonicalFiatCurrency: mapping.canonicalFiatCurrency,
                mappingStatus: "approved",
                reviewerNotes: mapping.reviewerNotes,
                sourceNotes: mapping.sourceNotes,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.providerAssetMappings.providerAssetRowId, mapping.providerAssetRowId),
                  eq(schema.providerAssetMappings.mappingStatus, "pending_review")
                )
              )
              .returning({ id: schema.providerAssetMappings.providerAssetRowId })

            if (approved === undefined) {
              return yield* new SyncEngineStorageError({
                operation:
                  "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.update",
                cause: "A concurrent mapping decision won before approval.",
              })
            }

            yield* Effect.forEach(
              replaySources,
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
                            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.requestActiveReplay"
                          )
                        )

                      if (activeJob !== undefined) {
                        return
                      }

                      const [createdJob] = yield* tx
                        .insert(schema.processingJobs)
                        .values({
                          sourceId,
                          principalId,
                          mode: "replay",
                          status: "pending",
                          attemptCount: 0,
                          maxAttempts: 3,
                          progressDetails: { mode: "replay", reason: "asset_mapping_approved" },
                          createdAt: now,
                          updatedAt: now,
                        })
                        .onConflictDoNothing()
                        .returning({ id: schema.processingJobs.id })
                        .pipe(
                          wrapSyncEngineSqlError(
                            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.createReplay"
                          )
                        )

                      if (createdJob !== undefined) {
                        return
                      }

                      if (attemptsRemaining > 1) {
                        return yield* Effect.suspend(() => requestReplay(attemptsRemaining - 1))
                      }

                      return yield* new SyncEngineStorageError({
                        operation:
                          "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.requestReplay",
                        cause: {
                          principalId,
                          sourceId,
                          message: "Active replay owner changed repeatedly.",
                        },
                      })
                    })

                  yield* requestReplay(3)
                }),
              { discard: true }
            )

            return { mappingChanged: true }
          })
        )
        .pipe(
          wrapSyncEngineStorageError(
            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay"
          )
        )

  const recordProviderAssetSourceUses: ProviderAssetRepositoryShape["recordProviderAssetSourceUses"] =
    ({ sourceId, providerAssetRowIds, observations }) => {
      const distinctProviderAssetRowIds = [...new Set(providerAssetRowIds)]
      if (distinctProviderAssetRowIds.length === 0) {
        return Effect.succeed(0)
      }

      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = nowDate()
            const mappings = yield* tx
              .select({
                providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
                mappingKind: schema.providerAssetMappings.mappingKind,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
                mappingStatus: schema.providerAssetMappings.mappingStatus,
              })
              .from(schema.providerAssetMappings)
              .where(
                inArray(
                  schema.providerAssetMappings.providerAssetRowId,
                  distinctProviderAssetRowIds
                )
              )
              .orderBy(asc(schema.providerAssetMappings.providerAssetRowId))
              .for("update")
            const approvedRepresentationIds = mappings.flatMap((mapping) =>
              mapping.mappingStatus === "approved" && mapping.assetRepresentationId !== null
                ? [mapping.assetRepresentationId]
                : []
            )
            const approvedRepresentations =
              approvedRepresentationIds.length === 0
                ? []
                : yield* tx
                    .select({
                      id: schema.assetRepresentations.id,
                      assetId: schema.assetRepresentations.assetId,
                      blockchainId: schema.assetRepresentations.blockchainId,
                      representationType: schema.assetRepresentations.type,
                      contractAddress: schema.assetRepresentations.contractAddress,
                      mintAddress: schema.assetRepresentations.mintAddress,
                      decimals: schema.assetRepresentations.decimals,
                    })
                    .from(schema.assetRepresentations)
                    .where(inArray(schema.assetRepresentations.id, approvedRepresentationIds))
            const mappingByProviderAssetRowId = new Map(
              mappings.map((mapping) => [mapping.providerAssetRowId, mapping])
            )
            const representationById = new Map(
              approvedRepresentations.map((representation) => [representation.id, representation])
            )

            for (const observation of observations) {
              const mapping = mappingByProviderAssetRowId.get(observation.providerAssetRowId)
              if (mapping?.mappingStatus !== "approved") {
                continue
              }

              const representation =
                mapping.assetRepresentationId === null
                  ? undefined
                  : representationById.get(mapping.assetRepresentationId)
              const matchesApprovedTarget =
                mapping.mappingKind === "asset" &&
                mapping.canonicalAssetId !== null &&
                representation !== undefined &&
                representation.assetId === mapping.canonicalAssetId &&
                representation.blockchainId === observation.observedBlockchainId &&
                (observation.representationType === null ||
                  representation.representationType === observation.representationType) &&
                (observation.contractAddress === null
                  ? true
                  : representation.contractAddress !== null &&
                    representation.contractAddress.trim().toLowerCase() ===
                      observation.contractAddress.trim().toLowerCase()) &&
                (observation.mintAddress === null ||
                  representation.mintAddress === observation.mintAddress) &&
                (observation.decimals === null || representation.decimals === observation.decimals)

              if (!matchesApprovedTarget) {
                return yield* new SyncEngineStorageError({
                  operation:
                    "providerAssetRepository.recordProviderAssetSourceUses.validateApprovedMapping",
                  cause: {
                    providerAssetRowId: observation.providerAssetRowId,
                    mapping,
                    observation,
                    message:
                      "Prepared representation evidence conflicts with the approved provider asset mapping.",
                  },
                })
              }
            }
            const [source] = yield* tx
              .select({ principalId: schema.sources.principalId })
              .from(schema.sources)
              .where(eq(schema.sources.id, sourceId))
              .limit(1)
            if (source === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.recordProviderAssetSourceUses.source",
                cause: `Source ${sourceId} does not exist.`,
              })
            }

            const rows = yield* tx
              .insert(schema.providerAssetSourceUses)
              .values(
                distinctProviderAssetRowIds.map((providerAssetRowId) => ({
                  providerAssetRowId,
                  sourceId,
                  createdAt: now,
                  updatedAt: now,
                }))
              )
              .onConflictDoNothing({
                target: [
                  schema.providerAssetSourceUses.providerAssetRowId,
                  schema.providerAssetSourceUses.sourceId,
                ],
              })
              .returning({ providerAssetRowId: schema.providerAssetSourceUses.providerAssetRowId })

            const newlyRecordedProviderAssetRowIds = new Set(
              rows.map(({ providerAssetRowId }) => providerAssetRowId)
            )
            yield* insertUnresolvedResolutionJobs({
              tx,
              providerAssetRowIds: distinctProviderAssetRowIds,
              now,
            })
            if (
              mappings.some(
                ({ mappingStatus, providerAssetRowId }) =>
                  mappingStatus === "approved" &&
                  newlyRecordedProviderAssetRowIds.has(providerAssetRowId)
              )
            ) {
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
                        eq(schema.processingJobs.principalId, source.principalId),
                        inArray(schema.processingJobs.status, ["pending", "processing"])
                      )
                    )
                    .returning({ id: schema.processingJobs.id })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "providerAssetRepository.recordProviderAssetSourceUses.attachReplay"
                      )
                    )
                  if (activeJob !== undefined) {
                    return
                  }

                  const [createdJob] = yield* tx
                    .insert(schema.processingJobs)
                    .values({
                      sourceId,
                      principalId: source.principalId,
                      mode: "replay",
                      status: "pending",
                      attemptCount: 0,
                      maxAttempts: 3,
                      progressDetails: {
                        mode: "replay",
                        reason: "approved_asset_use_discovered",
                      },
                      createdAt: now,
                      updatedAt: now,
                    })
                    .onConflictDoNothing()
                    .returning({ id: schema.processingJobs.id })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "providerAssetRepository.recordProviderAssetSourceUses.createReplay"
                      )
                    )
                  if (createdJob !== undefined) {
                    return
                  }

                  if (attemptsRemaining > 1) {
                    return yield* Effect.suspend(() => requestReplay(attemptsRemaining - 1))
                  }

                  return yield* new SyncEngineStorageError({
                    operation:
                      "providerAssetRepository.recordProviderAssetSourceUses.requestReplay",
                    cause: {
                      sourceId,
                      principalId: source.principalId,
                      message: "Active replay owner changed repeatedly.",
                    },
                  })
                })

              yield* requestReplay(3)
            }

            return rows.length
          })
        )
        .pipe(wrapSyncEngineSqlError("providerAssetRepository.recordProviderAssetSourceUses"))
    }

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

        return Option.fromNullishOr(row)
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

        return Option.fromNullishOr(row)
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

        return Option.fromNullishOr(row)
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

        return Option.fromNullishOr(row)
      })

  const listProviderAssetReviews: ProviderAssetRepositoryShape["listProviderAssetReviews"] = ({
    providerKey,
    mappingStatus,
    cursor,
    limit,
  }) =>
    Effect.gen(function* () {
      const cursorPredicate =
        cursor === null ? undefined : gt(schema.providerAssets.id, cursor.providerAssetRowId)
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
        .orderBy(asc(schema.providerAssets.id))
        .limit(limit)
        .pipe(wrapSyncEngineSqlError("providerAssetRepository.listProviderAssetReviews"))
    })

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

      return Option.fromNullishOr(row)
    })

  const scheduleUnresolvedResolutionJob: ProviderAssetRepositoryShape["scheduleUnresolvedResolutionJob"] =
    ({ providerAssetRowId }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [providerAsset] = yield* tx
              .select({
                id: schema.providerAssets.id,
                evidenceRevision: schema.providerAssets.evidenceRevision,
              })
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.id, providerAssetRowId))
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetRepository.scheduleUnresolvedResolutionJob.providerAsset"
                )
              )

            if (providerAsset === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.scheduleUnresolvedResolutionJob.providerAsset",
                cause: {
                  providerAssetRowId,
                  message: "Provider asset observation does not exist.",
                },
              })
            }

            const inserted = yield* insertUnresolvedResolutionJobs({
              tx,
              providerAssetRowIds: [providerAssetRowId],
              now: nowDate(),
            })
            const created = inserted.some((job) => job.providerAssetRowId === providerAssetRowId)

            return {
              created,
              providerAssetRowId,
              evidenceRevision: providerAsset.evidenceRevision,
            } satisfies AssetResolutionJobScheduleResult
          })
        )
        .pipe(wrapSyncEngineStorageError("providerAssetRepository.scheduleUnresolvedResolutionJob"))

  const claimResolutionJob: ProviderAssetRepositoryShape["claimResolutionJob"] = ({ jobId }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const now = nowDate()
          const [job] = yield* tx
            .select({
              id: schema.assetResolutionJobs.id,
              providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
              evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
              status: schema.assetResolutionJobs.status,
            })
            .from(schema.assetResolutionJobs)
            .where(eq(schema.assetResolutionJobs.id, jobId))
            .for("update")
            .limit(1)
            .pipe(wrapSyncEngineSqlError("providerAssetRepository.claimResolutionJob.job"))

          if (job === undefined || job.status !== "pending") {
            return { _tag: "not_claimable" } as const
          }

          const [providerAsset] = yield* tx
            .select({ evidenceRevision: schema.providerAssets.evidenceRevision })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.id, job.providerAssetRowId))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError("providerAssetRepository.claimResolutionJob.providerAsset")
            )

          if (
            providerAsset === undefined ||
            providerAsset.evidenceRevision !== job.evidenceRevision
          ) {
            yield* tx
              .update(schema.assetResolutionJobs)
              .set({ status: "completed", updatedAt: now })
              .where(eq(schema.assetResolutionJobs.id, jobId))
              .pipe(
                wrapSyncEngineSqlError("providerAssetRepository.claimResolutionJob.completeStale")
              )

            return { _tag: "stale" } as const
          }

          yield* tx
            .update(schema.assetResolutionJobs)
            .set({ status: "processing", updatedAt: now })
            .where(eq(schema.assetResolutionJobs.id, jobId))
            .pipe(wrapSyncEngineSqlError("providerAssetRepository.claimResolutionJob.claim"))

          return {
            _tag: "claimed",
            providerAssetRowId: job.providerAssetRowId,
            evidenceRevision: job.evidenceRevision,
          } as const
        })
      )
      .pipe(wrapSyncEngineStorageError("providerAssetRepository.claimResolutionJob"))

  const finishResolutionJob: ProviderAssetRepositoryShape["finishResolutionJob"] = ({
    jobId,
    status,
  }) =>
    db
      .update(schema.assetResolutionJobs)
      .set({ status, updatedAt: nowDate() })
      .where(eq(schema.assetResolutionJobs.id, jobId))
      .pipe(Effect.asVoid, wrapSyncEngineSqlError("providerAssetRepository.finishResolutionJob"))

  const recordAssetResolutionDecision: ProviderAssetRepositoryShape["recordAssetResolutionDecision"] =
    ({ decision }) =>
      db
        .insert(schema.assetResolutionDecisions)
        .values({
          providerAssetRowId: decision.providerAssetRowId,
          evidenceRevision: decision.evidenceRevision,
          policyRevision: decision.policyRevision,
          outcome: decision.outcome,
          assetId: decision.assetId,
          assetRepresentationId: decision.assetRepresentationId,
          blockchain: decision.blockchain,
          representationType: decision.representationType,
          contractAddress: decision.contractAddress,
          mintAddress: decision.mintAddress,
          decimals: decision.decimals,
          reason: decision.reason,
          chainEvidence: decision.chainEvidence,
          coinGeckoEvidence: decision.coinGeckoEvidence,
          actor: decision.actor,
        })
        .onConflictDoNothing({
          target: [
            schema.assetResolutionDecisions.providerAssetRowId,
            schema.assetResolutionDecisions.evidenceRevision,
          ],
        })
        .returning({ providerAssetRowId: schema.assetResolutionDecisions.providerAssetRowId })
        .pipe(
          Effect.map((rows) => ({ recorded: rows.length > 0 })),
          wrapSyncEngineSqlError("providerAssetRepository.recordAssetResolutionDecision")
        )

  return ProviderAssetRepository.of({
    upsertProviderAssets,
    upsertProviderAssetMappings,
    seedProviderAssetMappingsIfMissing,
    approveProviderAssetMappingAndRequestReplay,
    lockProviderAssetApprovalSnapshot,
    recordProviderAssetSourceUses,
    findProviderAssetByProviderAssetId,
    findProviderAssetByNaturalKey,
    findProviderAssetByCurrencyCode,
    findProviderAssetReviewById,
    listProviderAssetReviews,
    listProviderAssetObservedRepresentations,
    findProviderAssetMapping,
    scheduleUnresolvedResolutionJob,
    claimResolutionJob,
    finishResolutionJob,
    recordAssetResolutionDecision,
  } satisfies ProviderAssetRepositoryShape)
})

export const ProviderAssetRepositoryLive = Layer.effect(ProviderAssetRepository, make)
