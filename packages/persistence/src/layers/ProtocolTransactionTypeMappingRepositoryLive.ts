/**
 * ProtocolTransactionTypeMappingRepositoryLive - Reviewed protocol mapping persistence.
 *
 * @module ProtocolTransactionTypeMappingRepositoryLive
 */

import { and, count, desc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProtocolTransactionTypeMappingRepository,
  SyncEngineStorageError,
  type AddProtocolMappingEvidenceParams,
  type CreatePendingProtocolMappingFromCandidateParams,
  type PersistedProtocolMappingEvidence,
  type PersistedProtocolTransactionTypeMapping,
  type ProtocolTransactionTypeMappingRepositoryShape,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import {
  nowDate,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const storageError = (operation: string, cause: unknown) =>
  new SyncEngineStorageError({
    operation,
    cause,
  })

const invalidInput = ({
  operation,
  field,
  message,
}: {
  readonly operation: string
  readonly field: string
  readonly message: string
}) => Effect.fail(storageError(operation, { field, message }))

const uniqueNonEmptySubjectIdentifiers = (subjectIdentifiers: ReadonlyArray<string>) => [
  ...new Set(
    subjectIdentifiers
      .map((subjectIdentifier) => subjectIdentifier.trim())
      .filter((subjectIdentifier) => subjectIdentifier.length > 0)
  ),
]

const requiredSubjectIdentifiersForCoverage = ({
  candidate,
  relatedSubjectIdentifierGroups,
  fallbackSubjectIdentifier,
}: {
  readonly candidate: {
    readonly subjectKind: string
    readonly subjectIdentifier: string
  }
  readonly relatedSubjectIdentifierGroups: ReadonlyArray<ReadonlyArray<string>>
  readonly fallbackSubjectIdentifier: string
}) => {
  const requiredSubjectIdentifiers = uniqueNonEmptySubjectIdentifiers([
    // Protocol candidate identifiers are slugs; program/contract identifiers are chain subjects.
    ...(candidate.subjectKind === "protocol" ? [] : [candidate.subjectIdentifier]),
    ...relatedSubjectIdentifierGroups.flat(),
  ])

  return requiredSubjectIdentifiers.length === 0
    ? uniqueNonEmptySubjectIdentifiers([fallbackSubjectIdentifier])
    : requiredSubjectIdentifiers
}

const allowedSubjectIdentifiersForCandidate = ({
  candidate,
  relatedSubjectIdentifierGroups,
}: {
  readonly candidate: {
    readonly subjectKind: string
    readonly subjectIdentifier: string
  }
  readonly relatedSubjectIdentifierGroups: ReadonlyArray<ReadonlyArray<string>>
}) =>
  uniqueNonEmptySubjectIdentifiers([
    // Protocol candidate identifiers are slugs; program/contract identifiers are chain subjects.
    ...(candidate.subjectKind === "protocol" ? [] : [candidate.subjectIdentifier]),
    ...relatedSubjectIdentifierGroups.flat(),
  ])

const validateNonEmptyText = ({
  operation,
  field,
  value,
}: {
  readonly operation: string
  readonly field: string
  readonly value: string
}) =>
  value.trim().length === 0
    ? invalidInput({ operation, field, message: `${field} must not be empty.` })
    : Effect.succeed(void 0)

const requireRow = <A>({
  row,
  operation,
  cause,
}: {
  readonly row: A | undefined
  readonly operation: string
  readonly cause: unknown
}) => (row === undefined ? Effect.fail(storageError(operation, cause)) : Effect.succeed(row))

const validateConfidence = ({
  operation,
  confidence,
}: {
  readonly operation: string
  readonly confidence: string
}) => {
  const parsedConfidence = Number(confidence)
  return Number.isFinite(parsedConfidence) && parsedConfidence >= 0 && parsedConfidence <= 1
    ? Effect.succeed(void 0)
    : invalidInput({
        operation,
        field: "confidence",
        message: "confidence must be a decimal value between 0 and 1.",
      })
}

const validateVersion = ({
  operation,
  version,
}: {
  readonly operation: string
  readonly version: number
}) =>
  Number.isSafeInteger(version) && version > 0
    ? Effect.succeed(void 0)
    : invalidInput({
        operation,
        field: "version",
        message: "version must be a positive safe integer.",
      })

const validatePendingMapping = (
  operation: string,
  params: CreatePendingProtocolMappingFromCandidateParams
) =>
  Effect.gen(function* () {
    yield* validateNonEmptyText({ operation, field: "candidateId", value: params.candidateId })
    yield* validateNonEmptyText({
      operation,
      field: "subjectIdentifier",
      value: params.subjectIdentifier,
    })
    yield* validateNonEmptyText({ operation, field: "protocolName", value: params.protocolName })
    yield* validateConfidence({ operation, confidence: params.confidence })
    yield* validateVersion({ operation, version: params.version })
  })

const validateEvidence = (operation: string, params: AddProtocolMappingEvidenceParams) =>
  Effect.gen(function* () {
    yield* validateNonEmptyText({ operation, field: "mappingId", value: params.mappingId })
    if (params.sampleSignature !== null) {
      yield* validateNonEmptyText({
        operation,
        field: "sampleSignature",
        value: params.sampleSignature,
      })
    }
  })

const toPersistedMapping = (row: {
  readonly id: string
  readonly candidateId: string | null
  readonly blockchainId: string
  readonly subjectIdentifier: string
  readonly protocolName: string
  readonly movementPattern: "token_out_and_token_in"
  readonly transactionTypeKey: string | null
  readonly inventoryEffect:
    | "acquisition"
    | "disposal"
    | "income"
    | "internal_transfer"
    | "non_inventory"
    | "unknown"
  readonly taxTreatment:
    | "taxable_by_default"
    | "non_taxable_by_default"
    | "requires_additional_rule_logic"
  readonly confidence: string
  readonly mappingStatus: "approved" | "pending_review" | "rejected"
  readonly version: number
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): PersistedProtocolTransactionTypeMapping => ({
  id: row.id,
  candidateId: row.candidateId,
  blockchainId: row.blockchainId,
  subjectIdentifier: row.subjectIdentifier,
  protocolName: row.protocolName,
  movementPattern: row.movementPattern,
  transactionTypeKey: row.transactionTypeKey,
  inventoryEffect: row.inventoryEffect,
  taxTreatment: row.taxTreatment,
  confidence: row.confidence,
  mappingStatus: row.mappingStatus,
  version: row.version,
  reviewerNotes: row.reviewerNotes,
  sourceNotes: row.sourceNotes,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const toPersistedEvidence = (row: {
  readonly id: string
  readonly mappingId: string
  readonly candidateObservationId: string | null
  readonly evidenceKind:
    | "sample_signature"
    | "normalized_fixture"
    | "dune_observation"
    | "review_note"
  readonly sampleSignature: string | null
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
}): PersistedProtocolMappingEvidence => ({
  id: row.id,
  mappingId: row.mappingId,
  candidateObservationId: row.candidateObservationId,
  evidenceKind: row.evidenceKind,
  sampleSignature: row.sampleSignature,
  payload: row.payload,
  createdAt: row.createdAt,
})

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  const updateLinkedCandidateMappingStatus = ({
    tx,
    operation,
    mapping,
    updatedAt,
  }: {
    readonly tx: Transaction
    readonly operation: string
    readonly mapping: {
      readonly candidateId: string | null
      readonly blockchainId: string
      readonly subjectIdentifier: string
      readonly movementPattern: "token_out_and_token_in"
    }
    readonly updatedAt: Date
  }) => {
    const candidateId = mapping.candidateId
    return candidateId === null
      ? Effect.void
      : Effect.gen(function* () {
          const [candidateRow] = yield* tx
            .select({
              subjectKind: schema.protocolCandidates.subjectKind,
              subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
            })
            .from(schema.protocolCandidates)
            .where(eq(schema.protocolCandidates.id, candidateId))
            .limit(1)
            .pipe(wrapSyncEngineSqlError(operation))

          const candidate = yield* requireRow({
            row: candidateRow,
            operation,
            cause: {
              candidateId,
              message: "Failed to resolve protocol candidate.",
            },
          })

          const observationRows = yield* tx
            .select({
              relatedSubjectIdentifiers:
                schema.protocolCandidateObservations.relatedSubjectIdentifiers,
            })
            .from(schema.protocolCandidateObservations)
            .where(eq(schema.protocolCandidateObservations.candidateId, candidateId))
            .pipe(wrapSyncEngineSqlError(operation))

          const subjectIdentifiersToReview = requiredSubjectIdentifiersForCoverage({
            candidate,
            relatedSubjectIdentifierGroups: observationRows.map(
              (row) => row.relatedSubjectIdentifiers
            ),
            fallbackSubjectIdentifier: mapping.subjectIdentifier,
          })

          const approvedMappingRows = yield* tx
            .select({
              subjectIdentifier: schema.protocolTransactionTypeMappings.subjectIdentifier,
            })
            .from(schema.protocolTransactionTypeMappings)
            .where(
              and(
                eq(schema.protocolTransactionTypeMappings.blockchainId, mapping.blockchainId),
                inArray(
                  schema.protocolTransactionTypeMappings.subjectIdentifier,
                  subjectIdentifiersToReview
                ),
                eq(schema.protocolTransactionTypeMappings.movementPattern, mapping.movementPattern),
                eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
              )
            )
            .pipe(wrapSyncEngineSqlError(operation))

          const approvedSubjectIdentifiers = new Set(
            approvedMappingRows.map((row) => row.subjectIdentifier)
          )

          const [pendingMappingCount] = yield* tx
            .select({ value: count(schema.protocolTransactionTypeMappings.id) })
            .from(schema.protocolTransactionTypeMappings)
            .where(
              and(
                eq(schema.protocolTransactionTypeMappings.candidateId, candidateId),
                eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
              )
            )
            .pipe(wrapSyncEngineSqlError(operation))

          const hasPendingLinkedMappings = (pendingMappingCount?.value ?? 0) > 0

          const hasApprovedSubjectCoverage = subjectIdentifiersToReview.every((subjectIdentifier) =>
            approvedSubjectIdentifiers.has(subjectIdentifier)
          )

          const nextCandidateStatus =
            !hasPendingLinkedMappings && hasApprovedSubjectCoverage ? "approved" : "pending_review"

          yield* tx
            .update(schema.protocolCandidates)
            .set({
              mappingStatus: nextCandidateStatus,
              updatedAt,
            })
            .where(eq(schema.protocolCandidates.id, candidateId))
            .pipe(wrapSyncEngineSqlError(operation))
        })
  }

  const createPendingMappingFromCandidate: ProtocolTransactionTypeMappingRepositoryShape["createPendingMappingFromCandidate"] =
    (params) => {
      const operation = "protocolTransactionTypeMappingRepository.createPendingMappingFromCandidate"

      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* validatePendingMapping(operation, params)

            const [candidateRow] = yield* tx
              .select({
                id: schema.protocolCandidates.id,
                blockchainId: schema.protocolCandidates.blockchainId,
                subjectKind: schema.protocolCandidates.subjectKind,
                subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
              })
              .from(schema.protocolCandidates)
              .where(eq(schema.protocolCandidates.id, params.candidateId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError(operation))

            const candidate = yield* requireRow({
              row: candidateRow,
              operation,
              cause: {
                candidateId: params.candidateId,
                message: "Failed to resolve protocol candidate.",
              },
            })

            const observationRows = yield* tx
              .select({
                relatedSubjectIdentifiers:
                  schema.protocolCandidateObservations.relatedSubjectIdentifiers,
              })
              .from(schema.protocolCandidateObservations)
              .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
              .pipe(wrapSyncEngineSqlError(operation))
            const allowedSubjectIdentifiers = allowedSubjectIdentifiersForCandidate({
              candidate,
              relatedSubjectIdentifierGroups: observationRows.map(
                (row) => row.relatedSubjectIdentifiers
              ),
            })
            const subjectIdentifier = params.subjectIdentifier.trim()

            if (!allowedSubjectIdentifiers.includes(subjectIdentifier)) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateId: params.candidateId,
                  subjectIdentifier,
                  message: "Protocol mapping subject must belong to the mapped candidate.",
                })
              )
            }

            const now = nowDate()
            const [mapping] = yield* tx
              .insert(schema.protocolTransactionTypeMappings)
              .values({
                candidateId: candidate.id,
                blockchainId: candidate.blockchainId,
                subjectIdentifier,
                protocolName: params.protocolName,
                movementPattern: params.movementPattern,
                transactionTypeKey: params.transactionTypeKey,
                inventoryEffect: params.inventoryEffect,
                taxTreatment: params.taxTreatment,
                confidence: params.confidence,
                mappingStatus: "pending_review",
                version: params.version,
                reviewerNotes: params.reviewerNotes,
                sourceNotes: params.sourceNotes,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .pipe(wrapSyncEngineSqlError(operation))

            yield* tx
              .update(schema.protocolCandidates)
              .set({
                mappingStatus: "pending_review",
                updatedAt: now,
              })
              .where(eq(schema.protocolCandidates.id, candidate.id))
              .pipe(wrapSyncEngineSqlError(operation))

            return toPersistedMapping(
              yield* requireRow({
                row: mapping,
                operation,
                cause: { message: "Failed to create protocol mapping." },
              })
            )
          })
        )
        .pipe(wrapSyncEngineStorageError(operation))
    }

  const addEvidence: ProtocolTransactionTypeMappingRepositoryShape["addEvidence"] = (params) => {
    const operation = "protocolTransactionTypeMappingRepository.addEvidence"

    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* validateEvidence(operation, params)

          const [mappingRow] = yield* tx
            .select({
              candidateId: schema.protocolTransactionTypeMappings.candidateId,
              subjectIdentifier: schema.protocolTransactionTypeMappings.subjectIdentifier,
            })
            .from(schema.protocolTransactionTypeMappings)
            .where(eq(schema.protocolTransactionTypeMappings.id, params.mappingId))
            .limit(1)
            .pipe(wrapSyncEngineSqlError(operation))

          const mapping = yield* requireRow({
            row: mappingRow,
            operation,
            cause: {
              mappingId: params.mappingId,
              message: "Failed to resolve protocol mapping.",
            },
          })

          if (params.candidateObservationId !== null) {
            const [observationRow] = yield* tx
              .select({
                candidateId: schema.protocolCandidateObservations.candidateId,
                relatedSubjectIdentifiers:
                  schema.protocolCandidateObservations.relatedSubjectIdentifiers,
                subjectKind: schema.protocolCandidates.subjectKind,
                subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
              })
              .from(schema.protocolCandidateObservations)
              .innerJoin(
                schema.protocolCandidates,
                eq(schema.protocolCandidateObservations.candidateId, schema.protocolCandidates.id)
              )
              .where(eq(schema.protocolCandidateObservations.id, params.candidateObservationId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError(operation))

            const observation = yield* requireRow({
              row: observationRow,
              operation,
              cause: {
                candidateObservationId: params.candidateObservationId,
                message: "Failed to resolve protocol candidate observation.",
              },
            })

            if (mapping.candidateId === null || mapping.candidateId !== observation.candidateId) {
              return yield* Effect.fail(
                storageError(operation, {
                  mappingId: params.mappingId,
                  candidateObservationId: params.candidateObservationId,
                  message: "Protocol mapping evidence must belong to the mapped candidate.",
                })
              )
            }

            const coveredSubjectIdentifiers = allowedSubjectIdentifiersForCandidate({
              candidate: observation,
              relatedSubjectIdentifierGroups: [observation.relatedSubjectIdentifiers],
            })

            if (!coveredSubjectIdentifiers.includes(mapping.subjectIdentifier)) {
              return yield* Effect.fail(
                storageError(operation, {
                  mappingId: params.mappingId,
                  candidateObservationId: params.candidateObservationId,
                  subjectIdentifier: mapping.subjectIdentifier,
                  message: "Protocol mapping evidence must cover the mapped subject.",
                })
              )
            }
          }

          const now = nowDate()
          const [evidence] = yield* tx
            .insert(schema.protocolMappingEvidence)
            .values({
              mappingId: params.mappingId,
              candidateObservationId: params.candidateObservationId,
              evidenceKind: params.evidenceKind,
              sampleSignature: params.sampleSignature,
              payload: params.payload,
              createdAt: now,
            })
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          return toPersistedEvidence(
            yield* requireRow({
              row: evidence,
              operation,
              cause: { message: "Failed to create protocol mapping evidence." },
            })
          )
        })
      )
      .pipe(wrapSyncEngineStorageError(operation))
  }

  const approveMapping: ProtocolTransactionTypeMappingRepositoryShape["approveMapping"] = (
    params
  ) => {
    const operation = "protocolTransactionTypeMappingRepository.approveMapping"

    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* validateNonEmptyText({
            operation,
            field: "mappingId",
            value: params.mappingId,
          })
          yield* validateNonEmptyText({
            operation,
            field: "transactionTypeKey",
            value: params.transactionTypeKey,
          })

          const [transactionType] = yield* tx
            .select({ typeKey: schema.transactionTypes.typeKey })
            .from(schema.transactionTypes)
            .where(eq(schema.transactionTypes.typeKey, params.transactionTypeKey))
            .limit(1)
            .pipe(wrapSyncEngineSqlError(operation))

          yield* requireRow({
            row: transactionType,
            operation,
            cause: {
              transactionTypeKey: params.transactionTypeKey,
              message: "Cannot approve protocol mapping with an unknown transaction type.",
            },
          })

          const [evidenceCount] = yield* tx
            .select({ value: count(schema.protocolMappingEvidence.id) })
            .from(schema.protocolMappingEvidence)
            .where(eq(schema.protocolMappingEvidence.mappingId, params.mappingId))
            .pipe(wrapSyncEngineSqlError(operation))

          if ((evidenceCount?.value ?? 0) < 1) {
            return yield* Effect.fail(
              storageError(operation, {
                mappingId: params.mappingId,
                message: "Cannot approve protocol mapping without evidence.",
              })
            )
          }

          const now = nowDate()
          const [mapping] = yield* tx
            .update(schema.protocolTransactionTypeMappings)
            .set({
              transactionTypeKey: params.transactionTypeKey,
              mappingStatus: "approved",
              reviewerNotes: params.reviewerNotes,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.protocolTransactionTypeMappings.id, params.mappingId),
                eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
              )
            )
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          const approvedMapping = yield* requireRow({
            row: mapping,
            operation,
            cause: {
              mappingId: params.mappingId,
              message: "Failed to approve pending protocol mapping.",
            },
          })

          yield* updateLinkedCandidateMappingStatus({
            tx,
            operation,
            mapping: approvedMapping,
            updatedAt: now,
          })

          return toPersistedMapping(approvedMapping)
        })
      )
      .pipe(wrapSyncEngineStorageError(operation))
  }

  const rejectMapping: ProtocolTransactionTypeMappingRepositoryShape["rejectMapping"] = (
    params
  ) => {
    const operation = "protocolTransactionTypeMappingRepository.rejectMapping"

    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* validateNonEmptyText({
            operation,
            field: "mappingId",
            value: params.mappingId,
          })

          const now = nowDate()
          const [mapping] = yield* tx
            .update(schema.protocolTransactionTypeMappings)
            .set({
              mappingStatus: "rejected",
              reviewerNotes: params.reviewerNotes,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.protocolTransactionTypeMappings.id, params.mappingId),
                eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
              )
            )
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          const rejectedMapping = yield* requireRow({
            row: mapping,
            operation,
            cause: {
              mappingId: params.mappingId,
              message: "Failed to reject pending protocol mapping.",
            },
          })

          yield* updateLinkedCandidateMappingStatus({
            tx,
            operation,
            mapping: rejectedMapping,
            updatedAt: now,
          })

          return toPersistedMapping(rejectedMapping)
        })
      )
      .pipe(wrapSyncEngineStorageError(operation))
  }

  const findLatestApprovedMapping: ProtocolTransactionTypeMappingRepositoryShape["findLatestApprovedMapping"] =
    (params) => {
      const operation = "protocolTransactionTypeMappingRepository.findLatestApprovedMapping"

      return db
        .select()
        .from(schema.protocolTransactionTypeMappings)
        .where(
          and(
            eq(schema.protocolTransactionTypeMappings.blockchainId, params.blockchainId),
            eq(schema.protocolTransactionTypeMappings.subjectIdentifier, params.subjectIdentifier),
            eq(schema.protocolTransactionTypeMappings.movementPattern, params.movementPattern),
            eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
          )
        )
        .orderBy(desc(schema.protocolTransactionTypeMappings.version))
        .limit(1)
        .pipe(
          Effect.map((rows) =>
            rows[0] === undefined ? Option.none() : Option.some(toPersistedMapping(rows[0]))
          ),
          wrapSyncEngineSqlError(operation),
          wrapSyncEngineStorageError(operation)
        )
    }

  return ProtocolTransactionTypeMappingRepository.of({
    createPendingMappingFromCandidate,
    addEvidence,
    approveMapping,
    rejectMapping,
    findLatestApprovedMapping,
  } satisfies ProtocolTransactionTypeMappingRepositoryShape)
})

export const ProtocolTransactionTypeMappingRepositoryLive = Layer.effect(
  ProtocolTransactionTypeMappingRepository,
  make
)
