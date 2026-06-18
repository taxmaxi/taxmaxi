import { count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { ProtocolTransactionTypeMappingRepositoryLive } from "../../src/layers/ProtocolTransactionTypeMappingRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  ProtocolTransactionTypeMappingRepository,
  SyncEngineStorageError,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_protocol_mapping_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(
  effect: Effect.Effect<A, E, ProtocolTransactionTypeMappingRepository>
) =>
  Effect.runPromise(
    context.runWithLayer({ effect, layer: ProtocolTransactionTypeMappingRepositoryLive })
  )

const insertCandidateWithObservation = ({
  programId = "reviewed-program-1",
}: {
  readonly programId?: string
} = {}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [blockchain] = yield* db
        .select({ id: schema.blockchains.id })
        .from(schema.blockchains)
        .where(eq(schema.blockchains.name, "solana"))
        .limit(1)

      if (blockchain === undefined) {
        return yield* Effect.dieMessage("Missing seeded solana blockchain fixture")
      }

      const now = new Date("2026-06-01T10:00:00.000Z")
      const [candidate] = yield* db
        .insert(schema.protocolCandidates)
        .values({
          blockchainId: blockchain.id,
          subjectKind: "program",
          subjectIdentifier: programId,
          protocolNameHint: "Example DEX",
          categoryHint: "swap",
          mappingStatus: "pending_review",
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: schema.protocolCandidates.id,
          blockchainId: schema.protocolCandidates.blockchainId,
        })

      if (candidate === undefined) {
        return yield* Effect.dieMessage("Failed to create protocol candidate fixture")
      }

      const [observation] = yield* db
        .insert(schema.protocolCandidateObservations)
        .values({
          candidateId: candidate.id,
          onchainDataSource: "dune",
          onchainDataSourceObservationKey: `fixture:${programId}`,
          observedWindowStart: new Date("2026-01-01T00:00:00.000Z"),
          observedWindowEnd: new Date("2026-02-01T00:00:00.000Z"),
          interactionCount: "100",
          transactionCount: "80",
          uniqueActorCount: "20",
          sampleTransactionHashes: ["sample-signature-1"],
          retrievedAt: now,
          rawPayload: { program_id: programId },
          createdAt: now,
        })
        .returning({ id: schema.protocolCandidateObservations.id })

      if (observation === undefined) {
        return yield* Effect.dieMessage("Failed to create protocol observation fixture")
      }

      return {
        blockchainId: blockchain.id,
        candidateId: candidate.id,
        observationId: observation.id,
        programId,
      }
    })
  )

describe("ProtocolTransactionTypeMappingRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("creates a candidate-backed pending mapping and approves it with linked evidence", async () => {
    const fixture = await insertCandidateWithObservation()

    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          programId: fixture.programId,
          protocolName: "Example DEX",
          movementPattern: "token_out_and_token_in",
          transactionTypeKey: null,
          inventoryEffect: "disposal",
          taxTreatment: "taxable_by_default",
          confidence: "0.9500",
          version: 1,
          reviewerNotes: null,
          sourceNotes: "Dune candidate review",
        })
      )
    )

    const runtimeBeforeApproval = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.findLatestApprovedMapping({
          blockchainId: fixture.blockchainId,
          programId: fixture.programId,
          movementPattern: "token_out_and_token_in",
        })
      )
    )

    const evidence = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.addEvidence({
          mappingId: pendingMapping.id,
          candidateObservationId: fixture.observationId,
          evidenceKind: "dune_observation",
          sampleSignature: "sample-signature-1",
          payload: { source: "dune", queryId: 7_647_495 },
        })
      )
    )

    const approvedMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.approveMapping({
          mappingId: pendingMapping.id,
          transactionTypeKey: "swap_crypto_to_crypto",
          reviewerNotes: "Reviewed fixture",
        })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        const [evidenceRow] = yield* db
          .select({
            candidateObservationId: schema.protocolMappingEvidence.candidateObservationId,
            evidenceKind: schema.protocolMappingEvidence.evidenceKind,
            sampleSignature: schema.protocolMappingEvidence.sampleSignature,
          })
          .from(schema.protocolMappingEvidence)
          .where(eq(schema.protocolMappingEvidence.id, evidence.id))
          .limit(1)

        return { candidate, evidenceRow }
      })
    )

    expect(pendingMapping).toMatchObject({
      candidateId: fixture.candidateId,
      blockchainId: fixture.blockchainId,
      programId: fixture.programId,
      movementPattern: "token_out_and_token_in",
      transactionTypeKey: null,
      mappingStatus: "pending_review",
      confidence: "0.9500",
    })
    expect(Option.isNone(runtimeBeforeApproval)).toBe(true)
    expect(approvedMapping).toMatchObject({
      id: pendingMapping.id,
      transactionTypeKey: "swap_crypto_to_crypto",
      mappingStatus: "approved",
      reviewerNotes: "Reviewed fixture",
    })
    expect(rows.candidate).toMatchObject({ mappingStatus: "approved" })
    expect(rows.evidenceRow).toMatchObject({
      candidateObservationId: fixture.observationId,
      evidenceKind: "dune_observation",
      sampleSignature: "sample-signature-1",
    })
  })

  it("rejects a mapping without deleting the candidate or Dune observations", async () => {
    const fixture = await insertCandidateWithObservation({ programId: "rejected-program-1" })

    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          programId: fixture.programId,
          protocolName: "Rejected DEX",
          movementPattern: "token_out_and_token_in",
          transactionTypeKey: null,
          inventoryEffect: "unknown",
          taxTreatment: "requires_additional_rule_logic",
          confidence: "0.5000",
          version: 1,
          reviewerNotes: null,
          sourceNotes: null,
        })
      )
    )

    const rejectedMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.rejectMapping({
          mappingId: pendingMapping.id,
          reviewerNotes: "Not enough normalized fixture evidence",
        })
      )
    )

    const runtimeMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.findLatestApprovedMapping({
          blockchainId: fixture.blockchainId,
          programId: fixture.programId,
          movementPattern: "token_out_and_token_in",
        })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)
        const [observationCount] = yield* db
          .select({ value: count(schema.protocolCandidateObservations.id) })
          .from(schema.protocolCandidateObservations)
          .where(eq(schema.protocolCandidateObservations.candidateId, fixture.candidateId))

        return {
          candidate,
          observationCount: observationCount?.value ?? 0,
        }
      })
    )

    expect(rejectedMapping).toMatchObject({
      id: pendingMapping.id,
      mappingStatus: "rejected",
      reviewerNotes: "Not enough normalized fixture evidence",
    })
    expect(Option.isNone(runtimeMapping)).toBe(true)
    expect(rows.candidate).toMatchObject({ mappingStatus: "pending_review" })
    expect(rows.observationCount).toBe(1)
  })

  it("does not approve a mapping without evidence", async () => {
    const fixture = await insertCandidateWithObservation({ programId: "missing-evidence-program" })
    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          programId: fixture.programId,
          protocolName: "Missing Evidence DEX",
          movementPattern: "token_out_and_token_in",
          transactionTypeKey: null,
          inventoryEffect: "disposal",
          taxTreatment: "taxable_by_default",
          confidence: "0.9000",
          version: 1,
          reviewerNotes: null,
          sourceNotes: null,
        })
      )
    )

    const approvalResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.approveMapping({
            mappingId: pendingMapping.id,
            transactionTypeKey: "swap_crypto_to_crypto",
            reviewerNotes: "No evidence",
          })
        )
      )
    )

    expect(approvalResult._tag).toBe("Left")
    if (approvalResult._tag === "Right") {
      expect.fail("Expected approval without evidence to fail")
    }
    expect(approvalResult.left).toBeInstanceOf(SyncEngineStorageError)
  })

  it("does not approve a mapping with an unknown transaction type", async () => {
    const fixture = await insertCandidateWithObservation({ programId: "unknown-type-program" })
    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          programId: fixture.programId,
          protocolName: "Unknown Type DEX",
          movementPattern: "token_out_and_token_in",
          transactionTypeKey: null,
          inventoryEffect: "disposal",
          taxTreatment: "taxable_by_default",
          confidence: "0.9000",
          version: 1,
          reviewerNotes: null,
          sourceNotes: null,
        })
      )
    )

    await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.addEvidence({
          mappingId: pendingMapping.id,
          candidateObservationId: fixture.observationId,
          evidenceKind: "sample_signature",
          sampleSignature: "sample-signature-1",
          payload: { signature: "sample-signature-1" },
        })
      )
    )

    const approvalResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.approveMapping({
            mappingId: pendingMapping.id,
            transactionTypeKey: "missing_transaction_type",
            reviewerNotes: "Unknown type",
          })
        )
      )
    )

    expect(approvalResult._tag).toBe("Left")
    if (approvalResult._tag === "Right") {
      expect.fail("Expected approval with unknown transaction type to fail")
    }
    expect(approvalResult.left).toBeInstanceOf(SyncEngineStorageError)
  })

  it("returns the latest approved version for runtime lookup", async () => {
    const fixture = await insertCandidateWithObservation({ programId: "versioned-program" })

    const createApproveMapping = (version: number) =>
      runRepository(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          Effect.gen(function* () {
            const mapping = yield* repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              programId: fixture.programId,
              protocolName: "Versioned DEX",
              movementPattern: "token_out_and_token_in",
              transactionTypeKey: null,
              inventoryEffect: "disposal",
              taxTreatment: "taxable_by_default",
              confidence: version === 1 ? "0.9000" : "0.9900",
              version,
              reviewerNotes: null,
              sourceNotes: null,
            })
            yield* repository.addEvidence({
              mappingId: mapping.id,
              candidateObservationId: fixture.observationId,
              evidenceKind: "normalized_fixture",
              sampleSignature: `version-${version}-signature`,
              payload: { version },
            })
            return yield* repository.approveMapping({
              mappingId: mapping.id,
              transactionTypeKey: "swap_crypto_to_crypto",
              reviewerNotes: `Version ${version}`,
            })
          })
        )
      )

    await createApproveMapping(1)
    await createApproveMapping(2)

    const runtimeMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.findLatestApprovedMapping({
          blockchainId: fixture.blockchainId,
          programId: fixture.programId,
          movementPattern: "token_out_and_token_in",
        })
      )
    )

    expect(Option.getOrNull(runtimeMapping)).toMatchObject({
      version: 2,
      confidence: "0.9900",
      mappingStatus: "approved",
    })
  })
})
