import * as DateTime from "effect/DateTime"
import { count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"
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

describe("ProtocolCandidateRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      })
    )
  )

  it.effect("imports Dune observations as candidates and observation rows", () =>
    Effect.gen(function* () {
      const providerMappingCountBefore = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({ value: count(schema.providerTransactionTypeMappings.id) })
              .from(schema.providerTransactionTypeMappings)
            return row?.value ?? 0
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({
              observations: [
                {
                  blockchainName: "solana",
                  subjectKind: "program",
                  subjectIdentifier: "dune-program-1",
                  protocolNameHint: "Example DEX",
                  categoryHint: "dex",
                  sourceObservationKey: "7647495:1:program:dune-program-1:2024-01-01:2025-01-01",
                  observedWindowStart: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")
                  ),
                  observedWindowEnd: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")
                  ),
                  interactionCount: 1_000,
                  transactionCount: 800,
                  uniqueActorCount: 250,
                  relatedSubjectIdentifiers: [],
                  sampleTransactionHashes: ["signature-1", "signature-2"],
                  retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
                  rawPayload: { program_id: "dune-program-1", trade_rows: 1_000 },
                  sourceMetadata: {
                    source: "dune",
                    queryId: 7_647_495,
                    queryName: "solana-dex-project-priority",
                    queryVersion: 1,
                  },
                },
              ],
            })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
                      relatedSubjectIdentifiers:
                        schema.protocolCandidateObservations.relatedSubjectIdentifiers,
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
                    .where(
                      eq(schema.duneProtocolCandidateObservations.observationId, observation.id)
                    )
                    .limit(1)

            return {
              candidate,
              observation,
              duneObservation,
            }
          })
        )
      )

      const providerMappingCountAfter = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({ value: count(schema.providerTransactionTypeMappings.id) })
              .from(schema.providerTransactionTypeMappings)
            return row?.value ?? 0
          })
        )
      )

      expect(result.observationCount).toBe(1)
      expect(result.candidates).toHaveLength(1)
      expect(rows.candidate, "Expected protocol candidate").toMatchObject({
        subjectKind: "program",
        subjectIdentifier: "dune-program-1",
        protocolNameHint: "Example DEX",
        categoryHint: "dex",
        mappingStatus: "pending_review",
      })
      expect(rows.observation, "Expected protocol candidate observation").toMatchObject({
        onchainDataSource: "dune",
        interactionCount: "1000",
        transactionCount: "800",
        uniqueActorCount: "250",
        sampleTransactionHashes: ["signature-1", "signature-2"],
      })
      expect(rows.observation?.onchainDataSourceObservationKey).toContain("7647495:1:")
      expect(rows.duneObservation, "Expected Dune observation metadata").toMatchObject({
        queryId: 7_647_495,
        queryName: "solana-dex-project-priority",
        queryVersion: 1,
      })
      expect(providerMappingCountAfter).toBe(providerMappingCountBefore)
    })
  )

  it.effect("imports a Solana Dune rankings file as candidates and observations", () =>
    Effect.gen(function* () {
      const rankingsFile = {
        schemaVersion: 1,
        chain: "solana",
        onchainDataSource: "dune",
        generatedAt: "2026-06-01T10:30:00.000Z",
        startDate: "2024-01-01",
        endDate: "2025-01-01",
        parameters: { samplesPerProject: 25, windowDays: 7 },
        executions: [],
        queries: [
          {
            queryId: 7_647_495,
            queryName: "solana-dex-project-priority",
            version: 1,
            kind: "dex-project-priority",
          },
        ],
        entries: [
          {
            subjectKind: "protocol",
            subjectIdentifier: "orca",
            protocolNameHint: "orca",
            categoryHint: "swap",
            canonicalProgramIds: ["dex-only-program"],
            period: "2024-01-01 to 2025-01-01",
            invocationCount: 12_345,
            uniqueSignerCount: 456,
            transactionCount: 789,
            volumeUsd: 250_000.5,
            sampleSignatures: ["sample-signature-1", "sample-signature-2"],
            queryId: 7_647_495,
            queryName: "solana-dex-project-priority",
            queryVersion: 1,
            retrievedAt: "2026-06-01T10:00:00.000Z",
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runRepository(
          importSolanaDuneRankingsFile({ file: rankingsFile, blockchainName: "solana" })
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
              .where(eq(schema.protocolCandidates.subjectIdentifier, "orca"))
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
                      relatedSubjectIdentifiers:
                        schema.protocolCandidateObservations.relatedSubjectIdentifiers,
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
                    .where(
                      eq(schema.duneProtocolCandidateObservations.observationId, observation.id)
                    )
                    .limit(1)

            return { candidate, observation, duneObservation }
          })
        )
      )

      expect(result.observationCount).toBe(1)
      expect(result.candidates).toHaveLength(1)
      expect(rows.candidate, "Expected imported protocol candidate").toMatchObject({
        subjectKind: "protocol",
        subjectIdentifier: "orca",
        protocolNameHint: "orca",
        categoryHint: "swap",
        mappingStatus: "pending_review",
      })
      expect(rows.observation, "Expected imported protocol candidate observation").toMatchObject({
        observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")),
        observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        interactionCount: "12345",
        transactionCount: "789",
        uniqueActorCount: "456",
        relatedSubjectIdentifiers: ["dex-only-program"],
        sampleTransactionHashes: ["sample-signature-1", "sample-signature-2"],
        retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
      })
      expect(rows.observation?.rawPayload).toMatchObject({
        subjectKind: "protocol",
        subjectIdentifier: "orca",
        protocolNameHint: "orca",
        categoryHint: "swap",
        canonicalProgramIds: ["dex-only-program"],
        period: "2024-01-01 to 2025-01-01",
        invocationCount: 12_345,
        uniqueSignerCount: 456,
        transactionCount: 789,
        volumeUsd: 250_000.5,
        sampleSignatures: ["sample-signature-1", "sample-signature-2"],
        queryId: 7_647_495,
        queryName: "solana-dex-project-priority",
        queryVersion: 1,
        retrievedAt: "2026-06-01T10:00:00.000Z",
      })
      expect(rows.duneObservation, "Expected imported Dune observation metadata").toMatchObject({
        queryId: 7_647_495,
        queryName: "solana-dex-project-priority",
        queryVersion: 1,
      })
    })
  )

  it.effect(
    "updates existing candidates and observations on re-import without resetting review status",
    () =>
      Effect.gen(function* () {
        const observation = {
          blockchainName: "solana",
          subjectKind: "program" as const,
          subjectIdentifier: "dune-program-2",
          protocolNameHint: "Review Me",
          categoryHint: "dex",
          sourceObservationKey: "7647495:1:program:dune-program-2:2024-01-01:2025-01-01",
          observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")),
          observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          interactionCount: 100,
          transactionCount: 80,
          uniqueActorCount: 25,
          relatedSubjectIdentifiers: [],
          sampleTransactionHashes: ["signature-a"],
          retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
          rawPayload: { program_id: "dune-program-2", trade_rows: 100 },
          sourceMetadata: {
            source: "dune" as const,
            queryId: 7_647_495,
            queryName: "solana-dex-project-priority",
            queryVersion: 1,
          },
        }

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(ProtocolCandidateRepository, (repository) =>
              repository.importObservations({ observations: [observation] })
            )
          )
        )

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.protocolCandidates)
                .set({ mappingStatus: "approved" })
                .where(eq(schema.protocolCandidates.subjectIdentifier, "dune-program-2"))
            })
          )
        )

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(ProtocolCandidateRepository, (repository) =>
              repository.importObservations({
                observations: [
                  {
                    ...observation,
                    interactionCount: 250,
                    transactionCount: 200,
                    uniqueActorCount: 90,
                    sampleTransactionHashes: ["signature-b"],
                    retrievedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-06-02T10:00:00.000Z")
                    ),
                    rawPayload: { program_id: "dune-program-2", trade_rows: 250 },
                  },
                ],
              })
            )
          )
        )

        const rows = yield* Effect.promise(() =>
          runPg(
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
        )

        expect(rows.candidateCount).toBe(1)
        expect(rows.observationCount).toBe(1)
        expect(rows.candidate, "Expected protocol candidate").toMatchObject({
          protocolNameHint: "Review Me",
          mappingStatus: "approved",
          lastSeenAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-02T10:00:00.000Z")),
        })
        expect(rows.candidateObservation, "Expected protocol candidate observation").toMatchObject({
          interactionCount: "250",
          transactionCount: "200",
          uniqueActorCount: "90",
          sampleTransactionHashes: ["signature-b"],
        })
      })
  )

  it.effect("reopens an approved protocol candidate when re-import adds an uncovered program", () =>
    Effect.gen(function* () {
      const observation = {
        blockchainName: "solana",
        subjectKind: "protocol" as const,
        subjectIdentifier: "reopen-import-dex",
        protocolNameHint: "Reopen Import DEX",
        categoryHint: "dex",
        sourceObservationKey: "dune:reopen-import-dex",
        observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2026-05-01T00:00:00.000Z")),
        observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T00:00:00.000Z")),
        interactionCount: 100,
        transactionCount: 80,
        uniqueActorCount: 20,
        relatedSubjectIdentifiers: ["reopen-import-program-a"],
        sampleTransactionHashes: ["signature-a"],
        retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
        rawPayload: {
          canonicalProgramIds: ["reopen-import-program-a"],
          project: "reopen-import-dex",
        },
        sourceMetadata: {
          source: "dune" as const,
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          queryVersion: 1,
        },
      }

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({ observations: [observation] })
          )
        )
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [candidate] = yield* db
              .select({
                id: schema.protocolCandidates.id,
                blockchainId: schema.protocolCandidates.blockchainId,
              })
              .from(schema.protocolCandidates)
              .where(eq(schema.protocolCandidates.subjectIdentifier, "reopen-import-dex"))
              .limit(1)

            if (candidate === undefined) {
              return yield* Effect.die("Missing imported protocol candidate fixture")
            }

            yield* db.insert(schema.protocolTransactionTypeMappings).values({
              candidateId: candidate.id,
              blockchainId: candidate.blockchainId,
              subjectIdentifier: "reopen-import-program-a",
              protocolName: "Reopen Import DEX",
              movementPattern: "token_out_and_token_in",
              transactionTypeKey: "swap_crypto_to_crypto",
              inventoryEffect: "disposal",
              taxTreatment: "taxable_by_default",
              confidence: "0.9500",
              mappingStatus: "approved",
              version: 1,
              reviewerNotes: "Reviewed fixture",
              sourceNotes: null,
            })

            yield* db
              .update(schema.protocolCandidates)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.protocolCandidates.id, candidate.id))
          })
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({
              observations: [
                {
                  ...observation,
                  interactionCount: 250,
                  transactionCount: 200,
                  uniqueActorCount: 90,
                  relatedSubjectIdentifiers: ["reopen-import-program-a", "reopen-import-program-b"],
                  sampleTransactionHashes: ["signature-b"],
                  retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-02T10:00:00.000Z")),
                  rawPayload: {
                    canonicalProgramIds: ["reopen-import-program-a", "reopen-import-program-b"],
                    project: "reopen-import-dex",
                  },
                },
              ],
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
              .where(eq(schema.protocolCandidates.subjectIdentifier, "reopen-import-dex"))
              .limit(1)

            return candidate?.mappingStatus ?? null
          })
        )
      )

      expect(candidateStatus).toBe("pending_review")
    })
  )

  it.effect(
    "approves an imported protocol candidate when related subjects are already covered",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [blockchain] = yield* db
                .select({ id: schema.blockchains.id })
                .from(schema.blockchains)
                .where(eq(schema.blockchains.name, "solana"))
                .limit(1)

              if (blockchain === undefined) {
                return yield* Effect.die("Missing seeded solana blockchain fixture")
              }

              yield* db.insert(schema.protocolTransactionTypeMappings).values({
                candidateId: null,
                blockchainId: blockchain.id,
                subjectIdentifier: "already-covered-import-program",
                protocolName: "Already Covered DEX",
                movementPattern: "token_out_and_token_in",
                transactionTypeKey: "swap_crypto_to_crypto",
                inventoryEffect: "disposal",
                taxTreatment: "taxable_by_default",
                confidence: "0.9500",
                mappingStatus: "approved",
                version: 1,
                reviewerNotes: "Reviewed fixture",
                sourceNotes: null,
              })
            })
          )
        )

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(ProtocolCandidateRepository, (repository) =>
              repository.importObservations({
                observations: [
                  {
                    blockchainName: "solana",
                    subjectKind: "protocol",
                    subjectIdentifier: "already-covered-import-dex",
                    protocolNameHint: "Already Covered DEX",
                    categoryHint: "dex",
                    sourceObservationKey: "dune:already-covered-import-dex",
                    observedWindowStart: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-05-01T00:00:00.000Z")
                    ),
                    observedWindowEnd: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-06-01T00:00:00.000Z")
                    ),
                    interactionCount: 100,
                    transactionCount: 80,
                    uniqueActorCount: 20,
                    relatedSubjectIdentifiers: ["already-covered-import-program"],
                    sampleTransactionHashes: ["signature-a"],
                    retrievedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")
                    ),
                    rawPayload: {
                      canonicalProgramIds: ["already-covered-import-program"],
                      project: "already-covered-import-dex",
                    },
                    sourceMetadata: {
                      source: "dune",
                      queryId: 7_647_495,
                      queryName: "solana-dex-project-priority",
                      queryVersion: 1,
                    },
                  },
                ],
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
                .where(
                  eq(schema.protocolCandidates.subjectIdentifier, "already-covered-import-dex")
                )
                .limit(1)

              return candidate?.mappingStatus ?? null
            })
          )
        )

        expect(candidateStatus).toBe("approved")
      })
  )

  it.effect("keeps distinct same-window Dune observations when project hints differ", () =>
    Effect.gen(function* () {
      const baseObservation = {
        blockchainName: "solana",
        subjectKind: "program" as const,
        subjectIdentifier: "shared-dex-program",
        categoryHint: "swap",
        observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")),
        observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-08T00:00:00.000Z")),
        transactionCount: 80,
        uniqueActorCount: 25,
        relatedSubjectIdentifiers: [],
        sampleTransactionHashes: ["signature-a"],
        retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
        sourceMetadata: {
          source: "dune" as const,
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          queryVersion: 1,
        },
      }

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({
              observations: [
                {
                  ...baseObservation,
                  protocolNameHint: "raydium",
                  sourceObservationKey: "7647495:1:program:shared-dex-program:raydium:2024-01-01",
                  interactionCount: 100,
                  rawPayload: { project: "raydium" },
                },
                {
                  ...baseObservation,
                  protocolNameHint: "orca",
                  sourceObservationKey: "7647495:1:program:shared-dex-program:orca:2024-01-01",
                  interactionCount: 200,
                  rawPayload: { project: "orca" },
                },
              ],
            })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [candidateCountRow] = yield* db
              .select({ value: count(schema.protocolCandidates.id) })
              .from(schema.protocolCandidates)

            const observations = yield* db
              .select({
                key: schema.protocolCandidateObservations.onchainDataSourceObservationKey,
                interactionCount: schema.protocolCandidateObservations.interactionCount,
                rawPayload: schema.protocolCandidateObservations.rawPayload,
              })
              .from(schema.protocolCandidateObservations)

            return {
              candidateCount: candidateCountRow?.value ?? 0,
              observations,
            }
          })
        )
      )

      expect(rows.candidateCount).toBe(1)
      expect(rows.observations).toHaveLength(2)
      expect(rows.observations.map((row) => row.interactionCount).sort()).toEqual(["100", "200"])
      expect(rows.observations.map((row) => row.rawPayload)).toEqual(
        expect.arrayContaining([{ project: "raydium" }, { project: "orca" }])
      )
      expect(new Set(rows.observations.map((row) => row.key)).size).toBe(2)
    })
  )

  it.effect("refreshes non-null candidate hints on re-import", () =>
    Effect.gen(function* () {
      const observation = {
        blockchainName: "solana",
        subjectKind: "program" as const,
        subjectIdentifier: "renamed-dex-program",
        protocolNameHint: "Old DEX",
        categoryHint: "dex",
        sourceObservationKey: "7647495:1:program:renamed-dex-program:2024-01-01:2024-01-08",
        observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")),
        observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-08T00:00:00.000Z")),
        interactionCount: 100,
        transactionCount: 80,
        uniqueActorCount: 25,
        relatedSubjectIdentifiers: [],
        sampleTransactionHashes: ["signature-a"],
        retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")),
        rawPayload: { project: "old-dex" },
        sourceMetadata: {
          source: "dune" as const,
          queryId: 7_647_495,
          queryName: "solana-dex-project-priority",
          queryVersion: 1,
        },
      }

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({ observations: [observation] })
          )
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(ProtocolCandidateRepository, (repository) =>
            repository.importObservations({
              observations: [
                {
                  ...observation,
                  protocolNameHint: "New DEX",
                  categoryHint: "swap",
                  retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-02T10:00:00.000Z")),
                  rawPayload: { project: "new-dex" },
                },
              ],
            })
          )
        )
      )

      const row = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [candidate] = yield* db
              .select({
                protocolNameHint: schema.protocolCandidates.protocolNameHint,
                categoryHint: schema.protocolCandidates.categoryHint,
                lastSeenAt: schema.protocolCandidates.lastSeenAt,
              })
              .from(schema.protocolCandidates)
              .where(eq(schema.protocolCandidates.subjectIdentifier, "renamed-dex-program"))
              .limit(1)
            const [observationCountRow] = yield* db
              .select({ value: count(schema.protocolCandidateObservations.id) })
              .from(schema.protocolCandidateObservations)
            return {
              candidate,
              observationCount: observationCountRow?.value ?? 0,
            }
          })
        )
      )

      expect(row.candidate).toMatchObject({
        protocolNameHint: "New DEX",
        categoryHint: "swap",
        lastSeenAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-02T10:00:00.000Z")),
      })
      expect(row.observationCount).toBe(1)
    })
  )

  it.effect("rejects malformed batches without importing partial rows", () =>
    Effect.gen(function* () {
      const importResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(ProtocolCandidateRepository, (repository) =>
              repository.importObservations({
                observations: [
                  {
                    blockchainName: "solana",
                    subjectKind: "program",
                    subjectIdentifier: "valid-program",
                    protocolNameHint: null,
                    categoryHint: null,
                    sourceObservationKey: "7647495:1:program:valid-program:2024-01-01:2025-01-01",
                    observedWindowStart: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")
                    ),
                    observedWindowEnd: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")
                    ),
                    interactionCount: 10,
                    transactionCount: null,
                    uniqueActorCount: null,
                    relatedSubjectIdentifiers: [],
                    sampleTransactionHashes: [],
                    retrievedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")
                    ),
                    rawPayload: { program_id: "valid-program" },
                    sourceMetadata: {
                      source: "dune",
                      queryId: 7_647_495,
                      queryName: "solana-dex-project-priority",
                      queryVersion: 1,
                    },
                  },
                  {
                    blockchainName: "solana",
                    subjectKind: "program",
                    subjectIdentifier: "invalid-program",
                    protocolNameHint: null,
                    categoryHint: null,
                    sourceObservationKey: "7647495:1:program:invalid-program:2024-01-01:2025-01-01",
                    observedWindowStart: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")
                    ),
                    observedWindowEnd: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")
                    ),
                    interactionCount: -1,
                    transactionCount: null,
                    uniqueActorCount: null,
                    relatedSubjectIdentifiers: [],
                    sampleTransactionHashes: [],
                    retrievedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2026-06-01T10:00:00.000Z")
                    ),
                    rawPayload: { program_id: "invalid-program" },
                    sourceMetadata: {
                      source: "dune",
                      queryId: 7_647_495,
                      queryName: "solana-dex-project-priority",
                      queryVersion: 1,
                    },
                  },
                ],
              })
            )
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(importResult._tag).toBe("Failure")
      if (importResult._tag === "Success") {
        expect.fail("Expected malformed Dune observation import to fail")
      }
      expect(importResult.failure).toBeInstanceOf(SyncEngineStorageError)
      expect(rows).toEqual({
        candidateCount: 0,
        observationCount: 0,
        duneObservationCount: 0,
      })
    })
  )

  it.effect("rejects malformed Solana Dune rankings files with a structured error", () =>
    Effect.gen(function* () {
      const rankingsFile = {
        schemaVersion: 1,
        chain: "solana",
        onchainDataSource: "dune",
        generatedAt: "2026-06-01T10:30:00.000Z",
        startDate: "2024-01-01",
        endDate: "2025-01-01",
        parameters: { samplesPerProject: 25, windowDays: 7 },
        executions: [],
        queries: [],
        entries: [
          {
            subjectKind: "protocol",
            subjectIdentifier: "malformed-period-project",
            protocolNameHint: null,
            categoryHint: null,
            canonicalProgramIds: ["malformed-period-program"],
            period: "2024",
            invocationCount: 1,
            uniqueSignerCount: null,
            transactionCount: null,
            volumeUsd: null,
            sampleSignatures: [],
            queryId: 7_647_495,
            queryName: "solana-dex-project-priority",
            queryVersion: 1,
            retrievedAt: "2026-06-01T10:00:00.000Z",
          },
        ],
      }

      const importResult = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            importSolanaDuneRankingsFile({ file: rankingsFile, blockchainName: "solana" })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(importResult._tag).toBe("Failure")
      if (importResult._tag === "Success") {
        expect.fail("Expected malformed Solana Dune rankings file import to fail")
      }
      expect(importResult.failure).toBeInstanceOf(SolanaDuneRankingsFileImportError)
      expect(importResult.failure.message).toContain("Invalid period")
      expect(rows).toEqual({ candidateCount: 0, observationCount: 0 })
    })
  )
})
