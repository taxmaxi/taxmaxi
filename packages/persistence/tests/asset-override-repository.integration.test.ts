import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetOverrideRepository } from "../src/services/AssetOverrideRepository.ts"
import { AssetOverrideRepositoryLive } from "../src/layers/AssetOverrideRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { sourceInventoryLockQuery } from "../src/layers/SourceInventoryLock.ts"
import { schema } from "../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "./support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_override_repository",
})
const TEST_NFT_ASSET_ID = "00000000-0000-0000-0000-0000000000f1"

const RepositoryTestLive = AssetOverrideRepositoryLive.pipe(
  Layer.provideMerge(context.TestPgClientLive)
)

const runRepository = <A, E>(effect: Effect.Effect<A, E, AssetOverrideRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RepositoryTestLive), Effect.scoped))

const seedChainlessProviderAsset = () =>
  context.runPg(
    Effect.gen(function* () {
      yield* seedSyncEngineRepositoryFixture()
      const db = yield* drizzle
      yield* db.insert(schema.assets).values([
        {
          id: TEST_BTC_ASSET_ID,
          name: "Override Bitcoin Fixture",
          symbol: "OBTC",
          type: "fungible",
        },
        {
          id: TEST_EUR_ASSET_ID,
          name: "Override Euro Fixture",
          symbol: "OEUR",
          type: "fungible",
        },
      ])
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId: "override-usdc",
          currencyCode: "USDC",
          name: "USD Coin",
          exponent: 6,
          providerType: "crypto",
          retrievedAt: new Date("2026-08-21T00:00:00.000Z"),
        })
        .returning({ id: schema.providerAssets.id })

      if (providerAsset === undefined) {
        return yield* Effect.die("Failed to seed provider asset")
      }

      yield* db.insert(schema.providerAssetMappings).values({
        providerAssetRowId: providerAsset.id,
        mappingKind: "asset",
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
      })
      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId: TEST_SOURCE_ID,
        hasChainlessObservation: true,
      })

      return providerAsset.id
    })
  )

const seedUnknownTypeRepresentation = () =>
  context.runPg(
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture()
      const db = yield* drizzle
      yield* db.insert(schema.assets).values({
        id: TEST_BTC_ASSET_ID,
        name: "Override Bitcoin Fixture",
        symbol: "OBTC",
        type: "fungible",
      })
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId: "unknown-type-usdc",
          currencyCode: "USDC",
          name: "USD Coin",
          exponent: 6,
          providerType: "crypto",
          retrievedAt: new Date("2026-08-21T00:00:00.000Z"),
        })
        .returning({ id: schema.providerAssets.id })
      if (providerAsset === undefined) return yield* Effect.die("Failed to seed provider asset")

      yield* db.insert(schema.providerAssetMappings).values({
        providerAssetRowId: providerAsset.id,
        mappingKind: "asset",
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
      })
      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId: TEST_SOURCE_ID,
        hasChainlessObservation: true,
      })
      const timestamp = new Date("2026-08-21T01:00:00.000Z")
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: TEST_SOURCE_ID,
          externalId: "unknown-type-transaction",
          timestamp,
          providerTransactionType: "send",
          providerStatus: "completed",
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")

      yield* db.insert(schema.providerTransfers).values([
        {
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "unknown-type-transfer-6",
          providerAssetId: providerAsset.id,
          timestamp,
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAddress: "0xsender",
          toAccountRef: "coinbase-account-1",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: null,
          observedContractAddress: "0xabcdef1234567890",
          observedMintAddress: null,
          observedDecimals: 6,
          amount: "1",
        },
        {
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "unknown-type-transfer-18",
          providerAssetId: providerAsset.id,
          timestamp,
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAddress: "0xsender",
          toAccountRef: "coinbase-account-1",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: null,
          observedContractAddress: "0xABCDEF1234567890",
          observedMintAddress: null,
          observedDecimals: 18,
          amount: "2",
        },
      ])

      return { blockchainId: fixture.baseBlockchainId, providerAssetRowId: providerAsset.id }
    })
  )

const seedCrossSourceFifoDependency = (
  providerAssetRowId: string,
  {
    includeTargetUse = true,
    insertDependency = true,
  }: { readonly includeTargetUse?: boolean; readonly insertDependency?: boolean } = {}
) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const dependentSourceId = "00000000-0000-0000-0000-000000000272"
      const [coinbase] = yield* db
        .select({ id: schema.cex.id })
        .from(schema.cex)
        .where(eq(schema.cex.name, "coinbase"))
        .limit(1)
      if (coinbase === undefined) return yield* Effect.die("Missing Coinbase fixture")

      const [account] = yield* db
        .insert(schema.cexAccount)
        .values({
          cexId: coinbase.id,
          principalId: TEST_PRINCIPAL_ID,
          providerUserId: "override-dependent-user",
          providerAccountId: "override-dependent-account",
        })
        .returning({ id: schema.cexAccount.id })
      if (account === undefined) return yield* Effect.die("Failed to seed dependent account")

      yield* db.insert(schema.sources).values({
        id: dependentSourceId,
        principalId: TEST_PRINCIPAL_ID,
        name: "Dependent Coinbase Source",
        providerKey: "coinbase",
        sourceableType: "cex",
        cexAccountId: account.id,
        addressId: null,
      })
      if (includeTargetUse) {
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId,
          sourceId: dependentSourceId,
          hasChainlessObservation: true,
        })
      }

      const timestamp = new Date("2026-08-22T10:00:00.000Z")
      const [ownerTransaction, dependentTransaction] = yield* db
        .insert(schema.transactions)
        .values([
          {
            sourceId: TEST_SOURCE_ID,
            externalId: "override-owner-acquisition",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
          },
          {
            sourceId: dependentSourceId,
            externalId: "override-dependent-disposal",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
          },
        ])
        .returning({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
      if (ownerTransaction === undefined || dependentTransaction === undefined) {
        return yield* Effect.die("Failed to seed dependency transactions")
      }
      const transactionBySource = new Map(
        [ownerTransaction, dependentTransaction].map((transaction) => [
          transaction.sourceId,
          transaction.id,
        ])
      )
      const ownerTransactionId = transactionBySource.get(TEST_SOURCE_ID)
      const dependentTransactionId = transactionBySource.get(dependentSourceId)
      if (ownerTransactionId === undefined || dependentTransactionId === undefined) {
        return yield* Effect.die("Failed to identify dependency transactions")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId: TEST_SOURCE_ID,
        transactionId: ownerTransactionId,
        externalId: "override-owner-target-transfer",
        providerAssetId: providerAssetRowId,
        timestamp,
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "external-account",
        toAccountRef: "owned-account",
        amount: "1",
      })

      const [ownerLeg, dependentLeg] = yield* db
        .insert(schema.transactionLegs)
        .values([
          {
            sourceId: TEST_SOURCE_ID,
            externalId: "override-owner-acquisition-leg",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: ownerTransactionId,
          },
          {
            sourceId: dependentSourceId,
            externalId: "override-dependent-disposal-leg",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: dependentTransactionId,
          },
        ])
        .returning({ id: schema.transactionLegs.id, sourceId: schema.transactionLegs.sourceId })
      if (ownerLeg === undefined || dependentLeg === undefined) {
        return yield* Effect.die("Failed to seed dependency legs")
      }
      const legBySource = new Map([ownerLeg, dependentLeg].map((leg) => [leg.sourceId, leg.id]))
      const ownerLegId = legBySource.get(TEST_SOURCE_ID)
      const dependentLegId = legBySource.get(dependentSourceId)
      if (ownerLegId === undefined || dependentLegId === undefined) {
        return yield* Effect.die("Failed to identify dependency legs")
      }

      const [lot] = yield* db
        .insert(schema.fifoLots)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: timestamp,
          originalAmount: "1",
          remainingAmount: "0",
          costBasisPerToken: "10",
          costBasisCurrency: "EUR",
          sourceLegId: ownerLegId,
        })
        .returning({ id: schema.fifoLots.id })
      if (lot === undefined) return yield* Effect.die("Failed to seed FIFO lot")

      if (insertDependency) {
        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: dependentLegId,
          fifoLotId: lot.id,
          matchedAmount: "1",
          costBasis: "10",
          proceeds: "12",
          gainLoss: "2",
        })
      }

      return { dependentLegId, dependentSourceId, lotId: lot.id }
    })
  )

const seedTransitiveFifoDependency = ({
  sourceLegId,
  sourceId,
}: {
  readonly sourceLegId: string
  readonly sourceId: string
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const transitiveSourceId = "00000000-0000-0000-0000-000000000273"
      const [coinbase] = yield* db
        .select({ id: schema.cex.id })
        .from(schema.cex)
        .where(eq(schema.cex.name, "coinbase"))
        .limit(1)
      if (coinbase === undefined) return yield* Effect.die("Missing Coinbase fixture")

      const [account] = yield* db
        .insert(schema.cexAccount)
        .values({
          cexId: coinbase.id,
          principalId: TEST_PRINCIPAL_ID,
          providerUserId: "override-transitive-user",
          providerAccountId: "override-transitive-account",
        })
        .returning({ id: schema.cexAccount.id })
      if (account === undefined) return yield* Effect.die("Failed to seed transitive account")

      yield* db.insert(schema.sources).values({
        id: transitiveSourceId,
        principalId: TEST_PRINCIPAL_ID,
        name: "Transitive Coinbase Source",
        providerKey: "coinbase",
        sourceableType: "cex",
        cexAccountId: account.id,
        addressId: null,
      })

      const timestamp = new Date("2026-08-22T10:01:00.000Z")
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: transitiveSourceId,
          externalId: "override-transitive-disposal",
          timestamp,
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.die("Failed to seed transitive transaction")
      }

      const [leg] = yield* db
        .insert(schema.transactionLegs)
        .values({
          sourceId: transitiveSourceId,
          externalId: "override-transitive-disposal-leg",
          timestamp,
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "1",
          kind: "disposal",
          provenance: "deterministic",
          transactionId: transaction.id,
        })
        .returning({ id: schema.transactionLegs.id })
      if (leg === undefined) return yield* Effect.die("Failed to seed transitive leg")

      const [lot] = yield* db
        .insert(schema.fifoLots)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: timestamp,
          originalAmount: "1",
          remainingAmount: "0",
          costBasisPerToken: "10",
          costBasisCurrency: "EUR",
          sourceLegId,
        })
        .returning({ id: schema.fifoLots.id })
      if (lot === undefined) return yield* Effect.die("Failed to seed transitive FIFO lot")

      yield* db.insert(schema.disposalMatches).values({
        disposalLegId: leg.id,
        fifoLotId: lot.id,
        matchedAmount: "1",
        costBasis: "10",
        proceeds: "12",
        gainLoss: "2",
      })

      return transitiveSourceId
    })
  )

beforeEach(async () => {
  await Effect.runPromise(context.recreateTestDatabase())
})

describe("AssetOverrideRepository", () => {
  it("appends identity choices and withdrawals while keeping global data unchanged", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }

    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )

    expect(initial.systemConclusion).toEqual({
      _tag: "identity",
      state: "unresolved",
      assetId: null,
    })
    expect(initial.activeOverride).toBeNull()

    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Coinbase account statement identifies this holding as BTC.",
        })
      )
    )

    expect(created._tag).toBe("accepted")
    if (created._tag !== "accepted") return
    expect(created.projection.effectiveConclusion).toEqual({
      _tag: "identity",
      state: "resolved",
      assetId: TEST_BTC_ASSET_ID,
    })
    expect(created.projection.recomputationState).toBe("updating")

    const raced = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_EUR_ASSET_ID },
          reason: "A racing choice must not overwrite the accepted record.",
        })
      )
    )

    expect(raced._tag).toBe("conflict")

    const replaced = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: created.projection.systemRevision,
          expectedActiveOverrideId: created.projection.activeOverride?.id ?? null,
          replacement: { _tag: "identity", assetId: TEST_EUR_ASSET_ID },
          reason: "The audited custody export identifies the economic asset as EUR.",
        })
      )
    )

    expect(replaced._tag).toBe("accepted")
    if (replaced._tag !== "accepted") return

    const withdrawn = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.withdrawOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: replaced.projection.systemRevision,
          expectedActiveOverrideId: replaced.projection.activeOverride?.id ?? null,
          reason: "Return to TaxMaxi's current conclusion.",
        })
      )
    )

    expect(withdrawn._tag).toBe("accepted")
    if (withdrawn._tag !== "accepted") return
    expect(withdrawn.projection.activeOverride).toBeNull()
    expect(withdrawn.projection.history).toHaveLength(3)
    expect(withdrawn.projection.history.map((entry) => entry.action)).toEqual([
      "set",
      "set",
      "withdraw",
    ])

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({
            status: schema.providerAssetMappings.mappingStatus,
            assetId: schema.providerAssetMappings.canonicalAssetId,
          })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        const jobs = yield* db
          .select({
            mode: schema.processingJobs.mode,
            principalId: schema.processingJobs.principalId,
          })
          .from(schema.processingJobs)

        expect(mapping).toEqual({ status: "pending_review", assetId: null })
        expect(jobs).toEqual([{ mode: "replay", principalId: TEST_PRINCIPAL_ID }])
      })
    )
  })

  it("reports a credit-blocked override replay as failed", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )
    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Use the reviewed identity after replay completes.",
        })
      )
    )
    expect(created._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "credit_required",
            creditReasonCode: "no_usable_credits",
            creditsAvailable: 0,
          })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
      })
    )

    const projection = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )
    expect(projection.recomputationState).toBe("failed")
    expect(projection.history).toHaveLength(1)
  })

  it("reports a completed override replay with failed records as failed", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Use the reviewed identity after replay completes.",
        })
      )
    )
    expect(created._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 1 } })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        yield* db.insert(schema.processingJobs).values({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "sync",
          status: "completed",
          progressDetails: { failedRecords: 0 },
          completedAt: new Date("2026-08-23T02:00:00.000Z"),
          createdAt: new Date("2026-08-23T01:00:00.000Z"),
          updatedAt: new Date("2026-08-23T02:00:00.000Z"),
        })
      })
    )

    const projection = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    expect(projection.recomputationState).toBe("failed")
  })

  it.each([
    { status: "failed" as const, progressDetails: null },
    { status: "completed" as const, progressDetails: { failedRecords: 1 } },
  ])(
    "reports a $status owner replay before its pending FIFO dependent",
    async ({ status, progressDetails }) => {
      const providerAssetRowId = await seedChainlessProviderAsset()
      const { dependentSourceId } = await seedCrossSourceFifoDependency(providerAssetRowId, {
        includeTargetUse: false,
      })
      const target = { _tag: "provider_asset" as const, providerAssetRowId }
      const initial = await runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
        )
      )
      const created = await runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.setOverride({
            principalId: TEST_PRINCIPAL_ID,
            actorId: "00000000-0000-0000-0000-000000000181",
            kind: "identity",
            target,
            expectedSystemRevision: initial.systemRevision,
            expectedActiveOverrideId: null,
            replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
            reason: "Rebuild the owner before its FIFO consumer.",
          })
        )
      )
      expect(created._tag).toBe("accepted")

      await context.runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ status, progressDetails })
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const [dependentJob] = yield* db
            .select({ status: schema.processingJobs.status })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, dependentSourceId))
          expect(dependentJob?.status).toBe("pending")
        })
      )

      const projection = await runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
        )
      )
      expect(projection.recomputationState).toBe("failed")
    }
  )

  it("keeps a durable FIFO dependent in the projection after its live edge is reset", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentSourceId } = await seedCrossSourceFifoDependency(providerAssetRowId, {
      includeTargetUse: false,
    })
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Keep the dependent replay visible after the owner resets.",
        })
      )
    )
    expect(created._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 0 } })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        yield* db.delete(schema.disposalMatches)
        const [dependentJob] = yield* db
          .select({ status: schema.processingJobs.status })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, dependentSourceId))
        expect(dependentJob?.status).toBe("pending")
      })
    )

    const projection = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    expect(projection.recomputationState).toBe("updating")
  })

  it("validates provider asset identity replacements against known NFT type hints", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ providerType: "nft" })
          .where(eq(schema.providerAssets.id, providerAssetRowId))
        yield* db.insert(schema.assets).values({
          id: TEST_NFT_ASSET_ID,
          name: "Override NFT Fixture",
          symbol: "ONFT",
          type: "nft",
        })
      })
    )

    const mismatch = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository
          .validateOverride({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target,
            replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          })
          .pipe(Effect.flip)
      )
    )
    expect(mismatch).toMatchObject({
      _tag: "AssetOverrideValidationError",
      code: "asset_type_mismatch",
    })

    await expect(
      runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.validateOverride({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target,
            replacement: { _tag: "identity", assetId: TEST_NFT_ASSET_ID },
          })
        )
      )
    ).resolves.toMatchObject({ kind: "identity" })

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ providerType: "unknown" })
          .where(eq(schema.providerAssets.id, providerAssetRowId))
      })
    )
    await expect(
      runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.validateOverride({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target,
            replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          })
        )
      )
    ).resolves.toMatchObject({ kind: "identity" })
  })

  it("rejects economic-asset overrides for fiat mappings without scheduling replay", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ providerType: "fiat" })
          .where(eq(schema.providerAssets.id, providerAssetRowId))
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingKind: "fiat",
            mappingStatus: "approved",
            canonicalAssetId: null,
            canonicalFiatCurrency: "EUR",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )

    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    expect(initial.systemConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "unsupported_asset_type",
    })

    const inclusionError = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository
          .setOverride({
            principalId: TEST_PRINCIPAL_ID,
            actorId: "00000000-0000-0000-0000-000000000181",
            kind: "inclusion",
            target,
            expectedSystemRevision: initial.systemRevision,
            expectedActiveOverrideId: null,
            replacement: { _tag: "inclusion", state: "included" },
            reason: "Fiat must remain fiat.",
          })
          .pipe(Effect.flip)
      )
    )
    expect(inclusionError).toMatchObject({
      _tag: "AssetOverrideValidationError",
      code: "unsupported_asset_type",
    })

    const identityError = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository
          .validateOverride({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target,
            replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          })
          .pipe(Effect.flip)
      )
    )
    expect(identityError).toMatchObject({
      _tag: "AssetOverrideValidationError",
      code: "unsupported_asset_type",
    })

    const writes = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const overrides = yield* db
          .select({ id: schema.principalAssetOverrides.id })
          .from(schema.principalAssetOverrides)
        const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)
        return { jobs, overrides }
      })
    )
    expect(writes).toEqual({ jobs: [], overrides: [] })
  })

  it("keeps the accepted system revision stable until the override commits", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.execute(
          sql.raw(`
            create function pause_principal_asset_override_insert()
            returns trigger
            language plpgsql
            as $$
            begin
              perform pg_advisory_xact_lock(918273645);
              perform pg_sleep(0.5);
              return new;
            end;
            $$
          `)
        )
        yield* db.execute(
          sql.raw(`
            create trigger pause_principal_asset_override_insert
            before insert on principal_asset_overrides
            for each row execute function pause_principal_asset_override_insert()
          `)
        )
      })
    )

    const overrideWrite = runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Accept only while the inspected provider mapping is current.",
        })
      )
    )

    let overrideReachedInsert = false
    for (let attempt = 0; attempt < 100 && !overrideReachedInsert; attempt += 1) {
      overrideReachedInsert = await context.runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [lock] = yield* db
            .select({
              acquired: sql<boolean>`pg_try_advisory_lock(918273645)`,
            })
            .from(schema.sources)
            .where(eq(schema.sources.id, TEST_SOURCE_ID))
            .limit(1)
          if (lock?.acquired === true) {
            yield* db.execute(sql`select pg_advisory_unlock(918273645)`)
            return false
          }
          return true
        })
      )
      if (!overrideReachedInsert) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(overrideReachedInsert).toBe(true)
    const concurrentMappingChange = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "rejected", reviewerNotes: "Concurrent policy decision." })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )

    const [created] = await Promise.all([overrideWrite, concurrentMappingChange])
    expect(created._tag).toBe("accepted")
    if (created._tag !== "accepted") return
    expect(created.projection.staleSystemRevision).toBe(false)

    const afterConcurrentChange = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )
    expect(afterConcurrentChange.systemRevision).not.toBe(initial.systemRevision)
    expect(afterConcurrentChange.staleSystemRevision).toBe(true)
    expect(afterConcurrentChange.history).toHaveLength(1)
    expect(afterConcurrentChange.activeOverride?.id).toBe(created.projection.activeOverride?.id)
    expect(afterConcurrentChange.effectiveConclusion).toEqual({
      _tag: "identity",
      state: "resolved",
      assetId: TEST_BTC_ASSET_ID,
    })
  })

  it("accepts only one of two simultaneous override writers", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const write = (assetId: string) =>
      runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.setOverride({
            principalId: TEST_PRINCIPAL_ID,
            actorId: "00000000-0000-0000-0000-000000000181",
            kind: "identity",
            target,
            expectedSystemRevision: initial.systemRevision,
            expectedActiveOverrideId: null,
            replacement: { _tag: "identity", assetId },
            reason: "Only one racing decision may become active.",
          })
        )
      )

    const results = await Promise.all([write(TEST_BTC_ASSET_ID), write(TEST_EUR_ASSET_ID)])

    expect(results.map((result) => result._tag).sort()).toEqual(["accepted", "conflict"])
    const projection = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    expect(projection.history).toHaveLength(1)
  })

  it("acquires revision locks in normalization write order", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const transactionId = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "ordered-revision-lock-transaction",
            timestamp: new Date("2026-08-22T11:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        return transaction.id
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const normalizationWrite = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sourceInventoryLockQuery([TEST_SOURCE_ID]))
            yield* tx.execute(
              sql`select id from ${schema.sources} where id = ${TEST_SOURCE_ID} for update`
            )
            yield* tx
              .update(schema.providerAssetSourceUses)
              .set({ updatedAt: new Date("2026-08-22T11:00:00.000Z") })
              .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAssetRowId))
            yield* tx.execute(sql`select pg_sleep(0.3)`)
            yield* tx.insert(schema.providerTransfers).values({
              sourceId: TEST_SOURCE_ID,
              transactionId,
              externalId: "ordered-revision-lock-transfer",
              providerAssetId: providerAssetRowId,
              timestamp: new Date("2026-08-22T11:00:00.000Z"),
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAccountRef: "external-account",
              toAccountRef: "owned-account",
              observedBlockchainId: null,
              observedRepresentationType: null,
              observedContractAddress: null,
              observedMintAddress: null,
              observedDecimals: null,
              amount: "1",
            })
          })
        )
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const overrideWrite = runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "The normalization writer must finish without a lock cycle.",
        })
      )
    )

    const [, result] = await Promise.all([normalizationWrite, overrideWrite])
    expect(result._tag).toBe("accepted")
  })

  it("accepts overrides and schedules every cross-source FIFO dependency", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await seedCrossSourceFifoDependency(providerAssetRowId)
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const validation = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.validateOverride({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
    )
    expect(validation.systemConclusion).toMatchObject({ _tag: "identity", state: "unresolved" })

    const writeResult = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Replay the affected source and every FIFO consumer.",
        })
      )
    )
    expect(writeResult._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const overrides = yield* db
          .select({ id: schema.principalAssetOverrides.id })
          .from(schema.principalAssetOverrides)
        const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)
        const applications = yield* db
          .select({ sourceId: schema.principalAssetOverrideApplications.sourceId })
          .from(schema.principalAssetOverrideApplications)
        expect(overrides).toHaveLength(1)
        expect(jobs).toHaveLength(2)
        expect(new Set(applications.map(({ sourceId }) => sourceId)).size).toBe(2)
      })
    )
  })

  it("schedules a later disposal that can consume the replacement asset", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentSourceId } = await seedCrossSourceFifoDependency(providerAssetRowId, {
      includeTargetUse: false,
      insertDependency: false,
    })
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const result = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Replay later disposals that can consume the replacement asset.",
        })
      )
    )

    expect(result._tag).toBe("accepted")
    const applications = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            sourceId: schema.principalAssetOverrideApplications.sourceId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
      })
    )
    expect(applications).toEqual(
      expect.arrayContaining([
        { sourceId: TEST_SOURCE_ID, dependsOnSourceIds: [] },
        { sourceId: dependentSourceId, dependsOnSourceIds: [TEST_SOURCE_ID] },
      ])
    )
  })

  it("orders a target-owning consumer behind an earlier target owner", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentSourceId } = await seedCrossSourceFifoDependency(providerAssetRowId, {
      includeTargetUse: true,
      insertDependency: false,
    })
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [transaction] = yield* db
          .select({ id: schema.transactions.id, timestamp: schema.transactions.timestamp })
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, dependentSourceId))
          .limit(1)
        if (transaction === undefined) {
          return yield* Effect.die("Failed to find target-owning consumer transaction")
        }
        const [earlierTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: dependentSourceId,
            externalId: "target-owning-earlier-consumer-transaction",
            timestamp: new Date(transaction.timestamp.getTime() - 1_000),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (earlierTransaction === undefined) {
          return yield* Effect.die("Failed to seed earlier consumer transaction")
        }
        yield* db.insert(schema.transactionLegs).values({
          sourceId: dependentSourceId,
          externalId: "target-owning-earlier-consumer-leg",
          timestamp: new Date(transaction.timestamp.getTime() - 1_000),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "1",
          kind: "disposal",
          provenance: "deterministic",
          transactionId: earlierTransaction.id,
        })
        yield* db.insert(schema.providerTransfers).values({
          sourceId: dependentSourceId,
          transactionId: transaction.id,
          externalId: "target-owning-consumer-transfer",
          providerAssetId: providerAssetRowId,
          timestamp: new Date(transaction.timestamp.getTime() + 1_000),
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "external-account",
          toAccountRef: "owned-account",
          amount: "1",
        })
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const result = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Replay the earlier target owner before its target-owning consumer.",
        })
      )
    )
    expect(result._tag).toBe("accepted")

    const applications = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            sourceId: schema.principalAssetOverrideApplications.sourceId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
      })
    )
    expect(applications).toEqual(
      expect.arrayContaining([
        { sourceId: TEST_SOURCE_ID, dependsOnSourceIds: [] },
        { sourceId: dependentSourceId, dependsOnSourceIds: [TEST_SOURCE_ID] },
      ])
    )
  })

  it("schedules a later outbound movement when withdrawing the current asset", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentLegId, dependentSourceId } = await seedCrossSourceFifoDependency(
      providerAssetRowId,
      { includeTargetUse: false, insertDependency: false }
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_EUR_ASSET_ID },
          reason: "Use EUR until the reviewed provider identity is withdrawn.",
        })
      )
    )
    expect(created._tag).toBe("accepted")
    if (created._tag !== "accepted") return

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactionLegs)
          .where(eq(schema.transactionLegs.id, dependentLegId))
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 0 } })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        const [transaction] = yield* db
          .select({ id: schema.transactions.id, timestamp: schema.transactions.timestamp })
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, dependentSourceId))
          .limit(1)
        if (transaction === undefined) {
          return yield* Effect.die("Failed to find dependent transaction")
        }
        const [providerTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: dependentSourceId,
            transactionId: transaction.id,
            externalId: "potential-old-asset-outbound",
            timestamp: transaction.timestamp,
            direction: "outbound",
            processingMode: "accounting_only",
            fromAccountRef: "owned-account",
            toAccountRef: "external-account",
            amount: "1",
          })
          .returning({ id: schema.providerTransfers.id })
        if (providerTransfer === undefined) {
          return yield* Effect.die("Failed to create outbound provider transfer")
        }
        yield* db.insert(schema.inventoryMovements).values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: dependentSourceId,
          transactionId: transaction.id,
          providerTransferId: providerTransfer.id,
          assetId: TEST_EUR_ASSET_ID,
          timestamp: transaction.timestamp,
          direction: "outbound",
          purpose: "principal",
          taxTreatment: "taxable",
          reconciliationStatus: "unmatched",
          amount: "1",
        })
      })
    )

    const withdrawn = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.withdrawOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: created.projection.systemRevision,
          expectedActiveOverrideId: created.projection.activeOverride?.id ?? null,
          reason: "Return to the unresolved system identity.",
        })
      )
    )
    expect(withdrawn._tag).toBe("accepted")
    if (withdrawn._tag !== "accepted") return

    const applications = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            sourceId: schema.principalAssetOverrideApplications.sourceId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
          .where(
            eq(
              schema.principalAssetOverrideApplications.overrideId,
              withdrawn.projection.history.at(-1)?.id ?? "00000000-0000-0000-0000-000000000000"
            )
          )
      })
    )
    expect(applications).toEqual(
      expect.arrayContaining([
        { sourceId: TEST_SOURCE_ID, dependsOnSourceIds: [] },
        { sourceId: dependentSourceId, dependsOnSourceIds: [TEST_SOURCE_ID] },
      ])
    )
  })

  it("schedules the full transitive FIFO dependency chain", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const direct = await seedCrossSourceFifoDependency(providerAssetRowId)
    await seedTransitiveFifoDependency({
      sourceId: direct.dependentSourceId,
      sourceLegId: direct.dependentLegId,
    })
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const result = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Replay every direct and transitive FIFO consumer.",
        })
      )
    )

    expect(result._tag).toBe("accepted")
    const replayPlan = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const jobs = yield* db
          .select({ sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
        const applications = yield* db
          .select({
            sourceId: schema.principalAssetOverrideApplications.sourceId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
        return { applications, replayedSourceIds: new Set(jobs.map(({ sourceId }) => sourceId)) }
      })
    )
    expect(replayPlan.replayedSourceIds).toEqual(
      new Set([TEST_SOURCE_ID, direct.dependentSourceId, "00000000-0000-0000-0000-000000000273"])
    )
    expect(replayPlan.applications).toEqual(
      expect.arrayContaining([
        { sourceId: TEST_SOURCE_ID, dependsOnSourceIds: [] },
        { sourceId: direct.dependentSourceId, dependsOnSourceIds: [TEST_SOURCE_ID] },
        {
          sourceId: "00000000-0000-0000-0000-000000000273",
          dependsOnSourceIds: [direct.dependentSourceId, TEST_SOURCE_ID].sort(),
        },
      ])
    )
  })

  it("rejects a reverse FIFO edge added after override acceptance", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentSourceId, lotId: ownerLotId } =
      await seedCrossSourceFifoDependency(providerAssetRowId)
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values(
          [TEST_SOURCE_ID, dependentSourceId].map((sourceId) => ({
            sourceId,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync" as const,
            status: "processing" as const,
          }))
        )
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const accepted = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Keep a later sync from making the accepted replay plan cyclic.",
        })
      )
    )
    expect(accepted._tag).toBe("accepted")

    const reverseEdge = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const timestamp = new Date("2026-08-22T11:00:00.000Z")
        const [ownerTransaction, dependentTransaction] = yield* db
          .insert(schema.transactions)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "cycle-owner-disposal",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              sourceId: dependentSourceId,
              externalId: "cycle-dependent-acquisition",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          .returning({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
        if (ownerTransaction === undefined || dependentTransaction === undefined) {
          return yield* Effect.die("Failed to seed cyclic dependency transactions")
        }

        const transactionBySource = new Map(
          [ownerTransaction, dependentTransaction].map((transaction) => [
            transaction.sourceId,
            transaction.id,
          ])
        )
        const ownerTransactionId = transactionBySource.get(TEST_SOURCE_ID)
        const dependentTransactionId = transactionBySource.get(dependentSourceId)
        if (ownerTransactionId === undefined || dependentTransactionId === undefined) {
          return yield* Effect.die("Failed to identify cyclic dependency transactions")
        }

        const [ownerDisposalLeg, dependentAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "cycle-owner-disposal-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "disposal",
              provenance: "deterministic",
              transactionId: ownerTransactionId,
            },
            {
              sourceId: dependentSourceId,
              externalId: "cycle-dependent-acquisition-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: dependentTransactionId,
            },
          ])
          .returning({ id: schema.transactionLegs.id, sourceId: schema.transactionLegs.sourceId })
        if (ownerDisposalLeg === undefined || dependentAcquisitionLeg === undefined) {
          return yield* Effect.die("Failed to seed cyclic dependency legs")
        }

        const legBySource = new Map(
          [ownerDisposalLeg, dependentAcquisitionLeg].map((leg) => [leg.sourceId, leg.id])
        )
        const ownerDisposalLegId = legBySource.get(TEST_SOURCE_ID)
        const dependentAcquisitionLegId = legBySource.get(dependentSourceId)
        if (ownerDisposalLegId === undefined || dependentAcquisitionLegId === undefined) {
          return yield* Effect.die("Failed to identify cyclic dependency legs")
        }

        const [dependentLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: dependentSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: timestamp,
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "10",
            costBasisCurrency: "EUR",
            sourceLegId: dependentAcquisitionLegId,
          })
          .returning({ id: schema.fifoLots.id })
        if (dependentLot === undefined) return yield* Effect.die("Failed to seed dependent lot")

        const reverseEdge = yield* db
          .insert(schema.disposalMatches)
          .values({
            disposalLegId: ownerDisposalLegId,
            fifoLotId: dependentLot.id,
            matchedAmount: "1",
            costBasis: "10",
            proceeds: "12",
            gainLoss: "2",
          })
          .pipe(Effect.result)

        return {
          dependentLotId: dependentLot.id,
          ownerDisposalLegId,
          reverseEdge,
        }
      })
    )
    expect(reverseEdge.reverseEdge).toMatchObject({ _tag: "Failure" })

    const persistedReplayRows = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const overrides = yield* db.select().from(schema.principalAssetOverrides)
        const jobs = yield* db.select().from(schema.processingJobs)
        const matches = yield* db.select().from(schema.disposalMatches)
        const applications = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
        return { applications, jobs, matches, overrides }
      })
    )
    expect(persistedReplayRows.overrides).toHaveLength(1)
    expect(persistedReplayRows.jobs).toHaveLength(2)
    expect(persistedReplayRows.jobs.every((job) => job.followUpMode === "replay")).toBe(true)
    expect(persistedReplayRows.applications.every(({ replayJobId }) => replayJobId === null)).toBe(
      true
    )
    expect(persistedReplayRows.matches).toHaveLength(1)

    const directReplayRetries = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "completed", progressDetails: { failedRecords: 0 } })
          .where(eq(schema.processingJobs.mode, "sync"))
        const failedReplayJobs = yield* db
          .insert(schema.processingJobs)
          .values(
            [TEST_SOURCE_ID, dependentSourceId].map((sourceId) => ({
              sourceId,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay" as const,
              status: "failed" as const,
              completedAt: new Date("2026-08-22T12:00:00.000Z"),
              progressDetails: { failedRecords: 1 },
            }))
          )
          .returning({ id: schema.processingJobs.id, sourceId: schema.processingJobs.sourceId })
        for (const replayJob of failedReplayJobs) {
          yield* db
            .update(schema.principalAssetOverrideApplications)
            .set({ replayJobId: replayJob.id })
            .where(eq(schema.principalAssetOverrideApplications.sourceId, replayJob.sourceId))
        }
        return yield* db
          .insert(schema.processingJobs)
          .values(
            [TEST_SOURCE_ID, dependentSourceId].map((sourceId) => ({
              sourceId,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay" as const,
              status: "processing" as const,
            }))
          )
          .returning({ id: schema.processingJobs.id, sourceId: schema.processingJobs.sourceId })
      })
    )
    const retryWindowEdge = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .insert(schema.disposalMatches)
          .values({
            disposalLegId: reverseEdge.ownerDisposalLegId,
            fifoLotId: reverseEdge.dependentLotId,
            matchedAmount: "1",
            costBasis: "10",
            proceeds: "12",
            gainLoss: "2",
          })
          .pipe(Effect.result)
      })
    )
    expect(retryWindowEdge).toMatchObject({ _tag: "Failure" })

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        for (const replayJob of directReplayRetries) {
          yield* db
            .update(schema.processingJobs)
            .set({ status: "completed", progressDetails: { failedRecords: 0 } })
            .where(eq(schema.processingJobs.id, replayJob.id))
          yield* db
            .update(schema.principalAssetOverrideApplications)
            .set({ replayJobId: replayJob.id })
            .where(eq(schema.principalAssetOverrideApplications.sourceId, replayJob.sourceId))
        }
        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: reverseEdge.ownerDisposalLegId,
          fifoLotId: reverseEdge.dependentLotId,
          matchedAmount: "1",
          costBasis: "10",
          proceeds: "12",
          gainLoss: "2",
        })
      })
    )

    const matchesAfterReplay = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.disposalMatches)
      })
    )
    expect(matchesAfterReplay).toHaveLength(2)

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const unrelatedSourceId = "00000000-0000-0000-0000-000000000274"
        const [coinbase] = yield* db
          .select({ id: schema.cex.id })
          .from(schema.cex)
          .where(eq(schema.cex.name, "coinbase"))
          .limit(1)
        const [override] = yield* db
          .select({ id: schema.principalAssetOverrides.id })
          .from(schema.principalAssetOverrides)
          .limit(1)
        if (coinbase === undefined || override === undefined) {
          return yield* Effect.die("Missing disconnected replay fixtures")
        }

        const [account] = yield* db
          .insert(schema.cexAccount)
          .values({
            cexId: coinbase.id,
            principalId: TEST_PRINCIPAL_ID,
            providerUserId: "unrelated-active-replay-user",
            providerAccountId: "unrelated-active-replay-account",
          })
          .returning({ id: schema.cexAccount.id })
        if (account === undefined) return yield* Effect.die("Failed to seed unrelated account")

        yield* db.insert(schema.sources).values({
          id: unrelatedSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Unrelated Active Replay Source",
          providerKey: "coinbase",
          sourceableType: "cex",
          cexAccountId: account.id,
          addressId: null,
        })
        const [unrelatedReplayJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: unrelatedSourceId,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "pending",
          })
          .returning({ id: schema.processingJobs.id })
        if (unrelatedReplayJob === undefined) {
          return yield* Effect.die("Failed to seed unrelated replay job")
        }
        yield* db.insert(schema.principalAssetOverrideApplications).values({
          overrideId: override.id,
          sourceId: unrelatedSourceId,
          replayJobId: unrelatedReplayJob.id,
        })

        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: dependentSourceId,
            externalId: "disconnected-replay-cycle-disposal",
            timestamp: new Date("2026-08-22T13:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed disposal")
        const [disposalLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: dependentSourceId,
            externalId: "disconnected-replay-cycle-disposal-leg",
            timestamp: new Date("2026-08-22T13:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "disposal",
            provenance: "deterministic",
            transactionId: transaction.id,
          })
          .returning({ id: schema.transactionLegs.id })
        if (disposalLeg === undefined) return yield* Effect.die("Failed to seed disposal leg")

        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: disposalLeg.id,
          fifoLotId: ownerLotId,
          matchedAmount: "1",
          costBasis: "10",
          proceeds: "12",
          gainLoss: "2",
        })
      })
    )

    const matchesWithDisconnectedReplay = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.disposalMatches)
      })
    )
    expect(matchesWithDisconnectedReplay).toHaveLength(3)
  })

  it("includes a FIFO dependency added by a concurrent inventory writer", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const { dependentLegId, lotId } = await seedCrossSourceFifoDependency(providerAssetRowId, {
      insertDependency: false,
    })
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    const concurrentConsumer = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sourceInventoryLockQuery([TEST_SOURCE_ID]))
            yield* tx.execute(sql`select pg_sleep(0.4)`)
            yield* tx.insert(schema.disposalMatches).values({
              disposalLegId: dependentLegId,
              fifoLotId: lotId,
              matchedAmount: "1",
              costBasis: "10",
              proceeds: "12",
              gainLoss: "2",
            })
          })
        )
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const overrideWrite = runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Include a concurrently added FIFO consumer in replay.",
        })
      )
    )

    const [, result] = await Promise.all([concurrentConsumer, overrideWrite])
    expect(result._tag).toBe("accepted")
    const jobs = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
      })
    )
    expect(new Set(jobs.map(({ sourceId }) => sourceId)).size).toBe(2)
    const dependentApplication = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [application] = yield* db
          .select({
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
          .where(
            eq(
              schema.principalAssetOverrideApplications.sourceId,
              "00000000-0000-0000-0000-000000000272"
            )
          )
          .limit(1)
        return application
      })
    )
    expect(dependentApplication?.dependsOnSourceIds).toEqual([TEST_SOURCE_ID])
  })

  it("does not reveal whether an unowned provider asset exists", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const result = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.findProjection({
          principalId: "00000000-0000-0000-0000-000000000999",
          kind: "identity",
          target: { _tag: "provider_asset", providerAssetRowId },
        })
      )
    )

    expect(Option.isNone(result)).toBe(true)
  })

  it("scopes one cross-provider representation override to the owning principal", async () => {
    const targetFixture = await context.runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_BTC_ASSET_ID,
          name: "Cross-provider override asset",
          symbol: "XPRO",
          type: "fungible",
        })
        const samePrincipalAddressId = "00000000-0000-0000-0000-000000000285"
        const samePrincipalSourceId = "00000000-0000-0000-0000-000000000286"
        const otherUserId = "00000000-0000-0000-0000-000000000291"
        const otherPrincipalId = "00000000-0000-0000-0000-000000000292"
        const otherAddressId = "00000000-0000-0000-0000-000000000293"
        const otherSourceId = "00000000-0000-0000-0000-000000000294"
        yield* db.insert(schema.users).values({
          id: otherUserId,
          email: "other-cross-provider@example.com",
          emailVerified: true,
        })
        yield* db.insert(schema.principals).values({
          id: otherPrincipalId,
          kind: "user",
          userId: otherUserId,
        })
        yield* db.insert(schema.addresses).values([
          {
            id: samePrincipalAddressId,
            principalId: TEST_PRINCIPAL_ID,
            address: "0x0000000000000000000000000000000000000285",
            type: "evm",
            name: "Second owned wallet",
          },
          {
            id: otherAddressId,
            principalId: otherPrincipalId,
            address: "0x0000000000000000000000000000000000000293",
            type: "evm",
            name: "Other principal wallet",
          },
        ])
        yield* db.insert(schema.sources).values([
          {
            id: samePrincipalSourceId,
            principalId: TEST_PRINCIPAL_ID,
            name: "Second Helius source",
            providerKey: "helius-solana",
            sourceableType: "onchain",
            addressId: samePrincipalAddressId,
          },
          {
            id: otherSourceId,
            principalId: otherPrincipalId,
            name: "Other principal Helius source",
            providerKey: "helius-solana",
            sourceableType: "onchain",
            addressId: otherAddressId,
          },
        ])
        const [coinbaseAsset, heliusAsset] = yield* db
          .insert(schema.providerAssets)
          .values([
            {
              provider: "coinbase",
              providerAssetId: "cross-provider-coinbase",
              currencyCode: "XPRO",
              exponent: 18,
              providerType: "crypto",
              retrievedAt: new Date("2026-08-21T00:00:00.000Z"),
            },
            {
              provider: "helius",
              providerAssetId: "cross-provider-helius",
              currencyCode: "XPRO",
              exponent: 18,
              providerType: "crypto",
              retrievedAt: new Date("2026-08-21T00:00:00.000Z"),
            },
          ])
          .returning({ id: schema.providerAssets.id, provider: schema.providerAssets.provider })
        if (coinbaseAsset === undefined || heliusAsset === undefined) {
          return yield* Effect.die("Failed to seed cross-provider assets")
        }
        const providerAssetIdByProvider = new Map(
          [coinbaseAsset, heliusAsset].map((asset) => [asset.provider, asset.id])
        )
        const coinbaseAssetId = providerAssetIdByProvider.get("coinbase")
        const heliusAssetId = providerAssetIdByProvider.get("helius")
        if (coinbaseAssetId === undefined || heliusAssetId === undefined) {
          return yield* Effect.die("Failed to identify cross-provider assets")
        }
        yield* db.insert(schema.providerAssetMappings).values(
          [coinbaseAssetId, heliusAssetId].map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
          }))
        )
        const contractAddress = "0x0000000000000000000000000000000000000c55"
        const observedSources = [
          { sourceId: TEST_SOURCE_ID, providerAssetId: coinbaseAssetId },
          { sourceId: samePrincipalSourceId, providerAssetId: heliusAssetId },
          { sourceId: otherSourceId, providerAssetId: heliusAssetId },
        ]
        const transactions = yield* db
          .insert(schema.transactions)
          .values(
            observedSources.map(({ sourceId }, index) => ({
              sourceId,
              externalId: `cross-provider-transaction-${index}`,
              timestamp: new Date(`2026-08-21T0${index + 1}:00:00.000Z`),
              principalId: sourceId === otherSourceId ? otherPrincipalId : TEST_PRINCIPAL_ID,
            }))
          )
          .returning({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
        const transactionIdBySourceId = new Map(
          transactions.map((transaction) => [transaction.sourceId, transaction.id])
        )
        const providerTransfers = []
        for (const [index, { providerAssetId, sourceId }] of observedSources.entries()) {
          const transactionId = transactionIdBySourceId.get(sourceId)
          if (transactionId === undefined) {
            return yield* Effect.die("Missing cross-provider transaction")
          }
          providerTransfers.push({
            sourceId,
            transactionId,
            externalId: `cross-provider-transfer-${index}`,
            timestamp: new Date(`2026-08-21T0${index + 1}:00:00.000Z`),
            direction: "inbound" as const,
            processingMode: "accounting_and_evidence" as const,
            fromAddress: `0xexternal${index}`,
            toAddress: `0xowned${index}`,
            providerAssetId,
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "token" as const,
            observedContractAddress: contractAddress,
            observedDecimals: 18,
            amount: "1",
          })
        }
        yield* db.insert(schema.providerTransfers).values(providerTransfers)
        yield* db.insert(schema.sourceRepresentationUses).values(
          observedSources.map(({ sourceId }) => ({
            sourceId,
            blockchainId: fixture.baseBlockchainId,
            representationType: "token" as const,
            contractAddress,
            mintAddress: null,
          }))
        )
        return {
          otherPrincipalId,
          otherSourceId,
          samePrincipalSourceId,
          target: {
            _tag: "representation" as const,
            blockchainId: fixture.baseBlockchainId,
            representationType: "token" as const,
            contractAddress,
            mintAddress: null,
          },
        }
      })
    )
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target: targetFixture.target,
        })
      )
    )
    const accepted = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target: targetFixture.target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Use one representation choice across both owned providers.",
        })
      )
    )
    expect(accepted._tag).toBe("accepted")

    const scope = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const applications = yield* db
          .select({ sourceId: schema.principalAssetOverrideApplications.sourceId })
          .from(schema.principalAssetOverrideApplications)
        const jobs = yield* db
          .select({ sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
        return {
          applicationSourceIds: new Set(applications.map(({ sourceId }) => sourceId)),
          jobSourceIds: new Set(jobs.map(({ sourceId }) => sourceId)),
        }
      })
    )
    const ownedSourceIds = new Set([TEST_SOURCE_ID, targetFixture.samePrincipalSourceId])
    expect(scope.applicationSourceIds).toEqual(ownedSourceIds)
    expect(scope.jobSourceIds).toEqual(ownedSourceIds)
    expect(scope.applicationSourceIds.has(targetFixture.otherSourceId)).toBe(false)

    const otherProjection = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: targetFixture.otherPrincipalId,
          kind: "identity",
          target: targetFixture.target,
        })
      )
    )
    expect(otherProjection.activeOverride).toBeNull()
    expect(otherProjection.recomputationState).toBe("complete")
    expect(otherProjection.effectiveConclusion).toEqual(otherProjection.systemConclusion)
  })

  it("uses representation targets instead of provider targets for exact observations", async () => {
    const { baseBlockchainId } = await context.runPg(seedSyncEngineRepositoryFixture())
    const contractAddress = "0x0000000000000000000000000000000000000abc"
    const providerAssetRowId = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "exact-observation-only",
            currencyCode: "EXACT",
            exponent: 18,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-22T12:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) return yield* Effect.die("Failed to seed provider asset")

        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        yield* db.insert(schema.providerAssetSourceUses).values({
          providerAssetRowId: providerAsset.id,
          sourceId: TEST_SOURCE_ID,
          hasChainlessObservation: false,
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: baseBlockchainId,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })
        return providerAsset.id
      })
    )

    const [providerProjection, representationProjection] = await Promise.all([
      runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.findProjection({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target: { _tag: "provider_asset", providerAssetRowId },
          })
        )
      ),
      runRepository(
        Effect.flatMap(AssetOverrideRepository, (repository) =>
          repository.findProjection({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target: {
              _tag: "representation",
              blockchainId: baseBlockchainId,
              representationType: "token",
              contractAddress,
              mintAddress: null,
            },
          })
        )
      ),
    ])

    expect(Option.isNone(providerProjection)).toBe(true)
    expect(Option.isSome(representationProjection)).toBe(true)
  })

  it("retains the inspected inclusion reason in append-only history", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingStatus: "excluded",
            canonicalAssetId: TEST_BTC_ASSET_ID,
            reviewerNotes: "Excluded by TaxMaxi policy.",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )

    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )

    expect(initial.systemConclusion).toEqual({
      _tag: "inclusion",
      state: "excluded",
      reason: "taxmaxi_policy",
    })

    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "The custody statement confirms this asset is legitimate.",
        })
      )
    )

    expect(created._tag).toBe("accepted")
    if (created._tag !== "accepted") return
    expect(created.projection.history[0]?.inspectedSystemConclusion).toEqual({
      _tag: "inclusion",
      state: "excluded",
      reason: "taxmaxi_policy",
    })
    expect(created.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })
  })

  it("keeps an included choice blocked until the target has an effective identity", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const inclusionBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )

    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: inclusionBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Include this holding once its economic identity is settled.",
        })
      )
    )

    expect(included._tag).toBe("accepted")
    if (included._tag !== "accepted") return
    expect(included.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "asset_identity_unresolved",
    })

    const identityBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "identity",
          target,
        })
      )
    )
    const identified = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: identityBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Identify the included holding as the existing Bitcoin asset.",
        })
      )
    )
    expect(identified._tag).toBe("accepted")

    const inclusionAfter = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    expect(inclusionAfter.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })
  })

  it("tracks the identity replay used by an inclusion projection", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const identityBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const identified = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: identityBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Use this identity in the inclusion projection.",
        })
      )
    )
    expect(identified._tag).toBe("accepted")

    const updating = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    expect(updating.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })
    expect(updating.recomputationState).toBe("updating")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "failed" })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
      })
    )
    const failed = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    expect(failed.recomputationState).toBe("failed")
  })

  it("completes an inclusion projection after every durable override application succeeds", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const identityBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const identified = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: identityBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Resolve identity before replay convergence.",
        })
      )
    )
    expect(identified._tag).toBe("accepted")

    const inclusionBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: inclusionBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Confirm inclusion before replay convergence.",
        })
      )
    )
    expect(included._tag).toBe("accepted")

    const applicationCount = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [count] = yield* db
          .select({ value: sql<number>`count(*)` })
          .from(schema.principalAssetOverrideApplications)
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "completed",
            completedAt: new Date("2026-08-21T03:00:00.000Z"),
            progressDetails: { failedRecords: 0 },
          })
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        return Number(count?.value ?? 0)
      })
    )
    expect(applicationCount).toBe(2)

    const complete = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    expect(complete.recomputationState).toBe("complete")
    expect(complete.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })

    await seedCrossSourceFifoDependency(providerAssetRowId, { insertDependency: false })

    const expanded = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    expect(expanded.recomputationState).toBe("updating")
  })

  it("uses a retained rejected identity in an included projection", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "rejected", canonicalAssetId: TEST_BTC_ASSET_ID })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Use the retained reviewed identity.",
        })
      )
    )
    expect(included._tag).toBe("accepted")
    if (included._tag !== "accepted") return
    expect(included.projection.systemConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "asset_identity_unresolved",
    })
    expect(included.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })
  })

  it("uses a retained rejected identity for an included representation", async () => {
    const target = await context.runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_BTC_ASSET_ID,
          name: "Retained Representation Bitcoin",
          symbol: "RRBTC",
          type: "fungible",
        })
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "retained-representation-asset",
            currencyCode: "RRA",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-21T02:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) return yield* Effect.die("Failed to seed provider asset")
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "rejected",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: null,
          canonicalFiatCurrency: null,
        })
        const contractAddress = "0x0000000000000000000000000000000000000211"
        const timestamp = new Date("2026-08-21T02:05:00.000Z")
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "retained-representation-transaction",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "retained-representation-transfer",
          providerAssetId: providerAsset.id,
          timestamp,
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAddress: "0xretained-sender",
          toAccountRef: "owned-account",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedMintAddress: null,
          observedDecimals: 8,
          amount: "1",
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })
        return {
          _tag: "representation" as const,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token" as const,
          contractAddress,
          mintAddress: null,
        }
      })
    )

    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Use the retained exact-representation identity.",
        })
      )
    )

    expect(included._tag).toBe("accepted")
    if (included._tag !== "accepted") return
    expect(included.projection.systemConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "asset_identity_unresolved",
    })
    expect(included.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "included",
      reason: null,
    })
  })

  it("keeps providerless missing decimals blocked after an identity override", async () => {
    const target = await context.runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_BTC_ASSET_ID,
          name: "Providerless Missing Decimals Bitcoin",
          symbol: "PMDBTC",
          type: "fungible",
        })
        const contractAddress = "0x0000000000000000000000000000000000000212"
        const timestamp = new Date("2026-08-21T02:10:00.000Z")
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "providerless-missing-decimals-transaction",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "providerless-missing-decimals-transfer",
          providerAssetId: null,
          timestamp,
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAddress: "0xproviderless-sender",
          toAccountRef: "owned-account",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedMintAddress: null,
          observedDecimals: null,
          amount: "1",
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })
        return {
          _tag: "representation" as const,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token" as const,
          contractAddress,
          mintAddress: null,
        }
      })
    )

    const identityBefore = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const identified = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: identityBefore.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Identify the asset without bypassing its missing decimals.",
        })
      )
    )
    expect(identified._tag).toBe("accepted")

    const inclusion = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    expect(inclusion.systemConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "missing_decimals",
    })
    expect(inclusion.effectiveConclusion).toEqual(inclusion.systemConclusion)
  })

  it("requires one retained identity across matching provider mappings", async () => {
    const target = await context.runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values([
          {
            id: TEST_BTC_ASSET_ID,
            name: "Conflicting Retained Bitcoin",
            symbol: "CRBTC",
            type: "fungible",
          },
          {
            id: TEST_EUR_ASSET_ID,
            name: "Conflicting Retained Euro",
            symbol: "CREUR",
            type: "fungible",
          },
        ])
        const providerAssets = yield* db
          .insert(schema.providerAssets)
          .values([
            {
              provider: "coinbase",
              providerAssetId: "conflicting-retained-coinbase",
              currencyCode: "CRC",
              exponent: 8,
              providerType: "crypto",
              retrievedAt: new Date("2026-08-21T02:20:00.000Z"),
            },
            {
              provider: "helius",
              providerAssetId: "conflicting-retained-helius",
              currencyCode: "CRH",
              exponent: 8,
              providerType: "crypto",
              retrievedAt: new Date("2026-08-21T02:20:00.000Z"),
            },
          ])
          .returning({ id: schema.providerAssets.id })
        const firstProviderAsset = providerAssets[0]
        const secondProviderAsset = providerAssets[1]
        if (firstProviderAsset === undefined || secondProviderAsset === undefined) {
          return yield* Effect.die("Failed to seed conflicting provider assets")
        }
        yield* db.insert(schema.providerAssetMappings).values([
          {
            providerAssetRowId: firstProviderAsset.id,
            mappingKind: "asset",
            mappingStatus: "approved",
            canonicalAssetId: TEST_BTC_ASSET_ID,
          },
          {
            providerAssetRowId: secondProviderAsset.id,
            mappingKind: "asset",
            mappingStatus: "rejected",
            canonicalAssetId: TEST_EUR_ASSET_ID,
          },
        ])
        const contractAddress = "0x0000000000000000000000000000000000000213"
        const timestamp = new Date("2026-08-21T02:25:00.000Z")
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "conflicting-retained-transaction",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")
        yield* db.insert(schema.providerTransfers).values(
          providerAssets.map(({ id }, index) => ({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: `conflicting-retained-transfer-${index}`,
            providerAssetId: id,
            timestamp,
            direction: "inbound" as const,
            processingMode: "accounting_and_evidence" as const,
            fromAddress: `0xconflicting-sender-${index}`,
            toAccountRef: "owned-account",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "token" as const,
            observedContractAddress: contractAddress,
            observedMintAddress: null,
            observedDecimals: 8,
            amount: "1",
          }))
        )
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })
        return {
          _tag: "representation" as const,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token" as const,
          contractAddress,
          mintAddress: null,
        }
      })
    )

    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "inclusion", target })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Do not choose between conflicting retained identities.",
        })
      )
    )
    expect(included._tag).toBe("accepted")
    if (included._tag !== "accepted") return
    expect(included.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "asset_identity_unresolved",
    })
  })

  it("preserves a technical blocker that appears after an inclusion choice", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingStatus: "excluded",
            canonicalAssetId: TEST_BTC_ASSET_ID,
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Include the policy-excluded asset while its facts are complete.",
        })
      )
    )
    expect(included._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ exponent: null })
          .where(eq(schema.providerAssets.id, providerAssetRowId))
      })
    )
    const blocked = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )

    expect(blocked.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "missing_decimals",
    })
  })

  it("keeps an included policy exclusion blocked until its identity is known", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "excluded", canonicalAssetId: null })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    const included = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "included" },
          reason: "Include the policy-excluded asset once its identity is known.",
        })
      )
    )

    expect(included._tag).toBe("accepted")
    if (included._tag !== "accepted") return
    expect(included.projection.effectiveConclusion).toEqual({
      _tag: "inclusion",
      state: "blocked",
      reason: "asset_identity_unresolved",
    })
  })

  it("gives unknown-type observations exactly one provider-asset identity", async () => {
    const { blockchainId, providerAssetRowId } = await seedUnknownTypeRepresentation()
    const target = { _tag: "provider_asset" as const, providerAssetRowId }

    const first = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )
    const second = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    expect(first.target).toEqual(target)
    expect(second.systemRevision).toBe(first.systemRevision)

    const representationProjections = await Promise.all(
      (["token", "nft"] as const).map((representationType) =>
        runRepository(
          Effect.flatMap(AssetOverrideRepository, (repository) =>
            repository.findProjection({
              principalId: TEST_PRINCIPAL_ID,
              kind: "identity",
              target: {
                _tag: "representation",
                blockchainId,
                representationType,
                contractAddress: "0xABCDEF1234567890",
                mintAddress: null,
              },
            })
          )
        )
      )
    )
    expect(representationProjections.every(Option.isNone)).toBe(true)

    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: first.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "The provider asset identifies the unknown-type observation.",
        })
      )
    )

    expect(created._tag).toBe("accepted")
    if (created._tag !== "accepted") return
    expect(created.projection.activeOverride?.target).toEqual(target)
  })

  it("keeps representation override history available while transaction evidence is absent", async () => {
    const target = await context.runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_BTC_ASSET_ID,
          name: "Durable Representation Fixture",
          symbol: "DRF",
          type: "fungible",
        })
        const contractAddress = "0x0000000000000000000000000000000000000172"
        yield* db.insert(schema.assetRepresentations).values({
          assetId: TEST_BTC_ASSET_ID,
          blockchainId: fixture.baseBlockchainId,
          type: "token",
          contractAddress,
          mintAddress: null,
          decimals: 6,
        })
        const timestamp = new Date("2026-08-22T12:00:00.000Z")
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "durable-representation-transaction",
            timestamp,
            providerTransactionType: "send",
            providerStatus: "completed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")

        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "durable-representation-transfer",
          timestamp,
          direction: "inbound",
          processingMode: "accounting_and_evidence",
          fromAddress: "0xsender",
          toAccountRef: "owned-account",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "token",
          observedContractAddress: contractAddress,
          observedMintAddress: null,
          observedDecimals: 6,
          amount: "1",
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress,
          mintAddress: null,
        })

        return {
          _tag: "representation" as const,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token" as const,
          contractAddress,
          mintAddress: null,
        }
      })
    )

    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    const created = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "inclusion",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "inclusion", state: "excluded" },
          reason: "Exclude this representation after reviewing its source evidence.",
        })
      )
    )
    expect(created._tag).toBe("accepted")

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.externalId, "durable-representation-transaction"))
      })
    )

    const duringReplay = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.findProjection({
          principalId: TEST_PRINCIPAL_ID,
          kind: "inclusion",
          target,
        })
      )
    )
    expect(Option.isSome(duringReplay)).toBe(true)
    if (Option.isNone(duringReplay)) return
    expect(duringReplay.value.activeOverride?.replacement).toEqual({
      _tag: "inclusion",
      state: "excluded",
    })
    expect(duringReplay.value.recomputationState).toBe("updating")
  })

  it("keeps validation errors for malformed representation targets", async () => {
    const error = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository
          .getProjection({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            target: {
              _tag: "representation",
              blockchainId: "00000000-0000-0000-0000-000000000001",
              representationType: "native",
              contractAddress: "0xinvalid",
              mintAddress: null,
            },
          })
          .pipe(Effect.flip)
      )
    )

    expect(error).toMatchObject({
      _tag: "AssetOverrideValidationError",
      code: "invalid_representation_target",
    })
  })

  it("marks an existing active processing job for replay", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "sync",
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
        })
      })
    )
    const target = { _tag: "provider_asset" as const, providerAssetRowId }
    const initial = await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.getProjection({ principalId: TEST_PRINCIPAL_ID, kind: "identity", target })
      )
    )

    await runRepository(
      Effect.flatMap(AssetOverrideRepository, (repository) =>
        repository.setOverride({
          principalId: TEST_PRINCIPAL_ID,
          actorId: "00000000-0000-0000-0000-000000000181",
          kind: "identity",
          target,
          expectedSystemRevision: initial.systemRevision,
          expectedActiveOverrideId: null,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          reason: "Use the audited asset identity.",
        })
      )
    )

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const jobs = yield* db
          .select({ followUpMode: schema.processingJobs.followUpMode })
          .from(schema.processingJobs)
        expect(jobs).toEqual([{ followUpMode: "replay" }])
      })
    )
  })
})
