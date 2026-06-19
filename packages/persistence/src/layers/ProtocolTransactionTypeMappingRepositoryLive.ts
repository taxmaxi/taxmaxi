/**
 * ProtocolTransactionTypeMappingRepositoryLive - Reviewed protocol mapping persistence.
 *
 * @module ProtocolTransactionTypeMappingRepositoryLive
 */

import { and, count, desc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
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

const ProtocolCandidateObservationPayload = Schema.Struct({
  canonicalProgramIds: Schema.optional(Schema.Array(Schema.String)),
})

const canonicalProgramIdsFromRawPayload = ({
  operation,
  payload,
}: {
  readonly operation: string
  readonly payload: unknown
}) =>
  Schema.decodeUnknown(ProtocolCandidateObservationPayload)(payload).pipe(
    Effect.mapError((cause) =>
      storageError(operation, {
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

const uniqueNonEmptyProgramIds = (programIds: ReadonlyArray<string>) => [
  ...new Set(
    programIds.map((programId) => programId.trim()).filter((programId) => programId.length > 0)
  ),
]

const observedCanonicalProgramIds = ({
  operation,
  rawPayloads,
}: {
  readonly operation: string
  readonly rawPayloads: ReadonlyArray<unknown>
}) =>
  Effect.gen(function* () {
    const observedProgramIdGroups = yield* Effect.forEach(rawPayloads, (payload) =>
      canonicalProgramIdsFromRawPayload({ operation, payload })
    )
    return uniqueNonEmptyProgramIds(observedProgramIdGroups.flat())
  })

const requiredProgramIdsForRuntimeCoverage = ({
  operation,
  candidate,
  rawPayloads,
  fallbackProgramId,
}: {
  readonly operation: string
  readonly candidate: {
    readonly subjectKind: string
    readonly subjectIdentifier: string
  }
  readonly rawPayloads: ReadonlyArray<unknown>
  readonly fallbackProgramId: string
}) =>
  Effect.gen(function* () {
    const canonicalProgramIds = yield* observedCanonicalProgramIds({ operation, rawPayloads })
    const requiredProgramIds = uniqueNonEmptyProgramIds([
      ...(candidate.subjectKind === "program" ? [candidate.subjectIdentifier] : []),
      ...canonicalProgramIds,
    ])

    return requiredProgramIds.length === 0
      ? uniqueNonEmptyProgramIds([fallbackProgramId])
      : requiredProgramIds
  })

const allowedProgramIdsForCandidate = ({
  operation,
  candidate,
  rawPayloads,
}: {
  readonly operation: string
  readonly candidate: {
    readonly subjectKind: string
    readonly subjectIdentifier: string
  }
  readonly rawPayloads: ReadonlyArray<unknown>
}) =>
  Effect.gen(function* () {
    const canonicalProgramIds = yield* observedCanonicalProgramIds({ operation, rawPayloads })
    return uniqueNonEmptyProgramIds([
      ...(candidate.subjectKind === "protocol" ? [] : [candidate.subjectIdentifier]),
      ...canonicalProgramIds,
    ])
  })

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
    yield* validateNonEmptyText({ operation, field: "programId", value: params.programId })
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
  readonly programId: string
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
  programId: row.programId,
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

  const createPendingMappingFromCandidate: ProtocolTransactionTypeMappingRepositoryShape["createPendingMappingFromCandidate"] =
    (params) => {
      const operation = "protocolTransactionTypeMappingRepository.createPendingMappingFromCandidate"

      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* validatePendingMapping(operation, params)

            const [candidate] = yield* tx
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

            if (candidate === undefined) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateId: params.candidateId,
                  message: "Failed to resolve protocol candidate.",
                })
              )
            }

            const observationRows = yield* tx
              .select({
                rawPayload: schema.protocolCandidateObservations.rawPayload,
              })
              .from(schema.protocolCandidateObservations)
              .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
              .pipe(wrapSyncEngineSqlError(operation))
            const allowedProgramIds = yield* allowedProgramIdsForCandidate({
              operation,
              candidate,
              rawPayloads: observationRows.map((row) => row.rawPayload),
            })
            const programId = params.programId.trim()

            if (!allowedProgramIds.includes(programId)) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateId: params.candidateId,
                  programId,
                  message: "Protocol mapping program must belong to the mapped candidate.",
                })
              )
            }

            const now = nowDate()
            const [mapping] = yield* tx
              .insert(schema.protocolTransactionTypeMappings)
              .values({
                candidateId: candidate.id,
                blockchainId: candidate.blockchainId,
                programId,
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

            return mapping === undefined
              ? yield* Effect.fail(
                  storageError(operation, { message: "Failed to create protocol mapping." })
                )
              : toPersistedMapping(mapping)
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

          const [mapping] = yield* tx
            .select({
              candidateId: schema.protocolTransactionTypeMappings.candidateId,
            })
            .from(schema.protocolTransactionTypeMappings)
            .where(eq(schema.protocolTransactionTypeMappings.id, params.mappingId))
            .limit(1)
            .pipe(wrapSyncEngineSqlError(operation))

          if (mapping === undefined) {
            return yield* Effect.fail(
              storageError(operation, {
                mappingId: params.mappingId,
                message: "Failed to resolve protocol mapping.",
              })
            )
          }

          if (params.candidateObservationId !== null) {
            const [observation] = yield* tx
              .select({
                candidateId: schema.protocolCandidateObservations.candidateId,
              })
              .from(schema.protocolCandidateObservations)
              .where(eq(schema.protocolCandidateObservations.id, params.candidateObservationId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError(operation))

            if (observation === undefined) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateObservationId: params.candidateObservationId,
                  message: "Failed to resolve protocol candidate observation.",
                })
              )
            }

            if (mapping.candidateId === null || mapping.candidateId !== observation.candidateId) {
              return yield* Effect.fail(
                storageError(operation, {
                  mappingId: params.mappingId,
                  candidateObservationId: params.candidateObservationId,
                  message: "Protocol mapping evidence must belong to the mapped candidate.",
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

          return evidence === undefined
            ? yield* Effect.fail(
                storageError(operation, { message: "Failed to create protocol mapping evidence." })
              )
            : toPersistedEvidence(evidence)
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

          if (transactionType === undefined) {
            return yield* Effect.fail(
              storageError(operation, {
                transactionTypeKey: params.transactionTypeKey,
                message: "Cannot approve protocol mapping with an unknown transaction type.",
              })
            )
          }

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

          if (mapping === undefined) {
            return yield* Effect.fail(
              storageError(operation, {
                mappingId: params.mappingId,
                message: "Failed to approve pending protocol mapping.",
              })
            )
          }

          if (mapping.candidateId !== null) {
            const [candidate] = yield* tx
              .select({
                subjectKind: schema.protocolCandidates.subjectKind,
                subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
              })
              .from(schema.protocolCandidates)
              .where(eq(schema.protocolCandidates.id, mapping.candidateId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError(operation))

            if (candidate === undefined) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateId: mapping.candidateId,
                  message: "Failed to resolve protocol candidate.",
                })
              )
            }

            const observationRows = yield* tx
              .select({
                rawPayload: schema.protocolCandidateObservations.rawPayload,
              })
              .from(schema.protocolCandidateObservations)
              .where(eq(schema.protocolCandidateObservations.candidateId, mapping.candidateId))
              .pipe(wrapSyncEngineSqlError(operation))

            const programIdsToReview = yield* requiredProgramIdsForRuntimeCoverage({
              operation,
              candidate,
              rawPayloads: observationRows.map((row) => row.rawPayload),
              fallbackProgramId: mapping.programId,
            })

            const approvedMappingRows = yield* tx
              .select({
                programId: schema.protocolTransactionTypeMappings.programId,
              })
              .from(schema.protocolTransactionTypeMappings)
              .where(
                and(
                  eq(schema.protocolTransactionTypeMappings.blockchainId, mapping.blockchainId),
                  inArray(schema.protocolTransactionTypeMappings.programId, programIdsToReview),
                  eq(
                    schema.protocolTransactionTypeMappings.movementPattern,
                    mapping.movementPattern
                  ),
                  eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
                )
              )
              .pipe(wrapSyncEngineSqlError(operation))
            const approvedProgramIds = new Set(approvedMappingRows.map((row) => row.programId))
            const [pendingMappingCount] = yield* tx
              .select({ value: count(schema.protocolTransactionTypeMappings.id) })
              .from(schema.protocolTransactionTypeMappings)
              .where(
                and(
                  eq(schema.protocolTransactionTypeMappings.candidateId, mapping.candidateId),
                  eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
                )
              )
              .pipe(wrapSyncEngineSqlError(operation))
            const hasPendingLinkedMappings = (pendingMappingCount?.value ?? 0) > 0
            const hasApprovedRuntimeCoverage = programIdsToReview.every((programId) =>
              approvedProgramIds.has(programId)
            )
            const nextCandidateStatus =
              !hasPendingLinkedMappings && hasApprovedRuntimeCoverage
                ? "approved"
                : "pending_review"

            yield* tx
              .update(schema.protocolCandidates)
              .set({
                mappingStatus: nextCandidateStatus,
                updatedAt: now,
              })
              .where(eq(schema.protocolCandidates.id, mapping.candidateId))
              .pipe(wrapSyncEngineSqlError(operation))
          }

          return toPersistedMapping(mapping)
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

          const [mapping] = yield* tx
            .update(schema.protocolTransactionTypeMappings)
            .set({
              mappingStatus: "rejected",
              reviewerNotes: params.reviewerNotes,
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(schema.protocolTransactionTypeMappings.id, params.mappingId),
                eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
              )
            )
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          if (mapping === undefined) {
            return yield* Effect.fail(
              storageError(operation, {
                mappingId: params.mappingId,
                message: "Failed to reject pending protocol mapping.",
              })
            )
          }

          if (mapping.candidateId !== null) {
            const now = nowDate()
            const [candidate] = yield* tx
              .select({
                subjectKind: schema.protocolCandidates.subjectKind,
                subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
              })
              .from(schema.protocolCandidates)
              .where(eq(schema.protocolCandidates.id, mapping.candidateId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError(operation))

            if (candidate === undefined) {
              return yield* Effect.fail(
                storageError(operation, {
                  candidateId: mapping.candidateId,
                  message: "Failed to resolve protocol candidate.",
                })
              )
            }

            const observationRows = yield* tx
              .select({
                rawPayload: schema.protocolCandidateObservations.rawPayload,
              })
              .from(schema.protocolCandidateObservations)
              .where(eq(schema.protocolCandidateObservations.candidateId, mapping.candidateId))
              .pipe(wrapSyncEngineSqlError(operation))
            const programIdsToReview = yield* requiredProgramIdsForRuntimeCoverage({
              operation,
              candidate,
              rawPayloads: observationRows.map((row) => row.rawPayload),
              fallbackProgramId: mapping.programId,
            })

            const approvedMappingRows = yield* tx
              .select({
                programId: schema.protocolTransactionTypeMappings.programId,
              })
              .from(schema.protocolTransactionTypeMappings)
              .where(
                and(
                  eq(schema.protocolTransactionTypeMappings.blockchainId, mapping.blockchainId),
                  inArray(schema.protocolTransactionTypeMappings.programId, programIdsToReview),
                  eq(
                    schema.protocolTransactionTypeMappings.movementPattern,
                    mapping.movementPattern
                  ),
                  eq(schema.protocolTransactionTypeMappings.mappingStatus, "approved")
                )
              )
              .pipe(wrapSyncEngineSqlError(operation))
            const approvedProgramIds = new Set(approvedMappingRows.map((row) => row.programId))
            const [pendingMappingCount] = yield* tx
              .select({ value: count(schema.protocolTransactionTypeMappings.id) })
              .from(schema.protocolTransactionTypeMappings)
              .where(
                and(
                  eq(schema.protocolTransactionTypeMappings.candidateId, mapping.candidateId),
                  eq(schema.protocolTransactionTypeMappings.mappingStatus, "pending_review")
                )
              )
              .pipe(wrapSyncEngineSqlError(operation))
            const hasPendingLinkedMappings = (pendingMappingCount?.value ?? 0) > 0
            const hasApprovedRuntimeCoverage = programIdsToReview.every((programId) =>
              approvedProgramIds.has(programId)
            )
            const nextCandidateStatus =
              !hasPendingLinkedMappings && hasApprovedRuntimeCoverage
                ? "approved"
                : "pending_review"

            yield* tx
              .update(schema.protocolCandidates)
              .set({
                mappingStatus: nextCandidateStatus,
                updatedAt: now,
              })
              .where(eq(schema.protocolCandidates.id, mapping.candidateId))
              .pipe(wrapSyncEngineSqlError(operation))
          }

          return toPersistedMapping(mapping)
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
            eq(schema.protocolTransactionTypeMappings.programId, params.programId),
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
