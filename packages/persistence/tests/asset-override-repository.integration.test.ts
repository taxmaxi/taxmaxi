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
  { insertDependency = true }: { readonly insertDependency?: boolean } = {}
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
      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId,
        sourceId: dependentSourceId,
        hasChainlessObservation: true,
      })

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

    await new Promise((resolve) => setTimeout(resolve, 100))
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
          dependsOnSourceIds: [direct.dependentSourceId],
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
