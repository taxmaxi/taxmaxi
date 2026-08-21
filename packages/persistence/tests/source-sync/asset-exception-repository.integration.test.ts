import { AssetExceptionRepository } from "@my/sync-engine/services"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetExceptionRepositoryLive } from "../../src/layers/AssetExceptionRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_exception_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, AssetExceptionRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetExceptionRepositoryLive }))

const seedException = (suffix = "") =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const observedAt = new Date("2025-01-02T00:00:00.000Z")
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId: `exception-token${suffix}`,
          naturalKey: `currency_code:EXC${suffix}`,
          currencyCode: "EXC",
          name: "Exception Token",
          exponent: 6,
          providerType: "crypto",
          rawProviderPayload: { id: `exception-token${suffix}` },
          evidenceRevision: 2,
          discoveredAt: observedAt,
          retrievedAt: observedAt,
        })
        .returning({ id: schema.providerAssets.id })
      if (providerAsset === undefined) {
        return yield* Effect.die("Failed to seed provider asset")
      }

      yield* db.insert(schema.assetResolutionJobs).values({
        providerAssetRowId: providerAsset.id,
        evidenceRevision: 2,
        status: "completed",
      })
      const [decision] = yield* db
        .insert(schema.assetResolutionDecisions)
        .values({
          providerAssetRowId: providerAsset.id,
          evidenceRevision: 2,
          policyRevision: "test-policy.1",
          outcome: "pending",
          reason: "display_collision",
          actor: "policy:test-policy.1",
        })
        .returning({ id: schema.assetResolutionDecisions.id })
      if (decision === undefined) {
        return yield* Effect.die("Failed to seed resolution decision")
      }
      const [evidence] = yield* db
        .insert(schema.assetResolutionEvidence)
        .values({
          decisionId: decision.id,
          authority: "chain",
          claimKind: "representation",
          sourceLocator: `coinbase:exception-token${suffix}`,
          retrievedAt: observedAt,
          evidenceRevision: 2,
          decodedClaim: { blockchain: "base", decimals: 6 },
          rawPayload: { asset: "exception-token" },
        })
        .returning({ id: schema.assetResolutionEvidence.id })
      if (evidence === undefined) {
        return yield* Effect.die("Failed to seed evidence")
      }

      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId: TEST_SOURCE_ID,
      })
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          externalId: `exception-transaction${suffix}`,
          timestamp: observedAt,
          metadata: {
            provider: "coinbase",
            nativeAmount: { amount: "1250.50", currency: "EUR" },
          },
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.die("Failed to seed transaction")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId: TEST_SOURCE_ID,
        transactionId: transaction.id,
        externalId: `exception-transfer${suffix}`,
        providerAssetId: providerAsset.id,
        timestamp: observedAt,
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase:external",
        toAccountRef: "coinbase:user",
        amount: "10",
      })

      return {
        providerAssetRowId: providerAsset.id,
        decisionId: decision.id,
        evidenceId: evidence.id,
      }
    })
  )

beforeEach(async () => {
  await Effect.runPromise(context.recreateTestDatabase())
  await runPg(seedSyncEngineRepositoryFixture())
})

describe("AssetExceptionRepositoryLive", () => {
  it("lists completed domain exceptions with impact-ranked aggregate reach", async () => {
    const fixture = await seedException()

    const rows = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.listExceptions({ cursor: null, limit: 10 })
      })
    )

    expect(rows).toEqual([
      expect.objectContaining({
        providerAssetRowId: fixture.providerAssetRowId,
        reason: "display_collision",
        severity: "medium",
        blockedReports: 1,
        affectedPrincipals: 1,
        affectedTransactions: 1,
        affectedSources: 1,
        affectedTransactionValueEur: "1250.50",
      }),
    ])
  })

  it("previews and atomically accepts a typed exclusion", async () => {
    const fixture = await seedException()
    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: { _tag: "exclusion", reason: "confirmed_spam" } as const,
      evidenceRevision: 2,
      activeDecisionRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: "The stored chain evidence confirms the provider observation is spam.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "none" as const,
      expectedRepresentationOutcome: "none" as const,
    }

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const preview = yield* repository.previewDecision(input)
        const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
        return { preview, submitted }
      })
    )

    expect(result.preview).toMatchObject({
      _tag: "ready",
      preview: {
        assetOutcome: "none",
        representationOutcome: "none",
        rematerializationSourceCount: 1,
      },
    })
    expect(result.submitted).toMatchObject({
      _tag: "accepted",
      detail: {
        reviewStatus: "excluded",
        rematerialization: { status: "pending", affectedSourceCount: 1 },
      },
    })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const decisions = yield* db
          .select({
            status: schema.assetResolutionDecisions.status,
            outcome: schema.assetResolutionDecisions.outcome,
          })
          .from(schema.assetResolutionDecisions)
        const mappings = yield* db
          .select({ status: schema.providerAssetMappings.mappingStatus })
          .from(schema.providerAssetMappings)
        const work = yield* db
          .select({
            sourceId: schema.assetDecisionRematerializations.sourceId,
            processingJobId: schema.assetDecisionRematerializations.processingJobId,
          })
          .from(schema.assetDecisionRematerializations)
        return { decisions, mappings, work }
      })
    )

    expect(state.decisions).toEqual(
      expect.arrayContaining([
        { status: "superseded", outcome: "pending" },
        { status: "active", outcome: "excluded" },
      ])
    )
    expect(state.mappings).toEqual([{ status: "excluded" }])
    expect(state.work).toEqual([{ sourceId: TEST_SOURCE_ID, processingJobId: expect.any(String) }])

    const processingJobId = state.work[0]?.processingJobId
    if (processingJobId === undefined || processingJobId === null) {
      throw new Error("Expected rematerialization processing job")
    }
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(schema.processingJobs.id, processingJobId))
      })
    )
    const completedDetail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected completed exception detail")
        }
        return found.value
      })
    )

    expect(completedDetail.rematerialization.status).toBe("complete")

    const failedAt = new Date("2026-08-21T18:00:00.000Z")
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "failed", completedAt: failedAt })
          .where(eq(schema.processingJobs.id, processingJobId))
      })
    )
    const failedDetail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected failed exception detail")
        }
        return found.value
      })
    )

    expect(failedDetail.rematerialization).toMatchObject({
      status: "operator_attention",
      failedSourceCount: 1,
      lastFailureAt: failedAt,
      failureCode: "rematerialization_failed",
    })
  })

  it("returns a stale revision without adding another decision or work item", async () => {
    const fixture = await seedException()
    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: { _tag: "exclusion", reason: "provider_artifact" } as const,
      evidenceRevision: 2,
      activeDecisionRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: "The provider generated this observation as an internal artifact.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "none" as const,
      expectedRepresentationOutcome: "none" as const,
    }

    const results = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const accepted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
        const stale = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
        return { accepted, stale }
      })
    )

    expect(results.accepted._tag).toBe("accepted")
    expect(results.stale).toMatchObject({ _tag: "stale_revision", evidenceRevision: 2 })

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const decisions = yield* db
          .select({ id: schema.assetResolutionDecisions.id })
          .from(schema.assetResolutionDecisions)
        const work = yield* db
          .select({ sourceId: schema.assetDecisionRematerializations.sourceId })
          .from(schema.assetDecisionRematerializations)
        return { decisions: decisions.length, work: work.length }
      })
    )

    expect(counts).toEqual({ decisions: 2, work: 1 })
  })

  it("derives and persists a new canonical identity from a declarative claim", async () => {
    const fixture = await seedException()
    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: {
        _tag: "identity",
        assetId: null,
        newAsset: { name: "Exception Coin", symbol: "EXC", type: "fungible" },
        representation: null,
      } as const,
      evidenceRevision: 2,
      activeDecisionRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: "The provider evidence identifies this as a distinct fungible economic asset.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "create" as const,
      expectedRepresentationOutcome: "none" as const,
    }

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const preview = yield* repository.previewDecision(input)
        const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
        return { preview, submitted }
      })
    )

    expect(result.preview).toMatchObject({
      _tag: "ready",
      preview: { assetOutcome: "create", representationOutcome: "none" },
    })
    expect(result.submitted).toMatchObject({
      _tag: "accepted",
      detail: { reviewStatus: "approved" },
    })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const assets = yield* db
          .select({ id: schema.assets.id, name: schema.assets.name, symbol: schema.assets.symbol })
          .from(schema.assets)
          .where(eq(schema.assets.name, "Exception Coin"))
        const mappings = yield* db
          .select({
            assetId: schema.providerAssetMappings.canonicalAssetId,
            status: schema.providerAssetMappings.mappingStatus,
          })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        return { assets, mappings }
      })
    )

    expect(state.assets).toEqual([
      expect.objectContaining({ name: "Exception Coin", symbol: "EXC" }),
    ])
    expect(state.mappings).toEqual([{ assetId: state.assets[0]?.id, status: "approved" }])
  })

  it("serializes concurrent claims for the same new canonical identity", async () => {
    const [first, second] = await Promise.all([seedException("-a"), seedException("-b")])
    const submit = (fixture: Awaited<ReturnType<typeof seedException>>) =>
      runRepository(
        Effect.gen(function* () {
          const repository = yield* AssetExceptionRepository
          return yield* repository.submitDecision({
            actorId: TEST_USER_ID,
            input: {
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: {
                  name: "Concurrent Exception Coin",
                  symbol: "CEC",
                  type: "fungible",
                },
                representation: null,
              },
              evidenceRevision: 2,
              activeDecisionRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Concurrent observations identify the same economic asset.",
              expectedResultingAssetId: null,
              expectedAssetOutcome: "create",
              expectedRepresentationOutcome: "none",
            },
          })
        })
      )

    const results = await Promise.all([submit(first), submit(second)])

    expect(results.map((result) => result._tag).sort()).toEqual(["accepted", "identity_changed"])
    const assets = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.name, "Concurrent Exception Coin"))
      })
    )
    expect(assets).toHaveLength(1)
  })

  it("supports exact lookup after the exception leaves the queue", async () => {
    const fixture = await seedException()

    const detail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "provider_asset_id",
          provider: "coinbase",
          providerAssetId: "exception-token",
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected exception detail")
        }
        return found.value
      })
    )

    expect(detail).toMatchObject({
      providerAssetRowId: fixture.providerAssetRowId,
      policyOutput: { outcome: "pending", reason: "display_collision" },
      evidence: [expect.objectContaining({ id: fixture.evidenceId, authority: "chain" })],
      impact: { affectedSources: 1, affectedTransactions: 1 },
    })
  })
})
