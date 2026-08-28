import * as DateTime from "effect/DateTime"
import { count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
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
  blockchainName = "solana",
  subjectKind = "program",
  candidateSubjectIdentifier = "reviewed-program-1",
  relatedSubjectIdentifiers = [],
  rawPayload = { subjectIdentifier: candidateSubjectIdentifier },
}: {
  readonly blockchainName?: string
  readonly subjectKind?: "program" | "contract" | "protocol"
  readonly candidateSubjectIdentifier?: string
  readonly relatedSubjectIdentifiers?: ReadonlyArray<string>
  readonly rawPayload?: Record<string, unknown>
} = {}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [blockchain] = yield* db
        .select({ id: schema.blockchains.id })
        .from(schema.blockchains)
        .where(eq(schema.blockchains.name, blockchainName))
        .limit(1)

      if (blockchain === undefined) {
        return yield* Effect.die(`Missing seeded ${blockchainName} blockchain fixture`)
      }

      const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z"))
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
        return yield* Effect.die("Failed to create protocol candidate fixture")
      }

      const [observation] = yield* db
        .insert(schema.protocolCandidateObservations)
        .values({
          candidateId: candidate.id,
          onchainDataSource: "dune",
          onchainDataSourceObservationKey: `fixture:${candidateSubjectIdentifier}:${relatedSubjectIdentifiers.join(",")}`,
          observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00.000Z")),
          interactionCount: "100",
          transactionCount: "80",
          uniqueActorCount: "20",
          relatedSubjectIdentifiers,
          sampleTransactionHashes: ["sample-signature-1"],
          retrievedAt: now,
          rawPayload,
          createdAt: now,
        })
        .returning({ id: schema.protocolCandidateObservations.id })

      if (observation === undefined) {
        return yield* Effect.die("Failed to create protocol observation fixture")
      }

      return {
        blockchainId: blockchain.id,
        candidateId: candidate.id,
        observationId: observation.id,
        candidateSubjectIdentifier,
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
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      })
    )
  )

  it.effect("creates a candidate-backed pending mapping and approves it with linked evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => insertCandidateWithObservation())

      const pendingMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
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
      )

      const approvedMappingBeforeApproval = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.findLatestApprovedMapping({
              blockchainId: fixture.blockchainId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
              movementPattern: "token_out_and_token_in",
            })
          )
        )
      )

      const evidence = yield* Effect.promise(() =>
        runRepository(
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
      )

      const approvedMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.approveMapping({
              mappingId: pendingMapping.id,
              transactionTypeKey: "swap_crypto_to_crypto",
              reviewerNotes: "Reviewed fixture",
            })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(pendingMapping).toMatchObject({
        candidateId: fixture.candidateId,
        blockchainId: fixture.blockchainId,
        subjectIdentifier: fixture.candidateSubjectIdentifier,
        movementPattern: "token_out_and_token_in",
        transactionTypeKey: null,
        mappingStatus: "pending_review",
        confidence: "0.9500",
      })
      expect(Option.isNone(approvedMappingBeforeApproval)).toBe(true)
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
  )

  it.effect("rejects a mapping without deleting the candidate or Dune observations", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "rejected-program-1",
        })
      )

      const pendingMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
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
      )

      const rejectedMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.rejectMapping({
              mappingId: pendingMapping.id,
              reviewerNotes: "Not enough normalized fixture evidence",
            })
          )
        )
      )

      const approvedMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.findLatestApprovedMapping({
              blockchainId: fixture.blockchainId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
              movementPattern: "token_out_and_token_in",
            })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(rejectedMapping).toMatchObject({
        id: pendingMapping.id,
        mappingStatus: "rejected",
        reviewerNotes: "Not enough normalized fixture evidence",
      })
      expect(Option.isNone(approvedMapping)).toBe(true)
      expect(rows.candidate).toMatchObject({ mappingStatus: "pending_review" })
      expect(rows.observationCount).toBe(1)
    })
  )

  it.effect("does not approve a mapping without evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "missing-evidence-program",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
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
      )

      const approvalResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
              repository.approveMapping({
                mappingId: pendingMapping.id,
                transactionTypeKey: "swap_crypto_to_crypto",
                reviewerNotes: "No evidence",
              })
            )
          )
        )
      )

      expect(approvalResult._tag).toBe("Failure")
      if (approvalResult._tag === "Success") {
        expect.fail("Expected approval without evidence to fail")
      }
      expect(approvalResult.failure).toBeInstanceOf(SyncEngineStorageError)
    })
  )

  it.effect("does not approve a mapping with an unknown transaction type", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "unknown-type-program",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.createPendingMappingFromCandidate({
              candidateId: fixture.candidateId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
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
      )

      yield* Effect.promise(() =>
        runRepository(
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
      )

      const approvalResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
              repository.approveMapping({
                mappingId: pendingMapping.id,
                transactionTypeKey: "missing_transaction_type",
                reviewerNotes: "Unknown type",
              })
            )
          )
        )
      )

      expect(approvalResult._tag).toBe("Failure")
      if (approvalResult._tag === "Success") {
        expect.fail("Expected approval with unknown transaction type to fail")
      }
      expect(approvalResult.failure).toBeInstanceOf(SyncEngineStorageError)
    })
  )

  it.effect("does not attach evidence from another candidate", () =>
    Effect.gen(function* () {
      const mappingFixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "evidence-owner-program",
        })
      )
      const unrelatedFixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "unrelated-evidence-program",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: mappingFixture.candidateId,
          subjectIdentifier: mappingFixture.candidateSubjectIdentifier,
        })
      )

      const evidenceResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
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
      )

      expect(evidenceResult._tag).toBe("Failure")
      if (evidenceResult._tag === "Success") {
        expect.fail("Expected unrelated evidence to fail")
      }
      expect(evidenceResult.failure).toBeInstanceOf(SyncEngineStorageError)
    })
  )

  it.effect("does not attach same-candidate evidence for a different observed subject", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          subjectKind: "protocol",
          candidateSubjectIdentifier: "subject-evidence-dex",
          relatedSubjectIdentifiers: ["subject-evidence-program-a"],
          rawPayload: {
            canonicalProgramIds: ["subject-evidence-program-a"],
            project: "subject-evidence-dex",
          },
        })
      )
      const unrelatedObservationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z"))
            const [observation] = yield* db
              .insert(schema.protocolCandidateObservations)
              .values({
                candidateId: fixture.candidateId,
                onchainDataSource: "dune",
                onchainDataSourceObservationKey: "fixture:subject-evidence-dex:program-b",
                observedWindowStart: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2026-02-01T00:00:00.000Z")
                ),
                observedWindowEnd: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2026-03-01T00:00:00.000Z")
                ),
                interactionCount: "100",
                transactionCount: "80",
                uniqueActorCount: "20",
                relatedSubjectIdentifiers: ["subject-evidence-program-b"],
                sampleTransactionHashes: ["sample-signature-2"],
                retrievedAt: now,
                rawPayload: {
                  canonicalProgramIds: ["subject-evidence-program-b"],
                  project: "subject-evidence-dex",
                },
                createdAt: now,
              })
              .returning({ id: schema.protocolCandidateObservations.id })

            if (observation === undefined) {
              return yield* Effect.die("Failed to create protocol observation fixture")
            }

            return observation.id
          })
        )
      )
      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "subject-evidence-program-b",
          protocolName: "Subject Evidence DEX",
        })
      )

      const evidenceResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
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
        )
      )
      const validEvidence = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.addEvidence({
              mappingId: pendingMapping.id,
              candidateObservationId: unrelatedObservationId,
              evidenceKind: "dune_observation",
              sampleSignature: "sample-signature-2",
              payload: { source: "dune", queryId: 7_647_495 },
            })
          )
        )
      )

      expect(evidenceResult._tag).toBe("Failure")
      if (evidenceResult._tag === "Success") {
        expect.fail("Expected wrong-subject evidence to fail")
      }
      expect(evidenceResult.failure).toBeInstanceOf(SyncEngineStorageError)
      expect(validEvidence.candidateObservationId).toBe(unrelatedObservationId)
    })
  )

  it.effect("does not create a mapping for a program outside the candidate evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          subjectKind: "protocol",
          candidateSubjectIdentifier: "candidate-owned-protocol",
          relatedSubjectIdentifiers: ["candidate-owned-program"],
          rawPayload: {
            canonicalProgramIds: ["candidate-owned-program"],
            project: "candidate-owned-protocol",
          },
        })
      )

      const creationResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
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
      )

      expect(creationResult._tag).toBe("Failure")
      if (creationResult._tag === "Success") {
        expect.fail("Expected unrelated program mapping to fail")
      }
      expect(creationResult.failure).toBeInstanceOf(SyncEngineStorageError)
    })
  )

  it.effect("does not create a protocol-candidate mapping for the protocol slug", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          subjectKind: "protocol",
          candidateSubjectIdentifier: "protocol-slug-dex",
          relatedSubjectIdentifiers: ["protocol-slug-program"],
          rawPayload: {
            canonicalProgramIds: [],
            project: "protocol-slug-dex",
          },
        })
      )

      const creationResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
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
      )

      expect(creationResult._tag).toBe("Failure")
      if (creationResult._tag === "Success") {
        expect.fail("Expected protocol slug mapping to fail")
      }
      expect(creationResult.failure).toBeInstanceOf(SyncEngineStorageError)
    })
  )

  it.effect("stores the normalized subject identifier for candidate-backed mappings", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "trimmed-program-id",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: " trimmed-program-id ",
        })
      )

      const approvedMapping = yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: pendingMapping.id,
          observationId: fixture.observationId,
        })
      )

      const latestApprovedMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.findLatestApprovedMapping({
              blockchainId: fixture.blockchainId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
              movementPattern: "token_out_and_token_in",
            })
          )
        )
      )

      expect(pendingMapping.subjectIdentifier).toBe(fixture.candidateSubjectIdentifier)
      expect(approvedMapping.subjectIdentifier).toBe(fixture.candidateSubjectIdentifier)
      expect(Option.isSome(latestApprovedMapping)).toBe(true)
      if (Option.isSome(latestApprovedMapping)) {
        expect(latestApprovedMapping.value.id).toBe(approvedMapping.id)
      }
    })
  )

  it.effect(
    "keeps a multi-program candidate pending until every observed program is approved",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          insertCandidateWithObservation({
            subjectKind: "protocol",
            candidateSubjectIdentifier: "multi-program-dex",
            relatedSubjectIdentifiers: ["multi-program-a", "multi-program-b"],
            rawPayload: {
              canonicalProgramIds: ["multi-program-a", "multi-program-b"],
              project: "multi-program-dex",
            },
          })
        )
        const firstMapping = yield* Effect.promise(() =>
          createPendingMapping({
            candidateId: fixture.candidateId,
            subjectIdentifier: "multi-program-a",
            protocolName: "Multi Program DEX",
          })
        )
        yield* Effect.promise(() =>
          addEvidenceAndApprove({
            mappingId: firstMapping.id,
            observationId: fixture.observationId,
          })
        )

        const statusAfterFirstApproval = yield* Effect.promise(() =>
          runPg(
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
        )

        const secondMapping = yield* Effect.promise(() =>
          createPendingMapping({
            candidateId: fixture.candidateId,
            subjectIdentifier: "multi-program-b",
            protocolName: "Multi Program DEX",
          })
        )
        yield* Effect.promise(() =>
          addEvidenceAndApprove({
            mappingId: secondMapping.id,
            observationId: fixture.observationId,
          })
        )

        const statusAfterSecondApproval = yield* Effect.promise(() =>
          runPg(
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
        )

        expect(statusAfterFirstApproval).toBe("pending_review")
        expect(statusAfterSecondApproval).toBe("approved")
      })
  )

  it.effect("keeps a contract candidate pending until its direct subject is approved", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          blockchainName: "base",
          subjectKind: "contract",
          candidateSubjectIdentifier: "candidate-contract-a",
          relatedSubjectIdentifiers: ["observed-contract-b"],
          rawPayload: {
            canonicalProgramIds: ["observed-contract-b"],
            project: "contract-dex",
          },
        })
      )
      const observedSubjectMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "observed-contract-b",
          protocolName: "Contract DEX",
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: observedSubjectMapping.id,
          observationId: fixture.observationId,
        })
      )

      const statusAfterObservedSubjectApproval = yield* Effect.promise(() =>
        runPg(
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
      )

      const directSubjectMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "candidate-contract-a",
          protocolName: "Contract DEX",
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: directSubjectMapping.id,
          observationId: fixture.observationId,
        })
      )

      const statusAfterDirectSubjectApproval = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(statusAfterObservedSubjectApproval).toBe("pending_review")
      expect(statusAfterDirectSubjectApproval).toBe("approved")
    })
  )

  it.effect("does not approve an already approved mapping again", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "repeat-approval-program",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: pendingMapping.id,
          observationId: fixture.observationId,
          reviewerNotes: "Original approval",
        })
      )

      const secondApprovalResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
              repository.approveMapping({
                mappingId: pendingMapping.id,
                transactionTypeKey: "trade_other",
                reviewerNotes: "Changed approval",
              })
            )
          )
        )
      )

      const row = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(secondApprovalResult._tag).toBe("Failure")
      if (secondApprovalResult._tag === "Success") {
        expect.fail("Expected approving an approved mapping to fail")
      }
      expect(secondApprovalResult.failure).toBeInstanceOf(SyncEngineStorageError)
      expect(row).toMatchObject({
        transactionTypeKey: "swap_crypto_to_crypto",
        mappingStatus: "approved",
        reviewerNotes: "Original approval",
      })
    })
  )

  it.effect("does not reject an already approved mapping", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "reject-approved-program",
        })
      )
      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: pendingMapping.id,
          observationId: fixture.observationId,
        })
      )

      const rejectionResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
              repository.rejectMapping({
                mappingId: pendingMapping.id,
                reviewerNotes: "Reject after approval",
              })
            )
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(rejectionResult._tag).toBe("Failure")
      if (rejectionResult._tag === "Success") {
        expect.fail("Expected rejecting an approved mapping to fail")
      }
      expect(rejectionResult.failure).toBeInstanceOf(SyncEngineStorageError)
      expect(rows.mapping).toMatchObject({
        mappingStatus: "approved",
        reviewerNotes: "Reviewed fixture",
      })
      expect(rows.candidate).toMatchObject({ mappingStatus: "approved" })
    })
  )

  it.effect("reopens an approved candidate when adding a new pending version", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "reopen-version-program",
        })
      )
      const approvedMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
          version: 1,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: approvedMapping.id,
          observationId: fixture.observationId,
        })
      )

      yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
          version: 2,
        })
      )

      const candidateStatus = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(candidateStatus).toBe("pending_review")
    })
  )

  it.effect("keeps a candidate pending while linked mapping versions still await review", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          subjectKind: "protocol",
          candidateSubjectIdentifier: "pending-version-dex",
          relatedSubjectIdentifiers: ["pending-version-program-a", "pending-version-program-b"],
          rawPayload: {
            canonicalProgramIds: ["pending-version-program-a", "pending-version-program-b"],
            project: "pending-version-dex",
          },
        })
      )
      const firstProgramV1 = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "pending-version-program-a",
          protocolName: "Pending Version DEX",
          version: 1,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: firstProgramV1.id,
          observationId: fixture.observationId,
        })
      )
      const secondProgramV1 = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "pending-version-program-b",
          protocolName: "Pending Version DEX",
          version: 1,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: secondProgramV1.id,
          observationId: fixture.observationId,
        })
      )

      const firstProgramV2 = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "pending-version-program-a",
          protocolName: "Pending Version DEX",
          version: 2,
        })
      )
      yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: "pending-version-program-b",
          protocolName: "Pending Version DEX",
          version: 2,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: firstProgramV2.id,
          observationId: fixture.observationId,
        })
      )

      const candidateStatus = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(candidateStatus).toBe("pending_review")
    })
  )

  it.effect("approves a candidate again after rejecting its only pending version bump", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "reject-version-bump-program",
        })
      )
      const approvedMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
          version: 1,
        })
      )
      yield* Effect.promise(() =>
        addEvidenceAndApprove({
          mappingId: approvedMapping.id,
          observationId: fixture.observationId,
        })
      )

      const pendingMapping = yield* Effect.promise(() =>
        createPendingMapping({
          candidateId: fixture.candidateId,
          subjectIdentifier: fixture.candidateSubjectIdentifier,
          version: 2,
        })
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.rejectMapping({
              mappingId: pendingMapping.id,
              reviewerNotes: "Keep the approved version",
            })
          )
        )
      )

      const candidateStatus = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(candidateStatus).toBe("approved")
    })
  )

  it.effect(
    "approves a multi-program candidate when other candidates cover required programs",
    () =>
      Effect.gen(function* () {
        const existingProgramFixture = yield* Effect.promise(() =>
          insertCandidateWithObservation({
            candidateSubjectIdentifier: "cross-candidate-program-a",
          })
        )
        const existingMapping = yield* Effect.promise(() =>
          createPendingMapping({
            candidateId: existingProgramFixture.candidateId,
            subjectIdentifier: existingProgramFixture.candidateSubjectIdentifier,
            protocolName: "Program DEX",
          })
        )
        yield* Effect.promise(() =>
          addEvidenceAndApprove({
            mappingId: existingMapping.id,
            observationId: existingProgramFixture.observationId,
          })
        )

        const protocolFixture = yield* Effect.promise(() =>
          insertCandidateWithObservation({
            subjectKind: "protocol",
            candidateSubjectIdentifier: "cross-candidate-dex",
            relatedSubjectIdentifiers: ["cross-candidate-program-a", "cross-candidate-program-b"],
            rawPayload: {
              canonicalProgramIds: ["cross-candidate-program-a", "cross-candidate-program-b"],
              project: "cross-candidate-dex",
            },
          })
        )
        const protocolMapping = yield* Effect.promise(() =>
          createPendingMapping({
            candidateId: protocolFixture.candidateId,
            subjectIdentifier: "cross-candidate-program-b",
            protocolName: "Cross Candidate DEX",
          })
        )
        yield* Effect.promise(() =>
          addEvidenceAndApprove({
            mappingId: protocolMapping.id,
            observationId: protocolFixture.observationId,
          })
        )

        const candidateStatus = yield* Effect.promise(() =>
          runPg(
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
        )

        expect(candidateStatus).toBe("approved")
      })
  )

  it.effect("returns the latest approved version for runtime lookup", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        insertCandidateWithObservation({
          candidateSubjectIdentifier: "versioned-program",
        })
      )

      const createApproveMapping = (version: number) =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            Effect.gen(function* () {
              const mapping = yield* repository.createPendingMappingFromCandidate({
                candidateId: fixture.candidateId,
                subjectIdentifier: fixture.candidateSubjectIdentifier,
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

      yield* Effect.promise(() => createApproveMapping(1))
      yield* Effect.promise(() => createApproveMapping(2))

      const runtimeMapping = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolTransactionTypeMappingRepository, (repository) =>
            repository.findLatestApprovedMapping({
              blockchainId: fixture.blockchainId,
              subjectIdentifier: fixture.candidateSubjectIdentifier,
              movementPattern: "token_out_and_token_in",
            })
          )
        )
      )

      expect(Option.getOrNull(runtimeMapping)).toMatchObject({
        version: 2,
        confidence: "0.9900",
        mappingStatus: "approved",
      })
    })
  )
})
