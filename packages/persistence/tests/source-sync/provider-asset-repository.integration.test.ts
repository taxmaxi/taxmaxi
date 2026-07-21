import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProviderAssetRepository, SyncEngineStorageError } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_asset_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

describe("ProviderAssetRepositoryLive", () => {
  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  describe("current schema", () => {
    beforeEach(async () => {
      await Effect.runPromise(context.recreateTestDatabase())
      const fixture = await runPg(seedSyncEngineRepositoryFixture())
      await runPg(
        seedSyncEngineAssets({
          baseBlockchainId: fixture.baseBlockchainId,
          bitcoinBlockchainId: fixture.bitcoinBlockchainId,
        })
      )
    })

    it("upserts provider assets by stable provider asset id and resolves mappings", async () => {
      const firstUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "btc",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset" },
              },
            ],
          })
        )
      )

      const secondUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin Updated",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset", revision: 2 },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-provider-asset",
          })
        )
      )

      expect(Option.isSome(providerAsset)).toBe(true)

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const providerAssetRecord = providerAsset.value

      const mappingUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAssetRecord.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                canonicalAssetSymbol: "BTC",
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Reviewed",
                sourceNotes: "Seeded in integration test",
              },
            ],
          })
        )
      )

      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({
            providerAssetRowId: providerAssetRecord.id,
          })
        )
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(firstUpsertCount).toBe(1)
      expect(secondUpsertCount).toBe(1)
      expect(mappingUpsertCount).toBe(1)
      expect(providerAssetRecord).toMatchObject({
        provider: "coinbase",
        providerAssetId: "btc-provider-asset",
        naturalKey: null,
        currencyCode: "BTC",
        name: "Bitcoin Updated",
        exponent: 8,
        providerType: "crypto",
      })
      expect(Option.getOrNull(mapping)).toMatchObject({
        providerAssetRowId: providerAssetRecord.id,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        canonicalAssetSymbol: "BTC",
        mappingStatus: "approved",
      })
      expect(providerAssetRows).toHaveLength(1)
    })

    it("falls back to provider-scoped natural-key lookup when provider asset id is absent", async () => {
      const upsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:EUR",
                currencyCode: "eur",
                name: "Euro",
                exponent: 2,
                providerType: "fiat",
                payload: { id: "EUR" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:EUR",
          })
        )
      )

      expect(upsertCount).toBe(1)
      expect(Option.getOrNull(providerAsset)).toMatchObject({
        provider: "coinbase",
        providerAssetId: null,
        naturalKey: "currency_code:EUR",
        currencyCode: "EUR",
        name: "Euro",
        exponent: 2,
        providerType: "fiat",
      })
    })

    it("pages provider asset reviews with a stable provider asset cursor", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "ada-provider-asset",
                naturalKey: null,
                currencyCode: "ADA",
                name: "Cardano",
                exponent: 6,
                providerType: "crypto",
                payload: { code: "ADA" },
              },
              {
                providerAssetId: "eth-provider-asset",
                naturalKey: null,
                currencyCode: "ETH",
                name: "Ethereum",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "ETH" },
              },
              {
                providerAssetId: "sol-provider-asset",
                naturalKey: null,
                currencyCode: "SOL",
                name: "Solana",
                exponent: 9,
                providerType: "crypto",
                payload: { code: "SOL" },
              },
            ],
          })
        )
      )

      const providerAssets = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const cardano = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "ada-provider-asset",
          })
          const ethereum = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "eth-provider-asset",
          })
          const solana = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "sol-provider-asset",
          })

          if (Option.isNone(cardano) || Option.isNone(ethereum) || Option.isNone(solana)) {
            return yield* Effect.dieMessage("Expected provider assets to exist")
          }

          return [cardano.value, ethereum.value, solana.value] as const
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: providerAssets.map((providerAsset) => ({
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: null,
              canonicalAssetSymbol: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review",
              reviewerNotes: null,
              sourceNotes: "Needs review",
            })),
          })
        )
      )

      const firstPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            query: null,
            cursorProviderAssetRowId: null,
            limit: 2,
          })
        )
      )

      expect(firstPage.map((row) => row.providerAsset.currencyCode)).toEqual(["ADA", "ETH"])

      const secondPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            query: null,
            cursorProviderAssetRowId: firstPage[1]?.providerAsset.id ?? null,
            limit: 2,
          })
        )
      )

      expect(secondPage.map((row) => row.providerAsset.currencyCode)).toEqual(["SOL"])
    })

    it("keeps reviewed natural-key mappings preferred when a stable provider asset id arrives later", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:HYPE",
                currencyCode: "hype",
                name: "Hyperliquid",
                exponent: null,
                providerType: null,
                payload: { code: "HYPE" },
              },
            ],
          })
        )
      )

      const naturalKeyProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:HYPE",
          })
        )
      )

      if (Option.isNone(naturalKeyProviderAsset)) {
        expect.fail("Expected natural-key provider asset row to exist")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: naturalKeyProviderAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                canonicalAssetSymbol: "BTC",
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Admin reviewed placeholder asset",
                sourceNotes: "Admin decision",
              },
            ],
          })
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "hype-provider-asset",
                naturalKey: null,
                currencyCode: "HYPE",
                name: "Hyperliquid",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "HYPE", asset_id: "hype-provider-asset" },
              },
            ],
          })
        )
      )

      const resolvedProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByCurrencyCode({
            providerKey: "coinbase",
            currencyCode: "HYPE",
          })
        )
      )

      expect(Option.getOrNull(resolvedProviderAsset)).toMatchObject({
        id: naturalKeyProviderAsset.value.id,
        naturalKey: "currency_code:HYPE",
        providerAssetId: null,
        currencyCode: "HYPE",
      })
    })

    it("fails when a provider asset entry has neither stable id nor natural key", async () => {
      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: null,
                currencyCode: "mystery",
                name: "Mystery Asset",
                exponent: null,
                providerType: null,
                payload: { code: "MYSTERY" },
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(error).toEqual(
        new SyncEngineStorageError({
          operation: "providerAssetRepository.upsertProviderAssets",
          cause: {
            providerKey: "coinbase",
            currencyCode: "mystery",
            message: "Provider asset entries require either providerAssetId or naturalKey.",
          },
        })
      )
      expect(providerAssetRows).toHaveLength(0)
    })

    it("searches review evidence and applies one attributed decision atomically", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "review-usdc",
                naturalKey: "currency_code:USDC",
                currencyCode: "USDC",
                name: "USD Coin",
                exponent: 6,
                providerType: "crypto",
                payload: { contract_address: "0xreview" },
              },
            ],
          })
          const asset = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "review-usdc",
          })
          if (Option.isNone(asset)) return yield* Effect.dieMessage("missing provider asset")
          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: asset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                canonicalAssetSymbol: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Needs review",
              },
            ],
          })
          return asset.value
        })
      )
      const reviewedAt = new Date("2026-07-20T10:00:00.000Z")
      const [firstDecision, secondDecision, searched, count, review] = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const decision = {
            providerAssetRowId: providerAsset.id,
            mappingKind: "asset" as const,
            canonicalAssetId: TEST_BTC_ASSET_ID,
            canonicalAssetSymbol: "BTC",
            canonicalAssetDraft: null,
            mappingStatus: "approved" as const,
            reviewerNotes: "Verified evidence",
            sourceNotes: "Mapped in review",
            reviewedBy: TEST_USER_ID,
            reviewedAt,
            createReplayJobs: false,
          }
          const first = yield* repository.decideProviderAssetMapping(decision)
          const second = yield* repository.decideProviderAssetMapping(decision)
          const rows = yield* repository.listProviderAssetReviews({
            providerKey: null,
            mappingStatus: "approved",
            query: "0xreview",
            cursorProviderAssetRowId: null,
            limit: 10,
          })
          const total = yield* repository.countProviderAssetReviews({
            providerKey: null,
            mappingStatus: "approved",
            query: "USD Coin",
          })
          const loaded = yield* repository.findProviderAssetReviewById({
            providerAssetRowId: providerAsset.id,
          })
          return [first, second, rows, total, loaded] as const
        })
      )

      expect(firstDecision.updated).toBe(true)
      expect(secondDecision.updated).toBe(false)
      expect(searched).toHaveLength(1)
      expect(count).toBe(1)
      expect(Option.getOrNull(review)?.mapping).toMatchObject({
        reviewedBy: TEST_USER_ID,
        reviewedAt,
        reviewerNotes: "Verified evidence",
      })
    })

    it("publishes a canonical asset and durable replay job in the review transaction", async () => {
      const providerAssetId = crypto.randomUUID()
      const transactionId = crypto.randomUUID()

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.providerAssets).values({
            id: providerAssetId,
            provider: "helius-solana",
            providerAssetId: "ReviewMint111111111111111111111111111111111",
            currencyCode: "RVT",
            name: "Review Token",
            providerType: "spl-token",
            rawProviderPayload: { symbol: "RVT" },
            retrievedAt: new Date("2026-07-20T10:00:00.000Z"),
          })
          yield* db.insert(schema.providerAssetMappings).values({
            providerAssetRowId: providerAssetId,
            mappingKind: "asset",
            mappingStatus: "pending_review",
          })
          yield* db.insert(schema.transactions).values({
            id: transactionId,
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            externalId: "provider-asset-review-replay",
            timestamp: new Date("2026-07-20T10:00:00.000Z"),
          })
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId,
            providerAssetId,
            externalId: "provider-asset-review-replay",
            timestamp: new Date("2026-07-20T10:00:00.000Z"),
            direction: "inbound",
            fromAddress: "external",
            toAddress: "owned",
            amount: "1",
          })
          yield* db.insert(schema.processingJobs).values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "pending",
          })
        })
      )

      const reviewedAt = new Date("2026-07-20T11:00:00.000Z")
      const decision = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.decideProviderAssetMapping({
            providerAssetRowId: providerAssetId,
            mappingKind: "asset",
            canonicalAssetId: null,
            canonicalAssetSymbol: null,
            canonicalAssetDraft: {
              blockchain: {
                name: "review-chain",
                chainType: "solana",
                chainId: null,
                nativeAssetSymbol: "SOL",
                explorerUrl: null,
                logoUrl: null,
                coingeckoPlatformId: "review-chain",
              },
              asset: {
                contractAddress: "ReviewMint111111111111111111111111111111111",
                name: "Review Token",
                symbol: "RVT",
                decimals: 9,
                coingeckoCoinId: "review-token",
                logoUrl: null,
                type: "token",
                isSpam: false,
              },
            },
            mappingStatus: "approved",
            reviewerNotes: null,
            sourceNotes: "Reviewed",
            reviewedBy: TEST_USER_ID,
            reviewedAt,
            createReplayJobs: true,
          })
        )
      )
      const staleDecision = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.decideProviderAssetMapping({
            providerAssetRowId: providerAssetId,
            mappingKind: "asset",
            canonicalAssetId: null,
            canonicalAssetSymbol: null,
            canonicalAssetDraft: {
              blockchain: {
                name: "wrong-review-chain",
                chainType: "solana",
                chainId: null,
                nativeAssetSymbol: "SOL",
                explorerUrl: null,
                logoUrl: null,
                coingeckoPlatformId: "wrong-review-chain",
              },
              asset: {
                contractAddress: "WrongMint1111111111111111111111111111111111",
                name: "Wrong Review Token",
                symbol: "WRONG",
                decimals: 9,
                coingeckoCoinId: "wrong-review-token",
                logoUrl: null,
                type: "token",
                isSpam: false,
              },
            },
            mappingStatus: "approved",
            reviewerNotes: null,
            sourceNotes: "Stale review",
            reviewedBy: TEST_USER_ID,
            reviewedAt,
            createReplayJobs: true,
          })
        )
      )

      const persisted = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({
              sourceId: schema.processingJobs.sourceId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const mappings = yield* db
            .select({ canonicalAssetId: schema.providerAssetMappings.canonicalAssetId })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetId))
          const staleAssets = yield* db
            .select({ id: schema.assets.id })
            .from(schema.assets)
            .where(eq(schema.assets.coingeckoCoinId, "wrong-review-token"))
          return { jobs, mappings, staleAssets }
        })
      )

      expect(decision).toMatchObject({
        updated: true,
        canonicalAsset: { symbol: "RVT" },
        affectedSources: [
          {
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            jobId: expect.any(String),
          },
        ],
      })
      expect(persisted.jobs).toEqual([
        { sourceId: TEST_SOURCE_ID, mode: "sync", followUpMode: "replay" },
      ])
      expect(persisted.mappings[0]?.canonicalAssetId).toBe(decision.canonicalAsset?.id)
      expect(staleDecision.updated).toBe(false)
      expect(persisted.staleAssets).toHaveLength(0)

      const replayJobId = decision.affectedSources[0]?.jobId
      expect(replayJobId).toBeDefined()

      if (replayJobId !== undefined) {
        const unrelatedJobId = crypto.randomUUID()
        await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.transactions).where(eq(schema.transactions.id, transactionId))
            yield* db.insert(schema.processingJobs).values({
              id: unrelatedJobId,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "sync",
              status: "completed",
              completedAt: new Date("2026-07-20T12:00:00.000Z"),
            })
          })
        )

        const replaySource = await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.findProviderAssetReplaySource({
              providerAssetRowId: providerAssetId,
              sourceId: TEST_SOURCE_ID,
              jobId: replayJobId,
            })
          )
        )

        expect(Option.getOrNull(replaySource)).toEqual({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          jobId: replayJobId,
        })

        const unrelatedSource = await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.findProviderAssetReplaySource({
              providerAssetRowId: providerAssetId,
              sourceId: TEST_SOURCE_ID,
              jobId: unrelatedJobId,
            })
          )
        )
        expect(Option.isNone(unrelatedSource)).toBe(true)
      }
    })

    it("uses one canonical asset for concurrent native approvals", async () => {
      const providerAssetIds = [crypto.randomUUID(), crypto.randomUUID()] as const

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.providerAssets).values(
            providerAssetIds.map((id, index) => ({
              id,
              provider: "coinbase",
              providerAssetId: `native-review-${index}`,
              currencyCode: "RNC",
              name: "Review Native Coin",
              providerType: "crypto",
              rawProviderPayload: { symbol: "RNC" },
              retrievedAt: new Date("2026-07-20T10:00:00.000Z"),
            }))
          )
          yield* db.insert(schema.providerAssetMappings).values(
            providerAssetIds.map((providerAssetRowId) => ({
              providerAssetRowId,
              mappingKind: "asset" as const,
              mappingStatus: "pending_review" as const,
            }))
          )
        })
      )

      const decide = (providerAssetRowId: string) =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.decideProviderAssetMapping({
              providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: null,
              canonicalAssetSymbol: null,
              canonicalAssetDraft: {
                blockchain: {
                  name: "review-native-chain",
                  chainType: "other",
                  chainId: null,
                  nativeAssetSymbol: "RNC",
                  explorerUrl: null,
                  logoUrl: null,
                  coingeckoPlatformId: "review-native-chain",
                },
                asset: {
                  contractAddress: null,
                  name: "Review Native Coin",
                  symbol: "RNC",
                  decimals: 8,
                  coingeckoCoinId: "review-native-coin",
                  logoUrl: null,
                  type: "native",
                  isSpam: false,
                },
              },
              mappingStatus: "approved",
              reviewerNotes: null,
              sourceNotes: "Concurrent review",
              reviewedBy: TEST_USER_ID,
              reviewedAt: new Date("2026-07-20T12:00:00.000Z"),
              createReplayJobs: false,
            })
          )
        )

      const decisions = await Promise.all(providerAssetIds.map(decide))

      expect(decisions[0]?.canonicalAsset?.id).toBe(decisions[1]?.canonicalAsset?.id)

      const nativeAssets = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assets.id })
            .from(schema.assets)
            .where(eq(schema.assets.coingeckoCoinId, "review-native-coin"))
        })
      )
      expect(nativeAssets).toHaveLength(1)
    })

    it("preserves review history when the administrator is deleted", async () => {
      const providerAssetId = crypto.randomUUID()

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.providerAssets).values({
            id: providerAssetId,
            provider: "coinbase",
            providerAssetId: "reviewed-before-user-deletion",
            currencyCode: "DEL",
            name: "Deletion Review",
            providerType: "crypto",
            rawProviderPayload: {},
            retrievedAt: new Date("2026-07-20T10:00:00.000Z"),
          })
          yield* db.insert(schema.providerAssetMappings).values({
            providerAssetRowId: providerAssetId,
            mappingKind: "asset",
            mappingStatus: "rejected",
            reviewedBy: TEST_USER_ID,
            reviewedAt: new Date("2026-07-20T12:00:00.000Z"),
          })
          yield* db.delete(schema.users).where(eq(schema.users.id, TEST_USER_ID))
        })
      )

      const [mapping] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ reviewedBy: schema.providerAssetMappings.reviewedBy })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetId))
        })
      )

      expect(mapping?.reviewedBy).toBeNull()
    })
  })
})
