import { count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { ProtocolCandidateRepositoryLive } from "../../src/layers/ProtocolCandidateRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProtocolCandidateRepository, SyncEngineStorageError } from "@my/sync-engine/services"
import {
  importSolanaDuneRankingsFile,
  SolanaDuneRankingsFileImportError,
} from "@my/sync-engine/providers/helius-solana"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_protocol_candidate_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProtocolCandidateRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProtocolCandidateRepositoryLive }))

const expectDefined = <A>(value: A | undefined, message: string): A => {
  expect(value, message).toBeDefined()
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

const findSolanaBlockchainId = Effect.gen(function* () {
  const db = yield* drizzle
  const [blockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))
    .limit(1)

  return blockchain?.id
})

const requireSolanaBlockchainId = async () =>
  expectDefined(await runPg(findSolanaBlockchainId), "Missing solana blockchain fixture")

describe("ProtocolCandidateRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("imports Dune observations as candidates and observation rows", async () => {
    const solanaBlockchainId = await requireSolanaBlockchainId()
    const providerMappingCountBefore = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({ value: count(schema.providerTransactionTypeMappings.id) })
          .from(schema.providerTransactionTypeMappings)
        return row?.value ?? 0
      })
    )

    const result = await runRepository(
      Effect.flatMap(ProtocolCandidateRepository, (repository) =>
        repository.importDuneObservations({
          observations: [
            {
              blockchainId: solanaBlockchainId,
              subjectKind: "program",
              subjectIdentifier: "dune-program-1",
              protocolNameHint: "Example DEX",
              categoryHint: "dex",
              observedWindowStart: new Date("2024-01-01T00:00:00.000Z"),
              observedWindowEnd: new Date("2025-01-01T00:00:00.000Z"),
              interactionCount: 1_000,
              transactionCount: 800,
              uniqueActorCount: 250,
              sampleTransactionHashes: ["signature-1", "signature-2"],
              retrievedAt: new Date("2026-06-01T10:00:00.000Z"),
              rawPayload: { program_id: "dune-program-1", trade_rows: 1_000 },
              queryId: 7_647_495,
              queryName: "solana-dex-project-priority",
              queryVersion: 1,
            },
          ],
        })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({
            id: schema.protocolCandidates.id,
            subjectKind: schema.protocolCandidates.subjectKind,
            subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
            protocolNameHint: schema.protocolCandidates.protocolNameHint,
            categoryHint: schema.protocolCandidates.categoryHint,
            mappingStatus: schema.protocolCandidates.mappingStatus,
          })
          .from(schema.protocolCandidates)
          .limit(1)

        const [observation] =
          candidate === undefined
            ? []
            : yield* db
                .select({
                  id: schema.protocolCandidateObservations.id,
                  onchainDataSource: schema.protocolCandidateObservations.onchainDataSource,
                  onchainDataSourceObservationKey:
                    schema.protocolCandidateObservations.onchainDataSourceObservationKey,
                  interactionCount: schema.protocolCandidateObservations.interactionCount,
                  transactionCount: schema.protocolCandidateObservations.transactionCount,
                  uniqueActorCount: schema.protocolCandidateObservations.uniqueActorCount,
                  sampleTransactionHashes:
                    schema.protocolCandidateObservations.sampleTransactionHashes,
                })
                .from(schema.protocolCandidateObservations)
                .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                .limit(1)

        const [duneObservation] =
          observation === undefined
            ? []
            : yield* db
                .select({
                  queryId: schema.duneProtocolCandidateObservations.queryId,
                  queryName: schema.duneProtocolCandidateObservations.queryName,
                  queryVersion: schema.duneProtocolCandidateObservations.queryVersion,
                })
                .from(schema.duneProtocolCandidateObservations)
                .where(eq(schema.duneProtocolCandidateObservations.observationId, observation.id))
                .limit(1)

        return {
          candidate,
          observation,
          duneObservation,
        }
      })
    )
    const providerMappingCountAfter = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({ value: count(schema.providerTransactionTypeMappings.id) })
          .from(schema.providerTransactionTypeMappings)
        return row?.value ?? 0
      })
    )

    expect(result.observationCount).toBe(1)
    expect(result.candidates).toHaveLength(1)
    const candidate = expectDefined(rows.candidate, "Expected protocol candidate")
    const observation = expectDefined(rows.observation, "Expected protocol candidate observation")
    const duneObservation = expectDefined(
      rows.duneObservation,
      "Expected Dune observation metadata"
    )
    expect(candidate).toMatchObject({
      subjectKind: "program",
      subjectIdentifier: "dune-program-1",
      protocolNameHint: "Example DEX",
      categoryHint: "dex",
      mappingStatus: "pending_review",
    })
    expect(observation).toMatchObject({
      onchainDataSource: "dune",
      interactionCount: "1000",
      transactionCount: "800",
      uniqueActorCount: "250",
      sampleTransactionHashes: ["signature-1", "signature-2"],
    })
    expect(observation.onchainDataSourceObservationKey).toContain("7647495:1:")
    expect(duneObservation).toMatchObject({
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
    })
    expect(providerMappingCountAfter).toBe(providerMappingCountBefore)
  })

  it("imports a Solana Dune rankings file as candidates and observations", async () => {
    const solanaBlockchainId = await requireSolanaBlockchainId()
    const rankingsFile = {
      schemaVersion: 1,
      chain: "solana",
      onchainDataSource: "dune",
      generatedAt: "2026-06-01T10:30:00.000Z",
      window: { fromYear: 2024, toYear: 2024 },
      top: 10,
      executionWindowDays: 1,
      queries: [
        {
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          periodGranularity: "year",
          version: 1,
          kind: "dex-project-priority",
        },
      ],
      entries: [
        {
          programId: "dex-only-program",
          period: "2024-01-01 to 2025-01-01",
          invocationCount: 12_345,
          uniqueSignerCount: 456,
          transactionCount: 789,
          sampleSignatures: ["sample-signature-1", "sample-signature-2"],
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          periodGranularity: "year",
          queryVersion: 1,
          retrievedAt: "2026-06-01T10:00:00.000Z",
        },
      ],
    }

    const result = await runRepository(
      importSolanaDuneRankingsFile({ file: rankingsFile, blockchainId: solanaBlockchainId })
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidate] = yield* db
          .select({
            id: schema.protocolCandidates.id,
            subjectKind: schema.protocolCandidates.subjectKind,
            subjectIdentifier: schema.protocolCandidates.subjectIdentifier,
            protocolNameHint: schema.protocolCandidates.protocolNameHint,
            categoryHint: schema.protocolCandidates.categoryHint,
            mappingStatus: schema.protocolCandidates.mappingStatus,
          })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.subjectIdentifier, "dex-only-program"))
          .limit(1)

        const [observation] =
          candidate === undefined
            ? []
            : yield* db
                .select({
                  id: schema.protocolCandidateObservations.id,
                  observedWindowStart: schema.protocolCandidateObservations.observedWindowStart,
                  observedWindowEnd: schema.protocolCandidateObservations.observedWindowEnd,
                  interactionCount: schema.protocolCandidateObservations.interactionCount,
                  transactionCount: schema.protocolCandidateObservations.transactionCount,
                  uniqueActorCount: schema.protocolCandidateObservations.uniqueActorCount,
                  sampleTransactionHashes:
                    schema.protocolCandidateObservations.sampleTransactionHashes,
                  retrievedAt: schema.protocolCandidateObservations.retrievedAt,
                  rawPayload: schema.protocolCandidateObservations.rawPayload,
                })
                .from(schema.protocolCandidateObservations)
                .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                .limit(1)

        const [duneObservation] =
          observation === undefined
            ? []
            : yield* db
                .select({
                  queryId: schema.duneProtocolCandidateObservations.queryId,
                  queryName: schema.duneProtocolCandidateObservations.queryName,
                  queryVersion: schema.duneProtocolCandidateObservations.queryVersion,
                })
                .from(schema.duneProtocolCandidateObservations)
                .where(eq(schema.duneProtocolCandidateObservations.observationId, observation.id))
                .limit(1)

        return { candidate, observation, duneObservation }
      })
    )

    expect(result.observationCount).toBe(1)
    expect(result.candidates).toHaveLength(1)
    const candidate = expectDefined(rows.candidate, "Expected imported protocol candidate")
    const observation = expectDefined(
      rows.observation,
      "Expected imported protocol candidate observation"
    )
    const duneObservation = expectDefined(
      rows.duneObservation,
      "Expected imported Dune observation metadata"
    )
    expect(candidate).toMatchObject({
      subjectKind: "program",
      subjectIdentifier: "dex-only-program",
      protocolNameHint: null,
      categoryHint: null,
      mappingStatus: "pending_review",
    })
    expect(observation).toMatchObject({
      observedWindowStart: new Date("2024-01-01T00:00:00.000Z"),
      observedWindowEnd: new Date("2025-01-01T00:00:00.000Z"),
      interactionCount: "12345",
      transactionCount: "789",
      uniqueActorCount: "456",
      sampleTransactionHashes: ["sample-signature-1", "sample-signature-2"],
      retrievedAt: new Date("2026-06-01T10:00:00.000Z"),
    })
    expect(observation.rawPayload).toMatchObject({
      programId: "dex-only-program",
      period: "2024-01-01 to 2025-01-01",
      invocationCount: 12_345,
      uniqueSignerCount: 456,
      transactionCount: 789,
      sampleSignatures: ["sample-signature-1", "sample-signature-2"],
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
      retrievedAt: "2026-06-01T10:00:00.000Z",
    })
    expect(duneObservation).toMatchObject({
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
    })
  })

  it("updates existing candidates and observations on re-import without resetting review status", async () => {
    const solanaBlockchainId = await requireSolanaBlockchainId()
    const observation = {
      blockchainId: solanaBlockchainId,
      subjectKind: "program" as const,
      subjectIdentifier: "dune-program-2",
      protocolNameHint: "Review Me",
      categoryHint: "dex",
      observedWindowStart: new Date("2024-01-01T00:00:00.000Z"),
      observedWindowEnd: new Date("2025-01-01T00:00:00.000Z"),
      interactionCount: 100,
      transactionCount: 80,
      uniqueActorCount: 25,
      sampleTransactionHashes: ["signature-a"],
      retrievedAt: new Date("2026-06-01T10:00:00.000Z"),
      rawPayload: { program_id: "dune-program-2", trade_rows: 100 },
      queryId: 7_647_495,
      queryName: "solana-dex-project-priority",
      queryVersion: 1,
    }

    await runRepository(
      Effect.flatMap(ProtocolCandidateRepository, (repository) =>
        repository.importDuneObservations({ observations: [observation] })
      )
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.protocolCandidates)
          .set({ mappingStatus: "approved" })
          .where(eq(schema.protocolCandidates.subjectIdentifier, "dune-program-2"))
      })
    )

    await runRepository(
      Effect.flatMap(ProtocolCandidateRepository, (repository) =>
        repository.importDuneObservations({
          observations: [
            {
              ...observation,
              protocolNameHint: null,
              interactionCount: 250,
              transactionCount: 200,
              uniqueActorCount: 90,
              sampleTransactionHashes: ["signature-b"],
              retrievedAt: new Date("2026-06-02T10:00:00.000Z"),
              rawPayload: { program_id: "dune-program-2", trade_rows: 250 },
            },
          ],
        })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidateCountRow] = yield* db
          .select({ value: count(schema.protocolCandidates.id) })
          .from(schema.protocolCandidates)
        const [observationCountRow] = yield* db
          .select({ value: count(schema.protocolCandidateObservations.id) })
          .from(schema.protocolCandidateObservations)
        const [candidate] = yield* db
          .select({
            id: schema.protocolCandidates.id,
            protocolNameHint: schema.protocolCandidates.protocolNameHint,
            mappingStatus: schema.protocolCandidates.mappingStatus,
            lastSeenAt: schema.protocolCandidates.lastSeenAt,
          })
          .from(schema.protocolCandidates)
          .where(eq(schema.protocolCandidates.subjectIdentifier, "dune-program-2"))
          .limit(1)

        const [candidateObservation] =
          candidate === undefined
            ? []
            : yield* db
                .select({
                  interactionCount: schema.protocolCandidateObservations.interactionCount,
                  transactionCount: schema.protocolCandidateObservations.transactionCount,
                  uniqueActorCount: schema.protocolCandidateObservations.uniqueActorCount,
                  sampleTransactionHashes:
                    schema.protocolCandidateObservations.sampleTransactionHashes,
                })
                .from(schema.protocolCandidateObservations)
                .where(eq(schema.protocolCandidateObservations.candidateId, candidate.id))
                .limit(1)

        return {
          candidateCount: candidateCountRow?.value ?? 0,
          observationCount: observationCountRow?.value ?? 0,
          candidate,
          candidateObservation,
        }
      })
    )

    expect(rows.candidateCount).toBe(1)
    expect(rows.observationCount).toBe(1)
    const updatedCandidate = expectDefined(rows.candidate, "Expected protocol candidate")
    const candidateObservation = expectDefined(
      rows.candidateObservation,
      "Expected protocol candidate observation"
    )
    expect(updatedCandidate).toMatchObject({
      protocolNameHint: "Review Me",
      mappingStatus: "approved",
      lastSeenAt: new Date("2026-06-02T10:00:00.000Z"),
    })
    expect(candidateObservation).toMatchObject({
      interactionCount: "250",
      transactionCount: "200",
      uniqueActorCount: "90",
      sampleTransactionHashes: ["signature-b"],
    })
  })

  it("rejects malformed batches without importing partial rows", async () => {
    const solanaBlockchainId = await requireSolanaBlockchainId()

    const importResult = await runRepository(
      Effect.either(
        Effect.flatMap(ProtocolCandidateRepository, (repository) =>
          repository.importDuneObservations({
            observations: [
              {
                blockchainId: solanaBlockchainId,
                subjectKind: "program",
                subjectIdentifier: "valid-program",
                protocolNameHint: null,
                categoryHint: null,
                observedWindowStart: new Date("2024-01-01T00:00:00.000Z"),
                observedWindowEnd: new Date("2025-01-01T00:00:00.000Z"),
                interactionCount: 10,
                transactionCount: null,
                uniqueActorCount: null,
                sampleTransactionHashes: [],
                retrievedAt: new Date("2026-06-01T10:00:00.000Z"),
                rawPayload: { program_id: "valid-program" },
                queryId: 7_647_495,
                queryName: "solana-dex-project-priority",
                queryVersion: 1,
              },
              {
                blockchainId: solanaBlockchainId,
                subjectKind: "program",
                subjectIdentifier: "invalid-program",
                protocolNameHint: null,
                categoryHint: null,
                observedWindowStart: new Date("2024-01-01T00:00:00.000Z"),
                observedWindowEnd: new Date("2025-01-01T00:00:00.000Z"),
                interactionCount: -1,
                transactionCount: null,
                uniqueActorCount: null,
                sampleTransactionHashes: [],
                retrievedAt: new Date("2026-06-01T10:00:00.000Z"),
                rawPayload: { program_id: "invalid-program" },
                queryId: 7_647_495,
                queryName: "solana-dex-project-priority",
                queryVersion: 1,
              },
            ],
          })
        )
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidateCountRow] = yield* db
          .select({ value: count(schema.protocolCandidates.id) })
          .from(schema.protocolCandidates)
        const [observationCountRow] = yield* db
          .select({ value: count(schema.protocolCandidateObservations.id) })
          .from(schema.protocolCandidateObservations)
        const [duneObservationCountRow] = yield* db
          .select({ value: count(schema.duneProtocolCandidateObservations.observationId) })
          .from(schema.duneProtocolCandidateObservations)

        return {
          candidateCount: candidateCountRow?.value ?? 0,
          observationCount: observationCountRow?.value ?? 0,
          duneObservationCount: duneObservationCountRow?.value ?? 0,
        }
      })
    )

    expect(importResult._tag).toBe("Left")
    if (importResult._tag === "Right") {
      expect.fail("Expected malformed Dune observation import to fail")
    }
    expect(importResult.left).toBeInstanceOf(SyncEngineStorageError)
    expect(rows).toEqual({
      candidateCount: 0,
      observationCount: 0,
      duneObservationCount: 0,
    })
  })

  it("rejects malformed Solana Dune rankings files with a structured error", async () => {
    const solanaBlockchainId = await requireSolanaBlockchainId()
    const rankingsFile = {
      schemaVersion: 1,
      chain: "solana",
      onchainDataSource: "dune",
      generatedAt: "2026-06-01T10:30:00.000Z",
      window: { fromYear: 2024, toYear: 2024 },
      top: 10,
      executionWindowDays: 1,
      queries: [],
      entries: [
        {
          programId: "malformed-period-program",
          period: "2024",
          invocationCount: 1,
          uniqueSignerCount: null,
          transactionCount: null,
          sampleSignatures: [],
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          periodGranularity: "year",
          queryVersion: 1,
          retrievedAt: "2026-06-01T10:00:00.000Z",
        },
      ],
    }

    const importResult = await runRepository(
      Effect.either(
        importSolanaDuneRankingsFile({ file: rankingsFile, blockchainId: solanaBlockchainId })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [candidateCountRow] = yield* db
          .select({ value: count(schema.protocolCandidates.id) })
          .from(schema.protocolCandidates)
        const [observationCountRow] = yield* db
          .select({ value: count(schema.protocolCandidateObservations.id) })
          .from(schema.protocolCandidateObservations)

        return {
          candidateCount: candidateCountRow?.value ?? 0,
          observationCount: observationCountRow?.value ?? 0,
        }
      })
    )

    expect(importResult._tag).toBe("Left")
    if (importResult._tag === "Right") {
      expect.fail("Expected malformed Solana Dune rankings file import to fail")
    }
    expect(importResult.left).toBeInstanceOf(SolanaDuneRankingsFileImportError)
    expect(importResult.left.message).toContain("Invalid period")
    expect(rows).toEqual({ candidateCount: 0, observationCount: 0 })
  })
})
