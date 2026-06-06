/**
 * ProtocolCandidateRepositoryLive - Protocol candidate review queue persistence.
 *
 * @module ProtocolCandidateRepositoryLive
 */

import { sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  ProtocolCandidateRepository,
  SyncEngineStorageError,
  type DuneProtocolCandidateObservationDraft,
  type PersistedProtocolCandidate,
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

const operation = "protocolCandidateRepository.importDuneObservations"

const failInvalidObservation = ({
  field,
  message,
}: {
  readonly field: string
  readonly message: string
}) =>
  Effect.fail(
    new SyncEngineStorageError({
      operation,
      cause: {
        field,
        message,
      },
    })
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
    ? failInvalidObservation({ field, message: `${field} must not be empty.` })
    : Effect.void

const validateSafeCount = ({ field, value }: { readonly field: string; readonly value: number }) =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.void
    : failInvalidObservation({ field, message: `${field} must be a non-negative safe integer.` })

const validateNullableSafeCount = ({
  field,
  value,
}: {
  readonly field: string
  readonly value: number | null
}) => (value === null ? Effect.void : validateSafeCount({ field, value }))

const validateObservation = (observation: DuneProtocolCandidateObservationDraft) =>
  Effect.gen(function* () {
    yield* validateNonEmptyText({
      field: "subjectIdentifier",
      value: observation.subjectIdentifier,
    })
    yield* validateNonEmptyText({ field: "queryName", value: observation.queryName })
    yield* validateSafeCount({ field: "interactionCount", value: observation.interactionCount })
    yield* validateNullableSafeCount({
      field: "transactionCount",
      value: observation.transactionCount,
    })
    yield* validateNullableSafeCount({
      field: "uniqueActorCount",
      value: observation.uniqueActorCount,
    })
    yield* validateSafeCount({ field: "queryId", value: observation.queryId })
    yield* validateSafeCount({ field: "queryVersion", value: observation.queryVersion })

    if (!isValidDate(observation.observedWindowStart)) {
      yield* failInvalidObservation({
        field: "observedWindowStart",
        message: "observedWindowStart must be a valid date.",
      })
    }

    if (!isValidDate(observation.observedWindowEnd)) {
      yield* failInvalidObservation({
        field: "observedWindowEnd",
        message: "observedWindowEnd must be a valid date.",
      })
    }

    if (observation.observedWindowStart >= observation.observedWindowEnd) {
      yield* failInvalidObservation({
        field: "observedWindowEnd",
        message: "observedWindowEnd must be after observedWindowStart.",
      })
    }

    if (!isValidDate(observation.retrievedAt)) {
      yield* failInvalidObservation({
        field: "retrievedAt",
        message: "retrievedAt must be a valid date.",
      })
    }
  })

const makeDuneSourceObservationKey = (observation: DuneProtocolCandidateObservationDraft): string =>
  [
    observation.queryId,
    observation.queryVersion,
    observation.observedWindowStart.toISOString(),
    observation.observedWindowEnd.toISOString(),
  ].join(":")

const numericValue = (value: number | null): string | null =>
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
        new SyncEngineStorageError({
          operation,
          cause: {
            subjectKind,
            message: "Persisted protocol candidate has an unknown subject kind.",
          },
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

  const importDuneObservations: ProtocolCandidateRepositoryShape["importDuneObservations"] = ({
    observations,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (observations.length === 0) {
            return {
              candidates: [],
              observationCount: 0,
            }
          }

          yield* Effect.forEach(observations, validateObservation, { discard: true })

          const now = nowDate()
          const candidates = yield* Effect.forEach(observations, (observation) =>
            tx
              .insert(schema.protocolCandidates)
              .values({
                blockchainId: observation.blockchainId,
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
                        new SyncEngineStorageError({
                          operation,
                          cause: {
                            message: "Failed to upsert protocol candidate.",
                          },
                        })
                      )
                    : toPersistedCandidate(rows[0])
                ),
                wrapSyncEngineSqlError(operation)
              )
          )

          yield* Effect.forEach(
            observations,
            (observation, index) =>
              Effect.gen(function* () {
                const candidate = candidates[index]
                if (candidate === undefined) {
                  yield* Effect.fail(
                    new SyncEngineStorageError({
                      operation,
                      cause: {
                        message: "Missing imported candidate for observation.",
                      },
                    })
                  )
                  return
                }

                const sourceObservationKey = makeDuneSourceObservationKey(observation)
                const [persistedObservation] = yield* tx
                  .insert(schema.protocolCandidateObservations)
                  .values({
                    candidateId: candidate.id,
                    source: "dune",
                    sourceObservationKey,
                    observedWindowStart: observation.observedWindowStart,
                    observedWindowEnd: observation.observedWindowEnd,
                    interactionCount: String(observation.interactionCount),
                    transactionCount: numericValue(observation.transactionCount),
                    uniqueActorCount: numericValue(observation.uniqueActorCount),
                    sampleTransactionHashes: [...observation.sampleTransactionHashes],
                    retrievedAt: observation.retrievedAt,
                    rawPayload: observation.rawPayload,
                    createdAt: now,
                  })
                  .onConflictDoUpdate({
                    target: [
                      schema.protocolCandidateObservations.candidateId,
                      schema.protocolCandidateObservations.source,
                      schema.protocolCandidateObservations.sourceObservationKey,
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
                  yield* Effect.fail(
                    new SyncEngineStorageError({
                      operation,
                      cause: {
                        message: "Failed to upsert protocol candidate observation.",
                      },
                    })
                  )
                  return
                }

                yield* tx
                  .insert(schema.duneProtocolCandidateObservations)
                  .values({
                    observationId: persistedObservation.id,
                    queryId: observation.queryId,
                    queryName: observation.queryName,
                    queryVersion: observation.queryVersion,
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

          return {
            candidates,
            observationCount: observations.length,
          }
        })
      )
      .pipe(wrapSyncEngineStorageError(operation))

  return ProtocolCandidateRepository.of({
    importDuneObservations,
  } satisfies ProtocolCandidateRepositoryShape)
})

export const ProtocolCandidateRepositoryLive = Layer.effect(ProtocolCandidateRepository, make)
