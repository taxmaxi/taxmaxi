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
  subjectIdentifier = "reviewed-program-1",
  subjectKind = "program",
  candidateSubjectIdentifier = subjectIdentifier,
  rawPayload = { program_id: subjectIdentifier },
}: {
  readonly subjectIdentifier?: string
  readonly subjectKind?: "program" | "contract" | "protocol"
  readonly candidateSubjectIdentifier?: string
  readonly rawPayload?: Record<string, unknown>
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
          subjectKind,
          subjectIdentifier: candidateSubjectIdentifier,
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
          onchainDataSourceObservationKey: `fixture:${subjectIdentifier}`,
          observedWindowStart: new Date("2026-01-01T00:00:00.000Z"),
          observedWindowEnd: new Date("2026-02-01T00:00:00.000Z"),
          interactionCount: "100",
          transactionCount: "80",
          uniqueActorCount: "20",
          sampleTransactionHashes: ["sample-signature-1"],
          retrievedAt: now,
          rawPayload,
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
        subjectIdentifier,
      }
    })
  )

const createPendingMapping = ({
  candidateId,
  subjectIdentifier,
  version = 1,
  protocolName = "Example DEX",
}: {
  readonly candidateId: string
  readonly subjectIdentifier: string
  readonly version?: number
  readonly protocolName?: string
}) =>
  runRepository(
    Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
      repository.createPendingMappingFromCandidate({
        candidateId,
        subjectIdentifier,
        protocolName,
        movementPattern: "token_out_and_token_in",
        transactionTypeKey: null,
        inventoryEffect: "disposal",
        taxTreatment: "taxable_by_default",
        confidence: "0.9500",
        version,
        reviewerNotes: null,
        sourceNotes: null,
      })
    )
  )

const addEvidenceAndApprove = ({
  mappingId,
  observationId,
  reviewerNotes = "Reviewed fixture",
}: {
  readonly mappingId: string
  readonly observationId: string
  readonly reviewerNotes?: string
}) =>
  runRepository(
    Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
      Effect.gen(function* () {
        yield* repository.addEvidence({
          mappingId,
          candidateObservationId: observationId,
          evidenceKind: "dune_observation",
          sampleSignature: "sample-signature-1",
          payload: { source: "dune", queryId: 7_647_495 },
        })
        return yield* repository.approveMapping({
          mappingId,
          transactionTypeKey: "swap_crypto_to_crypto",
          reviewerNotes,
        })
      })
    )
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
          subjectIdentifier: fixture.subjectIdentifier,
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
          subjectIdentifier: fixture.subjectIdentifier,
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
      subjectIdentifier: fixture.subjectIdentifier,
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
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "rejected-program-1",
    })

    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.subjectIdentifier,
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
          subjectIdentifier: fixture.subjectIdentifier,
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
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "missing-evidence-program",
    })
    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.subjectIdentifier,
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
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "unknown-type-program",
    })
    const pendingMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.createPendingMappingFromCandidate({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.subjectIdentifier,
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

  it("does not attach evidence from another candidate", async () => {
    const mappingFixture = await insertCandidateWithObservation({
      subjectIdentifier: "evidence-owner-program",
    })
    const unrelatedFixture = await insertCandidateWithObservation({
      subjectIdentifier: "unrelated-evidence-program",
    })
    const pendingMapping = await createPendingMapping({
      candidateId: mappingFixture.candidateId,
      subjectIdentifier: mappingFixture.subjectIdentifier,
    })

    const evidenceResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.addEvidence({
            mappingId: pendingMapping.id,
            candidateObservationId: unrelatedFixture.observationId,
            evidenceKind: "dune_observation",
            sampleSignature: "sample-signature-1",
            payload: { source: "dune", queryId: 7_647_495 },
          })
        )
      )
    )

    expect(evidenceResult._tag).toBe("Left")
    if (evidenceResult._tag === "Right") {
      expect.fail("Expected unrelated evidence to fail")
    }
    expect(evidenceResult.left).toBeInstanceOf(SyncEngineStorageError)
  })

  it("does not create a mapping for a program outside the candidate evidence", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "candidate-owned-program",
      subjectKind: "protocol",
      candidateSubjectIdentifier: "candidate-owned-protocol",
      rawPayload: {
        canonicalProgramIds: ["candidate-owned-program"],
        project: "candidate-owned-protocol",
      },
    })

    const creationResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.createPendingMappingFromCandidate({
            candidateId: fixture.candidateId,
            subjectIdentifier: "unrelated-program",
            protocolName: "Unrelated DEX",
            movementPattern: "token_out_and_token_in",
            transactionTypeKey: null,
            inventoryEffect: "disposal",
            taxTreatment: "taxable_by_default",
            confidence: "0.9500",
            version: 1,
            reviewerNotes: null,
            sourceNotes: null,
          })
        )
      )
    )

    expect(creationResult._tag).toBe("Left")
    if (creationResult._tag === "Right") {
      expect.fail("Expected unrelated program mapping to fail")
    }
    expect(creationResult.left).toBeInstanceOf(SyncEngineStorageError)
  })

  it("does not create a protocol-candidate mapping for the protocol slug", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "protocol-slug-program",
      subjectKind: "protocol",
      candidateSubjectIdentifier: "protocol-slug-dex",
      rawPayload: {
        canonicalProgramIds: [],
        project: "protocol-slug-dex",
      },
    })

    const creationResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.createPendingMappingFromCandidate({
            candidateId: fixture.candidateId,
            subjectIdentifier: "protocol-slug-dex",
            protocolName: "Protocol Slug DEX",
            movementPattern: "token_out_and_token_in",
            transactionTypeKey: null,
            inventoryEffect: "disposal",
            taxTreatment: "taxable_by_default",
            confidence: "0.9500",
            version: 1,
            reviewerNotes: null,
            sourceNotes: null,
          })
        )
      )
    )

    expect(creationResult._tag).toBe("Left")
    if (creationResult._tag === "Right") {
      expect.fail("Expected protocol slug mapping to fail")
    }
    expect(creationResult.left).toBeInstanceOf(SyncEngineStorageError)
  })

  it("stores the normalized subject identifier for candidate-backed mappings", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "trimmed-program-id",
    })
    const pendingMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: " trimmed-program-id ",
    })

    const approvedMapping = await addEvidenceAndApprove({
      mappingId: pendingMapping.id,
      observationId: fixture.observationId,
    })
    const runtimeMapping = await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.findLatestApprovedMapping({
          blockchainId: fixture.blockchainId,
          subjectIdentifier: fixture.subjectIdentifier,
          movementPattern: "token_out_and_token_in",
        })
      )
    )

    expect(pendingMapping.subjectIdentifier).toBe(fixture.subjectIdentifier)
    expect(approvedMapping.subjectIdentifier).toBe(fixture.subjectIdentifier)
    expect(Option.isSome(runtimeMapping)).toBe(true)
    if (Option.isSome(runtimeMapping)) {
      expect(runtimeMapping.value.id).toBe(approvedMapping.id)
    }
  })

  it("keeps a multi-program candidate pending until every observed program is approved", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "multi-program-a",
      subjectKind: "protocol",
      candidateSubjectIdentifier: "multi-program-dex",
      rawPayload: {
        canonicalProgramIds: ["multi-program-a", "multi-program-b"],
        project: "multi-program-dex",
      },
    })
    const firstMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "multi-program-a",
      protocolName: "Multi Program DEX",
    })
    await addEvidenceAndApprove({
      mappingId: firstMapping.id,
      observationId: fixture.observationId,
    })

    const statusAfterFirstApproval = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    const secondMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "multi-program-b",
      protocolName: "Multi Program DEX",
    })
    await addEvidenceAndApprove({
      mappingId: secondMapping.id,
      observationId: fixture.observationId,
    })

    const statusAfterSecondApproval = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    expect(statusAfterFirstApproval).toBe("pending_review")
    expect(statusAfterSecondApproval).toBe("approved")
  })

  it("does not approve an already approved mapping again", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "repeat-approval-program",
    })
    const pendingMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
    })
    await addEvidenceAndApprove({
      mappingId: pendingMapping.id,
      observationId: fixture.observationId,
      reviewerNotes: "Original approval",
    })

    const secondApprovalResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.approveMapping({
            mappingId: pendingMapping.id,
            transactionTypeKey: "trade_other",
            reviewerNotes: "Changed approval",
          })
        )
      )
    )

    const row = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({
            transactionTypeKey: schema.protocolTransactionTypeMappings.transactionTypeKey,
            mappingStatus: schema.protocolTransactionTypeMappings.mappingStatus,
            reviewerNotes: schema.protocolTransactionTypeMappings.reviewerNotes,
          })
          .from(schema.protocolTransactionTypeMappings)
          .where(eq(schema.protocolTransactionTypeMappings.id, pendingMapping.id))
          .limit(1)

        return mapping
      })
    )

    expect(secondApprovalResult._tag).toBe("Left")
    if (secondApprovalResult._tag === "Right") {
      expect.fail("Expected approving an approved mapping to fail")
    }
    expect(secondApprovalResult.left).toBeInstanceOf(SyncEngineStorageError)
    expect(row).toMatchObject({
      transactionTypeKey: "swap_crypto_to_crypto",
      mappingStatus: "approved",
      reviewerNotes: "Original approval",
    })
  })

  it("does not reject an already approved mapping", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "reject-approved-program",
    })
    const pendingMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
    })
    await addEvidenceAndApprove({
      mappingId: pendingMapping.id,
      observationId: fixture.observationId,
    })

    const rejectionResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          repository.rejectMapping({
            mappingId: pendingMapping.id,
            reviewerNotes: "Reject after approval",
          })
        )
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({
            mappingStatus: schema.protocolTransactionTypeMappings.mappingStatus,
            reviewerNotes: schema.protocolTransactionTypeMappings.reviewerNotes,
          })
          .from(schema.protocolTransactionTypeMappings)
          .where(eq(schema.protocolTransactionTypeMappings.id, pendingMapping.id))
          .limit(1)
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return { mapping, candidate }
      })
    )

    expect(rejectionResult._tag).toBe("Left")
    if (rejectionResult._tag === "Right") {
      expect.fail("Expected rejecting an approved mapping to fail")
    }
    expect(rejectionResult.left).toBeInstanceOf(SyncEngineStorageError)
    expect(rows.mapping).toMatchObject({
      mappingStatus: "approved",
      reviewerNotes: "Reviewed fixture",
    })
    expect(rows.candidate).toMatchObject({ mappingStatus: "approved" })
  })

  it("reopens an approved candidate when adding a new pending version", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "reopen-version-program",
    })
    const approvedMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
      version: 1,
    })
    await addEvidenceAndApprove({
      mappingId: approvedMapping.id,
      observationId: fixture.observationId,
    })

    await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
      version: 2,
    })

    const candidateStatus = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    expect(candidateStatus).toBe("pending_review")
  })

  it("keeps a candidate pending while linked mapping versions still await review", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "pending-version-program-a",
      subjectKind: "protocol",
      candidateSubjectIdentifier: "pending-version-dex",
      rawPayload: {
        canonicalProgramIds: ["pending-version-program-a", "pending-version-program-b"],
        project: "pending-version-dex",
      },
    })
    const firstProgramV1 = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "pending-version-program-a",
      protocolName: "Pending Version DEX",
      version: 1,
    })
    await addEvidenceAndApprove({
      mappingId: firstProgramV1.id,
      observationId: fixture.observationId,
    })
    const secondProgramV1 = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "pending-version-program-b",
      protocolName: "Pending Version DEX",
      version: 1,
    })
    await addEvidenceAndApprove({
      mappingId: secondProgramV1.id,
      observationId: fixture.observationId,
    })

    const firstProgramV2 = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "pending-version-program-a",
      protocolName: "Pending Version DEX",
      version: 2,
    })
    await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: "pending-version-program-b",
      protocolName: "Pending Version DEX",
      version: 2,
    })
    await addEvidenceAndApprove({
      mappingId: firstProgramV2.id,
      observationId: fixture.observationId,
    })

    const candidateStatus = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    expect(candidateStatus).toBe("pending_review")
  })

  it("approves a candidate again after rejecting its only pending version bump", async () => {
    const fixture = await insertCandidateWithObservation({
      subjectIdentifier: "reject-version-bump-program",
    })
    const approvedMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
      version: 1,
    })
    await addEvidenceAndApprove({
      mappingId: approvedMapping.id,
      observationId: fixture.observationId,
    })

    const pendingMapping = await createPendingMapping({
      candidateId: fixture.candidateId,
      subjectIdentifier: fixture.subjectIdentifier,
      version: 2,
    })
    await runRepository(
      Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
        repository.rejectMapping({
          mappingId: pendingMapping.id,
          reviewerNotes: "Keep the approved version",
        })
      )
    )

    const candidateStatus = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, fixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    expect(candidateStatus).toBe("approved")
  })

  it("approves a multi-program candidate when other candidates cover required programs", async () => {
    const existingProgramFixture = await insertCandidateWithObservation({
      subjectIdentifier: "cross-candidate-program-a",
    })
    const existingMapping = await createPendingMapping({
      candidateId: existingProgramFixture.candidateId,
      subjectIdentifier: existingProgramFixture.subjectIdentifier,
      protocolName: "Program DEX",
    })
    await addEvidenceAndApprove({
      mappingId: existingMapping.id,
      observationId: existingProgramFixture.observationId,
    })

    const protocolFixture = await insertCandidateWithObservation({
      subjectIdentifier: "cross-candidate-program-b",
      subjectKind: "protocol",
      candidateSubjectIdentifier: "cross-candidate-dex",
      rawPayload: {
        canonicalProgramIds: ["cross-candidate-program-a", "cross-candidate-program-b"],
        project: "cross-candidate-dex",
      },
    })
    const protocolMapping = await createPendingMapping({
      candidateId: protocolFixture.candidateId,
      subjectIdentifier: "cross-candidate-program-b",
      protocolName: "Cross Candidate DEX",
    })
    await addEvidenceAndApprove({
      mappingId: protocolMapping.id,
      observationId: protocolFixture.observationId,
    })

    const candidateStatus = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({ mappingStatus: schema.protocolCandidates.mappingStatus })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.id, protocolFixture.candidateId))
          .limit(1)

        return candidate?.mappingStatus ?? null
      })
    )

    expect(candidateStatus).toBe("approved")
  })

  it("returns the latest approved version for runtime lookup", async () => {
    const fixture = await insertCandidateWithObservation({ subjectIdentifier: "versioned-program" })

    const createApproveMapping = (version: number) =>
      runRepository(
        Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
          Effect.gen(function* () {
            const mapping = yield* repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              subjectIdentifier: fixture.subjectIdentifier,
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
          subjectIdentifier: fixture.subjectIdentifier,
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
