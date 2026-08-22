import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetOverrideRepository } from "../src/services/AssetOverrideRepository.ts"
import { AssetOverrideRepositoryLive } from "../src/layers/AssetOverrideRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
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

  it("retains the inspected inclusion reason in append-only history", async () => {
    const providerAssetRowId = await seedChainlessProviderAsset()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingStatus: "rejected",
            canonicalAssetId: TEST_BTC_ASSET_ID,
            reviewerNotes: "Rejected by TaxMaxi policy.",
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
