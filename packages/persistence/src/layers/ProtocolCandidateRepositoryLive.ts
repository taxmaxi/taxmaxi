/**
 * ProtocolCandidateRepositoryLive - Protocol candidate review queue persistence.
 *
 * @module ProtocolCandidateRepositoryLive
 */

import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProtocolCandidateRepository,
  SyncEngineStorageError,
  type PersistedProtocolCandidate,
  type ProtocolCandidateObservationSourceMetadata,
  type ProtocolCandidateObservationDraft,
  type ProtocolCandidateReviewDetail,
  type ProtocolCandidateReviewListRow,
  type ProtocolCandidateReviewObservation,
  type ProtocolCandidateSubjectKind,
  type ProtocolCandidateRepositoryShape,
  type TaxMaxiTransactionTypeReference,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const importOperation = "protocolCandidateRepository.importObservations"
const listPendingReviewOperation = "protocolCandidateRepository.listPendingReviewCandidates"
const getReviewDetailOperation = "protocolCandidateRepository.getReviewDetail"
const listTransactionTypesOperation = "protocolCandidateRepository.listTransactionTypes"

const storageError = (operation: string, cause: unknown) =>
  new SyncEngineStorageError({
    operation,
    cause,
  })

const invalidObservation = ({
  field,
  message,
}: {
  readonly field: string
  readonly message: string
}) => Effect.fail(storageError(importOperation, { field, message }))

const uniqueNonEmptySubjectIdentifiers = (subjectIdentifiers: ReadonlyArray<string>) => [
  ...new Set(
    subjectIdentifiers
      .map((subjectIdentifier) => subjectIdentifier.trim())
      .filter((subjectIdentifier) => subjectIdentifier.length > 0)
  ),
]

const requiredSubjectIdentifiersForCandidate = ({
  candidate,
  relatedSubjectIdentifierGroups,
}: {
  readonly candidate: Pick<PersistedProtocolCandidate, "subjectKind" | "subjectIdentifier">
  readonly relatedSubjectIdentifierGroups: ReadonlyArray<ReadonlyArray<string>>
}) =>
  uniqueNonEmptySubjectIdentifiers([
    // Protocol candidate identifiers are slugs; program/contract identifiers are chain subjects.
    ...(candidate.subjectKind === "protocol" ? [] : [candidate.subjectIdentifier]),
    ...relatedSubjectIdentifierGroups.flat(),
  ])

const isValidDate = (date: Date): boolean => !Number.isNaN(date.getTime())

const validateNonEmptyText = ({
  field,
  value,
}: {
  readonly field: string
  readonly value: string
}) =>
  value.trim().length === 0
    ? invalidObservation({ field, message: `${field} must not be empty.` })
    : Effect.void

const validateSafeCount = ({ field, value }: { readonly field: string; readonly value: number }) =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.void
    : invalidObservation({ field, message: `${field} must be a non-negative safe integer.` })

const validateNullableSafeCount = ({
  field,
  value,
}: {
  readonly field: string
  readonly value: number | null
}) => (value === null ? Effect.void : validateSafeCount({ field, value }))

const validateObservation = (observation: ProtocolCandidateObservationDraft) =>
  Effect.gen(function* () {
    yield* validateNonEmptyText({ field: "blockchainName", value: observation.blockchainName })
    yield* validateNonEmptyText({
      field: "subjectIdentifier",
      value: observation.subjectIdentifier,
    })
    yield* validateNonEmptyText({
      field: "sourceObservationKey",
      value: observation.sourceObservationKey,
    })
    yield* validateSafeCount({ field: "interactionCount", value: observation.interactionCount })
    yield* validateNullableSafeCount({
      field: "transactionCount",
      value: observation.transactionCount,
    })
    yield* validateNullableSafeCount({
      field: "uniqueActorCount",
      value: observation.uniqueActorCount,
    })
    switch (observation.sourceMetadata.source) {
      case "dune": {
        yield* validateNonEmptyText({
          field: "sourceMetadata.queryName",
          value: observation.sourceMetadata.queryName,
        })
        yield* validateSafeCount({
          field: "sourceMetadata.queryId",
          value: observation.sourceMetadata.queryId,
        })
        yield* validateSafeCount({
          field: "sourceMetadata.queryVersion",
          value: observation.sourceMetadata.queryVersion,
        })
        break
      }
    }

    if (!isValidDate(observation.observedWindowStart)) {
      yield* invalidObservation({
        field: "observedWindowStart",
        message: "observedWindowStart must be a valid date.",
      })
    }

    if (!isValidDate(observation.observedWindowEnd)) {
      yield* invalidObservation({
        field: "observedWindowEnd",
        message: "observedWindowEnd must be a valid date.",
      })
    }

    if (observation.observedWindowStart >= observation.observedWindowEnd) {
      yield* invalidObservation({
        field: "observedWindowEnd",
        message: "observedWindowEnd must be after observedWindowStart.",
      })
    }

    if (!isValidDate(observation.retrievedAt)) {
      yield* invalidObservation({
        field: "retrievedAt",
        message: "retrievedAt must be a valid date.",
      })
    }
  })

const toNumericText = (value: number | null): string | null =>
  value === null ? null : String(value)

const decodeSubjectKind = (
  subjectKind: string
): Effect.Effect<ProtocolCandidateSubjectKind, SyncEngineStorageError> => {
  switch (subjectKind) {
    case "program":
    case "contract":
    case "protocol": {
      return Effect.succeed(subjectKind)
    }
    default: {
      return Effect.fail(
        storageError(importOperation, {
          subjectKind,
          message: "Persisted protocol candidate has an unknown subject kind.",
        })
      )
    }
  }
}

const toPersistedCandidate = (candidate: {
  readonly id: string
  readonly blockchainId: string
  readonly subjectKind: string
  readonly subjectIdentifier: string
  readonly protocolNameHint: string | null
  readonly categoryHint: string | null
  readonly mappingStatus: "approved" | "pending_review" | "rejected"
  readonly firstSeenAt: Date
  readonly lastSeenAt: Date
}): Effect.Effect<PersistedProtocolCandidate, SyncEngineStorageError> =>
  Effect.map(decodeSubjectKind(candidate.subjectKind), (subjectKind) => ({
    id: candidate.id,
    blockchainId: candidate.blockchainId,
    subjectKind,
    subjectIdentifier: candidate.subjectIdentifier,
    protocolNameHint: candidate.protocolNameHint,
    categoryHint: candidate.categoryHint,
    mappingStatus: candidate.mappingStatus,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
  }))

const decodeObservationSourceMetadata = (metadata: {
  readonly queryId: number
  readonly queryName: string
  readonly queryVersion: number
}): ProtocolCandidateObservationSourceMetadata => ({
  source: "dune",
  queryId: metadata.queryId,
  queryName: metadata.queryName,
  queryVersion: metadata.queryVersion,
})

const toReviewListRow = (candidate: {
  readonly id: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly subjectKind: string
  readonly subjectIdentifier: string
  readonly protocolNameHint: string | null
  readonly categoryHint: string | null
  readonly mappingStatus: "approved" | "pending_review" | "rejected"
  readonly firstSeenAt: Date
  readonly lastSeenAt: Date
  readonly observationCount: number
}): Effect.Effect<ProtocolCandidateReviewListRow, SyncEngineStorageError> =>
  Effect.map(toPersistedCandidate(candidate), (persisted) => ({
    ...persisted,
    blockchainName: candidate.blockchainName,
    observationCount: candidate.observationCount,
  }))

const toReviewObservation = (row: {
  readonly id: string
  readonly onchainDataSource: "dune"
  readonly onchainDataSourceObservationKey: string
  readonly observedWindowStart: Date
  readonly observedWindowEnd: Date
  readonly interactionCount: string
  readonly transactionCount: string | null
  readonly uniqueActorCount: string | null
  readonly relatedSubjectIdentifiers: ReadonlyArray<string>
  readonly sampleTransactionHashes: ReadonlyArray<string>
  readonly retrievedAt: Date
  readonly rawPayload: Record<string, unknown>
  readonly queryId: number
  readonly queryName: string
  readonly queryVersion: number
}): ProtocolCandidateReviewObservation => ({
  id: row.id,
  onchainDataSource: row.onchainDataSource,
  onchainDataSourceObservationKey: row.onchainDataSourceObservationKey,
  observedWindowStart: row.observedWindowStart,
  observedWindowEnd: row.observedWindowEnd,
  interactionCount: row.interactionCount,
  transactionCount: row.transactionCount,
  uniqueActorCount: row.uniqueActorCount,
  relatedSubjectIdentifiers: row.relatedSubjectIdentifiers,
  sampleTransactionHashes: row.sampleTransactionHashes,
  retrievedAt: row.retrievedAt,
  rawPayload: row.rawPayload,
  sourceMetadata: decodeObservationSourceMetadata(row),
})

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const importObservations: ProtocolCandidateRepositoryShape["importObservations"] = ({
    observations,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const requiredSubjectIdentifiersBeforeByCandidateId = new Map<
            string,
            ReadonlySet<string>
          >()

          if (observations.length === 0) {
            return {
              candidates: [],
              observationCount: 0,
            }
          }

          yield* Effect.forEach(observations, validateObservation, { discard: true })

          const now = nowDate()
          const candidates = yield* Effect.forEach(observations, (observation) =>
            Effect.gen(function* () {
              const [blockchain] = yield* tx
                .select({ id: schema.blockchains.id })
                .from(schema.blockchains)
                .where(eq(schema.blockchains.name, observation.blockchainName))
                .limit(1)
                .pipe(wrapSyncEngineSqlError(importOperation))

              if (blockchain === undefined) {
                return yield* Effect.fail(
                  storageError(importOperation, {
                    blockchainName: observation.blockchainName,
                    message: "Failed to resolve protocol candidate blockchain.",
                  })
                )
              }

              const candidate = yield* tx
                .insert(schema.protocolCandidates)
                .values({
                  blockchainId: blockchain.id,
                  subjectKind: observation.subjectKind,
                  subjectIdentifier: observation.subjectIdentifier,
                  protocolNameHint: observation.protocolNameHint,
                  categoryHint: observation.categoryHint,
                  mappingStatus: "pending_review",
                  firstSeenAt: observation.retrievedAt,
                  lastSeenAt: observation.retrievedAt,
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: [
                    schema.protocolCandidates.blockchainId,
                    schema.protocolCandidates.subjectKind,
                    schema.protocolCandidates.subjectIdentifier,
                  ],
                  set: {
                    protocolNameHint: sql`coalesce(excluded.protocol_name_hint, ${schema.protocolCandidates.protocolNameHint})`,
                    categoryHint: sql`coalesce(excluded.category_hint, ${schema.protocolCandidates.categoryHint})`,
                    firstSeenAt: sql`least(${schema.protocolCandidates.firstSeenAt}, excluded.first_seen_at)`,
                    lastSeenAt: sql`greatest(${schema.protocolCandidates.lastSeenAt}, excluded.last_seen_at)`,
                    updatedAt: now,
                  },
                })
                .returning({
                  id: schema.protocolCandidates.id,
                  blockchainId: schema.protocolCandidates.blockchainId,
                  subjectKind: schema.protocolCandidates.subjectKind,
                  subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
                  protocolNameHint: schema.protocolCandidates.protocolNameHint,
                  categoryHint: schema.protocolCandidates.categoryHint,
                  mappingStatus: schema.protocolCandidates.mappingStatus,
                  firstSeenAt: schema.protocolCandidates.firstSeenAt,
                  lastSeenAt: schema.protocolCandidates.lastSeenAt,
                })
                .pipe(
                  Effect.flatMap((rows) =>
                    rows[0] === undefined
                      ? Effect.fail(
                          storageError(importOperation, {
                            message: "Failed to upsert protocol candidate.",
                          })
                        )
                      : toPersistedCandidate(rows[0])
                  ),
                  wrapSyncEngineSqlError(importOperation)
                )

              if (!requiredSubjectIdentifiersBeforeByCandidateId.has(candidate.id)) {
                const observationRows = yield* tx
                  .select({
                    relatedSubjectIdentifiers:
                      schema.protocolCandidateObservations.relatedSubjectIdentifiers,
                  })
                  .from(schema.protocolCandidateObservations)
                  .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                  .pipe(wrapSyncEngineSqlError(importOperation))

                const requiredSubjectIdentifiersBefore = requiredSubjectIdentifiersForCandidate({
                  candidate,
                  relatedSubjectIdentifierGroups: observationRows.map(
                    (row) => row.relatedSubjectIdentifiers
                  ),
                })

                requiredSubjectIdentifiersBeforeByCandidateId.set(
                  candidate.id,
                  new Set(requiredSubjectIdentifiersBefore)
                )
              }

              return candidate
            })
          )

          yield* Effect.forEach(
            observations,
            (observation, index) =>
              Effect.gen(function* () {
                const candidate = candidates[index]
                if (candidate === undefined) {
                  return yield* Effect.fail(
                    storageError(importOperation, {
                      message: "Missing imported candidate for observation.",
                    })
                  )
                }

                const [persistedObservation] = yield* tx
                  .insert(schema.protocolCandidateObservations)
                  .values({
                    candidateId: candidate.id,
                    onchainDataSource: observation.sourceMetadata.source,
                    onchainDataSourceObservationKey: observation.sourceObservationKey,
                    observedWindowStart: observation.observedWindowStart,
                    observedWindowEnd: observation.observedWindowEnd,
                    interactionCount: String(observation.interactionCount),
                    transactionCount: toNumericText(observation.transactionCount),
                    uniqueActorCount: toNumericText(observation.uniqueActorCount),
                    sampleTransactionHashes: [...observation.sampleTransactionHashes],
                    relatedSubjectIdentifiers: uniqueNonEmptySubjectIdentifiers(
                      observation.relatedSubjectIdentifiers
                    ),
                    retrievedAt: observation.retrievedAt,
                    rawPayload: observation.rawPayload,
                    createdAt: now,
                  })
                  .onConflictDoUpdate({
                    target: [
                      schema.protocolCandidateObservations.candidateId,
                      schema.protocolCandidateObservations.onchainDataSource,
                      schema.protocolCandidateObservations.onchainDataSourceObservationKey,
                    ],
                    set: {
                      observedWindowStart: sql.raw("excluded.observed_window_start"),
                      observedWindowEnd: sql.raw("excluded.observed_window_end"),
                      interactionCount: sql.raw("excluded.interaction_count"),
                      transactionCount: sql.raw("excluded.transaction_count"),
                      uniqueActorCount: sql.raw("excluded.unique_actor_count"),
                      sampleTransactionHashes: sql.raw("excluded.sample_transaction_hashes"),
                      relatedSubjectIdentifiers: sql.raw("excluded.related_subject_identifiers"),
                      retrievedAt: sql.raw("excluded.retrieved_at"),
                      rawPayload: sql.raw("excluded.raw_payload"),
                    },
                  })
                  .returning({
                    id: schema.protocolCandidateObservations.id,
                  })
                  .pipe(wrapSyncEngineSqlError(importOperation))

                if (persistedObservation === undefined) {
                  return yield* Effect.fail(
                    storageError(importOperation, {
                      message: "Failed to upsert protocol candidate observation.",
                    })
                  )
                }

                yield* tx
                  .insert(schema.duneProtocolCandidateObservations)
                  .values({
                    observationId: persistedObservation.id,
                    queryId: observation.sourceMetadata.queryId,
                    queryName: observation.sourceMetadata.queryName,
                    queryVersion: observation.sourceMetadata.queryVersion,
                  })
                  .onConflictDoUpdate({
                    target: schema.duneProtocolCandidateObservations.observationId,
                    set: {
                      queryId: sql.raw("excluded.query_id"),
                      queryName: sql.raw("excluded.query_name"),
                      queryVersion: sql.raw("excluded.query_version"),
                    },
                  })
                  .pipe(wrapSyncEngineSqlError(importOperation))
              }),
            { discard: true }
          )

          const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
          yield* Effect.forEach(candidatesById.values(), (candidate) =>
            Effect.gen(function* () {
              const requiredSubjectIdentifiersBefore =
                requiredSubjectIdentifiersBeforeByCandidateId.get(candidate.id) ?? new Set<string>()

              const observationRows = yield* tx
                .select({
                  relatedSubjectIdentifiers:
                    schema.protocolCandidateObservations.relatedSubjectIdentifiers,
                })
                .from(schema.protocolCandidateObservations)
                .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                .pipe(wrapSyncEngineSqlError(importOperation))

              const requiredSubjectIdentifiersAfter = requiredSubjectIdentifiersForCandidate({
                candidate,
                relatedSubjectIdentifierGroups: observationRows.map(
                  (row) => row.relatedSubjectIdentifiers
                ),
              })
              const addedSubjectIdentifiers = requiredSubjectIdentifiersAfter.filter(
                (subjectIdentifier) => !requiredSubjectIdentifiersBefore.has(subjectIdentifier)
              )

              const shouldRecomputeStatus =
                candidate.mappingStatus === "pending_review" ||
                (candidate.mappingStatus === "approved" && addedSubjectIdentifiers.length > 0)

              if (!shouldRecomputeStatus || requiredSubjectIdentifiersAfter.length === 0) {
                return
              }

              const approvedMappingRows = yield* tx
                .select({
                  subjectIdentifier: schema.protocolTransactionTypeMappings.subjectIdentifier,
                })
                .from(schema.protocolTransactionTypeMappings)
                .where(
                  and(
                    eq(schema.protocolTransactionTypeMappings.blockchainId, candidate.blockchainId),
                    inArray(
                      schema.protocolTransactionTypeMappings.subjectIdentifier,
                      requiredSubjectIdentifiersAfter
                    ),
                    eq(
                      schema.protocolTransactionTypeMappings.movementPattern,
                      "token_out_and_token_in"
                    ),
                    eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
                  )
                )
                .pipe(wrapSyncEngineSqlError(importOperation))
              const approvedSubjectIdentifiers = new Set(
                approvedMappingRows.map((row) => row.subjectIdentifier)
              )
              const hasUncoveredSubject = requiredSubjectIdentifiersAfter.some(
                (subjectIdentifier) => !approvedSubjectIdentifiers.has(subjectIdentifier)
              )

              const [pendingMappingCount] = yield* tx
                .select({ value: count(schema.protocolTransactionTypeMappings.id) })
                .from(schema.protocolTransactionTypeMappings)
                .where(
                  and(
                    eq(schema.protocolTransactionTypeMappings.candidateId, candidate.id),
                    eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
                  )
                )
                .pipe(wrapSyncEngineSqlError(importOperation))

              const nextMappingStatus =
                !hasUncoveredSubject && (pendingMappingCount?.value ?? 0) === 0
                  ? "approved"
                  : "pending_review"

              yield* tx
                .update(schema.protocolCandidates)
                .set({
                  mappingStatus: nextMappingStatus,
                  updatedAt: now,
                })
                .where(eq(schema.protocolCandidates.id, candidate.id))
                .pipe(wrapSyncEngineSqlError(importOperation))
            })
          )

          const candidateIds = [...new Set(candidates.map((candidate) => candidate.id))]
          const currentCandidateRows = yield* tx
            .select({
              id: schema.protocolCandidates.id,
              blockchainId: schema.protocolCandidates.blockchainId,
              subjectKind: schema.protocolCandidates.subjectKind,
              subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
              protocolNameHint: schema.protocolCandidates.protocolNameHint,
              categoryHint: schema.protocolCandidates.categoryHint,
              mappingStatus: schema.protocolCandidates.mappingStatus,
              firstSeenAt: schema.protocolCandidates.firstSeenAt,
              lastSeenAt: schema.protocolCandidates.lastSeenAt,
            })
            .from(schema.protocolCandidates)
            .where(inArray(schema.protocolCandidates.id, candidateIds))
            .pipe(wrapSyncEngineSqlError(importOperation))
          const currentCandidates = yield* Effect.forEach(
            currentCandidateRows,
            toPersistedCandidate
          )
          const currentCandidatesById = new Map(
            currentCandidates.map((candidate) => [candidate.id, candidate])
          )
          const returnedCandidates = yield* Effect.forEach(candidates, (candidate) => {
            const currentCandidate = currentCandidatesById.get(candidate.id)
            return currentCandidate === undefined
              ? Effect.fail(
                  storageError(importOperation, {
                    message: "Failed to reload imported candidate.",
                  })
                )
              : Effect.succeed(currentCandidate)
          })

          return {
            candidates: returnedCandidates,
            observationCount: observations.length,
          }
        })
      )
      .pipe(wrapSyncEngineStorageError(importOperation))

  const listPendingReviewCandidates: ProtocolCandidateRepositoryShape["listPendingReviewCandidates"] =
    ({ cursorCandidateId, limit }) =>
      Effect.gen(function* () {
        const [cursorCandidate] =
          cursorCandidateId === null
            ? [undefined]
            : yield* db
                .select({
                  id: schema.protocolCandidates.id,
                  lastSeenAt: schema.protocolCandidates.lastSeenAt,
                })
                .from(schema.protocolCandidates)
                .where(
                  and(
                    eq(schema.protocolCandidates.id, cursorCandidateId),
                    eq(schema.protocolCandidates.mappingStatus, "pending_review")
                  )
                )
                .limit(1)
                .pipe(wrapSyncEngineSqlError(listPendingReviewOperation))

        if (cursorCandidateId !== null && cursorCandidate === undefined) {
          return []
        }

        const rows = yield* db
          .select({
            id: schema.protocolCandidates.id,
            blockchainId: schema.protocolCandidates.blockchainId,
            blockchainName: schema.blockchains.name,
            subjectKind: schema.protocolCandidates.subjectKind,
            subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
            protocolNameHint: schema.protocolCandidates.protocolNameHint,
            categoryHint: schema.protocolCandidates.categoryHint,
            mappingStatus: schema.protocolCandidates.mappingStatus,
            firstSeenAt: schema.protocolCandidates.firstSeenAt,
            lastSeenAt: schema.protocolCandidates.lastSeenAt,
            observationCount: count(schema.protocolCandidateObservations.id),
          })
          .from(schema.protocolCandidates)
          .innerJoin(
            schema.blockchains,
            eq(schema.blockchains.id, schema.protocolCandidates.blockchainId)
          )
          .leftJoin(
            schema.protocolCandidateObservations,
            eq(schema.protocolCandidateObservations.candidateId, schema.protocolCandidates.id)
          )
          .where(
            cursorCandidate === undefined
              ? eq(schema.protocolCandidates.mappingStatus, "pending_review")
              : and(
                  eq(schema.protocolCandidates.mappingStatus, "pending_review"),
                  or(
                    lt(schema.protocolCandidates.lastSeenAt, cursorCandidate.lastSeenAt),
                    and(
                      eq(schema.protocolCandidates.lastSeenAt, cursorCandidate.lastSeenAt),
                      gt(schema.protocolCandidates.id, cursorCandidate.id)
                    )
                  )
                )
          )
          .groupBy(
            schema.protocolCandidates.id,
            schema.blockchains.name,
            schema.protocolCandidates.blockchainId,
            schema.protocolCandidates.subjectKind,
            schema.protocolCandidates.subjectIdentifier,
            schema.protocolCandidates.protocolNameHint,
            schema.protocolCandidates.categoryHint,
            schema.protocolCandidates.mappingStatus,
            schema.protocolCandidates.firstSeenAt,
            schema.protocolCandidates.lastSeenAt
          )
          .orderBy(desc(schema.protocolCandidates.lastSeenAt), asc(schema.protocolCandidates.id))
          .limit(limit)
          .pipe(wrapSyncEngineSqlError(listPendingReviewOperation))

        return yield* Effect.forEach(rows, toReviewListRow)
      })

  const getReviewDetail: ProtocolCandidateRepositoryShape["getReviewDetail"] = ({
    candidateId,
    observationCursorId,
    observationLimit,
  }) =>
    Effect.gen(function* () {
      const [candidateRow] = yield* db
        .select({
          id: schema.protocolCandidates.id,
          blockchainId: schema.protocolCandidates.blockchainId,
          blockchainName: schema.blockchains.name,
          subjectKind: schema.protocolCandidates.subjectKind,
          subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
          protocolNameHint: schema.protocolCandidates.protocolNameHint,
          categoryHint: schema.protocolCandidates.categoryHint,
          mappingStatus: schema.protocolCandidates.mappingStatus,
          firstSeenAt: schema.protocolCandidates.firstSeenAt,
          lastSeenAt: schema.protocolCandidates.lastSeenAt,
          observationCount: count(schema.protocolCandidateObservations.id),
        })
        .from(schema.protocolCandidates)
        .innerJoin(
          schema.blockchains,
          eq(schema.blockchains.id, schema.protocolCandidates.blockchainId)
        )
        .leftJoin(
          schema.protocolCandidateObservations,
          eq(schema.protocolCandidateObservations.candidateId, schema.protocolCandidates.id)
        )
        .where(eq(schema.protocolCandidates.id, candidateId))
        .groupBy(
          schema.protocolCandidates.id,
          schema.blockchains.name,
          schema.protocolCandidates.blockchainId,
          schema.protocolCandidates.subjectKind,
          schema.protocolCandidates.subjectIdentifier,
          schema.protocolCandidates.protocolNameHint,
          schema.protocolCandidates.categoryHint,
          schema.protocolCandidates.mappingStatus,
          schema.protocolCandidates.firstSeenAt,
          schema.protocolCandidates.lastSeenAt
        )
        .limit(1)
        .pipe(wrapSyncEngineSqlError(getReviewDetailOperation))

      if (candidateRow === undefined) {
        return Option.none<ProtocolCandidateReviewDetail>()
      }

      const candidate = yield* toReviewListRow(candidateRow)

      const [cursorObservation] =
        observationCursorId === null
          ? [undefined]
          : yield* db
              .select({
                id: schema.protocolCandidateObservations.id,
                retrievedAt: schema.protocolCandidateObservations.retrievedAt,
              })
              .from(schema.protocolCandidateObservations)
              .where(
                and(
                  eq(schema.protocolCandidateObservations.id, observationCursorId),
                  eq(schema.protocolCandidateObservations.candidateId, candidateId)
                )
              )
              .limit(1)
              .pipe(wrapSyncEngineSqlError(getReviewDetailOperation))

      if (observationCursorId !== null && cursorObservation === undefined) {
        return Option.some({
          candidate,
          observations: [],
        })
      }

      const observationRows = yield* db
        .select({
          id: schema.protocolCandidateObservations.id,
          onchainDataSource: schema.protocolCandidateObservations.onchainDataSource,
          onchainDataSourceObservationKey:
            schema.protocolCandidateObservations.onchainDataSourceObservationKey,
          observedWindowStart: schema.protocolCandidateObservations.observedWindowStart,
          observedWindowEnd: schema.protocolCandidateObservations.observedWindowEnd,
          interactionCount: schema.protocolCandidateObservations.interactionCount,
          transactionCount: schema.protocolCandidateObservations.transactionCount,
          uniqueActorCount: schema.protocolCandidateObservations.uniqueActorCount,
          relatedSubjectIdentifiers: schema.protocolCandidateObservations.relatedSubjectIdentifiers,
          sampleTransactionHashes: schema.protocolCandidateObservations.sampleTransactionHashes,
          retrievedAt: schema.protocolCandidateObservations.retrievedAt,
          rawPayload: schema.protocolCandidateObservations.rawPayload,
          queryId: schema.duneProtocolCandidateObservations.queryId,
          queryName: schema.duneProtocolCandidateObservations.queryName,
          queryVersion: schema.duneProtocolCandidateObservations.queryVersion,
        })
        .from(schema.protocolCandidateObservations)
        .innerJoin(
          schema.duneProtocolCandidateObservations,
          eq(
            schema.duneProtocolCandidateObservations.observationId,
            schema.protocolCandidateObservations.id
          )
        )
        .where(
          cursorObservation === undefined
            ? eq(schema.protocolCandidateObservations.candidateId, candidateId)
            : and(
                eq(schema.protocolCandidateObservations.candidateId, candidateId),
                or(
                  lt(
                    schema.protocolCandidateObservations.retrievedAt,
                    cursorObservation.retrievedAt
                  ),
                  and(
                    eq(
                      schema.protocolCandidateObservations.retrievedAt,
                      cursorObservation.retrievedAt
                    ),
                    gt(schema.protocolCandidateObservations.id, cursorObservation.id)
                  )
                )
              )
        )
        .orderBy(
          desc(schema.protocolCandidateObservations.retrievedAt),
          asc(schema.protocolCandidateObservations.id)
        )
        .limit(observationLimit)
        .pipe(wrapSyncEngineSqlError(getReviewDetailOperation))

      return Option.some({
        candidate,
        observations: observationRows.map(toReviewObservation),
      })
    })

  const listTransactionTypes: ProtocolCandidateRepositoryShape["listTransactionTypes"] = () =>
    db
      .select({
        typeKey: schema.transactionTypes.typeKey,
        categoryKey: schema.transactionTypes.categoryKey,
        subcategoryKey: schema.transactionTypes.subcategoryKey,
        labelEn: schema.transactionTypes.labelEn,
        labelDe: schema.transactionTypes.labelDe,
      })
      .from(schema.transactionTypes)
      .orderBy(asc(schema.transactionTypes.typeKey))
      .pipe(
        wrapSyncEngineSqlError(listTransactionTypesOperation),
        Effect.map((rows): ReadonlyArray<TaxMaxiTransactionTypeReference> => rows)
      )

  return ProtocolCandidateRepository.of({
    importObservations,
    listPendingReviewCandidates,
    getReviewDetail,
    listTransactionTypes,
  } satisfies ProtocolCandidateRepositoryShape)
})

export const ProtocolCandidateRepositoryLive = Layer.effect(ProtocolCandidateRepository, make)
