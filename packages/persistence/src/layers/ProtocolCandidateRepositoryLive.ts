/**
 * ProtocolCandidateRepositoryLive - Protocol candidate review queue persistence.
 *
 * @module ProtocolCandidateRepositoryLive
 */

import { and, eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  ProtocolCandidateRepository,
  SyncEngineStorageError,
  type PersistedProtocolCandidate,
  type ProtocolCandidateObservationDraft,
  type ProtocolCandidateSubjectKind,
  type ProtocolCandidateRepositoryShape,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const operation = "protocolCandidateRepository.importObservations"

const storageError = (cause: unknown) =>
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
}) => Effect.fail(storageError({ field, message }))

const ProtocolCandidateObservationPayload = Schema.Struct({
  canonicalProgramIds: Schema.optional(Schema.Array(Schema.String)),
})

const canonicalProgramIdsFromRawPayload = (payload: unknown) =>
  Schema.decodeUnknown(ProtocolCandidateObservationPayload)(payload).pipe(
    Effect.mapError((cause) =>
      storageError({
        message: "Failed to decode protocol candidate observation payload.",
        cause,
      })
    ),
    Effect.map(({ canonicalProgramIds }) => [
      ...new Set(
        (canonicalProgramIds ?? [])
          .map((programId) => programId.trim())
          .filter((programId) => programId.length > 0)
      ),
    ])
  )

const requiredProgramIdsForCandidate = ({
  candidate,
  rawPayloads,
}: {
  readonly candidate: Pick<PersistedProtocolCandidate, "subjectKind" | "subjectIdentifier">
  readonly rawPayloads: ReadonlyArray<unknown>
}) =>
  Effect.map(
    Effect.forEach(rawPayloads, canonicalProgramIdsFromRawPayload),
    (observedProgramIdGroups) => [
      ...new Set(
        [
          ...(candidate.subjectKind === "program" ? [candidate.subjectIdentifier] : []),
          ...observedProgramIdGroups.flat(),
        ]
          .map((programId) => programId.trim())
          .filter((programId) => programId.length > 0)
      ),
    ]
  )

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
        storageError({
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

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const importObservations: ProtocolCandidateRepositoryShape["importObservations"] = ({
    observations,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const approvedCandidatesById = new Map<string, PersistedProtocolCandidate>()
          const requiredProgramIdsBeforeByCandidateId = new Map<string, ReadonlySet<string>>()

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
                .pipe(wrapSyncEngineSqlError(operation))

              if (blockchain === undefined) {
                return yield* Effect.fail(
                  storageError({
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
                          storageError({ message: "Failed to upsert protocol candidate." })
                        )
                      : toPersistedCandidate(rows[0])
                  ),
                  wrapSyncEngineSqlError(operation)
                )

              if (!requiredProgramIdsBeforeByCandidateId.has(candidate.id)) {
                const observationRows = yield* tx
                  .select({
                    rawPayload: schema.protocolCandidateObservations.rawPayload,
                  })
                  .from(schema.protocolCandidateObservations)
                  .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                  .pipe(wrapSyncEngineSqlError(operation))

                const requiredProgramIdsBefore = yield* requiredProgramIdsForCandidate({
                  candidate,
                  rawPayloads: observationRows.map((row) => row.rawPayload),
                })

                requiredProgramIdsBeforeByCandidateId.set(
                  candidate.id,
                  new Set(requiredProgramIdsBefore)
                )

                if (candidate.mappingStatus === "approved") {
                  approvedCandidatesById.set(candidate.id, candidate)
                }
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
                    storageError({ message: "Missing imported candidate for observation." })
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
                      retrievedAt: sql.raw("excluded.retrieved_at"),
                      rawPayload: sql.raw("excluded.raw_payload"),
                    },
                  })
                  .returning({
                    id: schema.protocolCandidateObservations.id,
                  })
                  .pipe(wrapSyncEngineSqlError(operation))

                if (persistedObservation === undefined) {
                  return yield* Effect.fail(
                    storageError({
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
                  .pipe(wrapSyncEngineSqlError(operation))
              }),
            { discard: true }
          )

          yield* Effect.forEach(approvedCandidatesById.values(), (candidate) =>
            Effect.gen(function* () {
              const requiredProgramIdsBefore =
                requiredProgramIdsBeforeByCandidateId.get(candidate.id) ?? new Set<string>()

              const observationRows = yield* tx
                .select({
                  rawPayload: schema.protocolCandidateObservations.rawPayload,
                })
                .from(schema.protocolCandidateObservations)
                .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                .pipe(wrapSyncEngineSqlError(operation))

              const requiredProgramIdsAfter = yield* requiredProgramIdsForCandidate({
                candidate,
                rawPayloads: observationRows.map((row) => row.rawPayload),
              })
              const addedProgramIds = requiredProgramIdsAfter.filter(
                (programId) => !requiredProgramIdsBefore.has(programId)
              )

              if (addedProgramIds.length === 0) {
                return
              }

              const approvedMappingRows = yield* tx
                .select({
                  programId: schema.protocolTransactionTypeMappings.programId,
                })
                .from(schema.protocolTransactionTypeMappings)
                .where(
                  and(
                    eq(schema.protocolTransactionTypeMappings.blockchainId, candidate.blockchainId),
                    inArray(schema.protocolTransactionTypeMappings.programId, addedProgramIds),
                    eq(
                      schema.protocolTransactionTypeMappings.movementPattern,
                      "token_out_and_token_in"
                    ),
                    eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
                  )
                )
                .pipe(wrapSyncEngineSqlError(operation))
              const approvedProgramIds = new Set(approvedMappingRows.map((row) => row.programId))
              const hasUncoveredAddedProgram = addedProgramIds.some(
                (programId) => !approvedProgramIds.has(programId)
              )

              if (!hasUncoveredAddedProgram) {
                return
              }

              yield* tx
                .update(schema.protocolCandidates)
                .set({
                  mappingStatus: "pending_review",
                  updatedAt: now,
                })
                .where(eq(schema.protocolCandidates.id, candidate.id))
                .pipe(wrapSyncEngineSqlError(operation))
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
            .pipe(wrapSyncEngineSqlError(operation))
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
              ? Effect.fail(storageError({ message: "Failed to reload imported candidate." }))
              : Effect.succeed(currentCandidate)
          })

          return {
            candidates: returnedCandidates,
            observationCount: observations.length,
          }
        })
      )
      .pipe(wrapSyncEngineStorageError(operation))

  return ProtocolCandidateRepository.of({
    importObservations,
  } satisfies ProtocolCandidateRepositoryShape)
})

export const ProtocolCandidateRepositoryLive = Layer.effect(ProtocolCandidateRepository, make)
