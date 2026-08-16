import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../persistence/src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { ProviderAssetRepositoryLive } from "../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../persistence/src/layers/SyncEngineTransactionLive.ts"
import { and, eq } from "../../persistence/src/query/index.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { AssetCanonicalizationServiceLive } from "../src/layers/AssetCanonicalizationServiceLive.ts"
import { AssetCanonicalizationService } from "../src/services/AssetCanonicalizationService.ts"
import {
  CoinGeckoClient,
  CoinGeckoClientError,
  type CoinGeckoClientShape,
} from "../src/services/coingecko/CoinGeckoClient.ts"
import { SyncEngineTransaction } from "@my/sync-engine/services"

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

const seedChainlessPendingProviderAsset = ({
  providerAssetId,
  providerType,
}: {
  readonly providerAssetId: string
  readonly providerType: string
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId,
          currencyCode: providerType === "nft" ? "ART" : "COIN",
          name: providerType === "nft" ? "Artwork" : "Coin",
          exponent: providerType === "nft" ? 0 : 8,
          providerType,
          retrievedAt: new Date("2026-08-16T08:00:00.000Z"),
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
      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId: TEST_SOURCE_ID,
      })

      return providerAsset.id
    })
  )

const seedObservedPendingProviderAsset = ({
  providerAssetId,
}: {
  readonly providerAssetId: string
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [ethereumBlockchain] = yield* db
        .select({ id: schema.blockchains.id })
        .from(schema.blockchains)
        .where(eq(schema.blockchains.name, "ethereum"))
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId,
          currencyCode: "BTC",
          name: "Bitcoin",
          exponent: 18,
          providerType: "crypto",
          retrievedAt: new Date("2026-08-16T09:00:00.000Z"),
        })
        .returning({ id: schema.providerAssets.id })
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: TEST_SOURCE_ID,
          externalId: `${providerAssetId}-transaction`,
          timestamp: new Date("2026-08-16T09:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.transactions.id })
      if (
        ethereumBlockchain === undefined ||
        providerAsset === undefined ||
        transaction === undefined
      ) {
        return yield* Effect.dieMessage("Failed to seed observed provider asset")
      }

      yield* db.insert(schema.providerAssetMappings).values({
        providerAssetRowId: providerAsset.id,
        mappingKind: "asset",
        mappingStatus: "pending_review",
      })
      yield* db.insert(schema.providerTransfers).values({
        sourceId: TEST_SOURCE_ID,
        transactionId: transaction.id,
        externalId: `${providerAssetId}-transfer`,
        providerAssetId: providerAsset.id,
        timestamp: new Date("2026-08-16T09:00:00.000Z"),
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

      return providerAsset.id
    })
  )

const makeTrackedServiceLayer = ({
  coinGeckoClient,
  transactionEntered,
}: {
  readonly coinGeckoClient: CoinGeckoClientShape
  readonly transactionEntered: Deferred.Deferred<void>
}) => {
  const transactionLayer = Layer.succeed(
    SyncEngineTransaction,
    SyncEngineTransaction.of({
      run: (effect) =>
        Deferred.succeed(transactionEntered, undefined).pipe(Effect.zipRight(effect)),
    })
  )
  const repositoryLayer = Layer.mergeAll(
    AssetRepositoryLive,
    ProviderAssetRepositoryLive,
    transactionLayer
  ).pipe(Layer.provide(context.TestPgClientLive))

  return AssetCanonicalizationServiceLive.pipe(
    Layer.provide(repositoryLayer),
    Layer.provide(Layer.succeed(CoinGeckoClient, coinGeckoClient))
  )
}

describe("AssetCanonicalizationServiceLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    const fixture = await context.runPg(seedSyncEngineRepositoryFixture())
    await context.runPg(seedSyncEngineAssets(fixture))
  })

  it("approves a chainless crypto provider asset only to a fungible target", async () => {
    const providerAssetRowId = await seedChainlessPendingProviderAsset({
      providerAssetId: "chainless-fungible-approval",
      providerType: "crypto",
    })

    const result = await runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: null,
          reviewerNotes: "Reviewed chainless fungible asset.",
        })
      )
    )
    const state = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({ status: schema.providerAssetMappings.mappingStatus })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        const jobs = yield* db
          .select({ mode: schema.processingJobs.mode, sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
        return { jobs, mapping }
      })
    )

    expect(result.mapping).toMatchObject({
      mappingStatus: "approved",
      canonicalAssetId: TEST_BTC_ASSET_ID,
      assetRepresentationId: null,
    })
    expect(state.mapping?.status).toBe("approved")
    expect(state.jobs).toEqual([{ mode: "replay", sourceId: TEST_SOURCE_ID }])
  })

  it("approves a chainless NFT provider asset to an NFT target", async () => {
    const providerAssetRowId = await seedChainlessPendingProviderAsset({
      providerAssetId: "chainless-nft-approval",
      providerType: "nft",
    })
    const targetAssetId = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [asset] = yield* db
          .insert(schema.assets)
          .values({ name: "Artwork", symbol: "ART", type: "nft" })
          .returning({ id: schema.assets.id })
        if (asset === undefined) {
          return yield* Effect.dieMessage("Failed to seed NFT target")
        }
        return asset.id
      })
    )

    const result = await runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId: targetAssetId,
          assetRepresentationId: null,
          reviewerNotes: "Reviewed chainless NFT asset.",
        })
      )
    )
    const state = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({ status: schema.providerAssetMappings.mappingStatus })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
        const jobs = yield* db
          .select({ mode: schema.processingJobs.mode, sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
        return { jobs, mapping }
      })
    )

    expect(result.mapping).toMatchObject({
      mappingStatus: "approved",
      canonicalAssetId: targetAssetId,
      assetRepresentationId: null,
    })
    expect(state.mapping?.status).toBe("approved")
    expect(state.jobs).toEqual([{ mode: "replay", sourceId: TEST_SOURCE_ID }])
  })

  it.each([
    {
      providerType: "crypto",
      targetType: "nft" as const,
      expectedMessage: "Provider asset type does not match the selected economic asset type.",
    },
    {
      providerType: "nft",
      targetType: "fungible" as const,
      expectedMessage: "Provider asset type does not match the selected economic asset type.",
    },
    {
      providerType: "unknown",
      targetType: "fungible" as const,
      expectedMessage: "Provider asset type does not prove a fungible or NFT economic asset.",
    },
  ])(
    "rejects a chainless $providerType provider asset mapped to a $targetType target",
    async ({ expectedMessage, providerType, targetType }) => {
      const providerAssetRowId = await seedChainlessPendingProviderAsset({
        providerAssetId: `chainless-${providerType}-mismatch`,
        providerType,
      })
      const targetAssetId =
        targetType === "fungible"
          ? TEST_BTC_ASSET_ID
          : await context.runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                const [asset] = yield* db
                  .insert(schema.assets)
                  .values({ name: "Artwork", symbol: "ART", type: "nft" })
                  .returning({ id: schema.assets.id })
                if (asset === undefined) {
                  return yield* Effect.dieMessage("Failed to seed NFT target")
                }
                return asset.id
              })
            )

      const result = await runService(
        Effect.flatMap(AssetCanonicalizationService, (service) =>
          service.approveProviderAssetMapping({
            providerAssetRowId,
            canonicalAssetId: targetAssetId,
            assetRepresentationId: null,
            reviewerNotes: "Mismatched chainless type.",
          })
        ).pipe(Effect.either)
      )
      const state = await context.runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
          const jobs = yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
          return { jobs, mapping }
        })
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "AssetCanonicalizationBadRequestError",
          message: expectedMessage,
        })
      }
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.jobs).toHaveLength(0)
    }
  )

  it("resolves CoinGecko evidence before entering the database transaction", async () => {
    const providerAssetRowId = await seedObservedPendingProviderAsset({
      providerAssetId: "coingecko-outside-transaction",
    })
    const searchStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseSearch = await Effect.runPromise(Deferred.make<void>())
    const transactionEntered = await Effect.runPromise(Deferred.make<void>())
    const coinGeckoClient = CoinGeckoClient.of({
      searchCoins: () =>
        Deferred.succeed(searchStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseSearch)),
          Effect.as([{ id: "ethereum", name: "Bitcoin", symbol: "btc" }])
        ),
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
    const layer = makeTrackedServiceLayer({ coinGeckoClient, transactionEntered })
    const canonicalization = Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(AssetCanonicalizationService, (service) =>
          service.canonicalizeProviderAssetFromCoinGecko({
            providerAssetRowId,
            reviewerNotes: "Resolve external evidence first.",
          })
        ),
        layer,
      })
    )

    await Effect.runPromise(Deferred.await(searchStarted))
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(transactionEntered)))).toBe(true)

    await Effect.runPromise(Deferred.succeed(releaseSearch, undefined))
    const result = await canonicalization

    expect(result.providerAsset.mapping?.mappingStatus).toBe("approved")
    expect(Option.isSome(await Effect.runPromise(Deferred.poll(transactionEntered)))).toBe(true)
  })

  it("does not enter the database transaction when CoinGecko resolution fails", async () => {
    const providerAssetRowId = await seedObservedPendingProviderAsset({
      providerAssetId: "coingecko-failure-before-transaction",
    })
    const transactionEntered = await Effect.runPromise(Deferred.make<void>())
    const coinGeckoClient = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.fail(new CoinGeckoClientError({ message: "CoinGecko unavailable" })),
      getCoin: () => Effect.dieMessage("getCoin should not be called"),
      listMarkets: () => Effect.succeed([]),
    })
    const layer = makeTrackedServiceLayer({ coinGeckoClient, transactionEntered })
    const before = await countCanonicalRows()
    const result = await Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(AssetCanonicalizationService, (service) =>
          service.canonicalizeProviderAssetFromCoinGecko({
            providerAssetRowId,
            reviewerNotes: "Provider failure before transaction.",
          })
        ).pipe(Effect.either),
        layer,
      })
    )
    const after = await countCanonicalRows()

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationProviderError",
        message: "CoinGecko unavailable",
      })
    }
    expect(after).toEqual(before)
    expect(Option.isNone(await Effect.runPromise(Deferred.poll(transactionEntered)))).toBe(true)
  })

  it.each(["metadata", "observations"] as const)(
    "rejects CoinGecko approval when provider %s change during resolution",
    async (changedEvidence) => {
      const providerAssetRowId = await seedObservedPendingProviderAsset({
        providerAssetId: `coingecko-stale-${changedEvidence}`,
      })
      const searchStarted = await Effect.runPromise(Deferred.make<void>())
      const releaseSearch = await Effect.runPromise(Deferred.make<void>())
      const coinGeckoClient = CoinGeckoClient.of({
        searchCoins: () =>
          Deferred.succeed(searchStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseSearch)),
            Effect.as([{ id: "ethereum", name: "Bitcoin", symbol: "btc" }])
          ),
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
      const layer = AssetCanonicalizationServiceLive.pipe(
        Layer.provide(RepositoryLayer),
        Layer.provide(Layer.succeed(CoinGeckoClient, coinGeckoClient))
      )
      const before = await countCanonicalRows()
      const canonicalization = Effect.runPromise(
        context.runWithLayer({
          effect: Effect.flatMap(AssetCanonicalizationService, (service) =>
            service.canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId,
              reviewerNotes: "Reject stale provider evidence.",
            })
          ).pipe(Effect.either),
          layer,
        })
      )

      await Effect.runPromise(Deferred.await(searchStarted))
      await context.runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          if (changedEvidence === "metadata") {
            yield* db
              .update(schema.providerAssets)
              .set({ retrievedAt: new Date("2026-08-16T10:00:00.000Z") })
              .where(eq(schema.providerAssets.id, providerAssetRowId))
          } else {
            yield* db
              .update(schema.providerTransfers)
              .set({ observedDecimals: 17 })
              .where(eq(schema.providerTransfers.providerAssetId, providerAssetRowId))
          }
        })
      )
      await Effect.runPromise(Deferred.succeed(releaseSearch, undefined))
      const result = await canonicalization
      const after = await countCanonicalRows()
      const state = await context.runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
          const jobs = yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
          return { jobs, mapping }
        })
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "AssetCanonicalizationInternalError",
          message: "Provider asset evidence changed before canonical approval.",
        })
      }
      expect(after).toEqual(before)
      expect(state.mapping?.status).toBe("pending_review")
      expect(state.jobs).toHaveLength(0)
    }
  )

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
      expect(result.left._tag).toBe("AssetCanonicalizationBadRequestError")
      expect(result.left.message).toBe(
        "Provider asset mapping cannot be approved from its current state."
      )
    }
  })

  it("revalidates the canonical representation after a concurrent target update", async () => {
    const fixture = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [bitcoinRepresentation] = yield* db
          .select({
            id: schema.assetRepresentations.id,
            blockchainId: schema.assetRepresentations.blockchainId,
          })
          .from(schema.assetRepresentations)
          .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "btc-concurrent-target-update",
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            retrievedAt: new Date("2026-08-16T11:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "btc-concurrent-target-update-transaction",
            timestamp: new Date("2026-08-16T11:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (
          bitcoinRepresentation === undefined ||
          providerAsset === undefined ||
          transaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to seed concurrent target update fixture")
        }

        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          mappingStatus: "pending_review",
        })
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: "btc-concurrent-target-update-transfer",
          providerAssetId: providerAsset.id,
          timestamp: new Date("2026-08-16T11:00:00.000Z"),
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account-1",
          toAddress: "bc1qconcurrenttargetupdate000000000000000000",
          amount: "0.1",
          observedBlockchainId: bitcoinRepresentation.blockchainId,
          observedRepresentationType: "token",
          observedContractAddress: "sync-engine-btc-fixture",
          observedDecimals: 8,
          metadata: {},
        })

        return { providerAssetRowId: providerAsset.id }
      })
    )
    const targetUpdated = await Effect.runPromise(Deferred.make<void>())
    const releaseTargetUpdate = await Effect.runPromise(Deferred.make<void>())
    const concurrentTargetUpdate = context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(schema.assetRepresentations)
              .set({ decimals: 7 })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            yield* Deferred.succeed(targetUpdated, undefined)
            yield* Deferred.await(releaseTargetUpdate)
          })
        )
      })
    )
    await Effect.runPromise(Deferred.await(targetUpdated))

    const approval = runService(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId: fixture.providerAssetRowId,
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          reviewerNotes: "Reject a stale canonical representation.",
        })
      ).pipe(Effect.either)
    )
    const earlyOutcome = await Promise.race([
      approval.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])
    await Effect.runPromise(Deferred.succeed(releaseTargetUpdate, undefined))
    const [result] = await Promise.all([approval, concurrentTargetUpdate])
    const state = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select({ status: schema.providerAssetMappings.mappingStatus })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId))
        const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)
        return { jobs, mapping }
      })
    )

    expect(earlyOutcome).toBe("blocked")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Selected representation does not match the observed on-chain identity.",
      })
    }
    expect(state.mapping?.status).toBe("pending_review")
    expect(state.jobs).toHaveLength(0)
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

  it("rejects a concurrent CoinGecko winner before canonical writes", async () => {
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
          observedBlockchainId: bitcoinRepresentation.blockchainId,
          observedRepresentationType: "native",
          observedDecimals: 8,
          metadata: {},
        })
        return {
          bitcoinRepresentationId: bitcoinRepresentation.id,
          providerAssetRowId: providerAsset.id,
        }
      })
    )
    const before = await countCanonicalRows()
    const searchStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseSearch = await Effect.runPromise(Deferred.make<void>())
    const coinGeckoClient = CoinGeckoClient.of({
      searchCoins: () =>
        Deferred.succeed(searchStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseSearch)),
          Effect.as([{ id: "ethereum", name: "Bitcoin", symbol: "btc" }])
        ),
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
    const layer = AssetCanonicalizationServiceLive.pipe(
      Layer.provide(RepositoryLayer),
      Layer.provide(Layer.succeed(CoinGeckoClient, coinGeckoClient))
    )
    const canonicalization = Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(AssetCanonicalizationService, (service) =>
          service.canonicalizeProviderAssetFromCoinGecko({
            providerAssetRowId: fixture.providerAssetRowId,
            reviewerNotes: "Losing concurrent target.",
          })
        ).pipe(Effect.either),
        layer,
      })
    )

    await Effect.runPromise(Deferred.await(searchStarted))
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
    await Effect.runPromise(Deferred.succeed(releaseSearch, undefined))
    const result = await canonicalization

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
})
