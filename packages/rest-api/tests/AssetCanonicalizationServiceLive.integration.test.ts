import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../persistence/src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { ProviderAssetRepositoryLive } from "../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../persistence/src/layers/SyncEngineTransactionLive.ts"
import { and, eq } from "../../persistence/src/query/index.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { AssetCanonicalizationServiceLive } from "../src/layers/AssetCanonicalizationServiceLive.ts"
import { AssetCanonicalizationService } from "../src/services/AssetCanonicalizationService.ts"
import { CoinGeckoClient } from "../src/services/coingecko/CoinGeckoClient.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_canonicalization_service",
})

await Effect.runPromise(context.recreateTestDatabase())

const CoinGeckoClientTestLive = Layer.succeed(
  CoinGeckoClient,
  CoinGeckoClient.of({
    searchCoins: () => Effect.succeed([{ id: "ethereum", name: "Bitcoin", symbol: "btc" }]),
    getCoin: () =>
      Effect.succeed({
        id: "ethereum",
        symbol: "eth",
        name: "Ethereum",
        asset_platform_id: null,
        platforms: {},
        detail_platforms: {},
      }),
    listMarkets: () => Effect.succeed([]),
  })
)

const RepositoryLayer = Layer.mergeAll(
  AssetRepositoryLive,
  ProviderAssetRepositoryLive,
  SyncEngineTransactionLive
).pipe(Layer.provide(context.TestPgClientLive))
const ServiceLayer = AssetCanonicalizationServiceLive.pipe(
  Layer.provide(RepositoryLayer),
  Layer.provide(CoinGeckoClientTestLive)
)

const runService = <A, E>(effect: Effect.Effect<A, E, AssetCanonicalizationService>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ServiceLayer }))

const countCanonicalRows = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const assets = yield* db.select({ id: schema.assets.id }).from(schema.assets)
      const representations = yield* db
        .select({ id: schema.assetRepresentations.id })
        .from(schema.assetRepresentations)
      return {
        assets: assets.length,
        representations: representations.length,
      }
    })
  )

describe("AssetCanonicalizationServiceLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    const fixture = await context.runPg(seedSyncEngineRepositoryFixture())
    await context.runPg(seedSyncEngineAssets(fixture))
  })

  it("blocks a chainless pending asset before CoinGecko can create canonical rows", async () => {
    const providerAssetRowId = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "btc-chainless-pending",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-15T10:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.dieMessage("Failed to seed chainless provider asset")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        return providerAsset.id
      })
    )
    const before = await countCanonicalRows()
    const result = await runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.canonicalizeProviderAssetFromCoinGecko({
          providerAssetRowId,
          reviewerNotes: "Symbol and name only.",
        })
      ).pipe(Effect.either)
    )
    const after = await countCanonicalRows()

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message:
          "Provider assets without exact on-chain identity require a reviewed canonical target.",
      })
    }
    expect(after).toEqual(before)
  })

  it("reports a concurrent manual rejection as a decision conflict", async () => {
    const fixture = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [bitcoinRepresentation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            blockchainId: schema.assetRepresentations.blockchainId,
          })
          .from(schema.assetRepresentations)
          .where(
            and(
              eq(schema.assetRepresentations.assetId, TEST_BTC_ASSET_ID),
              eq(schema.assetRepresentations.type, "token")
            )
          )
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "btc-concurrent-rejection",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-15T10:30:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "btc-concurrent-rejection-transaction",
            timestamp: new Date("2026-08-15T10:30:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (
          bitcoinRepresentation === undefined ||
          providerAsset === undefined ||
          transaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to seed concurrent rejection fixture")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "btc-concurrent-rejection-transfer",
          providerAssetId: providerAsset.id,
          timestamp: new Date("2026-08-15T10:30:00.000Z"),
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account-1",
          toAddress: "bc1qconcurrentrejection00000000000000000000",
          amount: "0.1",
          observedBlockchainId: bitcoinRepresentation.blockchainId,
          observedRepresentationType: "token",
          observedContractAddress: "sync-engine-btc-fixture",
          observedDecimals: 8,
          metadata: {},
        })
        return {
          assetRepresentationId: bitcoinRepresentation.id,
          providerAssetRowId: providerAsset.id,
        }
      })
    )
    const lockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseLock = await Effect.runPromise(Deferred.make<void>())
    const lockProviderAsset = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
              .for("no key update")
            yield* Deferred.succeed(lockAcquired, undefined)
            yield* Deferred.await(releaseLock)
          })
        )
      })
    )
    await Effect.runPromise(Deferred.await(lockAcquired))
    const approval = runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId: fixture.providerAssetRowId,
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: fixture.assetRepresentationId,
          reviewerNotes: "Concurrent rejection test.",
        })
      ).pipe(Effect.either)
    )
    const earlyOutcome = await Promise.race([
      approval.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({ mappingStatus: "rejected" })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
      })
    )
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
    const [result] = await Promise.all([approval, lockProviderAsset])

    expect(earlyOutcome).toBe("blocked")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Provider asset mapping was concurrently rejected.",
      })
    }
  })

  it("rejects an approved CoinGecko target conflict before canonical writes", async () => {
    const fixture = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [bitcoinRepresentation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            blockchainId: schema.assetRepresentations.blockchainId,
          })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.assetId, TEST_BTC_ASSET_ID))
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "btc-approved-conflict",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-15T11:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "btc-approved-conflict-transaction",
            timestamp: new Date("2026-08-15T12:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (
          bitcoinRepresentation === undefined ||
          providerAsset === undefined ||
          transaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to seed approved conflict fixture")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: bitcoinRepresentation.id,
          mappingStatus: "approved",
        })
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "btc-approved-conflict-transfer",
          providerAssetId: providerAsset.id,
          timestamp: new Date("2026-08-15T12:00:00.000Z"),
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account-1",
          toAddress: "bc1qcoingeckoconflict0000000000000000000000",
          amount: "0.1",
          observedBlockchainId: bitcoinRepresentation.blockchainId,
          observedRepresentationType: "native",
          observedDecimals: 8,
          metadata: {},
        })
        return { providerAssetRowId: providerAsset.id }
      })
    )
    const before = await countCanonicalRows()
    const result = await runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.canonicalizeProviderAssetFromCoinGecko({
          providerAssetRowId: fixture.providerAssetRowId,
          reviewerNotes: "Conflicting CoinGecko target.",
        })
      ).pipe(Effect.either)
    )
    const after = await countCanonicalRows()
    const mapping = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({ canonicalAssetId: schema.providerAssetMappings.canonicalAssetId })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        return row
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Provider asset mapping is already approved for a different target.",
      })
    }
    expect(after).toEqual(before)
    expect(mapping?.canonicalAssetId).toBe(TEST_BTC_ASSET_ID)
  })

  it("rolls back CoinGecko rows when another approval wins during canonical writes", async () => {
    const fixture = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [ethereumBlockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "ethereum"))
        const [bitcoinRepresentation] = yield* db
          .select({ id: schema.assetRepresentations.id })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.assetId, TEST_BTC_ASSET_ID))
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "btc-concurrent-conflict",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 18,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-15T13:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "btc-concurrent-conflict-transaction",
            timestamp: new Date("2026-08-15T13:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (
          ethereumBlockchain === undefined ||
          bitcoinRepresentation === undefined ||
          providerAsset === undefined ||
          transaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to seed concurrent conflict fixture")
        }
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "btc-concurrent-conflict-transfer",
          providerAssetId: providerAsset.id,
          timestamp: new Date("2026-08-15T13:00:00.000Z"),
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account-1",
          toAddress: "0x1111111111111111111111111111111111111111",
          amount: "0.1",
          observedBlockchainId: ethereumBlockchain.id,
          observedRepresentationType: "native",
          observedDecimals: 18,
          metadata: {},
        })
        return {
          bitcoinRepresentationId: bitcoinRepresentation.id,
          ethereumBlockchainId: ethereumBlockchain.id,
          providerAssetRowId: providerAsset.id,
        }
      })
    )
    const before = await countCanonicalRows()
    const lockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseLock = await Effect.runPromise(Deferred.make<void>())
    const lockEthereum = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.id, fixture.ethereumBlockchainId))
              .for("update")
            yield* Deferred.succeed(lockAcquired, undefined)
            yield* Deferred.await(releaseLock)
          })
        )
      })
    )
    await Effect.runPromise(Deferred.await(lockAcquired))

    const canonicalization = runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.canonicalizeProviderAssetFromCoinGecko({
          providerAssetRowId: fixture.providerAssetRowId,
          reviewerNotes: "Losing concurrent target.",
        })
      ).pipe(Effect.either)
    )
    await context.waitForQueryBlockedOnLock({ queryIncludes: 'insert into "blockchains"' })
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            canonicalAssetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: fixture.bitcoinRepresentationId,
            mappingStatus: "approved",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
      })
    )
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
    const [result] = await Promise.all([canonicalization, lockEthereum])

    const after = await countCanonicalRows()
    const mapping = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({ canonicalAssetId: schema.providerAssetMappings.canonicalAssetId })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        return row
      })
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Provider asset mapping was concurrently approved for a different target.",
      })
    }
    expect(after).toEqual(before)
    expect(mapping?.canonicalAssetId).toBe(TEST_BTC_ASSET_ID)
  })
})
