import { NO_CURRENT_ASSET_CONCLUSION, NO_CURRENT_ASSET_POLICY_EVALUATION } from "@my/core/assets"
import { AssetExceptionRepository } from "@my/sync-engine/services"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
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

const seedException = (
  suffix = "",
  {
    sourceId = TEST_SOURCE_ID,
    principalId = TEST_PRINCIPAL_ID,
  }: { readonly sourceId?: string; readonly principalId?: string } = {}
) =>
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
      // The actionable evaluation is created after the observation was first
      // discovered; ranking must age the case from this later timestamp.
      const evaluatedAt = new Date("2025-01-05T00:00:00.000Z")
      const [decision] = yield* db
        .insert(schema.assetResolutionDecisions)
        .values({
          providerAssetRowId: providerAsset.id,
          evidenceRevision: 2,
          policyRevision: "test-policy.1",
          outcome: "pending",
          reason: "display_collision",
          actor: "policy:test-policy.1",
          createdAt: evaluatedAt,
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
        sourceId,
      })
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId,
          principalId,
          externalId: `exception-transaction${suffix}`,
          timestamp: observedAt,
          metadata: {
            provider: "coinbase",
            nativeAmount: { amount: "1250.50", currency: "EUR" },
          },
          providerFiatAmount: "1250.50",
          providerFiatCurrency: "EUR",
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.die("Failed to seed transaction")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId,
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
        return yield* repository.listExceptions({ cursor: null, limit: 10, query: null })
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
        // The case ages from the actionable evaluation, not from the earlier
        // provider observation discovery.
        oldestAt: new Date("2025-01-05T00:00:00.000Z"),
      }),
    ])
  })

  it("filters exceptions by a search query across provider keys and names", async () => {
    const fixture = await seedException()

    const { matchingName, matchingNaturalKey, noMatch } = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const matchingName = yield* repository.listExceptions({
          cursor: null,
          limit: 10,
          query: "exception token",
        })
        const matchingNaturalKey = yield* repository.listExceptions({
          cursor: null,
          limit: 10,
          query: "currency_code:EXC",
        })
        const noMatch = yield* repository.listExceptions({
          cursor: null,
          limit: 10,
          query: "unrelated-asset",
        })
        return { matchingName, matchingNaturalKey, noMatch }
      })
    )

    expect(matchingName).toEqual([
      expect.objectContaining({ providerAssetRowId: fixture.providerAssetRowId }),
    ])
    expect(matchingNaturalKey).toEqual([
      expect.objectContaining({ providerAssetRowId: fixture.providerAssetRowId }),
    ])
    expect(noMatch).toEqual([])
  })

  it("previews and atomically accepts a typed exclusion without a free-text rationale", async () => {
    const fixture = await seedException()
    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: { _tag: "exclusion", reason: "confirmed_spam" } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: null,
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
        impact: { blockedReports: 1, affectedSources: 1 },
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
            rationale: schema.assetResolutionDecisions.rationale,
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
        { status: "active", outcome: "pending", rationale: null },
        { status: "active", outcome: "excluded", rationale: null },
      ])
    )
    expect(state.mappings).toEqual([{ status: "excluded" }])
    expect(state.work).toEqual([{ sourceId: TEST_SOURCE_ID, processingJobId: expect.any(String) }])

    const processingJobId = state.work[0]?.processingJobId
    if (processingJobId === undefined || processingJobId === null) {
      throw new Error("Expected rematerialization processing job")
    }
    // The job lifecycle settles rebuild rows when a replay finishes
    // (covered by source-sync-job-repository tests); readers trust the
    // stored row status.
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(schema.processingJobs.id, processingJobId))
        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ status: "complete" })
          .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
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

    expect(completedDetail).toMatchObject({
      impact: { blockedReports: 0, affectedSources: 1 },
      rematerialization: { status: "complete" },
    })

    const completedFollowUpJobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [followUpJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "completed",
          })
          .returning({ id: schema.processingJobs.id })
        if (followUpJob === undefined) {
          return yield* Effect.die("Expected completed replay follow-up")
        }
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "failed",
            followUpMode: "replay",
            followUpJobId: followUpJob.id,
          })
          .where(eq(schema.processingJobs.id, processingJobId))
        // Follow-up materialization repoints unfinished rows to the new
        // replay job, and its completion settles them.
        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({ processingJobId: followUpJob.id, status: "complete" })
          .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
        return followUpJob.id
      })
    )
    const completedFollowUpDetail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected completed follow-up exception detail")
        }
        return found.value
      })
    )

    expect(completedFollowUpDetail).toMatchObject({
      impact: { blockedReports: 0, affectedSources: 1 },
      rematerialization: { status: "complete" },
    })

    const failedAt = new Date("2026-08-21T18:00:00.000Z")
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "failed",
            completedAt: failedAt,
            followUpMode: null,
            followUpJobId: null,
          })
          .where(eq(schema.processingJobs.id, processingJobId))
        yield* db
          .delete(schema.processingJobs)
          .where(eq(schema.processingJobs.id, completedFollowUpJobId))
        // A failed replay parks the rows at operator_attention; the reader
        // falls back to the generic failure code when none was stored.
        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({
            processingJobId,
            status: "operator_attention",
            failureCode: null,
            lastFailureAt: failedAt,
          })
          .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
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

    expect(failedDetail).toMatchObject({
      impact: { blockedReports: 1, affectedSources: 1 },
      rematerialization: {
        status: "operator_attention",
        failedSourceCount: 1,
        lastFailureAt: failedAt,
        failureCode: "rematerialization_failed",
      },
    })
  })

  it("reuses a pending replay without scheduling a redundant follow-up", async () => {
    const fixture = await seedException()
    const pendingReplayJobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [pendingReplay] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "pending",
          })
          .returning({ id: schema.processingJobs.id })
        if (pendingReplay === undefined) {
          return yield* Effect.die("Failed to seed pending replay job")
        }
        return pendingReplay.id
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.submitDecision({
          actorId: TEST_USER_ID,
          input: {
            providerAssetRowId: fixture.providerAssetRowId,
            claim: { _tag: "exclusion", reason: "confirmed_spam" },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: null,
            expectedResultingAssetId: null,
            expectedAssetOutcome: "none",
            expectedRepresentationOutcome: "none",
          },
        })
      })
    )

    expect(result).toMatchObject({ _tag: "accepted" })
    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const jobs = yield* db
          .select({
            id: schema.processingJobs.id,
            mode: schema.processingJobs.mode,
            status: schema.processingJobs.status,
            followUpMode: schema.processingJobs.followUpMode,
          })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        const work = yield* db
          .select({ processingJobId: schema.assetDecisionRematerializations.processingJobId })
          .from(schema.assetDecisionRematerializations)
        return { jobs, work }
      })
    )

    // The not-yet-started replay already rebuilds this decision when it
    // runs, so it is reused directly instead of being marked for a
    // follow-up replay that would leave its rebuild rows unsettled.
    expect(state.jobs).toEqual([
      { id: pendingReplayJobId, mode: "replay", status: "pending", followUpMode: null },
    ])
    expect(state.work).toEqual([{ processingJobId: pendingReplayJobId }])
  })

  it("still requires a rationale for an identity decision", async () => {
    const fixture = await seedException()
    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "Exception Token", symbol: "EXC", type: "fungible" },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: null,
        })
      })
    )

    expect(result).toEqual({ _tag: "invalid_evidence" })
  })

  it("returns a stale revision without adding another decision or work item", async () => {
    const fixture = await seedException()
    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: { _tag: "exclusion", reason: "provider_artifact" } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: fixture.decisionId,
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

  it("rejects confirmation when only the current policy evaluation changed", async () => {
    const fixture = await seedException()
    const newerPolicyEvaluationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [evaluation] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 2,
            policyRevision: "test-policy.2",
            outcome: "fail_closed",
            status: "active",
            reason: "ownership_conflict",
            actor: "policy:test-policy.2",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (evaluation === undefined) {
          return yield* Effect.die("Failed to seed replacement policy evaluation")
        }
        yield* db.insert(schema.assetResolutionCurrentState).values({
          providerAssetRowId: fixture.providerAssetRowId,
          currentConclusionId: null,
          currentPolicyEvaluationId: evaluation.id,
        })
        return evaluation.id
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.submitDecision({
          input: {
            providerAssetRowId: fixture.providerAssetRowId,
            claim: { _tag: "exclusion", reason: "provider_artifact" },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: null,
            expectedResultingAssetId: null,
            expectedAssetOutcome: "none",
            expectedRepresentationOutcome: "none",
          },
          actorId: TEST_USER_ID,
        })
      })
    )

    expect(result).toEqual({
      _tag: "stale_revision",
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: newerPolicyEvaluationId,
    })
    const work = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.assetDecisionRematerializations)
      })
    )
    expect(work).toEqual([])
  })

  it("rolls back every write when the final current-state compare-and-set misses", async () => {
    const fixture = await seedException()
    const newerPolicyEvaluationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [evaluation] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 2,
            policyRevision: "test-policy.cas-race",
            outcome: "fail_closed",
            reason: "ownership_conflict",
            actor: "policy:test-policy.cas-race",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (evaluation === undefined) {
          return yield* Effect.die("Failed to seed competing policy evaluation")
        }
        yield* db.insert(schema.assetResolutionCurrentState).values({
          providerAssetRowId: fixture.providerAssetRowId,
          currentConclusionId: null,
          currentPolicyEvaluationId: fixture.decisionId,
        })
        return evaluation.id
      })
    )
    const readWriteCounts = () =>
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const decisions = yield* db
            .select({ id: schema.assetResolutionDecisions.id })
            .from(schema.assetResolutionDecisions)
          const mappings = yield* db
            .select({ id: schema.providerAssetMappings.id })
            .from(schema.providerAssetMappings)
          const work = yield* db
            .select({ decisionId: schema.assetDecisionRematerializations.decisionId })
            .from(schema.assetDecisionRematerializations)
          return { decisions: decisions.length, mappings: mappings.length, work: work.length }
        })
      )
    const before = await readWriteCounts()

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.execute(
          sql.raw(`
            create function advance_asset_policy_during_human_insert() returns trigger
            language plpgsql as $trigger$
            begin
              if new.human_claim is not null then
                update asset_resolution_current_state
                set current_policy_evaluation_id = '${newerPolicyEvaluationId}'::uuid
                where provider_asset_row_id = new.provider_asset_row_id;
              end if;
              return new;
            end
            $trigger$
          `)
        )
        yield* db.execute(sql`
          create trigger advance_asset_policy_during_human_insert
          after insert on asset_resolution_decisions
          for each row execute function advance_asset_policy_during_human_insert()
        `)
      })
    )

    const result = await runRepository(
      Effect.flatMap(AssetExceptionRepository, (repository) =>
        repository.submitDecision({
          input: {
            providerAssetRowId: fixture.providerAssetRowId,
            claim: { _tag: "exclusion", reason: "provider_artifact" },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: null,
            expectedResultingAssetId: null,
            expectedAssetOutcome: "none",
            expectedRepresentationOutcome: "none",
          },
          actorId: TEST_USER_ID,
        })
      )
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.execute(
          sql`drop trigger advance_asset_policy_during_human_insert on asset_resolution_decisions`
        )
        yield* db.execute(sql`drop function advance_asset_policy_during_human_insert()`)
      })
    )

    expect(result).toMatchObject({
      _tag: "stale_revision",
      currentPolicyEvaluationRevision: fixture.decisionId,
    })
    expect(await readWriteCounts()).toEqual(before)
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
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: fixture.decisionId,
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

  it("requires Helius identity claims to match the observed representation", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({
            provider: "helius-solana",
            providerAssetId: "ObservedMint111",
            naturalKey: "solana:mint:ObservedMint111",
            providerType: "spl-token",
            exponent: 6,
          })
          .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
      })
    )

    const preview = (
      representation: {
        readonly blockchain: string
        readonly type: "token"
        readonly contractAddress: null
        readonly mintAddress: string
        readonly decimals: number
      } | null
    ) =>
      runRepository(
        Effect.gen(function* () {
          const repository = yield* AssetExceptionRepository
          return yield* repository.previewDecision({
            providerAssetRowId: fixture.providerAssetRowId,
            claim: {
              _tag: "identity",
              assetId: null,
              newAsset: { name: "Observed Asset", symbol: "OBS", type: "fungible" },
              representation,
            },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: "The exact Solana representation is confirmed by stored evidence.",
          })
        })
      )

    await expect(preview(null)).resolves.toMatchObject({ _tag: "invalid_claim" })
    await expect(
      preview({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: "DifferentMint222",
        decimals: 6,
      })
    ).resolves.toMatchObject({ _tag: "invalid_claim" })
    await expect(
      preview({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: "ObservedMint111",
        decimals: 6,
      })
    ).resolves.toMatchObject({ _tag: "ready" })

    // Older stored evidence can disagree with the latest provider metadata,
    // and replay validates every stored row against the approved mapping. A
    // claim that matches only the latest metadata must be rejected, or the
    // accepted decision would fail its rebuild every time.
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [solana] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "solana"))
        if (solana === undefined) {
          return yield* Effect.die("Missing seeded solana blockchain")
        }
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: solana.id,
            observedRepresentationType: "token",
            observedMintAddress: "ObservedMint111",
            observedDecimals: 9,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
      })
    )
    await expect(
      preview({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: "ObservedMint111",
        decimals: 6,
      })
    ).resolves.toMatchObject({ _tag: "invalid_claim" })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerTransfers)
          .set({ observedDecimals: 6 })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
      })
    )
    await expect(
      preview({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: "ObservedMint111",
        decimals: 6,
      })
    ).resolves.toMatchObject({ _tag: "ready" })
  })

  it("rejects representations for chainless observations", async () => {
    const fixture = await seedException()

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "Chainless Asset", symbol: "CHA", type: "fungible" },
            representation: {
              blockchain: "base",
              type: "token",
              contractAddress: "0x0000000000000000000000000000000000000001",
              mintAddress: null,
              decimals: 6,
            },
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "A chainless provider observation cannot prove an on-chain representation.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "invalid_claim" })
  })

  it("rejects chainless claims when a chain representation was observed", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        if (blockchain === undefined) {
          return yield* Effect.die("Missing seeded base blockchain")
        }
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "token",
            observedContractAddress: "0x-observed-chain-identity",
            observedDecimals: 6,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "Chainless Claim", symbol: "CHC", type: "fungible" },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "An approved mapping without a representation cannot satisfy replay.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "invalid_claim" })
  })

  it("rejects identity claims that match only part of the stored observations", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        if (blockchain === undefined) {
          return yield* Effect.die("Missing seeded base blockchain")
        }
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "token",
            observedContractAddress: "0x-partial-match",
            observedDecimals: 6,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
        const [transaction] = yield* db
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(eq(schema.transactions.externalId, "exception-transaction"))
          .limit(1)
        if (transaction === undefined) {
          return yield* Effect.die("Missing seeded transaction")
        }
        // A second stored observation disagrees on decimals, so replay would
        // fail while re-validating it against the approved mapping.
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "exception-transfer-conflicting",
          providerAssetId: fixture.providerAssetRowId,
          timestamp: new Date("2025-01-02T01:00:00.000Z"),
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase:external",
          toAccountRef: "coinbase:user",
          amount: "5",
          observedBlockchainId: blockchain.id,
          observedRepresentationType: "token",
          observedContractAddress: "0x-partial-match",
          observedDecimals: 9,
        })
      })
    )

    const preview = (decimals: number) =>
      runRepository(
        Effect.gen(function* () {
          const repository = yield* AssetExceptionRepository
          return yield* repository.previewDecision({
            providerAssetRowId: fixture.providerAssetRowId,
            claim: {
              _tag: "identity",
              assetId: null,
              newAsset: { name: "Partial Match Asset", symbol: "PMA", type: "fungible" },
              representation: {
                blockchain: "base",
                type: "token",
                contractAddress: "0x-partial-match",
                mintAddress: null,
                decimals,
              },
            },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: "Every stored observation must stay compatible with the claim.",
          })
        })
      )

    await expect(preview(6)).resolves.toMatchObject({ _tag: "invalid_claim" })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerTransfers)
          .set({ observedDecimals: 6 })
          .where(eq(schema.providerTransfers.externalId, "exception-transfer-conflicting"))
      })
    )
    await expect(preview(6)).resolves.toMatchObject({ _tag: "ready" })
  })

  it("rejects chainless identity claims incompatible with the provider asset type", async () => {
    const fiatFixture = await seedException("-fiat-claim")
    const nftFixture = await seedException("-nft-claim")
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ providerType: "fiat" })
          .where(eq(schema.providerAssets.id, fiatFixture.providerAssetRowId))
      })
    )

    const results = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const fiatAsAsset = yield* repository.previewDecision({
          providerAssetRowId: fiatFixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "Fiat as asset", symbol: "FIA", type: "fungible" },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fiatFixture.decisionId,
          evidenceSnapshotIds: [fiatFixture.evidenceId],
          rationale: "A fiat observation must not become an economic asset mapping.",
        })
        const cryptoAsNft = yield* repository.previewDecision({
          providerAssetRowId: nftFixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "Crypto NFT", symbol: "CNF", type: "nft" },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: nftFixture.decisionId,
          evidenceSnapshotIds: [nftFixture.evidenceId],
          rationale: "A chainless crypto observation must remain fungible.",
        })
        return { fiatAsAsset, cryptoAsNft }
      })
    )

    expect(results.fiatAsAsset).toMatchObject({ _tag: "invalid_claim" })
    expect(results.cryptoAsNft).toMatchObject({ _tag: "invalid_claim" })
  })

  it("rejects a representation incompatible with an existing asset type", async () => {
    const fixture = await seedException()
    const assetId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        const [asset] = yield* db
          .insert(schema.assets)
          .values({ name: "Fungible Target", symbol: "FUN", type: "fungible" })
          .returning({ id: schema.assets.id })
        if (asset === undefined || blockchain === undefined) {
          return yield* Effect.die("Failed to seed target asset")
        }
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "nft",
            observedContractAddress: "0x-fungible-target",
            observedDecimals: 0,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
        return asset.id
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId,
            newAsset: null,
            representation: {
              blockchain: "base",
              type: "nft",
              contractAddress: "0x-fungible-target",
              mintAddress: null,
              decimals: 0,
            },
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "Attempt to attach an incompatible NFT representation.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "ambiguous_identity" })
  })

  it("reassigns representation ownership and rematerializes every mapped observation", async () => {
    const secondUserId = "00000000-0000-4000-8000-000000000311"
    const secondPrincipalId = "00000000-0000-4000-8000-000000000312"
    const secondSourceId = "00000000-0000-4000-8000-000000000313"
    await runPg(
      seedSyncEngineRepositoryFixture({
        userId: secondUserId,
        principalId: secondPrincipalId,
        sourceId: secondSourceId,
      })
    )
    const [first, second] = await Promise.all([
      seedException("-ownership-a"),
      seedException("-ownership-b", {
        sourceId: secondSourceId,
        principalId: secondPrincipalId,
      }),
    ])
    const seeded = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        const [oldAsset, replacementAsset] = yield* db
          .insert(schema.assets)
          .values([
            { name: "Old Owner", symbol: "OLD", type: "fungible" },
            { name: "Correct Owner", symbol: "RIGHT", type: "fungible" },
          ])
          .returning({ id: schema.assets.id, symbol: schema.assets.symbol })
        if (blockchain === undefined || oldAsset === undefined || replacementAsset === undefined) {
          return yield* Effect.die("Failed to seed ownership correction assets")
        }
        const owner = oldAsset.symbol === "OLD" ? oldAsset : replacementAsset
        const replacement = oldAsset.symbol === "RIGHT" ? oldAsset : replacementAsset
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: owner.id,
            blockchainId: blockchain.id,
            type: "token",
            contractAddress: "0xownership-correction",
            decimals: 6,
          })
          .returning({ id: schema.assetRepresentations.id })
        if (representation === undefined) {
          return yield* Effect.die("Failed to seed owned representation")
        }
        const [ownership] = yield* db
          .insert(schema.assetRepresentationOwnershipDecisions)
          .values({
            assetRepresentationId: representation.id,
            assetId: owner.id,
            policyRevision: "test-policy.1",
            actor: "policy:test-policy.1",
          })
          .returning({ id: schema.assetRepresentationOwnershipDecisions.id })
        if (ownership === undefined) {
          return yield* Effect.die("Failed to seed ownership decision")
        }
        yield* db.insert(schema.providerAssetMappings).values(
          [first.providerAssetRowId, second.providerAssetRowId].map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            canonicalAssetId: owner.id,
            assetRepresentationId: representation.id,
            mappingStatus: "approved" as const,
          }))
        )
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "token",
            observedContractAddress: "0xownership-correction",
            observedDecimals: 6,
          })
          .where(
            inArray(schema.providerTransfers.providerAssetId, [
              first.providerAssetRowId,
              second.providerAssetRowId,
            ])
          )
        return {
          oldAssetId: owner.id,
          replacementAssetId: replacement.id,
          representationId: representation.id,
          ownershipId: ownership.id,
        }
      })
    )

    const input = {
      providerAssetRowId: first.providerAssetRowId,
      claim: {
        _tag: "identity",
        assetId: seeded.replacementAssetId,
        newAsset: null,
        representation: {
          blockchain: "base",
          type: "token",
          contractAddress: "0xownership-correction",
          mintAddress: null,
          decimals: 6,
        },
      } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: first.decisionId,
      evidenceSnapshotIds: [first.evidenceId],
      rationale: "The representation belongs to the replacement economic asset.",
      expectedResultingAssetId: seeded.replacementAssetId,
      expectedAssetOutcome: "reuse" as const,
      expectedRepresentationOutcome: "reassign" as const,
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
        representationOutcome: "reassign",
        impact: { affectedPrincipals: 2, affectedTransactions: 2, affectedSources: 2 },
        rematerializationSourceCount: 2,
      },
    })
    expect(result.submitted).toMatchObject({ _tag: "accepted" })

    const persisted = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .select({ assetId: schema.assetRepresentations.assetId })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.id, seeded.representationId))
        const mappings = yield* db
          .select({ assetId: schema.providerAssetMappings.canonicalAssetId })
          .from(schema.providerAssetMappings)
          .where(
            inArray(schema.providerAssetMappings.providerAssetRowId, [
              first.providerAssetRowId,
              second.providerAssetRowId,
            ])
          )
        const ownership = yield* db
          .select({
            assetId: schema.assetRepresentationOwnershipDecisions.assetId,
            supersedesDecisionId: schema.assetRepresentationOwnershipDecisions.supersedesDecisionId,
          })
          .from(schema.assetRepresentationOwnershipDecisions)
          .where(
            eq(
              schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
              seeded.representationId
            )
          )
          .orderBy(asc(schema.assetRepresentationOwnershipDecisions.createdAt))
        const currentStates = yield* db
          .select({
            providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
            currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
          })
          .from(schema.assetResolutionCurrentState)
          .where(
            inArray(schema.assetResolutionCurrentState.providerAssetRowId, [
              first.providerAssetRowId,
              second.providerAssetRowId,
            ])
          )
        const work = yield* db
          .select({ decisionId: schema.assetDecisionRematerializations.decisionId })
          .from(schema.assetDecisionRematerializations)
        return { representation, mappings, ownership, currentStates, work }
      })
    )

    expect(persisted.representation?.assetId).toBe(seeded.replacementAssetId)
    expect(persisted.mappings).toEqual([
      { assetId: seeded.replacementAssetId },
      { assetId: seeded.replacementAssetId },
    ])
    expect(persisted.ownership).toEqual([
      { assetId: seeded.oldAssetId, supersedesDecisionId: null },
      {
        assetId: seeded.replacementAssetId,
        supersedesDecisionId: seeded.ownershipId,
      },
    ])
    expect(persisted.currentStates).toHaveLength(2)
    expect(
      persisted.currentStates.every(({ currentConclusionId }) => currentConclusionId !== null)
    ).toBe(true)
    expect(persisted.work).toHaveLength(4)

    const focalDecisionId = persisted.currentStates.find(
      ({ providerAssetRowId }) => providerAssetRowId === first.providerAssetRowId
    )?.currentConclusionId
    if (focalDecisionId === null || focalDecisionId === undefined) {
      throw new Error("Expected the focal current conclusion")
    }
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.assetDecisionRematerializations)
          .set({
            status: "operator_attention",
            failureCode: "related_source_failed",
            lastFailureAt: new Date("2026-08-26T12:00:00.000Z"),
          })
          .where(
            and(
              eq(schema.assetDecisionRematerializations.decisionId, focalDecisionId),
              eq(schema.assetDecisionRematerializations.sourceId, secondSourceId)
            )
          )
      })
    )
    const detailWithRelatedFailure = await runRepository(
      Effect.flatMap(AssetExceptionRepository, (repository) =>
        repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: first.providerAssetRowId,
        })
      )
    )
    expect(Option.getOrNull(detailWithRelatedFailure)?.rematerialization).toMatchObject({
      status: "operator_attention",
      affectedSourceCount: 2,
      failedSourceCount: 1,
      failureCode: "related_source_failed",
    })

    for (const assetId of [seeded.oldAssetId, seeded.replacementAssetId]) {
      const latest = await runRepository(
        Effect.flatMap(AssetExceptionRepository, (repository) =>
          repository.findDetail({
            _tag: "row_id",
            providerAssetRowId: first.providerAssetRowId,
          })
        )
      )
      const detail = Option.getOrNull(latest)
      if (detail === null) {
        throw new Error("Expected ownership correction detail")
      }
      const correction = {
        ...input,
        claim: { ...input.claim, assetId },
        currentConclusionRevision: detail.currentConclusionRevision,
        currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
        expectedResultingAssetId: assetId,
      }
      const correctionResult = await runRepository(
        Effect.gen(function* () {
          const repository = yield* AssetExceptionRepository
          const preview = yield* repository.previewDecision(correction)
          const submitted = yield* repository.submitDecision({
            input: correction,
            actorId: TEST_USER_ID,
          })
          return { preview, submitted }
        })
      )
      expect(correctionResult.preview).toMatchObject({
        _tag: "ready",
        preview: { representationOutcome: "reassign" },
      })
      expect(correctionResult.submitted).toMatchObject({ _tag: "accepted" })
    }

    const ownershipChain = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            id: schema.assetRepresentationOwnershipDecisions.id,
            assetId: schema.assetRepresentationOwnershipDecisions.assetId,
            supersedesDecisionId: schema.assetRepresentationOwnershipDecisions.supersedesDecisionId,
          })
          .from(schema.assetRepresentationOwnershipDecisions)
          .where(
            eq(
              schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
              seeded.representationId
            )
          )
      })
    )
    const supersededIds = new Set(
      ownershipChain.flatMap(({ supersedesDecisionId }) =>
        supersedesDecisionId === null ? [] : [supersedesDecisionId]
      )
    )
    const tips = ownershipChain.filter(({ id }) => !supersededIds.has(id))
    expect(ownershipChain).toHaveLength(4)
    expect(tips).toEqual([expect.objectContaining({ assetId: seeded.replacementAssetId })])
  })

  it("keeps an active human decision visible after the evidence revision advances", async () => {
    const fixture = await seedException()
    const humanDecisionId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.assetResolutionDecisions)
          .set({ status: "superseded" })
          .where(eq(schema.assetResolutionDecisions.id, fixture.decisionId))
        const [humanDecision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 2,
            policyRevision: "human-test.1",
            outcome: "excluded",
            status: "active",
            supersedesDecisionId: fixture.decisionId,
            reason: "confirmed_spam",
            humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
            rationale: "Human evidence settles the observation.",
            actor: TEST_USER_ID,
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (humanDecision === undefined) {
          return yield* Effect.die("Failed to seed human decision")
        }
        yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
          decisionId: humanDecision.id,
          evidenceId: fixture.evidenceId,
        })

        yield* db
          .update(schema.providerAssets)
          .set({ evidenceRevision: 3 })
          .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
        return humanDecision.id
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected exception detail")
        }
        const preview = yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: { _tag: "exclusion", reason: "provider_artifact" },
          evidenceRevision: 3,
          currentConclusionRevision: humanDecisionId,
          currentPolicyEvaluationRevision: NO_CURRENT_ASSET_POLICY_EVALUATION,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "The active settled evidence remains available for supersession.",
        })
        return { detail: found.value, preview }
      })
    )

    expect(result.detail).toMatchObject({
      reviewStatus: "excluded",
      currentConclusionRevision: humanDecisionId,
      currentPolicyEvaluationRevision: NO_CURRENT_ASSET_POLICY_EVALUATION,
      currentConclusion: { id: humanDecisionId, evidenceRevision: 2 },
      currentPolicyEvaluation: null,
      evidence: [expect.objectContaining({ id: fixture.evidenceId, evidenceRevision: 2 })],
    })
    expect(result.preview).toMatchObject({ _tag: "ready" })
  })

  it("supersedes the current conclusion while preserving the current policy evaluation", async () => {
    const fixture = await seedException()
    const seeded = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.assetResolutionDecisions)
          .set({ status: "superseded" })
          .where(eq(schema.assetResolutionDecisions.id, fixture.decisionId))
        const [humanDecision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 2,
            policyRevision: "human-test.1",
            outcome: "excluded",
            status: "active",
            supersedesDecisionId: fixture.decisionId,
            reason: "confirmed_spam",
            humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
            rationale: "Human evidence settles the observation.",
            actor: TEST_USER_ID,
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (humanDecision === undefined) {
          return yield* Effect.die("Failed to seed human decision")
        }
        yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
          decisionId: humanDecision.id,
          evidenceId: fixture.evidenceId,
        })
        yield* db
          .update(schema.providerAssets)
          .set({ evidenceRevision: 3 })
          .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
        yield* db
          .update(schema.assetResolutionJobs)
          .set({ evidenceRevision: 3 })
          .where(eq(schema.assetResolutionJobs.providerAssetRowId, fixture.providerAssetRowId))
        // New evidence reopens review with an active policy evaluation at
        // revision 3 while the human conclusion stays active at revision 2.
        // A single administrator superseding their own conclusion must not
        // collide with the policy row in the active-per-revision slot.
        const [policyRecheck] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 3,
            policyRevision: "test-policy.2",
            outcome: "pending",
            status: "active",
            reason: "display_collision",
            actor: "policy:test-policy.2",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (policyRecheck === undefined) {
          return yield* Effect.die("Failed to seed policy re-check decision")
        }
        yield* db
          .insert(schema.assetResolutionCurrentState)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            currentConclusionId: humanDecision.id,
            currentPolicyEvaluationId: policyRecheck.id,
          })
          .onConflictDoUpdate({
            target: schema.assetResolutionCurrentState.providerAssetRowId,
            set: {
              currentConclusionId: humanDecision.id,
              currentPolicyEvaluationId: policyRecheck.id,
            },
          })
        return { humanDecisionId: humanDecision.id, policyRecheckId: policyRecheck.id }
      })
    )

    const review = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const queue = yield* repository.listExceptions({ cursor: null, limit: 10, query: null })
        const detail = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        const preview = yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: { _tag: "exclusion", reason: "provider_artifact" },
          evidenceRevision: 3,
          currentConclusionRevision: seeded.humanDecisionId,
          currentPolicyEvaluationRevision: seeded.policyRecheckId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: null,
        })
        return { detail, preview, queue }
      })
    )
    expect(review.queue).toEqual([
      expect.objectContaining({
        providerAssetRowId: fixture.providerAssetRowId,
        currentConclusionRevision: seeded.humanDecisionId,
        currentPolicyEvaluationRevision: seeded.policyRecheckId,
      }),
    ])
    expect(Option.getOrNull(review.detail)).toMatchObject({
      currentConclusion: { id: seeded.humanDecisionId, evidenceRevision: 2 },
      currentPolicyEvaluation: { id: seeded.policyRecheckId, evidenceRevision: 3 },
    })
    expect(review.preview).toMatchObject({
      _tag: "ready",
      preview: {
        supersededConclusion: { id: seeded.humanDecisionId },
        currentConclusionRevision: seeded.humanDecisionId,
        currentPolicyEvaluationRevision: seeded.policyRecheckId,
      },
    })

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.submitDecision({
          input: {
            providerAssetRowId: fixture.providerAssetRowId,
            claim: { _tag: "exclusion", reason: "provider_artifact" },
            evidenceRevision: 3,
            currentConclusionRevision: seeded.humanDecisionId,
            currentPolicyEvaluationRevision: seeded.policyRecheckId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: null,
            expectedResultingAssetId: null,
            expectedAssetOutcome: "none",
            expectedRepresentationOutcome: "none",
          },
          actorId: TEST_USER_ID,
        })
      })
    )

    expect(result).toMatchObject({ _tag: "accepted" })
    const persisted = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const decisions = yield* db
          .select({
            id: schema.assetResolutionDecisions.id,
            status: schema.assetResolutionDecisions.status,
            outcome: schema.assetResolutionDecisions.outcome,
            evidenceRevision: schema.assetResolutionDecisions.evidenceRevision,
          })
          .from(schema.assetResolutionDecisions)
          .where(eq(schema.assetResolutionDecisions.providerAssetRowId, fixture.providerAssetRowId))
        const [current] = yield* db
          .select({
            currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
            currentPolicyEvaluationId: schema.assetResolutionCurrentState.currentPolicyEvaluationId,
          })
          .from(schema.assetResolutionCurrentState)
          .where(
            eq(schema.assetResolutionCurrentState.providerAssetRowId, fixture.providerAssetRowId)
          )
        return { current, decisions }
      })
    )
    if (result._tag !== "accepted" || result.detail.currentConclusion === null) {
      throw new Error("Expected an accepted current conclusion")
    }
    expect(persisted.current).toEqual({
      currentConclusionId: result.detail.currentConclusion.id,
      currentPolicyEvaluationId: seeded.policyRecheckId,
    })
    expect(
      persisted.decisions.find((decision) => decision.id === seeded.humanDecisionId)?.status
    ).toBe("active")
    expect(
      persisted.decisions.find((decision) => decision.id === seeded.policyRecheckId)?.status
    ).toBe("active")
    expect(result).toMatchObject({
      _tag: "accepted",
      detail: {
        currentConclusion: {
          supersedesConclusionId: seeded.humanDecisionId,
          evidenceRevision: 3,
        },
        currentPolicyEvaluation: {
          id: seeded.policyRecheckId,
          outcome: "pending",
          evidenceRevision: 3,
        },
      },
    })
    const settledQueue = await runRepository(
      Effect.flatMap(AssetExceptionRepository, (repository) =>
        repository.listExceptions({ cursor: null, limit: 10, query: null })
      )
    )
    expect(settledQueue).toEqual([])
  })

  it("treats a display match for a new asset as an explicit identity conflict", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            newAsset: { name: "duplicate display", symbol: "dup", type: "fungible" },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "Display fields alone cannot prove economic identity.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "ambiguous_identity" })
  })

  it("treats an NFKC lookalike display for a new asset as an identity conflict", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.previewDecision({
          providerAssetRowId: fixture.providerAssetRowId,
          claim: {
            _tag: "identity",
            assetId: null,
            // Full-width characters NFKC-fold to the existing display text.
            newAsset: {
              name: "Ｄｕｐｌｉｃａｔｅ Ｄｉｓｐｌａｙ",
              symbol: "ＤＵＰ",
              type: "fungible",
            },
            representation: null,
          },
          evidenceRevision: 2,
          currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
          currentPolicyEvaluationRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "Lookalike display text must collide with the existing asset.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "ambiguous_identity" })
  })

  it("treats a reused name or symbol as an identity conflict for a new asset", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
      })
    )

    const preview = (newAsset: { readonly name: string; readonly symbol: string }) =>
      runRepository(
        Effect.gen(function* () {
          const repository = yield* AssetExceptionRepository
          return yield* repository.previewDecision({
            providerAssetRowId: fixture.providerAssetRowId,
            claim: {
              _tag: "identity",
              assetId: null,
              newAsset: { ...newAsset, type: "fungible" },
              representation: null,
            },
            evidenceRevision: 2,
            currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
            currentPolicyEvaluationRevision: fixture.decisionId,
            evidenceSnapshotIds: [fixture.evidenceId],
            rationale: "Either display value colliding must block the duplicate.",
          })
        })
      )

    // The automatic resolver's duplicate brake treats any name-or-symbol
    // cross-match as a collision; the human path must match it.
    await expect(preview({ name: "Duplicate Display", symbol: "OTHER" })).resolves.toMatchObject({
      _tag: "ambiguous_identity",
    })
    await expect(preview({ name: "Something Else", symbol: "DUP" })).resolves.toMatchObject({
      _tag: "ambiguous_identity",
    })
    await expect(
      preview({ name: "Fresh Asset", symbol: "DUPLICATE DISPLAY" })
    ).resolves.toMatchObject({
      _tag: "ambiguous_identity",
    })
  })

  it("treats an already-owned representation as a conflict for a new-asset claim", async () => {
    const [first, second] = await Promise.all([
      seedException("-owned-a"),
      seedException("-owned-b"),
    ])
    const sharedAddress = "0x-owned-representation"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        if (blockchain === undefined) {
          return yield* Effect.die("Failed to seed Base blockchain observation")
        }
        yield* Effect.all([
          db
            .update(schema.providerTransfers)
            .set({
              observedBlockchainId: blockchain.id,
              observedRepresentationType: "token",
              observedContractAddress: sharedAddress,
              observedDecimals: 6,
            })
            .where(eq(schema.providerTransfers.providerAssetId, first.providerAssetRowId)),
          db
            .update(schema.providerTransfers)
            .set({
              observedBlockchainId: blockchain.id,
              observedRepresentationType: "token",
              observedContractAddress: sharedAddress,
              observedDecimals: 6,
            })
            .where(eq(schema.providerTransfers.providerAssetId, second.providerAssetRowId)),
        ])
      })
    )

    const firstInput = {
      providerAssetRowId: first.providerAssetRowId,
      claim: {
        _tag: "identity",
        assetId: null,
        newAsset: { name: "Owned Token", symbol: "OWN", type: "fungible" },
        representation: {
          blockchain: "base",
          type: "token",
          contractAddress: sharedAddress,
          mintAddress: null,
          decimals: 6,
        },
      } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: first.decisionId,
      evidenceSnapshotIds: [first.evidenceId],
      rationale: "The first observation creates the economic asset.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "create" as const,
      expectedRepresentationOutcome: "create" as const,
    }

    const firstSubmitted = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        return yield* repository.submitDecision({ input: firstInput, actorId: TEST_USER_ID })
      })
    )
    expect(firstSubmitted).toMatchObject({ _tag: "accepted" })

    // A different display name, so only the owned representation can raise
    // the conflict; the claim must not be rewritten into a silent reuse.
    const secondInput = {
      providerAssetRowId: second.providerAssetRowId,
      claim: {
        ...firstInput.claim,
        newAsset: { name: "Other Owned Token", symbol: "OWN2", type: "fungible" },
      } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: second.decisionId,
      evidenceSnapshotIds: [second.evidenceId],
      rationale: "The representation already belongs to the first asset.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "create" as const,
      expectedRepresentationOutcome: "create" as const,
    }

    const secondResults = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const preview = yield* repository.previewDecision(secondInput)
        const submitted = yield* repository.submitDecision({
          input: secondInput,
          actorId: TEST_USER_ID,
        })
        return { preview, submitted }
      })
    )

    expect(secondResults.preview).toMatchObject({ _tag: "ambiguous_identity" })
    expect(secondResults.submitted).toMatchObject({ _tag: "ambiguous_identity" })
  })

  it("reports directly owned evidence in the decision history", async () => {
    const fixture = await seedException()

    const detail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected exception detail")
        }
        return found.value
      })
    )

    // The policy decision stores its evidence directly through
    // asset_resolution_evidence.decision_id without link rows; history must
    // still report it.
    const policyDecision = detail.decisionHistory.find(
      (decision) => decision.id === fixture.decisionId
    )
    expect(policyDecision?.evidenceSnapshotIds).toEqual([fixture.evidenceId])
  })

  it("counts transactions blocked through source-only uses in the impact", async () => {
    const fixture = await seedException()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        // A Coinbase buy blocked by an unresolved currency persists with no
        // provider transfer; only the transaction-level use records it.
        const [tradeTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            externalId: "exception-trade-without-transfer",
            timestamp: new Date("2025-01-03T00:00:00.000Z"),
            metadata: {
              provider: "coinbase",
              nativeAmount: { amount: "500.25", currency: "EUR" },
            },
            providerFiatAmount: "500.25",
            providerFiatCurrency: "EUR",
          })
          .returning({ id: schema.transactions.id })
        if (tradeTransaction === undefined) {
          return yield* Effect.die("Failed to seed trade transaction")
        }
        yield* db.insert(schema.providerAssetTransactionUses).values({
          providerAssetRowId: fixture.providerAssetRowId,
          transactionId: tradeTransaction.id,
          sourceId: TEST_SOURCE_ID,
        })
      })
    )

    const detail = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const found = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId: fixture.providerAssetRowId,
        })
        if (Option.isNone(found)) {
          return yield* Effect.die("Expected exception detail")
        }
        return found.value
      })
    )

    expect(detail.impact).toMatchObject({
      affectedTransactions: 2,
      affectedTransactionValueEur: "1750.75",
    })
  })

  it("serializes conflicting claims for the same representation identity", async () => {
    const [first, second] = await Promise.all([seedException("-lock-a"), seedException("-lock-b")])
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        if (blockchain === undefined) {
          return yield* Effect.die("Failed to seed Base blockchain")
        }
        yield* Effect.all([
          db
            .update(schema.providerTransfers)
            .set({
              observedBlockchainId: blockchain.id,
              observedRepresentationType: "token",
              observedContractAddress: "0x-shared-representation",
              observedDecimals: 6,
            })
            .where(eq(schema.providerTransfers.providerAssetId, first.providerAssetRowId)),
          db
            .update(schema.providerTransfers)
            .set({
              observedBlockchainId: blockchain.id,
              observedRepresentationType: "nft",
              observedContractAddress: "0x-shared-representation",
              observedDecimals: 0,
            })
            .where(eq(schema.providerTransfers.providerAssetId, second.providerAssetRowId)),
        ])
      })
    )
    const submit = ({
      fixture,
      type,
      decimals,
    }: {
      readonly fixture: Awaited<ReturnType<typeof seedException>>
      readonly type: "token" | "nft"
      readonly decimals: number
    }) =>
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
                  name: `Representation ${type}`,
                  symbol: type === "token" ? "RPT" : "RPN",
                  type: type === "nft" ? "nft" : "fungible",
                },
                representation: {
                  blockchain: "base",
                  type,
                  contractAddress: "0x-shared-representation",
                  mintAddress: null,
                  decimals,
                },
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Concurrent claim for one representation identity.",
              expectedResultingAssetId: null,
              expectedAssetOutcome: "create",
              expectedRepresentationOutcome: "create",
            },
          })
        })
      )

    const results = await Promise.all([
      submit({ fixture: first, type: "token", decimals: 6 }),
      submit({ fixture: second, type: "nft", decimals: 0 }),
    ])

    expect(results.map((result) => result._tag).sort()).toEqual(["accepted", "ambiguous_identity"])
  })

  it("normalizes EVM contract identities before previewing and persisting them", async () => {
    const fixture = await seedException("-evm-case")
    const mixedCaseAddress = "0xAbCdEf0000000000000000000000000000001234"
    const alternateCaseAddress = "0xABCDEF0000000000000000000000000000001234"
    const normalizedAddress = mixedCaseAddress.toLowerCase()

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        if (blockchain === undefined) {
          return yield* Effect.die("Failed to seed Base blockchain observation")
        }
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "token",
            observedContractAddress: mixedCaseAddress,
            observedDecimals: 6,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
      })
    )

    const firstInput = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: {
        _tag: "identity",
        assetId: null,
        newAsset: { name: "Case Token", symbol: "CASE", type: "fungible" },
        representation: {
          blockchain: "base",
          type: "token",
          contractAddress: mixedCaseAddress,
          mintAddress: null,
          decimals: 6,
        },
      } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: "The observed Base contract identifies this economic asset.",
      expectedResultingAssetId: null,
      expectedAssetOutcome: "create" as const,
      expectedRepresentationOutcome: "create" as const,
    }

    const first = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const preview = yield* repository.previewDecision(firstInput)
        const submitted = yield* repository.submitDecision({
          input: firstInput,
          actorId: TEST_USER_ID,
        })
        return { preview, submitted }
      })
    )

    expect(first.preview).toMatchObject({
      _tag: "ready",
      preview: { assetOutcome: "create", representationOutcome: "create" },
    })
    expect(first.submitted).toMatchObject({ _tag: "accepted" })

    const created = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [asset] = yield* db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.name, "Case Token"))
        const [decision] = yield* db
          .select({ id: schema.assetResolutionCurrentState.currentConclusionId })
          .from(schema.assetResolutionCurrentState)
          .where(
            eq(schema.assetResolutionCurrentState.providerAssetRowId, fixture.providerAssetRowId)
          )
        if (asset === undefined || decision === undefined || decision.id === null) {
          return yield* Effect.die("Failed to load the first EVM identity decision")
        }
        return { assetId: asset.id, decisionId: decision.id }
      })
    )

    const secondInput = {
      ...firstInput,
      claim: {
        _tag: "identity",
        assetId: created.assetId,
        newAsset: null,
        representation: {
          ...firstInput.claim.representation,
          contractAddress: alternateCaseAddress,
        },
      } as const,
      currentConclusionRevision: created.decisionId,
      currentPolicyEvaluationRevision: fixture.decisionId,
      rationale: "A differently cased address still identifies the existing Base representation.",
      expectedResultingAssetId: created.assetId,
      expectedAssetOutcome: "reuse" as const,
      expectedRepresentationOutcome: "reuse" as const,
    }

    const second = await runRepository(
      Effect.gen(function* () {
        const repository = yield* AssetExceptionRepository
        const preview = yield* repository.previewDecision(secondInput)
        const submitted = yield* repository.submitDecision({
          input: secondInput,
          actorId: TEST_USER_ID,
        })
        return { preview, submitted }
      })
    )

    expect(second.preview).toMatchObject({
      _tag: "ready",
      preview: { assetOutcome: "reuse", representationOutcome: "reuse" },
    })
    expect(second.submitted).toMatchObject({ _tag: "accepted" })

    const stored = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const representations = yield* db
          .select({ contractAddress: schema.assetRepresentations.contractAddress })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.assetId, created.assetId))
        const decisions = yield* db
          .select({
            contractAddress: schema.assetResolutionDecisions.contractAddress,
            humanClaim: schema.assetResolutionDecisions.humanClaim,
          })
          .from(schema.assetResolutionDecisions)
          .where(eq(schema.assetResolutionDecisions.assetId, created.assetId))
        return { representations, decisions }
      })
    )

    expect(stored.representations).toEqual([{ contractAddress: normalizedAddress }])
    expect(stored.decisions).toHaveLength(2)
    expect(stored.decisions.map((decision) => decision.contractAddress)).toEqual([
      normalizedAddress,
      normalizedAddress,
    ])
    for (const decision of stored.decisions) {
      expect(decision.humanClaim).toEqual(
        expect.objectContaining({
          representation: expect.objectContaining({ contractAddress: normalizedAddress }),
        })
      )
    }
  })

  it("reuses a legacy mixed-case EVM representation", async () => {
    const fixture = await seedException("-legacy-evm-case")
    const storedAddress = "0xAbCdEf0000000000000000000000000000005678"
    const claimedAddress = "0xABCDEF0000000000000000000000000000005678"

    const seeded = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
        const [asset] = yield* db
          .insert(schema.assets)
          .values({ name: "Legacy Case Token", symbol: "LCASE", type: "fungible" })
          .returning({ id: schema.assets.id })
        if (blockchain === undefined || asset === undefined) {
          return yield* Effect.die("Failed to seed legacy EVM representation")
        }
        yield* db.insert(schema.assetRepresentations).values({
          assetId: asset.id,
          blockchainId: blockchain.id,
          type: "token",
          contractAddress: storedAddress,
          decimals: 6,
        })
        yield* db
          .update(schema.providerTransfers)
          .set({
            observedBlockchainId: blockchain.id,
            observedRepresentationType: "token",
            observedContractAddress: claimedAddress,
            observedDecimals: 6,
          })
          .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
        return { assetId: asset.id }
      })
    )

    const input = {
      providerAssetRowId: fixture.providerAssetRowId,
      claim: {
        _tag: "identity",
        assetId: seeded.assetId,
        newAsset: null,
        representation: {
          blockchain: "base",
          type: "token",
          contractAddress: claimedAddress,
          mintAddress: null,
          decimals: 6,
        },
      } as const,
      evidenceRevision: 2,
      currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
      currentPolicyEvaluationRevision: fixture.decisionId,
      evidenceSnapshotIds: [fixture.evidenceId],
      rationale: "The legacy mixed-case row is the same Base contract identity.",
      expectedResultingAssetId: seeded.assetId,
      expectedAssetOutcome: "reuse" as const,
      expectedRepresentationOutcome: "reuse" as const,
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
      preview: { assetOutcome: "reuse", representationOutcome: "reuse" },
    })
    expect(result.submitted).toMatchObject({ _tag: "accepted" })

    const representations = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ contractAddress: schema.assetRepresentations.contractAddress })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.assetId, seeded.assetId))
      })
    )
    expect(representations).toEqual([{ contractAddress: storedAddress }])
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
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
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

    expect(results.map((result) => result._tag).sort()).toEqual(["accepted", "ambiguous_identity"])
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

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [previousDecision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: fixture.providerAssetRowId,
            evidenceRevision: 1,
            policyRevision: "test-policy.0",
            outcome: "pending",
            reason: "display_collision",
            status: "superseded",
            actor: "policy:test-policy.0",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (previousDecision === undefined) {
          return yield* Effect.die("Failed to seed previous policy decision")
        }
        yield* db
          .update(schema.assetResolutionEvidence)
          .set({ decisionId: previousDecision.id })
          .where(eq(schema.assetResolutionEvidence.id, fixture.evidenceId))
        yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
          decisionId: fixture.decisionId,
          evidenceId: fixture.evidenceId,
        })
      })
    )

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
      currentPolicyEvaluation: { outcome: "pending", reason: "display_collision" },
      evidence: [expect.objectContaining({ id: fixture.evidenceId, authority: "chain" })],
      impact: { affectedSources: 1, affectedTransactions: 1 },
    })
  })
})
