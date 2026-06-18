/**
 * ProtocolTransactionTypeMappingRepositoryLive - Reviewed protocol mapping persistence.
 *
 * @module ProtocolTransactionTypeMappingRepositoryLive
 */

import { and, count, desc, eq } from "drizzle-orm"
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

            const now = nowDate()
            const [mapping] = yield* tx
              .insert(schema.protocolTransactionTypeMappings)
              .values({
                candidateId: candidate.id,
                blockchainId: candidate.blockchainId,
                programId: params.programId,
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
            .where(eq(schema.protocolTransactionTypeMappings.id, params.mappingId))
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          if (mapping === undefined) {
            return yield* Effect.fail(
              storageError(operation, {
                mappingId: params.mappingId,
                message: "Failed to approve protocol mapping.",
              })
            )
          }

          if (mapping.candidateId !== null) {
            yield* tx
              .update(schema.protocolCandidates)
              .set({
                mappingStatus: "approved",
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
            .where(eq(schema.protocolTransactionTypeMappings.id, params.mappingId))
            .returning()
            .pipe(wrapSyncEngineSqlError(operation))

          return mapping === undefined
            ? yield* Effect.fail(
                storageError(operation, {
                  mappingId: params.mappingId,
                  message: "Failed to reject protocol mapping.",
                })
              )
            : toPersistedMapping(mapping)
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
