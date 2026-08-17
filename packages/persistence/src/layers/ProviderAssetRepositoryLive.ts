/**
 * ProviderAssetRepositoryLive - Provider asset identity and mapping persistence.
 *
 * @module ProviderAssetRepositoryLive
 */

import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProviderAssetRepository,
  type ProviderAssetObservedRepresentationRecord,
  type ProviderAssetReplayDispatchState,
  type ProviderAssetRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { getAssetCatalogSearchPatterns } from "../query/AssetCatalogSearch.ts"
import { schema } from "../schema/index.ts"

class ApprovalObservationSourceSetChanged extends Data.TaggedError(
  "ApprovalObservationSourceSetChanged"
)<{
  readonly sourceIds: ReadonlyArray<string>
}> {}

class RejectionEvidenceSourceSetChanged extends Data.TaggedError(
  "RejectionEvidenceSourceSetChanged"
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

const providerAssetEvidenceRevisionExpression = (providerAssetRowId: string | SQLWrapper) =>
  sql<string>`md5(
    coalesce((
      select string_agg(observed.evidence_key, E'\n' order by observed.evidence_key)
      from (
        select distinct jsonb_build_array(
          pt.observed_blockchain_id,
          pt.observed_representation_type,
          lower(trim(pt.observed_contract_address)),
          pt.observed_mint_address,
          pt.observed_decimals
        )::text as evidence_key
        from provider_transfers pt
        where pt.provider_asset_id = ${providerAssetRowId}
          and num_nonnulls(
            pt.observed_blockchain_id,
            pt.observed_representation_type,
            pt.observed_contract_address,
            pt.observed_mint_address,
            pt.observed_decimals
          ) > 0
      ) observed
    ), '') || E'\n--sources--\n' || coalesce((
      select string_agg(affected.source_id::text, E'\n' order by affected.source_id)
      from (
        select pasu.source_id
        from provider_asset_source_uses pasu
        where pasu.provider_asset_row_id = ${providerAssetRowId}
        union
        select pt.source_id
        from provider_transfers pt
        where pt.provider_asset_id = ${providerAssetRowId}
      ) affected
    ), '')
  )`

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

  const selectProviderAssetReviewReplayFields = {
    sourceId: schema.providerAssetReviewReplays.sourceId,
    principalId: schema.providerAssetReviewReplays.principalId,
    jobId: schema.providerAssetReviewReplays.jobId,
    dispatchState: sql<ProviderAssetReplayDispatchState>`case
      when ${schema.processingJobs.status} = 'pending'
        and (
          ${schema.processingJobs.queueName} is null
          or ${schema.processingJobs.queueJobId} is null
        )
      then 'failed_to_queue'::provider_asset_replay_dispatch_state
      else 'queued'::provider_asset_replay_dispatch_state
    end`,
    errorMessage: sql<string | null>`case
      when ${schema.processingJobs.status} = 'pending'
        and (
          ${schema.processingJobs.queueName} is null
          or ${schema.processingJobs.queueJobId} is null
        )
      then coalesce(
        ${schema.providerAssetReviewReplays.errorMessage},
        'Failed to queue replay.'
      )
      else null
    end`,
  } as const

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
    ({ mappings, replaceUntouchedPendingOnly = false }) =>
      Effect.gen(function* () {
        if (mappings.length === 0) {
          return 0
        }

        const now = nowDate()

        if (replaceUntouchedPendingOnly) {
          const updated = yield* Effect.forEach(mappings, (mapping) =>
            db
              .update(schema.providerAssetMappings)
              .set({
                mappingKind: mapping.mappingKind,
                canonicalAssetId: mapping.canonicalAssetId,
                assetRepresentationId: mapping.assetRepresentationId,
                canonicalFiatCurrency: mapping.canonicalFiatCurrency,
                mappingStatus: mapping.mappingStatus,
                reviewerNotes: mapping.reviewerNotes,
                sourceNotes: mapping.sourceNotes,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.providerAssetMappings.providerAssetRowId, mapping.providerAssetRowId),
                  eq(schema.providerAssetMappings.mappingStatus, "pending_review"),
                  isNull(schema.providerAssetMappings.canonicalAssetId),
                  isNull(schema.providerAssetMappings.assetRepresentationId),
                  isNull(schema.providerAssetMappings.canonicalFiatCurrency),
                  isNull(schema.providerAssetMappings.reviewerNotes),
                  isNull(schema.providerAssetMappings.reviewedBy),
                  isNull(schema.providerAssetMappings.reviewedAt)
                )
              )
              .returning({ id: schema.providerAssetMappings.id })
              .pipe(
                Effect.map((rows) => rows.length),
                wrapSyncEngineStorageError(
                  "providerAssetRepository.upsertProviderAssetMappings.replaceUntouchedPending"
                )
              )
          )

          return updated.reduce((count, value) => count + value, 0)
        }

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
    ({
      providerAssetRowId,
      expectedObservedRepresentations,
      expectedEvidenceRevision,
      expectedProviderAssetRetrievedAt,
      expectedMappingUpdatedAt,
    }) =>
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

            if (
              expectedMappingUpdatedAt !== undefined &&
              (mapping === undefined ||
                mapping.updatedAt.getTime() !== expectedMappingUpdatedAt.getTime())
            ) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.lockProviderAssetApprovalSnapshot.mapping",
                cause: "Provider asset decision revision changed before approval.",
              })
            }

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

            const [evidence] = yield* tx
              .select({
                evidenceState: providerAssetReviewProjection.evidenceState,
                evidenceRevision: providerAssetEvidenceRevisionExpression(providerAssetRowId),
                affectedSourceCount: providerAssetReviewProjection.affectedSourceCount,
              })
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.id, providerAssetRowId))
              .limit(1)

            if (evidence === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.lockProviderAssetApprovalSnapshot.evidence",
                cause: "Provider asset evidence disappeared before approval.",
              })
            }

            if (evidence.evidenceRevision !== expectedEvidenceRevision) {
              return yield* new SyncEngineStorageError({
                operation:
                  "providerAssetRepository.lockProviderAssetApprovalSnapshot.evidenceRevision",
                cause: {
                  expectedEvidenceRevision,
                  actualEvidenceRevision: evidence.evidenceRevision,
                  message: "Provider asset evidence changed before approval.",
                },
              })
            }

            return {
              providerAsset,
              mapping: mapping ?? null,
              ...evidence,
            }
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
    ({
      mapping,
      reviewedBy = null,
      reviewedAt = nowDate(),
      expectedObservedRepresentations,
      expectedEvidenceRevision,
      expectedProviderAssetRetrievedAt,
      expectedMappingUpdatedAt,
    }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const approvalSnapshot = yield* lockProviderAssetApprovalSnapshot({
              providerAssetRowId: mapping.providerAssetRowId,
              expectedObservedRepresentations,
              expectedEvidenceRevision,
              expectedProviderAssetRetrievedAt,
              ...(expectedMappingUpdatedAt === undefined ? {} : { expectedMappingUpdatedAt }),
            })
            const currentMapping = approvalSnapshot.mapping
            const sameApprovedTarget =
              currentMapping?.mappingStatus === "approved" &&
              currentMapping.mappingKind === mapping.mappingKind &&
              currentMapping.canonicalAssetId === mapping.canonicalAssetId &&
              currentMapping.assetRepresentationId === mapping.assetRepresentationId &&
              currentMapping.canonicalFiatCurrency === mapping.canonicalFiatCurrency

            if (sameApprovedTarget) {
              const replays = yield* tx
                .select(selectProviderAssetReviewReplayFields)
                .from(schema.providerAssetReviewReplays)
                .innerJoin(
                  schema.processingJobs,
                  eq(schema.processingJobs.id, schema.providerAssetReviewReplays.jobId)
                )
                .where(
                  eq(
                    schema.providerAssetReviewReplays.providerAssetRowId,
                    mapping.providerAssetRowId
                  )
                )
                .orderBy(asc(schema.providerAssetReviewReplays.sourceId))
                .pipe(
                  wrapSyncEngineSqlError(
                    "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.loadReplays"
                  )
                )

              return { mappingChanged: false, replays }
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

            const now = reviewedAt
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
                reviewedBy,
                reviewedAt,
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

            const replays = yield* Effect.forEach(replaySources, ({ principalId, sourceId }) =>
              Effect.gen(function* () {
                const requestReplay = (
                  attemptsRemaining: number
                ): Effect.Effect<string, SyncEngineStorageError> =>
                  Effect.gen(function* () {
                    const [activeJob] = yield* tx
                      .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
                      .from(schema.processingJobs)
                      .where(
                        and(
                          eq(schema.processingJobs.sourceId, sourceId),
                          eq(schema.processingJobs.principalId, principalId),
                          inArray(schema.processingJobs.status, ["pending", "processing"])
                        )
                      )
                      .limit(1)
                      .for("update")
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.requestActiveReplay"
                        )
                      )

                    if (activeJob !== undefined) {
                      if (activeJob.mode !== "replay") {
                        yield* tx
                          .update(schema.processingJobs)
                          .set({ followUpMode: "replay", updatedAt: now })
                          .where(eq(schema.processingJobs.id, activeJob.id))
                          .pipe(
                            wrapSyncEngineSqlError(
                              "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.attachFollowUp"
                            )
                          )
                      }
                      return activeJob.id
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
                      return createdJob.id
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

                const jobId = yield* requestReplay(3)

                return {
                  sourceId,
                  principalId,
                  jobId,
                  dispatchState: "failed_to_queue" as const,
                  errorMessage: null,
                }
              })
            )

            if (replays.length > 0) {
              yield* tx
                .insert(schema.providerAssetReviewReplays)
                .values(
                  replays.map((replay) => ({
                    providerAssetRowId: mapping.providerAssetRowId,
                    ...replay,
                    createdAt: now,
                    updatedAt: now,
                  }))
                )
                .onConflictDoUpdate({
                  target: [
                    schema.providerAssetReviewReplays.providerAssetRowId,
                    schema.providerAssetReviewReplays.sourceId,
                  ],
                  set: {
                    principalId: sql.raw("excluded.principal_id"),
                    jobId: sql.raw("excluded.job_id"),
                    updatedAt: now,
                  },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "providerAssetRepository.approveProviderAssetMappingAndRequestReplay.linkReplays"
                  )
                )
            }

            return { mappingChanged: true, replays }
          })
        )
        .pipe(
          wrapSyncEngineStorageError(
            "providerAssetRepository.approveProviderAssetMappingAndRequestReplay"
          )
        )

  const rejectProviderAssetMapping: ProviderAssetRepositoryShape["rejectProviderAssetMapping"] = ({
    providerAssetRowId,
    reviewerNotes,
    reviewedBy,
    reviewedAt,
    expectedEvidenceRevision,
    expectedProviderAssetRetrievedAt,
    expectedMappingUpdatedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const loadAffectedSourceIds = () =>
            Effect.gen(function* () {
              const recordedSourceIds = yield* tx
                .select({ sourceId: schema.providerAssetSourceUses.sourceId })
                .from(schema.providerAssetSourceUses)
                .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAssetRowId))
              const observedSourceIds = yield* tx
                .selectDistinct({ sourceId: schema.providerTransfers.sourceId })
                .from(schema.providerTransfers)
                .where(eq(schema.providerTransfers.providerAssetId, providerAssetRowId))

              return [
                ...new Set(
                  [...recordedSourceIds, ...observedSourceIds].map(({ sourceId }) => sourceId)
                ),
              ].sort()
            })

          const affectedSourceIdsBeforeLock = yield* loadAffectedSourceIds()
          const lockedAffectedSources =
            affectedSourceIdsBeforeLock.length === 0
              ? []
              : yield* tx
                  .select({ sourceId: schema.sources.id })
                  .from(schema.sources)
                  .where(inArray(schema.sources.id, affectedSourceIdsBeforeLock))
                  .orderBy(asc(schema.sources.id))
                  .for("update")

          const [providerAsset] = yield* tx
            .select({ retrievedAt: schema.providerAssets.retrievedAt })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.id, providerAssetRowId))
            .for("no key update")
            .limit(1)

          if (
            providerAsset === undefined ||
            providerAsset.retrievedAt.getTime() !== expectedProviderAssetRetrievedAt.getTime()
          ) {
            return yield* new SyncEngineStorageError({
              operation: "providerAssetRepository.rejectProviderAssetMapping.evidence",
              cause: "Provider asset metadata changed before rejection.",
            })
          }

          const [mapping] = yield* tx
            .select({ updatedAt: schema.providerAssetMappings.updatedAt })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
            .for("update")
            .limit(1)

          if (
            expectedMappingUpdatedAt !== undefined &&
            (mapping === undefined ||
              mapping.updatedAt.getTime() !== expectedMappingUpdatedAt.getTime())
          ) {
            return yield* new SyncEngineStorageError({
              operation: "providerAssetRepository.rejectProviderAssetMapping.revision",
              cause: "Provider asset decision revision changed before rejection.",
            })
          }

          if (lockedAffectedSources.length !== affectedSourceIdsBeforeLock.length) {
            return yield* new SyncEngineStorageError({
              operation: "providerAssetRepository.rejectProviderAssetMapping.lockSources",
              cause: "A provider asset evidence source changed before rejection.",
            })
          }

          const lockedSourceIds = new Set(lockedAffectedSources.map(({ sourceId }) => sourceId))
          const newlyAffectedSourceIds = (yield* loadAffectedSourceIds()).filter(
            (sourceId) => !lockedSourceIds.has(sourceId)
          )

          if (newlyAffectedSourceIds.length > 0) {
            return yield* new RejectionEvidenceSourceSetChanged({
              sourceIds: newlyAffectedSourceIds,
            })
          }

          const [evidence] = yield* tx
            .select({
              evidenceRevision: providerAssetEvidenceRevisionExpression(providerAssetRowId),
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.id, providerAssetRowId))
            .limit(1)

          if (evidence?.evidenceRevision !== expectedEvidenceRevision) {
            return yield* new SyncEngineStorageError({
              operation: "providerAssetRepository.rejectProviderAssetMapping.evidenceRevision",
              cause: "Provider asset evidence changed before rejection.",
            })
          }

          const [rejected] = yield* tx
            .update(schema.providerAssetMappings)
            .set({
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "rejected",
              reviewerNotes,
              reviewedBy,
              reviewedAt,
              updatedAt: reviewedAt,
            })
            .where(
              and(
                eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId),
                eq(schema.providerAssetMappings.mappingStatus, "pending_review")
              )
            )
            .returning({ id: schema.providerAssetMappings.id })

          return rejected !== undefined
        })
      )
      .pipe(
        Effect.retry({
          times: 2,
          while: (error) => error instanceof RejectionEvidenceSourceSetChanged,
        }),
        wrapSyncEngineStorageError("providerAssetRepository.rejectProviderAssetMapping")
      )

  const findProviderAssetReviewReplay: ProviderAssetRepositoryShape["findProviderAssetReviewReplay"] =
    ({ providerAssetRowId, sourceId, jobId }) =>
      db
        .select(selectProviderAssetReviewReplayFields)
        .from(schema.providerAssetReviewReplays)
        .innerJoin(
          schema.processingJobs,
          eq(schema.processingJobs.id, schema.providerAssetReviewReplays.jobId)
        )
        .where(
          and(
            eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
            eq(schema.providerAssetReviewReplays.sourceId, sourceId),
            eq(schema.providerAssetReviewReplays.jobId, jobId)
          )
        )
        .limit(1)
        .pipe(
          Effect.map(([replay]) => Option.fromNullishOr(replay)),
          wrapSyncEngineStorageError("providerAssetRepository.findProviderAssetReviewReplay")
        )

  const listProviderAssetReviewReplays: ProviderAssetRepositoryShape["listProviderAssetReviewReplays"] =
    ({ providerAssetRowId }) =>
      db
        .select(selectProviderAssetReviewReplayFields)
        .from(schema.providerAssetReviewReplays)
        .innerJoin(
          schema.processingJobs,
          eq(schema.processingJobs.id, schema.providerAssetReviewReplays.jobId)
        )
        .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId))
        .orderBy(asc(schema.providerAssetReviewReplays.sourceId))
        .pipe(wrapSyncEngineStorageError("providerAssetRepository.listProviderAssetReviewReplays"))

  const markProviderAssetReviewReplayDispatch: ProviderAssetRepositoryShape["markProviderAssetReviewReplayDispatch"] =
    ({ providerAssetRowId, sourceId, jobId, dispatchState, errorMessage }) =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(schema.providerAssetReviewReplays)
          .set({ dispatchState, errorMessage, updatedAt: nowDate() })
          .where(
            and(
              eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
              eq(schema.providerAssetReviewReplays.sourceId, sourceId),
              eq(schema.providerAssetReviewReplays.jobId, jobId)
            )
          )
          .returning({ id: schema.providerAssetReviewReplays.id })

        if (updated.length === 1) return jobId

        const [advancedReplay] = yield* db
          .select({ jobId: schema.providerAssetReviewReplays.jobId })
          .from(schema.providerAssetReviewReplays)
          .where(
            and(
              eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
              eq(schema.providerAssetReviewReplays.sourceId, sourceId),
              eq(
                schema.providerAssetReviewReplays.jobId,
                sql`(
                  select ${schema.processingJobs.followUpJobId}
                  from ${schema.processingJobs}
                  where ${schema.processingJobs.id} = ${jobId}
                )`
              )
            )
          )
          .limit(1)

        return advancedReplay?.jobId ?? null
      }).pipe(
        wrapSyncEngineStorageError("providerAssetRepository.markProviderAssetReviewReplayDispatch")
      )

  const reserveProviderAssetReviewReplayRetry: ProviderAssetRepositoryShape["reserveProviderAssetReviewReplayRetry"] =
    ({ providerAssetRowId, sourceId, jobId }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [current] = yield* tx
              .select({
                principalId: schema.providerAssetReviewReplays.principalId,
                jobStatus: schema.processingJobs.status,
              })
              .from(schema.providerAssetReviewReplays)
              .innerJoin(
                schema.processingJobs,
                eq(schema.processingJobs.id, schema.providerAssetReviewReplays.jobId)
              )
              .where(
                and(
                  eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
                  eq(schema.providerAssetReviewReplays.sourceId, sourceId),
                  eq(schema.providerAssetReviewReplays.jobId, jobId)
                )
              )
              .limit(1)
              .for("update")
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetRepository.reserveProviderAssetReviewReplayRetry.lock"
                )
              )

            if (current === undefined || current.jobStatus !== "failed") {
              return Option.none()
            }

            const reservedAt = nowDate()
            const reserveJob = (
              attemptsRemaining: number
            ): Effect.Effect<string, SyncEngineStorageError> =>
              Effect.gen(function* () {
                const [activeJob] = yield* tx
                  .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
                  .from(schema.processingJobs)
                  .where(
                    and(
                      eq(schema.processingJobs.sourceId, sourceId),
                      eq(schema.processingJobs.principalId, current.principalId),
                      inArray(schema.processingJobs.status, ["pending", "processing"])
                    )
                  )
                  .limit(1)
                  .for("update")
                  .pipe(
                    wrapSyncEngineSqlError(
                      "providerAssetRepository.reserveProviderAssetReviewReplayRetry.activeJob"
                    )
                  )

                if (activeJob !== undefined) {
                  if (activeJob.mode !== "replay") {
                    yield* tx
                      .update(schema.processingJobs)
                      .set({ followUpMode: "replay", updatedAt: reservedAt })
                      .where(eq(schema.processingJobs.id, activeJob.id))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "providerAssetRepository.reserveProviderAssetReviewReplayRetry.attachFollowUp"
                        )
                      )
                  }
                  return activeJob.id
                }

                const [createdJob] = yield* tx
                  .insert(schema.processingJobs)
                  .values({
                    sourceId,
                    principalId: current.principalId,
                    mode: "replay",
                    status: "pending",
                    attemptCount: 0,
                    maxAttempts: 3,
                    progressDetails: { mode: "replay", reason: "asset_mapping_retried" },
                    createdAt: reservedAt,
                    updatedAt: reservedAt,
                  })
                  .onConflictDoNothing()
                  .returning({ id: schema.processingJobs.id })
                  .pipe(
                    wrapSyncEngineSqlError(
                      "providerAssetRepository.reserveProviderAssetReviewReplayRetry.createJob"
                    )
                  )

                if (createdJob !== undefined) return createdJob.id
                if (attemptsRemaining > 1) {
                  return yield* Effect.suspend(() => reserveJob(attemptsRemaining - 1))
                }

                return yield* new SyncEngineStorageError({
                  operation: "providerAssetRepository.reserveProviderAssetReviewReplayRetry.job",
                  cause: { providerAssetRowId, sourceId, jobId },
                })
              })

            const nextJobId = yield* reserveJob(3)
            const [reserved] = yield* tx
              .update(schema.providerAssetReviewReplays)
              .set({
                jobId: nextJobId,
                dispatchState: "failed_to_queue",
                errorMessage: null,
                updatedAt: reservedAt,
              })
              .where(
                and(
                  eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
                  eq(schema.providerAssetReviewReplays.sourceId, sourceId),
                  eq(schema.providerAssetReviewReplays.jobId, jobId)
                )
              )
              .returning({ id: schema.providerAssetReviewReplays.id })
              .pipe(
                wrapSyncEngineSqlError(
                  "providerAssetRepository.reserveProviderAssetReviewReplayRetry.link"
                )
              )

            return reserved === undefined
              ? Option.none()
              : Option.some({
                  sourceId,
                  principalId: current.principalId,
                  jobId: nextJobId,
                  dispatchState: "failed_to_queue" as const,
                  errorMessage: null,
                })
          })
        )
        .pipe(
          wrapSyncEngineStorageError(
            "providerAssetRepository.reserveProviderAssetReviewReplayRetry"
          )
        )

  const replaceProviderAssetReviewReplay: ProviderAssetRepositoryShape["replaceProviderAssetReviewReplay"] =
    ({ providerAssetRowId, sourceId, previousJobId, nextJobId }) =>
      db
        .update(schema.providerAssetReviewReplays)
        .set({
          jobId: nextJobId,
          dispatchState: "queued",
          errorMessage: null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAssetRowId),
            eq(schema.providerAssetReviewReplays.sourceId, sourceId),
            or(
              eq(schema.providerAssetReviewReplays.jobId, previousJobId),
              eq(schema.providerAssetReviewReplays.jobId, nextJobId)
            )
          )
        )
        .returning({ id: schema.providerAssetReviewReplays.id })
        .pipe(
          Effect.map((rows) => rows.length === 1),
          wrapSyncEngineStorageError("providerAssetRepository.replaceProviderAssetReviewReplay")
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
            const [source] = yield* tx
              .select({ principalId: schema.sources.principalId })
              .from(schema.sources)
              .where(eq(schema.sources.id, sourceId))
              .limit(1)
              .for("update")
            if (source === undefined) {
              return yield* new SyncEngineStorageError({
                operation: "providerAssetRepository.recordProviderAssetSourceUses.source",
                cause: `Source ${sourceId} does not exist.`,
              })
            }
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
            if (
              mappings.some(
                ({ mappingStatus, providerAssetRowId }) =>
                  mappingStatus === "approved" &&
                  newlyRecordedProviderAssetRowIds.has(providerAssetRowId)
              )
            ) {
              const requestReplay = (
                attemptsRemaining: number
              ): Effect.Effect<string, SyncEngineStorageError> =>
                Effect.gen(function* () {
                  const [activeJob] = yield* tx
                    .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
                    .from(schema.processingJobs)
                    .where(
                      and(
                        eq(schema.processingJobs.sourceId, sourceId),
                        eq(schema.processingJobs.principalId, source.principalId),
                        inArray(schema.processingJobs.status, ["pending", "processing"])
                      )
                    )
                    .limit(1)
                    .for("update")
                    .pipe(
                      wrapSyncEngineSqlError(
                        "providerAssetRepository.recordProviderAssetSourceUses.attachReplay"
                      )
                    )
                  if (activeJob !== undefined) {
                    if (activeJob.mode !== "replay") {
                      yield* tx
                        .update(schema.processingJobs)
                        .set({ followUpMode: "replay", updatedAt: now })
                        .where(eq(schema.processingJobs.id, activeJob.id))
                        .pipe(
                          wrapSyncEngineSqlError(
                            "providerAssetRepository.recordProviderAssetSourceUses.attachFollowUp"
                          )
                        )
                    }
                    return activeJob.id
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
                    return createdJob.id
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

              const jobId = yield* requestReplay(3)
              const approvedProviderAssetRowIds = mappings.flatMap(
                ({ mappingStatus, providerAssetRowId }) =>
                  mappingStatus === "approved" &&
                  newlyRecordedProviderAssetRowIds.has(providerAssetRowId)
                    ? [providerAssetRowId]
                    : []
              )

              yield* tx
                .insert(schema.providerAssetReviewReplays)
                .values(
                  approvedProviderAssetRowIds.map((providerAssetRowId) => ({
                    providerAssetRowId,
                    sourceId,
                    principalId: source.principalId,
                    jobId,
                    dispatchState: "queued" as const,
                    errorMessage: null,
                    createdAt: now,
                    updatedAt: now,
                  }))
                )
                .onConflictDoUpdate({
                  target: [
                    schema.providerAssetReviewReplays.providerAssetRowId,
                    schema.providerAssetReviewReplays.sourceId,
                  ],
                  set: {
                    principalId: source.principalId,
                    jobId,
                    dispatchState: "queued",
                    errorMessage: null,
                    updatedAt: now,
                  },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "providerAssetRepository.recordProviderAssetSourceUses.linkReplays"
                  )
                )
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
      reviewedBy: schema.providerAssetMappings.reviewedBy,
      reviewedAt: schema.providerAssetMappings.reviewedAt,
      updatedAt: schema.providerAssetMappings.updatedAt,
    },
    evidenceState: sql<"ambiguous" | "conflicting" | "exact" | "insufficient">`case
      when (
        select count(*) from (
          select distinct
            pt.observed_blockchain_id,
            pt.observed_representation_type,
            lower(pt.observed_contract_address),
            pt.observed_mint_address,
            pt.observed_decimals
          from provider_transfers pt
          where pt.provider_asset_id = ${schema.providerAssets.id}
            and pt.observed_blockchain_id is not null
            and pt.observed_representation_type is not null
            and pt.observed_decimals is not null
            and (
              (
                pt.observed_representation_type = 'native'
                and pt.observed_contract_address is null
                and pt.observed_mint_address is null
              )
              or (
                pt.observed_representation_type in ('token', 'nft')
                and num_nonnulls(pt.observed_contract_address, pt.observed_mint_address) = 1
              )
            )
        ) observed
      ) > 1 then 'conflicting'
      when exists (
        select 1 from provider_transfers pt
        where pt.provider_asset_id = ${schema.providerAssets.id}
          and num_nonnulls(
            pt.observed_blockchain_id,
            pt.observed_representation_type,
            pt.observed_contract_address,
            pt.observed_mint_address,
            pt.observed_decimals
          ) > 0
          and not (
            pt.observed_blockchain_id is not null
            and pt.observed_representation_type is not null
            and pt.observed_decimals is not null
            and (
              (
                pt.observed_representation_type = 'native'
                and pt.observed_contract_address is null
                and pt.observed_mint_address is null
              )
              or (
                pt.observed_representation_type in ('token', 'nft')
                and num_nonnulls(pt.observed_contract_address, pt.observed_mint_address) = 1
              )
            )
          )
      ) then 'insufficient'
      when exists (
        select 1 from provider_transfers pt
        where pt.provider_asset_id = ${schema.providerAssets.id}
          and pt.observed_blockchain_id is not null
          and pt.observed_representation_type is not null
          and pt.observed_decimals is not null
          and (
            (
              pt.observed_representation_type = 'native'
              and pt.observed_contract_address is null
              and pt.observed_mint_address is null
            )
            or (
              pt.observed_representation_type in ('token', 'nft')
              and num_nonnulls(pt.observed_contract_address, pt.observed_mint_address) = 1
            )
          )
      ) then 'exact'
      when ${schema.providerAssets.name} is not null
        and (${schema.providerAssets.providerAssetId} is not null or ${schema.providerAssets.naturalKey} is not null)
        then 'ambiguous'
      else 'insufficient'
    end`,
    evidenceRevision: providerAssetEvidenceRevisionExpression(schema.providerAssets.id),
    affectedSourceCount: sql<number>`(
      select count(distinct affected.source_id)::int
      from (
        select pasu.source_id
        from provider_asset_source_uses pasu
        where pasu.provider_asset_row_id = ${schema.providerAssets.id}
        union
        select pt.source_id
        from provider_transfers pt
        where pt.provider_asset_id = ${schema.providerAssets.id}
      ) affected
    )`.mapWith(Number),
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
    evidenceState,
    query,
    cursor,
    limit,
  }) =>
    Effect.gen(function* () {
      const evidenceExpression = providerAssetReviewProjection.evidenceState
      const cursorDiscoveredAtExpression =
        sql<number>`floor(extract(epoch from ${schema.providerAssets.discoveredAt}) * 1000)`.mapWith(
          Number
        )
      const cursorDiscoveredAt = cursor?.discoveredAt.getTime()
      const cursorPredicate =
        cursor === null
          ? undefined
          : or(
              gt(cursorDiscoveredAtExpression, cursorDiscoveredAt ?? 0),
              and(
                eq(cursorDiscoveredAtExpression, cursorDiscoveredAt ?? 0),
                gt(schema.providerAssets.id, cursor.providerAssetRowId)
              )
            )
      const searchFilters = getAssetCatalogSearchPatterns(query ?? "").map((searchPattern) =>
        or(
          ilike(schema.providerAssets.currencyCode, searchPattern),
          ilike(schema.providerAssets.name, searchPattern),
          ilike(schema.providerAssets.providerAssetId, searchPattern),
          ilike(schema.providerAssets.naturalKey, searchPattern),
          sql<boolean>`exists (
            select 1 from provider_transfers pt
            where pt.provider_asset_id = ${schema.providerAssets.id}
              and (
                pt.observed_contract_address ilike ${searchPattern}
                or pt.observed_mint_address ilike ${searchPattern}
              )
          )`
        )
      )
      const predicates = [
        eq(schema.providerAssetMappings.mappingKind, "asset"),
        sql<boolean>`(
          ${schema.providerAssets.provider} <> 'coinbase'
          or (${schema.providerAssets.rawProviderPayload}->>'source')
            is distinct from 'coinbase_fiat_currency_catalog'
        )`,
        ...(mappingStatus === null
          ? []
          : [eq(schema.providerAssetMappings.mappingStatus, mappingStatus)]),
        ...(providerKey === null ? [] : [eq(schema.providerAssets.provider, providerKey)]),
        ...(evidenceState === null ? [] : [eq(evidenceExpression, evidenceState)]),
        ...searchFilters,
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
        .orderBy(asc(cursorDiscoveredAtExpression), asc(schema.providerAssets.id))
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

  return ProviderAssetRepository.of({
    upsertProviderAssets,
    upsertProviderAssetMappings,
    seedProviderAssetMappingsIfMissing,
    approveProviderAssetMappingAndRequestReplay,
    rejectProviderAssetMapping,
    findProviderAssetReviewReplay,
    listProviderAssetReviewReplays,
    markProviderAssetReviewReplayDispatch,
    reserveProviderAssetReviewReplayRetry,
    replaceProviderAssetReviewReplay,
    lockProviderAssetApprovalSnapshot,
    recordProviderAssetSourceUses,
    findProviderAssetByProviderAssetId,
    findProviderAssetByNaturalKey,
    findProviderAssetByCurrencyCode,
    findProviderAssetReviewById,
    listProviderAssetReviews,
    listProviderAssetObservedRepresentations,
    findProviderAssetMapping,
  } satisfies ProviderAssetRepositoryShape)
})

export const ProviderAssetRepositoryLive = Layer.effect(ProviderAssetRepository, make)
