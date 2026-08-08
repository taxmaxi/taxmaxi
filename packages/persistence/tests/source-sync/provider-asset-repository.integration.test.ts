import { asc, eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
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
  let baseBlockchainId: string

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  describe("current schema", () => {
    beforeEach(async () => {
      await Effect.runPromise(context.recreateTestDatabase())
      const fixture = await runPg(seedSyncEngineRepositoryFixture())
      baseBlockchainId = fixture.baseBlockchainId
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
                assetRepresentationId: null,
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
        assetRepresentationId: null,
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

    it("rejects a network representation that belongs to another economic asset", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "mismatched-representation-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "mismatched-representation-fixture" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "mismatched-representation-fixture",
          })
        )
      )

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Invalid cross-asset representation fixture",
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      expect(error).toBeInstanceOf(SyncEngineStorageError)
    })

    it("rejects an update when the expected mapping status changed", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "mapping-status-snapshot-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Mapping status snapshot fixture",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "mapping-status-snapshot-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "mapping-status-snapshot-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected mapping status snapshot provider asset")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "rejected",
                reviewerNotes: "Rejected during review",
                sourceNotes: "Rejected during review",
              },
            ],
          })
        )
      )

      const updateResult = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Automatic exact representation match",
                expectedMappingStatus: "pending_review",
              },
            ],
          })
        ).pipe(Effect.either)
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({
            providerAssetRowId: providerAsset.value.id,
          })
        )
      )

      expect(updateResult._tag).toBe("Left")
      expect(Option.getOrNull(mapping)).toMatchObject({ mappingStatus: "rejected" })
    })

    it("requires the current approved target before correcting a mapping", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "approved-target-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "approved-target-fixture" },
              },
              {
                providerAssetId: "approved-target-batch-peer",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin batch peer",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "approved-target-batch-peer" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "approved-target-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected approved target provider asset")
      }
      const batchPeerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "approved-target-batch-peer",
          })
        )
      )
      if (Option.isNone(batchPeerAsset)) {
        expect.fail("Expected approved target batch peer provider asset")
      }
      const eurAssetId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [representation] = yield* db
            .select({ assetId: schema.assetRepresentations.assetId })
            .from(schema.assetRepresentations)
            .where(eq(schema.assetRepresentations.id, TEST_EUR_REPRESENTATION_ID))
          if (representation === undefined) {
            return yield* Effect.dieMessage("Expected EUR representation fixture")
          }
          return representation.assetId
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Initial approval",
                sourceNotes: "Initial approval",
              },
            ],
          })
        )
      )
      const remapResult = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: eurAssetId,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Conflicting approval",
                sourceNotes: "Conflicting approval",
              },
              {
                providerAssetRowId: batchPeerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Valid batch peer approval",
                sourceNotes: "Valid batch peer approval",
              },
            ],
          })
        ).pipe(Effect.either)
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.value.id })
        )
      )
      const batchPeerMapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({
            providerAssetRowId: batchPeerAsset.value.id,
          })
        )
      )

      expect(remapResult._tag).toBe("Left")
      expect(Option.getOrNull(mapping)).toMatchObject({
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        mappingStatus: "approved",
      })
      expect(Option.isNone(batchPeerMapping)).toBe(true)

      const corrected = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: eurAssetId,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Explicit correction",
                sourceNotes: "Explicit correction",
                expectedApprovedTarget: {
                  mappingKind: "asset",
                  canonicalAssetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: null,
                },
              },
            ],
          })
        )
      )
      const correctedMapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.value.id })
        )
      )

      expect(corrected).toBe(1)
      expect(Option.getOrNull(correctedMapping)).toMatchObject({
        canonicalAssetId: eurAssetId,
        assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
        mappingStatus: "approved",
      })
    })

    it("serializes concurrent corrections that share an approved target snapshot", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "concurrent-approved-target-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Concurrent approved target fixture",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "concurrent-approved-target-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "concurrent-approved-target-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected concurrent approved target provider asset")
      }
      const eurAssetId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [representation] = yield* db
            .select({ assetId: schema.assetRepresentations.assetId })
            .from(schema.assetRepresentations)
            .where(eq(schema.assetRepresentations.id, TEST_EUR_REPRESENTATION_ID))
          if (representation === undefined) {
            return yield* Effect.dieMessage("Expected EUR representation fixture")
          }
          return representation.assetId
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Initial approval",
                sourceNotes: "Initial approval",
              },
            ],
          })
        )
      )

      const expectedApprovedTarget = {
        mappingKind: "asset" as const,
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
      }
      const [assetCorrection, fiatCorrection] = await Promise.all([
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssetMappings({
              mappings: [
                {
                  providerAssetRowId: providerAsset.value.id,
                  mappingKind: "asset",
                  canonicalAssetId: eurAssetId,
                  assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                  canonicalFiatCurrency: null,
                  mappingStatus: "approved",
                  reviewerNotes: "Concurrent asset correction",
                  sourceNotes: "Concurrent asset correction",
                  expectedApprovedTarget,
                },
              ],
            })
          ).pipe(Effect.either)
        ),
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssetMappings({
              mappings: [
                {
                  providerAssetRowId: providerAsset.value.id,
                  mappingKind: "fiat",
                  canonicalAssetId: null,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: "EUR",
                  mappingStatus: "approved",
                  reviewerNotes: "Concurrent fiat correction",
                  sourceNotes: "Concurrent fiat correction",
                  expectedApprovedTarget,
                },
              ],
            })
          ).pipe(Effect.either)
        ),
      ])
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.value.id })
        )
      )

      expect([assetCorrection._tag, fiatCorrection._tag].sort()).toEqual(["Left", "Right"])
      expect(Option.getOrNull(mapping)).toEqual(
        expect.objectContaining(
          assetCorrection._tag === "Right"
            ? {
                mappingKind: "asset",
                canonicalAssetId: eurAssetId,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
              }
            : {
                mappingKind: "fiat",
                canonicalAssetId: null,
                canonicalFiatCurrency: "EUR",
              }
        )
      )
    })

    it("rejects approval when the observed representation snapshot changed", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "stale-observation-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Stale observation fixture",
                exponent: null,
                providerType: "spl-token",
                payload: { mint: "stale-observation-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "stale-observation-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected stale observation provider asset")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending observation review",
              },
            ],
          })
        )
      )

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "stale-observation-transaction",
              timestamp: new Date("2025-04-10T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.dieMessage("Failed to seed stale observation transaction")
          }
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "stale-observation-provider-transfer",
            providerAssetId: providerAsset.value.id,
            timestamp: new Date("2025-04-10T10:00:00.000Z"),
            direction: "inbound",
            fromAddress: "0x0000000000000000000000000000000000000001",
            toAddress: "0x0000000000000000000000000000000000000002",
            observedBlockchainId: baseBlockchainId,
            observedRepresentationType: "token",
            observedContractAddress: "0x0000000000000000000000000000000000000c96",
            observedDecimals: 8,
            amount: "1.00000000",
            metadata: { role: "principal" },
          })
        })
      )

      const approvalResult = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approve stale snapshot",
                sourceNotes: "Approve stale snapshot",
                expectedObservedRepresentations: [],
              },
            ],
          })
        ).pipe(Effect.either)
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.value.id })
        )
      )

      expect(approvalResult._tag).toBe("Left")
      expect(Option.getOrNull(mapping)).toMatchObject({ mappingStatus: "pending_review" })
    })

    it("rejects approval when provider metadata changed after validation", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "stale-provider-metadata-fixture",
                naturalKey: null,
                currencyCode: "STALE",
                name: "Stale provider metadata fixture",
                exponent: 5,
                providerType: "spl-token",
                payload: { mint: "stale-provider-metadata-fixture", revision: 1 },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "stale-provider-metadata-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected stale provider metadata asset")
      }
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending review",
              },
            ],
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({
              exponent: 6,
              retrievedAt: new Date(providerAsset.value.retrievedAt.getTime() + 1_000),
            })
            .where(eq(schema.providerAssets.id, providerAsset.value.id))
        })
      )

      const approval = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Stale approval",
                sourceNotes: "Stale approval",
                expectedMappingStatus: "pending_review",
                expectedProviderAssetRetrievedAt: providerAsset.value.retrievedAt,
              },
            ],
          })
        ).pipe(Effect.either)
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.value.id })
        )
      )

      expect(approval._tag).toBe("Left")
      expect(Option.getOrNull(mapping)).toMatchObject({ mappingStatus: "pending_review" })
    })

    it.each([
      { activeJob: true, approvedCorrection: false },
      { activeJob: false, approvedCorrection: false },
      { activeJob: false, approvedCorrection: true },
    ])(
      "requests durable replay for an approval decision (active: $activeJob, correction: $approvedCorrection)",
      async ({ activeJob, approvedCorrection }) => {
        const correctedAssetId = "00000000-0000-0000-0000-000000000694"
        await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssets({
              providerKey: "helius-solana",
              entries: [
                {
                  providerAssetId: "automatic-approval-replay-fixture",
                  naturalKey: null,
                  currencyCode: "PRIVATE",
                  name: "Automatic approval replay fixture",
                  exponent: 5,
                  providerType: "spl-token",
                  payload: { mint: "automatic-approval-replay-fixture" },
                },
              ],
            })
          )
        )
        const providerAsset = await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.findProviderAssetByProviderAssetId({
              providerKey: "helius-solana",
              providerAssetId: "automatic-approval-replay-fixture",
            })
          )
        )
        if (Option.isNone(providerAsset)) {
          expect.fail("Expected automatic approval replay provider asset")
        }

        await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssetMappings({
              mappings: [
                {
                  providerAssetRowId: providerAsset.value.id,
                  mappingKind: "asset",
                  canonicalAssetId: approvedCorrection ? TEST_BTC_ASSET_ID : null,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: null,
                  mappingStatus: approvedCorrection ? "approved" : "pending_review",
                  reviewerNotes: null,
                  sourceNotes: "Pending exact representation",
                },
              ],
            })
          )
        )

        await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            if (approvedCorrection) {
              yield* db.insert(schema.assets).values({
                id: correctedAssetId,
                name: "Corrected replay asset",
                symbol: "CORRECTED",
                type: "fungible",
              })
            }
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_SOURCE_ID,
                externalId: "automatic-approval-replay-transaction",
                timestamp: new Date("2025-04-11T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) {
              return yield* Effect.dieMessage("Failed to seed automatic approval transaction")
            }

            yield* db.insert(schema.providerTransfers).values({
              sourceId: TEST_SOURCE_ID,
              transactionId: transaction.id,
              externalId: "automatic-approval-replay-provider-transfer",
              providerAssetId: providerAsset.value.id,
              timestamp: new Date("2025-04-11T10:00:00.000Z"),
              direction: "inbound",
              fromAddress: "0x0000000000000000000000000000000000000001",
              toAddress: "0x0000000000000000000000000000000000000002",
              observedBlockchainId: baseBlockchainId,
              observedRepresentationType: "token",
              observedContractAddress: "0x0000000000000000000000000000000000000c97",
              observedDecimals: 5,
              amount: "1.00000",
              metadata: { role: "principal" },
            })
            if (activeJob) {
              yield* db.insert(schema.processingJobs).values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "sync",
                status: "processing",
                startedAt: new Date("2025-04-11T10:05:00.000Z"),
              })
            }
          })
        )

        await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.upsertProviderAssetMappings({
              mappings: [
                {
                  providerAssetRowId: providerAsset.value.id,
                  mappingKind: "asset",
                  canonicalAssetId: approvedCorrection ? correctedAssetId : TEST_BTC_ASSET_ID,
                  assetRepresentationId: null,
                  canonicalFiatCurrency: null,
                  mappingStatus: "approved",
                  reviewerNotes: null,
                  sourceNotes: "Matched exact representation",
                  requestReplayOnApproval: true,
                  ...(approvedCorrection
                    ? {
                        expectedApprovedTarget: {
                          mappingKind: "asset" as const,
                          canonicalAssetId: TEST_BTC_ASSET_ID,
                          assetRepresentationId: null,
                          canonicalFiatCurrency: null,
                        },
                      }
                    : { expectedMappingStatus: "pending_review" as const }),
                },
              ],
            })
          )
        )

        const replayState = await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [job] = yield* db
              .select({
                followUpMode: schema.processingJobs.followUpMode,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
              .limit(1)

            return job
          })
        )

        expect(replayState).toMatchObject(
          activeJob
            ? { followUpMode: "replay", mode: "sync", status: "processing" }
            : { followUpMode: null, mode: "replay", status: "pending" }
        )
      }
    )

    it("creates approval replay jobs for the source owner locked at commit", async () => {
      const newUserId = "00000000-0000-0000-0000-000000000695"
      const newPrincipalId = "00000000-0000-0000-0000-000000000696"
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "approval-replay-owner-fixture",
                naturalKey: null,
                currencyCode: "OWNER",
                name: "Approval replay owner fixture",
                exponent: 5,
                providerType: "spl-token",
                payload: { mint: "approval-replay-owner-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "approval-replay-owner-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected approval replay owner provider asset")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending review",
              },
            ],
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.users).values({
            id: newUserId,
            email: "approval-replay-owner@taxmaxi.test",
            name: "Approval replay owner",
          })
          yield* db.insert(schema.principals).values({
            id: newPrincipalId,
            kind: "user",
            userId: newUserId,
          })
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "approval-replay-owner-transaction",
              timestamp: new Date("2025-04-11T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.dieMessage("Failed to seed approval replay owner transaction")
          }
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "approval-replay-owner-provider-transfer",
            providerAssetId: providerAsset.value.id,
            timestamp: new Date("2025-04-11T10:00:00.000Z"),
            direction: "inbound",
            fromAddress: "0x0000000000000000000000000000000000000001",
            toAddress: "0x0000000000000000000000000000000000000002",
            amount: "1.00000",
            metadata: { role: "principal" },
          })
        })
      )

      const sourceLocked = await Effect.runPromise(Deferred.make<void>())
      const moveSource = await Effect.runPromise(Deferred.make<void>())
      const ownershipChange = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(sourceLocked, undefined)
              yield* Deferred.await(moveSource)
              yield* tx
                .update(schema.sources)
                .set({ principalId: newPrincipalId })
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(sourceLocked))

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved",
                sourceNotes: "Approved",
                expectedMappingStatus: "pending_review",
                expectedProviderAssetRetrievedAt: providerAsset.value.retrievedAt,
                requestReplayOnApproval: true,
              },
            ],
          })
        )
      )
      await context.waitForQueryBlockedOnLock({ queryIncludes: "sources" })
      await Effect.runPromise(Deferred.succeed(moveSource, undefined))
      await Promise.all([approval, ownershipChange])

      const [job] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ principalId: schema.processingJobs.principalId })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
            .limit(1)
        })
      )
      expect(job).toEqual({ principalId: newPrincipalId })
    })

    it("restarts approval when a new replay source commits before the provider asset lock", async () => {
      const secondAddressId = "00000000-0000-0000-0000-000000000697"
      const secondSourceId = "00000000-0000-0000-0000-000000000698"
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "approval-replay-source-set-fixture",
                naturalKey: null,
                currencyCode: "SOURCESET",
                name: "Approval replay source set fixture",
                exponent: 5,
                providerType: "spl-token",
                payload: { mint: "approval-replay-source-set-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "approval-replay-source-set-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected approval replay source set provider asset")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending review",
              },
            ],
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "approval-replay-source-set-first-transaction",
              timestamp: new Date("2025-04-11T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.dieMessage(
              "Failed to seed first approval replay source set transaction"
            )
          }
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "approval-replay-source-set-first-transfer",
            providerAssetId: providerAsset.value.id,
            timestamp: new Date("2025-04-11T10:00:00.000Z"),
            direction: "inbound",
            fromAddress: "ApprovalReplaySender111111111111111111111111111",
            toAddress: "ApprovalReplayReceiver1111111111111111111111111",
            amount: "1.00000",
            metadata: { role: "principal" },
          })
        })
      )

      const providerAssetLocked = await Effect.runPromise(Deferred.make<void>())
      const addSecondSource = await Effect.runPromise(Deferred.make<void>())
      const concurrentSource = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.providerAssets.id })
                .from(schema.providerAssets)
                .where(eq(schema.providerAssets.id, providerAsset.value.id))
                .for("update")
              yield* Deferred.succeed(providerAssetLocked, undefined)
              yield* Deferred.await(addSecondSource)
              yield* tx.insert(schema.addresses).values({
                id: secondAddressId,
                address: "ApprovalReplaySourceSet1111111111111111111111111",
                type: "solana",
                name: "Approval replay second source",
                principalId: TEST_PRINCIPAL_ID,
              })
              yield* tx.insert(schema.sources).values({
                id: secondSourceId,
                principalId: TEST_PRINCIPAL_ID,
                name: "Approval replay second source",
                providerKey: "helius-solana",
                sourceableType: "onchain",
                addressId: secondAddressId,
                cexAccountId: null,
              })
              const [transaction] = yield* tx
                .insert(schema.transactions)
                .values({
                  sourceId: secondSourceId,
                  externalId: "approval-replay-source-set-second-transaction",
                  timestamp: new Date("2025-04-11T10:05:00.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                })
                .returning({ id: schema.transactions.id })
              if (transaction === undefined) {
                return yield* Effect.dieMessage(
                  "Failed to seed second approval replay source set transaction"
                )
              }
              yield* tx.insert(schema.providerTransfers).values({
                sourceId: secondSourceId,
                transactionId: transaction.id,
                externalId: "approval-replay-source-set-second-transfer",
                providerAssetId: providerAsset.value.id,
                timestamp: new Date("2025-04-11T10:05:00.000Z"),
                direction: "inbound",
                fromAddress: "ApprovalReplaySender111111111111111111111111111",
                toAddress: "ApprovalReplaySecond11111111111111111111111111",
                amount: "1.00000",
                metadata: { role: "principal" },
              })
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(providerAssetLocked))

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved",
                sourceNotes: "Approved",
                expectedMappingStatus: "pending_review",
                expectedProviderAssetRetrievedAt: providerAsset.value.retrievedAt,
                requestReplayOnApproval: true,
              },
            ],
          })
        )
      )
      await context.waitForQueryBlockedOnLock({ queryIncludes: "provider_assets" })
      await Effect.runPromise(Deferred.succeed(addSecondSource, undefined))
      await Promise.all([approval, concurrentSource])

      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              principalId: schema.processingJobs.principalId,
              sourceId: schema.processingJobs.sourceId,
            })
            .from(schema.processingJobs)
            .orderBy(asc(schema.processingJobs.sourceId))
        })
      )
      expect(jobs).toEqual([
        { principalId: TEST_PRINCIPAL_ID, sourceId: TEST_SOURCE_ID },
        { principalId: TEST_PRINCIPAL_ID, sourceId: secondSourceId },
      ])
    })

    it("does not request replay when an approved target is unchanged", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "unchanged-approval-replay-fixture",
                naturalKey: null,
                currencyCode: "UNCHANGED",
                name: "Unchanged approval replay fixture",
                exponent: 5,
                providerType: "spl-token",
                payload: { mint: "unchanged-approval-replay-fixture" },
              },
            ],
          })
        )
      )
      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "unchanged-approval-replay-fixture",
          })
        )
      )
      if (Option.isNone(providerAsset)) {
        expect.fail("Expected unchanged approval provider asset")
      }
      const approvedTarget = {
        mappingKind: "asset" as const,
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                ...approvedTarget,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Initial approval",
              },
            ],
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "unchanged-approval-replay-transaction",
              timestamp: new Date("2025-04-11T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.dieMessage("Failed to seed unchanged approval transaction")
          }
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "unchanged-approval-replay-provider-transfer",
            providerAssetId: providerAsset.value.id,
            timestamp: new Date("2025-04-11T10:00:00.000Z"),
            direction: "inbound",
            fromAddress: "0x0000000000000000000000000000000000000001",
            toAddress: "0x0000000000000000000000000000000000000002",
            amount: "1.00000",
            metadata: { role: "principal" },
          })
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                ...approvedTarget,
                mappingStatus: "approved",
                reviewerNotes: "Reviewed again",
                sourceNotes: "Reviewed again",
                expectedApprovedTarget: approvedTarget,
                requestReplayOnApproval: true,
              },
            ],
          })
        )
      )

      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.processingJobs.id })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )
      expect(jobs).toEqual([])
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
              assetRepresentationId: null,
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
                assetRepresentationId: null,
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
  })
})
