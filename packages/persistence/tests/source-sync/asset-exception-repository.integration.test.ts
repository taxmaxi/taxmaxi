import { AssetExceptionRepository } from "@my/sync-engine/services"
import { and, eq } from "drizzle-orm"
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
            activeDecisionRevision: fixture.decisionId,
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
          activeDecisionRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "A chainless provider observation cannot prove an on-chain representation.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "invalid_claim" })
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
          activeDecisionRevision: fiatFixture.decisionId,
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
          activeDecisionRevision: nftFixture.decisionId,
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
          activeDecisionRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "Attempt to attach an incompatible NFT representation.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "ambiguous_identity" })
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
          activeDecisionRevision: humanDecisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "The active settled evidence remains available for supersession.",
        })
        return { detail: found.value, preview }
      })
    )

    expect(result.detail).toMatchObject({
      reviewStatus: "excluded",
      activeDecisionRevision: humanDecisionId,
      activeDecision: { id: humanDecisionId, evidenceRevision: 2 },
      policyOutput: null,
      evidence: [expect.objectContaining({ id: fixture.evidenceId, evidenceRevision: 2 })],
    })
    expect(result.preview).toMatchObject({ _tag: "ready" })
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
          activeDecisionRevision: fixture.decisionId,
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
          activeDecisionRevision: fixture.decisionId,
          evidenceSnapshotIds: [fixture.evidenceId],
          rationale: "Lookalike display text must collide with the existing asset.",
        })
      })
    )

    expect(result).toMatchObject({ _tag: "ambiguous_identity" })
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
              activeDecisionRevision: fixture.decisionId,
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
      activeDecisionRevision: fixture.decisionId,
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
          .select({ id: schema.assetResolutionDecisions.id })
          .from(schema.assetResolutionDecisions)
          .where(
            and(
              eq(schema.assetResolutionDecisions.providerAssetRowId, fixture.providerAssetRowId),
              eq(schema.assetResolutionDecisions.status, "active")
            )
          )
        if (asset === undefined || decision === undefined) {
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
      activeDecisionRevision: created.decisionId,
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
      activeDecisionRevision: fixture.decisionId,
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
      policyOutput: { outcome: "pending", reason: "display_collision" },
      evidence: [expect.objectContaining({ id: fixture.evidenceId, authority: "chain" })],
      impact: { affectedSources: 1, affectedTransactions: 1 },
    })
  })
})
