import { eq, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { AssetCatalogRepositoryLive } from "../../src/layers/AssetCatalogRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../src/layers/SyncEngineTransactionLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { AssetCatalogRepository } from "../../src/services/AssetCatalogRepository.ts"
import {
  ProviderAssetRepository,
  SourceNormalizationRepository,
  SyncEngineStorageError,
  SyncEngineTransaction,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_asset_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

const runAssetCatalog = <A, E>(effect: Effect.Effect<A, E, AssetCatalogRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetCatalogRepositoryLive }))

const AtomicNormalizationLayer = Layer.mergeAll(
  ProviderAssetRepositoryLive,
  SourceNormalizationRepositoryLive,
  SyncEngineTransactionLive
)

const runAtomicNormalization = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ProviderAssetRepository | SourceNormalizationRepository | SyncEngineTransaction
  >
) => Effect.runPromise(context.runWithLayer({ effect, layer: AtomicNormalizationLayer }))

const loadBitcoinObservation = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [representation] = yield* db
        .select({
          observedBlockchainId: schema.assetRepresentations.blockchainId,
          representationType: schema.assetRepresentations.type,
          contractAddress: schema.assetRepresentations.contractAddress,
          mintAddress: schema.assetRepresentations.mintAddress,
          decimals: schema.assetRepresentations.decimals,
        })
        .from(schema.assetRepresentations)
        .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
        .limit(1)
      if (representation === undefined) {
        return yield* Effect.die("Missing Bitcoin representation fixture")
      }
      return representation
    })
  )

const seedPendingApprovalAsset = async (
  suffix: string,
  { withProviderTransfer = true }: { readonly withProviderTransfer?: boolean } = {}
) => {
  const providerAsset = await runRepository(
    Effect.gen(function* () {
      const repository = yield* ProviderAssetRepository
      yield* repository.upsertProviderAssets({
        providerKey: "coinbase",
        entries: [
          {
            providerAssetId: `btc-approval-${suffix}`,
            naturalKey: null,
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            payload: { source: "test" },
          },
        ],
      })
      const result = yield* repository.findProviderAssetByProviderAssetId({
        providerKey: "coinbase",
        providerAssetId: `btc-approval-${suffix}`,
      })
      if (Option.isNone(result)) {
        return yield* Effect.die("Expected approval provider asset")
      }
      yield* repository.upsertProviderAssetMappings({
        mappings: [
          {
            providerAssetRowId: result.value.id,
            mappingKind: "asset",
            canonicalAssetId: null,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "pending_review",
            reviewerNotes: null,
            sourceNotes: "Pending transfer evidence",
          },
        ],
      })
      return result.value
    })
  )

  if (withProviderTransfer) {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const timestamp = new Date("2025-04-20T13:00:00.000Z")
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: `approval-${suffix}-transaction`,
            timestamp,
            providerTransactionType: "send",
            providerStatus: "completed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) {
          return yield* Effect.die("Expected approval replay transaction")
        }
        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transaction.id,
          externalId: `approval-${suffix}-transfer`,
          providerAssetId: providerAsset.id,
          timestamp,
          direction: "outbound",
          processingMode: "accounting_and_evidence",
          fromAccountRef: "coinbase-account-1",
          toAddress: "bc1qapprovalreplay000000000000000000000000",
          amount: "0.25",
          metadata: { role: "principal" },
        })
      })
    )
  }

  const review = await runRepository(
    Effect.flatMap(ProviderAssetRepository, (repository) =>
      repository.findProviderAssetReviewById({ providerAssetRowId: providerAsset.id })
    )
  )

  return { ...providerAsset, evidenceRevision: Option.getOrThrow(review).evidenceRevision }
}

const seedFailedApprovalReplay = async (suffix: string) => {
  const providerAsset = await seedPendingApprovalAsset(suffix, { withProviderTransfer: false })
  await runRepository(
    Effect.flatMap(ProviderAssetRepository, (repository) =>
      repository.recordProviderAssetSourceUses({
        sourceId: TEST_SOURCE_ID,
        providerAssetRowIds: [providerAsset.id],
        observations: [],
      })
    )
  )
  const approval = await runRepository(
    Effect.flatMap(ProviderAssetRepository, (repository) =>
      repository.approveProviderAssetMappingAndRequestReplay({
        mapping: {
          providerAssetRowId: providerAsset.id,
          mappingKind: "asset",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: null,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: "Approved for retry reservation",
          sourceNotes: "Retry reservation fixture",
        },
        expectedObservedRepresentations: [],
        expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
      })
    )
  )
  const jobId = approval.replays[0]?.jobId
  if (jobId === undefined) {
    throw new Error("Expected approval replay job")
  }

  await runPg(
    Effect.flatMap(drizzle, (db) =>
      db
        .update(schema.processingJobs)
        .set({ status: "failed" })
        .where(eq(schema.processingJobs.id, jobId))
    )
  )

  return { jobId, providerAsset }
}

describe("ProviderAssetRepositoryLive", () => {
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

    it("loads a full canonical asset and its representations by CoinGecko id", async () => {
      const asset = await runAssetCatalog(
        Effect.flatMap(AssetCatalogRepository, (repository) =>
          repository.findAssetByCoinGeckoId({ coingeckoCoinId: "bitcoin" })
        )
      )

      expect(Option.getOrThrow(asset)).toMatchObject({
        id: TEST_BTC_ASSET_ID,
        coingeckoCoinId: "bitcoin",
        representations: [expect.objectContaining({ id: TEST_BTC_REPRESENTATION_ID })],
      })
    })

    it("includes spam representations only for internal ownership searches", async () => {
      await runPg(
        Effect.flatMap(drizzle, (db) =>
          db
            .update(schema.assetRepresentations)
            .set({ isSpam: true })
            .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
        )
      )

      const [publicAssets, ownershipAssets] = await Promise.all([
        runAssetCatalog(
          Effect.flatMap(AssetCatalogRepository, (repository) =>
            repository.listAssets({ cursor: null, query: "bitcoin", limit: 100 })
          )
        ),
        runAssetCatalog(
          Effect.flatMap(AssetCatalogRepository, (repository) =>
            repository.listAssets({
              cursor: null,
              query: "bitcoin",
              limit: 100,
              includeSpamRepresentations: true,
            })
          )
        ),
      ])

      expect(publicAssets).toEqual([
        expect.objectContaining({ id: TEST_BTC_ASSET_ID, representations: [] }),
      ])
      expect(ownershipAssets).toEqual([
        expect.objectContaining({
          id: TEST_BTC_ASSET_ID,
          representations: [
            expect.objectContaining({ id: TEST_BTC_REPRESENTATION_ID, isSpam: true }),
          ],
        }),
      ])
    })

    it("does not overwrite an approved mapping while seeding a stale missing-mapping result", async () => {
      const providerAsset = await seedPendingApprovalAsset("stale-missing-mapping", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Admin approved",
                sourceNotes: "Keep this decision",
              },
            ],
          })
        )
      )

      const inserted = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.seedProviderAssetMappingsIfMissing({
            mappings: [
              {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Stale resolver result",
              },
            ],
          })
        )
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.id })
        )
      )

      expect(inserted).toBe(0)
      expect(Option.getOrThrow(mapping)).toMatchObject({
        mappingStatus: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
      })
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

    it("approves once and attaches replay to an active job under concurrent retries", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-approval-replay",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "test" },
              },
            ],
          })
          const result = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-approval-replay",
          })
          if (Option.isNone(result)) {
            return yield* Effect.die("Expected approval provider asset")
          }

          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: result.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending transfer evidence",
              },
            ],
          })

          return result.value
        })
      )

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const timestamp = new Date("2025-04-20T12:00:00.000Z")
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "approval-replay-transaction",
              timestamp,
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.die("Expected approval replay transaction")
          }

          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "approval-replay-transfer",
            providerAssetId: providerAsset.id,
            timestamp,
            direction: "outbound",
            processingMode: "accounting_and_evidence",
            fromAccountRef: "coinbase-account-1",
            toAddress: "bc1qapprovalreplay000000000000000000000000",
            amount: "0.25",
            metadata: { role: "principal" },
          })
          yield* db.insert(schema.processingJobs).values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "pending",
            attemptCount: 0,
            maxAttempts: 3,
            progressDetails: { mode: "sync" },
          })
        })
      )

      const approve = () =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved",
                sourceNotes: "Approved from transfer evidence",
              },
              reviewedBy: TEST_USER_ID,
              reviewedAt: new Date("2026-08-17T09:00:00.000Z"),
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )

      const results = await Promise.all([approve(), approve()])
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({
              status: schema.providerAssetMappings.mappingStatus,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              reviewedBy: schema.providerAssetMappings.reviewedBy,
              reviewedAt: schema.providerAssetMappings.reviewedAt,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const jobs = yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const replays = yield* db
            .select({ sourceId: schema.providerAssetReviewReplays.sourceId })
            .from(schema.providerAssetReviewReplays)
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))

          return { jobs, mapping, replays }
        })
      )

      expect(
        results
          .map(({ mappingChanged }) => mappingChanged)
          .sort((left, right) => Number(left) - Number(right))
      ).toEqual([false, true])
      expect(state.mapping).toEqual({
        status: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        reviewedBy: TEST_USER_ID,
        reviewedAt: new Date("2026-08-17T09:00:00.000Z"),
      })
      expect(state.jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
      expect(state.replays).toEqual([{ sourceId: TEST_SOURCE_ID }])
    })

    it("creates a replay job when approval has no active owner", async () => {
      const providerAsset = await seedPendingApprovalAsset("no-active-owner")

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(result.mappingChanged).toBe(true)
      expect(jobs).toEqual([{ mode: "replay", status: "pending", followUpMode: null }])
    })

    it("replays provider sources even when the asset has no provider-transfer row", async () => {
      const providerAsset = await seedPendingApprovalAsset("non-transfer-use", {
        withProviderTransfer: false,
      })
      const secondSourceId = "00000000-0000-4000-8000-000000000282"
      const otherProviderSourceId = "00000000-0000-4000-8000-000000000285"
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* seedSyncEngineRepositoryFixture({
            userId: "00000000-0000-4000-8000-000000000283",
            principalId: "00000000-0000-4000-8000-000000000284",
            sourceId: secondSourceId,
          })
          yield* seedSyncEngineRepositoryFixture({
            userId: "00000000-0000-4000-8000-000000000286",
            principalId: "00000000-0000-4000-8000-000000000287",
            sourceId: otherProviderSourceId,
          })
          yield* db
            .update(schema.sources)
            .set({ providerKey: "helius-solana" })
            .where(eq(schema.sources.id, otherProviderSourceId))
          yield* db.insert(schema.processingJobs).values({
            sourceId: secondSourceId,
            principalId: "00000000-0000-4000-8000-000000000284",
            mode: "sync",
            status: "pending",
            attemptCount: 0,
            maxAttempts: 3,
            progressDetails: { mode: "sync" },
          })
        })
      )
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          Effect.all([
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [],
            }),
            repository.recordProviderAssetSourceUses({
              sourceId: secondSourceId,
              providerAssetRowIds: [providerAsset.id],
              observations: [],
            }),
          ])
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved for a non-transfer transaction",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              followUpMode: schema.processingJobs.followUpMode,
              mode: schema.processingJobs.mode,
              sourceId: schema.processingJobs.sourceId,
              status: schema.processingJobs.status,
            })
            .from(schema.processingJobs)
            .orderBy(schema.processingJobs.sourceId)
        })
      )

      expect(jobs).toEqual([
        {
          followUpMode: null,
          mode: "replay",
          sourceId: TEST_SOURCE_ID,
          status: "pending",
        },
        {
          followUpMode: "replay",
          mode: "sync",
          sourceId: secondSourceId,
          status: "pending",
        },
      ])
    })

    it("backfills an unresolved asset from an appended provider-asset review segment", async () => {
      const providerAsset = await seedPendingApprovalAsset("legacy-appended-review", {
        withProviderTransfer: false,
      })
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "legacy-appended-provider-asset-review",
              timestamp: new Date("2025-04-20T13:00:00.000Z"),
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.die("Expected legacy review transaction")
          }
          yield* db.insert(schema.transactionReviews).values({
            transactionId: transaction.id,
            principalId: TEST_PRINCIPAL_ID,
            reviewStatus: "needs_review",
            categorizationReason:
              "Coinbase send requires review. provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for BTC.",
            matchedLayer: "provider_asset_mapping",
            needsReview: true,
          })
          yield* db.execute(sql`
            insert into provider_asset_source_uses (provider_asset_row_id, source_id)
            select distinct provider_assets.id, transactions.source_id
            from provider_assets
            inner join provider_asset_mappings
              on provider_asset_mappings.provider_asset_row_id = provider_assets.id
            inner join sources on sources.provider_key = 'coinbase'
            inner join transactions on transactions.source_id = sources.id
            inner join transaction_reviews
              on transaction_reviews.transaction_id = transactions.id
            where provider_assets.provider = 'coinbase'
              and provider_asset_mappings.mapping_status = 'pending_review'
              and transaction_reviews.categorization_reason like '%provider_asset_mapping:%'
              and upper(provider_assets.currency_code) = any(
                string_to_array(
                  upper(trim(trailing '.' from split_part(
                    split_part(transaction_reviews.categorization_reason, 'provider_asset_mapping:', 2),
                    ' for ',
                    2
                  ))),
                  ', '
                )
              )
            on conflict do nothing
          `)
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved legacy reviewed asset",
              sourceNotes: "Approved legacy reviewed asset",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(jobs).toEqual([{ mode: "replay", status: "pending" }])
    })

    it("requests replay when a source use is recorded after approval", async () => {
      const providerAsset = await seedPendingApprovalAsset("approval-before-source-use", {
        withProviderTransfer: false,
      })

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved before source use was recorded",
              sourceNotes: "Approved before source use was recorded",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const recordedAgain = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({
              id: schema.processingJobs.id,
              followUpMode: schema.processingJobs.followUpMode,
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const replays = yield* db
            .select({
              dispatchState: schema.providerAssetReviewReplays.dispatchState,
              jobId: schema.providerAssetReviewReplays.jobId,
              sourceId: schema.providerAssetReviewReplays.sourceId,
            })
            .from(schema.providerAssetReviewReplays)
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))

          return { jobs, replays }
        })
      )

      expect(recorded).toBe(1)
      expect(recordedAgain).toBe(0)
      expect(state.jobs).toEqual([
        expect.objectContaining({ followUpMode: null, mode: "replay", status: "pending" }),
      ])
      expect(state.replays).toEqual([
        {
          dispatchState: "queued",
          jobId: state.jobs[0]?.id,
          sourceId: TEST_SOURCE_ID,
        },
      ])
    })

    it("treats replay-link replacement with the current job as idempotent", async () => {
      const providerAsset = await seedPendingApprovalAsset("idempotent-replay-link", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const approval = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved for replay replacement",
              sourceNotes: "Replay replacement fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const previousJobId = approval.replays[0]?.jobId
      if (previousJobId === undefined) {
        expect.fail("Expected approval replay job")
      }
      const nextJobId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ status: "completed" })
            .where(eq(schema.processingJobs.id, previousJobId))
          const [nextJob] = yield* db
            .insert(schema.processingJobs)
            .values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "pending",
              attemptCount: 0,
              maxAttempts: 3,
              queueName: "source-sync",
              queueJobId: "replacement-replay-job",
            })
            .returning({ id: schema.processingJobs.id })
          if (nextJob === undefined) {
            return yield* Effect.die("Expected replacement replay job")
          }
          return nextJob.id
        })
      )

      const replacements = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          Effect.all(
            [
              repository.replaceProviderAssetReviewReplay({
                providerAssetRowId: providerAsset.id,
                sourceId: TEST_SOURCE_ID,
                previousJobId,
                nextJobId,
              }),
              repository.replaceProviderAssetReviewReplay({
                providerAssetRowId: providerAsset.id,
                sourceId: TEST_SOURCE_ID,
                previousJobId,
                nextJobId,
              }),
            ],
            { concurrency: 1 }
          )
        )
      )
      const replay = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetReviewReplay({
            providerAssetRowId: providerAsset.id,
            sourceId: TEST_SOURCE_ID,
            jobId: nextJobId,
          })
        )
      )

      expect(replacements).toEqual([true, true])
      expect(Option.getOrThrow(replay)).toMatchObject({
        jobId: nextJobId,
        dispatchState: "queued",
        errorMessage: null,
      })
    })

    it("creates one replacement job for concurrent failed replay retry reservations", async () => {
      const { jobId, providerAsset } = await seedFailedApprovalReplay("reserved-replay-retry")

      const reservations = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          Effect.all(
            [
              repository.reserveProviderAssetReviewReplayRetry({
                providerAssetRowId: providerAsset.id,
                sourceId: TEST_SOURCE_ID,
                jobId,
              }),
              repository.reserveProviderAssetReviewReplayRetry({
                providerAssetRowId: providerAsset.id,
                sourceId: TEST_SOURCE_ID,
                jobId,
              }),
            ],
            { concurrency: "unbounded" }
          )
        )
      )

      const reservedJobIds = reservations.flatMap(
        Option.match({ onNone: () => [], onSome: (reservation) => [reservation.jobId] })
      )
      expect(reservedJobIds).toHaveLength(1)
      expect(reservedJobIds[0]).not.toBe(jobId)

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const jobs = yield* db
            .select({
              id: schema.processingJobs.id,
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              progressDetails: schema.processingJobs.progressDetails,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          const [replay] = yield* db
            .select({ jobId: schema.providerAssetReviewReplays.jobId })
            .from(schema.providerAssetReviewReplays)
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))
          return { jobs, replay }
        })
      )

      expect(state.jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: jobId, mode: "replay", status: "failed" }),
          expect.objectContaining({
            id: reservedJobIds[0],
            mode: "replay",
            status: "pending",
            progressDetails: { mode: "replay", reason: "asset_mapping_retried" },
          }),
        ])
      )
      expect(state.jobs).toHaveLength(2)
      expect(state.replay?.jobId).toBe(reservedJobIds[0])
    })

    it("attaches a failed replay retry behind an active sync job", async () => {
      const { jobId, providerAsset } = await seedFailedApprovalReplay("retry-behind-active-sync")
      const activeSyncJobId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [activeSync] = yield* db
            .insert(schema.processingJobs)
            .values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "sync",
              status: "processing",
              attemptCount: 1,
              maxAttempts: 3,
            })
            .returning({ id: schema.processingJobs.id })
          if (activeSync === undefined) {
            return yield* Effect.die("Expected active sync job")
          }
          return activeSync.id
        })
      )

      const reservation = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.reserveProviderAssetReviewReplayRetry({
            providerAssetRowId: providerAsset.id,
            sourceId: TEST_SOURCE_ID,
            jobId,
          })
        )
      )
      const reservedReplay = Option.getOrThrow(reservation)
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [activeSync] = yield* db
            .select({ followUpMode: schema.processingJobs.followUpMode })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.id, activeSyncJobId))
          const [replay] = yield* db
            .select({ jobId: schema.providerAssetReviewReplays.jobId })
            .from(schema.providerAssetReviewReplays)
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))
          return { activeSync, replay }
        })
      )

      expect(reservedReplay).toMatchObject({
        jobId: activeSyncJobId,
        dispatchState: "failed_to_queue",
      })
      expect(state.activeSync?.followUpMode).toBe("replay")
      expect(state.replay?.jobId).toBe(activeSyncJobId)
    })

    it("derives replay dispatch state from durable queue and job progress", async () => {
      const providerAsset = await seedPendingApprovalAsset("replay-dispatch-read-model", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const approval = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved for dispatch read model",
              sourceNotes: "Dispatch read model fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobId = approval.replays[0]?.jobId
      if (jobId === undefined) {
        expect.fail("Expected approval replay job")
      }

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssetReviewReplays)
            .set({ dispatchState: "queued", errorMessage: null })
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))
        })
      )

      const loadReplay = () =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.findProviderAssetReviewReplay({
              providerAssetRowId: providerAsset.id,
              sourceId: TEST_SOURCE_ID,
              jobId,
            })
          )
        ).then(Option.getOrThrow)

      expect(await loadReplay()).toMatchObject({
        dispatchState: "failed_to_queue",
        errorMessage: "Failed to queue replay.",
      })

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ queueName: "source-sync", queueJobId: "bullmq-replay-job" })
            .where(eq(schema.processingJobs.id, jobId))
        })
      )

      expect(await loadReplay()).toMatchObject({ dispatchState: "queued", errorMessage: null })

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ status: "processing", queueName: null, queueJobId: null })
            .where(eq(schema.processingJobs.id, jobId))
        })
      )

      expect(await loadReplay()).toMatchObject({ dispatchState: "queued", errorMessage: null })
    })

    it("accepts a dispatch result after the replay link advances to its follow-up", async () => {
      const providerAsset = await seedPendingApprovalAsset("advanced-replay-dispatch", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const approval = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved for advanced dispatch",
              sourceNotes: "Advanced dispatch fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const completedJobId = approval.replays[0]?.jobId
      if (completedJobId === undefined) {
        expect.fail("Expected approval replay job")
      }
      const followUpJobId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.processingJobs)
            .set({ status: "completed" })
            .where(eq(schema.processingJobs.id, completedJobId))
          const [followUpJob] = yield* db
            .insert(schema.processingJobs)
            .values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "pending",
            })
            .returning({ id: schema.processingJobs.id })
          if (followUpJob === undefined) {
            return yield* Effect.die("Expected follow-up replay job")
          }
          yield* db
            .update(schema.processingJobs)
            .set({ followUpJobId: followUpJob.id })
            .where(eq(schema.processingJobs.id, completedJobId))
          yield* db
            .update(schema.providerAssetReviewReplays)
            .set({
              jobId: followUpJob.id,
              dispatchState: "failed_to_queue",
              errorMessage: "Failed to queue replay.",
            })
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))
          return followUpJob.id
        })
      )

      const marked = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.markProviderAssetReviewReplayDispatch({
            providerAssetRowId: providerAsset.id,
            sourceId: TEST_SOURCE_ID,
            jobId: completedJobId,
            dispatchState: "queued",
            errorMessage: null,
          })
        )
      )
      const persistedReplay = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [replay] = yield* db
            .select({
              jobId: schema.providerAssetReviewReplays.jobId,
              dispatchState: schema.providerAssetReviewReplays.dispatchState,
              errorMessage: schema.providerAssetReviewReplays.errorMessage,
            })
            .from(schema.providerAssetReviewReplays)
            .where(eq(schema.providerAssetReviewReplays.providerAssetRowId, providerAsset.id))
          return replay
        })
      )

      expect(marked).toBe(followUpJobId)
      expect(persistedReplay).toEqual({
        jobId: followUpJobId,
        dispatchState: "failed_to_queue",
        errorMessage: "Failed to queue replay.",
      })
    })

    it("blocks exact evidence when another observation is incomplete", async () => {
      const providerAsset = await seedPendingApprovalAsset("complete-plus-incomplete-evidence", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const transactions = yield* db
            .insert(schema.transactions)
            .values([
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "complete-evidence-transaction",
                timestamp: new Date("2025-04-20T14:00:00.000Z"),
                providerTransactionType: "send",
                providerStatus: "completed",
                principalId: TEST_PRINCIPAL_ID,
              },
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "incomplete-evidence-transaction",
                timestamp: new Date("2025-04-20T14:01:00.000Z"),
                providerTransactionType: "send",
                providerStatus: "completed",
                principalId: TEST_PRINCIPAL_ID,
              },
            ])
            .returning({ id: schema.transactions.id, externalId: schema.transactions.externalId })
          const transactionByExternalId = new Map(
            transactions.map((transaction) => [transaction.externalId, transaction.id])
          )
          const completeTransactionId = transactionByExternalId.get("complete-evidence-transaction")
          const incompleteTransactionId = transactionByExternalId.get(
            "incomplete-evidence-transaction"
          )
          if (completeTransactionId === undefined || incompleteTransactionId === undefined) {
            return yield* Effect.die("Expected evidence transactions")
          }

          yield* db.insert(schema.providerTransfers).values([
            {
              sourceId: TEST_SOURCE_ID,
              transactionId: completeTransactionId,
              externalId: "complete-evidence-transfer",
              providerAssetId: providerAsset.id,
              timestamp: new Date("2025-04-20T14:00:00.000Z"),
              direction: "outbound",
              processingMode: "evidence_only",
              fromAccountRef: "coinbase-account-1",
              toAddress: "bc1qcompleteevidence000000000000000000000",
              observedBlockchainId: observation.observedBlockchainId,
              observedRepresentationType: observation.representationType,
              observedContractAddress: observation.contractAddress,
              observedMintAddress: observation.mintAddress,
              observedDecimals: observation.decimals,
              amount: "0.25",
              metadata: { role: "principal" },
            },
            {
              sourceId: TEST_SOURCE_ID,
              transactionId: incompleteTransactionId,
              externalId: "incomplete-evidence-transfer",
              providerAssetId: providerAsset.id,
              timestamp: new Date("2025-04-20T14:01:00.000Z"),
              direction: "outbound",
              processingMode: "evidence_only",
              fromAccountRef: "coinbase-account-1",
              toAddress: "0x0000000000000000000000000000000000000001",
              observedBlockchainId: observation.observedBlockchainId,
              observedRepresentationType: null,
              observedContractAddress: "0x0000000000000000000000000000000000000001",
              observedMintAddress: null,
              observedDecimals: null,
              amount: "0.25",
              metadata: { role: "principal" },
            },
          ])
        })
      )

      const review = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetReviewById({ providerAssetRowId: providerAsset.id })
        )
      )
      expect(Option.getOrThrow(review).evidenceState).toBe("insufficient")
    })

    it("revises evidence for new sources and observations before rejection", async () => {
      const providerAsset = await seedPendingApprovalAsset("rejection-evidence-revision", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      const initialReview = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetReviewById({ providerAssetRowId: providerAsset.id })
        )
      ).then(Option.getOrThrow)

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const sourceReview = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetReviewById({ providerAssetRowId: providerAsset.id })
        )
      ).then(Option.getOrThrow)

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "rejection-revision-transaction",
              timestamp: new Date("2025-04-20T14:02:00.000Z"),
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.die("Expected rejection revision transaction")
          }
          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "rejection-revision-transfer",
            providerAssetId: providerAsset.id,
            timestamp: new Date("2025-04-20T14:02:00.000Z"),
            direction: "outbound",
            processingMode: "evidence_only",
            fromAccountRef: "coinbase-account-1",
            toAddress: "bc1qrejectionrevision00000000000000000000",
            observedBlockchainId: observation.observedBlockchainId,
            observedRepresentationType: observation.representationType,
            observedContractAddress: observation.contractAddress,
            observedMintAddress: observation.mintAddress,
            observedDecimals: observation.decimals,
            amount: "0.25",
            metadata: { role: "principal" },
          })
        })
      )
      const evidenceReview = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetReviewById({ providerAssetRowId: providerAsset.id })
        )
      ).then(Option.getOrThrow)

      expect(sourceReview.evidenceRevision).not.toBe(initialReview.evidenceRevision)
      expect(evidenceReview.evidenceRevision).not.toBe(sourceReview.evidenceRevision)
      const staleRejection = await runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.rejectProviderAssetMapping({
              providerAssetRowId: providerAsset.id,
              reviewerNotes: "Evidence is not enough",
              reviewedBy: TEST_USER_ID,
              reviewedAt: new Date("2026-08-17T10:00:00.000Z"),
              expectedEvidenceRevision: sourceReview.evidenceRevision,
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
              ...(sourceReview.mapping === null
                ? {}
                : { expectedMappingUpdatedAt: sourceReview.mapping.updatedAt }),
            })
          )
        )
      )
      const currentMapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.id })
        )
      )

      expect(staleRejection._tag).toBe("Failure")
      expect(Option.getOrThrow(currentMapping).mappingStatus).toBe("pending_review")

      const rejected = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.rejectProviderAssetMapping({
            providerAssetRowId: providerAsset.id,
            reviewerNotes: "Evidence is not enough",
            reviewedBy: TEST_USER_ID,
            reviewedAt: new Date("2026-08-17T10:01:00.000Z"),
            expectedEvidenceRevision: evidenceReview.evidenceRevision,
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            ...(evidenceReview.mapping === null
              ? {}
              : { expectedMappingUpdatedAt: evidenceReview.mapping.updatedAt }),
          })
        )
      )

      expect(rejected).toBe(true)
    })

    it("accepts exact representation evidence observed after approval", async () => {
      const providerAsset = await seedPendingApprovalAsset("exact-approved-use", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Exact evidence regression fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [{ providerAssetRowId: providerAsset.id, ...observation }],
          })
        )
      )

      expect(recorded).toBe(1)
    })

    it("accepts weaker evidence that does not contradict an approved representation", async () => {
      const providerAsset = await seedPendingApprovalAsset("partial-approved-use", {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Partial evidence regression fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [
              {
                providerAssetRowId: providerAsset.id,
                observedBlockchainId: observation.observedBlockchainId,
                representationType: null,
                contractAddress: null,
                mintAddress: null,
                decimals: null,
              },
            ],
          })
        )
      )

      expect(recorded).toBe(1)
    })

    it.each([
      ["blockchain", { observedBlockchainId: "00000000-0000-4000-8000-000000000999" }],
      ["representation type", { representationType: "nft" as const }],
      ["contract address", { contractAddress: "0x0000000000000000000000000000000000000001" }],
      ["mint address", { mintAddress: "conflicting-mint" }],
      ["decimals", { decimals: 9 }],
    ])("rejects approved evidence with a mismatched %s", async (_field, override) => {
      const providerAsset = await seedPendingApprovalAsset(`mismatched-${_field}`, {
        withProviderTransfer: false,
      })
      const observation = await loadBitcoinObservation()
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Mismatched evidence regression fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const result = await runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [{ providerAssetRowId: providerAsset.id, ...observation, ...override }],
            })
          )
        )
      )

      expect(result._tag).toBe("Failure")
    })

    it("rejects newly persisted evidence that conflicts with an approved mapping", async () => {
      const providerAsset = await seedPendingApprovalAsset("conflicting-approved-use", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved Bitcoin representation",
              sourceNotes: "Approved before conflicting source evidence persisted",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )

      const result = await runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.recordProviderAssetSourceUses({
              sourceId: TEST_SOURCE_ID,
              providerAssetRowIds: [providerAsset.id],
              observations: [
                {
                  providerAssetRowId: providerAsset.id,
                  observedBlockchainId: "00000000-0000-4000-8000-000000000999",
                  representationType: "token",
                  contractAddress: "0x0000000000000000000000000000000000000001",
                  mintAddress: null,
                  decimals: 18,
                },
              ],
            })
          )
        )
      )
      const sourceUses = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
        })
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          operation: "providerAssetRepository.recordProviderAssetSourceUses",
          cause: {
            operation:
              "providerAssetRepository.recordProviderAssetSourceUses.validateApprovedMapping",
          },
        })
      }
      expect(sourceUses).toEqual([])
    })

    it("rolls back normalized artifacts when approval wins before conflicting evidence persists", async () => {
      const providerAsset = await seedPendingApprovalAsset("approval-wins-persistence-race", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approval won before persistence",
              sourceNotes: "Concurrency regression fixture",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const conflictingBlockchainId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const blockchains = yield* db
            .select({ id: schema.blockchains.id, name: schema.blockchains.name })
            .from(schema.blockchains)
          const conflicting = blockchains.find(({ name }) => name.toLowerCase() !== "bitcoin")
          if (conflicting === undefined) {
            return yield* Effect.die("Missing conflicting blockchain fixture")
          }
          return conflicting.id
        })
      )

      const result = await runAtomicNormalization(
        Effect.result(
          Effect.gen(function* () {
            const providerAssetRepository = yield* ProviderAssetRepository
            const sourceNormalizationRepository = yield* SourceNormalizationRepository
            const syncEngineTransaction = yield* SyncEngineTransaction

            yield* syncEngineTransaction.run(
              sourceNormalizationRepository.persistNormalizedArtifacts({
                beforePersist: providerAssetRepository
                  .recordProviderAssetSourceUses({
                    sourceId: TEST_SOURCE_ID,
                    providerAssetRowIds: [providerAsset.id],
                    observations: [
                      {
                        providerAssetRowId: providerAsset.id,
                        observedBlockchainId: conflictingBlockchainId,
                        representationType: "token",
                        contractAddress: "0x0000000000000000000000000000000000000003",
                        mintAddress: null,
                        decimals: 18,
                      },
                    ],
                  })
                  .pipe(Effect.asVoid),
                transaction: {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "approval-wins-persistence-race",
                  externalGroupId: null,
                  timestamp: new Date("2025-04-21T10:00:00.000Z"),
                  transactionType: "internal_transfer",
                  providerTransactionType: "send",
                  providerStatus: "completed",
                  providerResourcePath: null,
                  providerDescription: "Conflicting approval race fixture",
                  providerCreatedAt: null,
                  providerUpdatedAt: null,
                  metadata: null,
                  principalId: TEST_PRINCIPAL_ID,
                },
                venueContext: {
                  venueType: "cex",
                  cexAccountId: null,
                  externalAccountId: null,
                  externalOrderId: null,
                  externalFillId: null,
                  side: null,
                  instrument: null,
                  fillPrice: null,
                  commissionAmount: null,
                  commissionCurrency: null,
                  metadata: null,
                },
                providerTransfers: [
                  {
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: null,
                    externalId: "approval-wins-persistence-race:transfer",
                    externalGroupId: null,
                    providerAssetId: providerAsset.id,
                    timestamp: new Date("2025-04-21T10:00:00.000Z"),
                    direction: "outbound",
                    processingMode: "evidence_only",
                    fromAccountRef: null,
                    toAccountRef: null,
                    fromAddress: "0x0000000000000000000000000000000000000001",
                    toAddress: "0x0000000000000000000000000000000000000002",
                    networkName: "ethereum",
                    networkHash: "0xapproval-wins-persistence-race",
                    observedBlockchainId: conflictingBlockchainId,
                    observedRepresentationType: "token",
                    observedContractAddress: "0x0000000000000000000000000000000000000003",
                    observedMintAddress: null,
                    observedDecimals: 18,
                    amount: "0.10000000",
                    metadata: { role: "principal" },
                  },
                ],
                feeTransfers: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: {
                  providerTransactionType: "send",
                  transactionType: "internal_transfer",
                  inventoryEffect: "internal_transfer",
                  taxTreatment: "requires_additional_rule_logic",
                  resolutionStrategy: "static",
                  pairedRecordRequired: false,
                  mappingStatus: "approved",
                },
              })
            )
          })
        )
      )
      const persistedState = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const transactions = yield* db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(eq(schema.transactions.externalId, "approval-wins-persistence-race"))
          const sourceUses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
          return { sourceUses, transactions }
        })
      )

      expect(result._tag).toBe("Failure")
      expect(persistedState).toEqual({ sourceUses: [], transactions: [] })
    })

    it("keeps approval pending when conflicting normalization reserves the mapping first", async () => {
      const providerAsset = await seedPendingApprovalAsset("normalization-wins-persistence-race", {
        withProviderTransfer: false,
      })
      const conflictingBlockchainId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const blockchains = yield* db
            .select({ id: schema.blockchains.id, name: schema.blockchains.name })
            .from(schema.blockchains)
          const conflicting = blockchains.find(({ name }) => name.toLowerCase() !== "bitcoin")
          if (conflicting === undefined) {
            return yield* Effect.die("Missing conflicting blockchain fixture")
          }
          return conflicting.id
        })
      )
      const sourceUseReserved = await Effect.runPromise(Deferred.make<void>())
      const allowPersistence = await Effect.runPromise(Deferred.make<void>())
      const observation = {
        providerAssetRowId: providerAsset.id,
        observedBlockchainId: conflictingBlockchainId,
        representationType: "token" as const,
        contractAddress: "0x0000000000000000000000000000000000000003",
        mintAddress: null,
        decimals: 18,
      }

      const normalization = runAtomicNormalization(
        Effect.gen(function* () {
          const providerAssetRepository = yield* ProviderAssetRepository
          const sourceNormalizationRepository = yield* SourceNormalizationRepository
          const syncEngineTransaction = yield* SyncEngineTransaction
          yield* syncEngineTransaction.run(
            sourceNormalizationRepository.persistNormalizedArtifacts({
              beforePersist: providerAssetRepository
                .recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [observation],
                })
                .pipe(
                  Effect.tap(() => Deferred.succeed(sourceUseReserved, undefined)),
                  Effect.andThen(Deferred.await(allowPersistence))
                ),
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "normalization-wins-persistence-race",
                externalGroupId: null,
                timestamp: new Date("2025-04-21T11:00:00.000Z"),
                transactionType: "internal_transfer",
                providerTransactionType: "send",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Normalization-first race fixture",
                providerCreatedAt: null,
                providerUpdatedAt: null,
                metadata: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: null,
                externalAccountId: null,
                externalOrderId: null,
                externalFillId: null,
                side: null,
                instrument: null,
                fillPrice: null,
                commissionAmount: null,
                commissionCurrency: null,
                metadata: null,
              },
              providerTransfers: [
                {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "normalization-wins-persistence-race:transfer",
                  externalGroupId: null,
                  providerAssetId: providerAsset.id,
                  timestamp: new Date("2025-04-21T11:00:00.000Z"),
                  direction: "outbound",
                  processingMode: "evidence_only",
                  fromAccountRef: null,
                  toAccountRef: null,
                  fromAddress: "0x0000000000000000000000000000000000000001",
                  toAddress: "0x0000000000000000000000000000000000000002",
                  networkName: "ethereum",
                  networkHash: "0xnormalization-wins-persistence-race",
                  observedBlockchainId: conflictingBlockchainId,
                  observedRepresentationType: "token",
                  observedContractAddress: observation.contractAddress,
                  observedMintAddress: null,
                  observedDecimals: observation.decimals,
                  amount: "0.10000000",
                  metadata: { role: "principal" },
                },
              ],
              feeTransfers: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: {
                providerTransactionType: "send",
                transactionType: "internal_transfer",
                inventoryEffect: "internal_transfer",
                taxTreatment: "requires_additional_rule_logic",
                resolutionStrategy: "static",
                pairedRecordRequired: false,
                mappingStatus: "approved",
              },
            })
          )
        })
      )

      await Effect.runPromise(Deferred.await(sourceUseReserved))
      const approval = runRepository(
        Effect.result(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Conflicting approval must not win",
                sourceNotes: "Normalization-first race fixture",
              },
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )
      )
      await Effect.runPromise(Deferred.succeed(allowPersistence, undefined))
      const [, approvalResult] = await Promise.all([normalization, approval])
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({ status: schema.providerAssetMappings.mappingStatus })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const transactions = yield* db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(eq(schema.transactions.externalId, "normalization-wins-persistence-race"))
          const sourceUses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, providerAsset.id))
          return { mapping, sourceUses, transactions }
        })
      )

      expect(approvalResult._tag).toBe("Failure")
      expect(state.mapping).toEqual({ status: "pending_review" })
      expect(state.transactions).toHaveLength(1)
      expect(state.sourceUses).toEqual([{ sourceId: TEST_SOURCE_ID }])
    })

    it.each(["pending", "processing"] as const)(
      "attaches replay to an active %s job when a new approved use is recorded",
      async (status) => {
        const providerAsset = await seedPendingApprovalAsset(`approved-use-${status}`, {
          withProviderTransfer: false,
        })
        await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved before active source use",
                sourceNotes: "Approved before active source use",
              },
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )
        await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "sync",
              status,
              attemptCount: status === "processing" ? 1 : 0,
              maxAttempts: 3,
              progressDetails: { mode: "sync" },
            })
          })
        )

        const [firstCount, secondCount] = await runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            Effect.all(
              [
                repository.recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [],
                }),
                repository.recordProviderAssetSourceUses({
                  sourceId: TEST_SOURCE_ID,
                  providerAssetRowIds: [providerAsset.id],
                  observations: [],
                }),
              ],
              { concurrency: 1 }
            )
          )
        )
        const jobs = await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                followUpMode: schema.processingJobs.followUpMode,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          })
        )

        expect([firstCount, secondCount]).toEqual([1, 0])
        expect(jobs).toEqual([{ followUpMode: "replay", mode: "sync", status }])
      }
    )

    it("locks observation sources before provider assets", async () => {
      const providerAsset = await seedPendingApprovalAsset("source-first-lock")
      const sourceLockAcquired = await Effect.runPromise(Deferred.make<void>())
      const updateProviderAsset = await Effect.runPromise(Deferred.make<void>())
      const heldNormalizationLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(sourceLockAcquired, undefined)
              yield* Deferred.await(updateProviderAsset)
              yield* tx
                .update(schema.providerAssets)
                .set({ retrievedAt: new Date("2026-08-16T12:00:00.000Z") })
                .where(eq(schema.providerAssets.id, providerAsset.id))
            })
          )
        })
      )
      await Effect.runPromise(Deferred.await(sourceLockAcquired))

      const approval = runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Source-first lock ordering",
              sourceNotes: "Source-first lock ordering",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        ).pipe(Effect.result)
      )
      await context.waitForQueryBlockedOnLock({ queryIncludes: 'from "sources"' })
      await Effect.runPromise(Deferred.succeed(updateProviderAsset, undefined))
      const [, result] = await Promise.all([heldNormalizationLock, approval])

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(SyncEngineStorageError)
      }
    })

    it("reattaches replay when another active owner wins the insert race", async () => {
      const providerAsset = await seedPendingApprovalAsset("insert-race-owner")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function inject_active_replay_owner() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mode = 'replay' then
                insert into processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  attempt_count,
                  max_attempts,
                  progress_details
                ) values (
                  new.source_id,
                  new.principal_id,
                  'sync',
                  'pending',
                  0,
                  3,
                  '{"mode":"sync"}'::jsonb
                ) on conflict do nothing;
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger inject_active_replay_owner_before_insert
            before insert on processing_jobs
            for each row execute function inject_active_replay_owner()
          `)
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
    })

    it("reattaches replay when a source-use insert loses the active-owner race", async () => {
      const providerAsset = await seedPendingApprovalAsset("source-use-insert-race-owner", {
        withProviderTransfer: false,
      })
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved before source use",
              sourceNotes: "Approved before source use",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function inject_active_source_use_owner() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mode = 'replay' then
                insert into processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  attempt_count,
                  max_attempts,
                  progress_details
                ) values (
                  new.source_id,
                  new.principal_id,
                  'sync',
                  'pending',
                  0,
                  3,
                  '{"mode":"sync"}'::jsonb
                ) on conflict do nothing;
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger inject_active_source_use_owner_before_insert
            before insert on processing_jobs
            for each row execute function inject_active_source_use_owner()
          `)
        })
      )

      const recorded = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.recordProviderAssetSourceUses({
            sourceId: TEST_SOURCE_ID,
            providerAssetRowIds: [providerAsset.id],
            observations: [],
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(recorded).toBe(1)
      expect(jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
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
            return yield* Effect.die("Expected provider assets to exist")
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
            evidenceState: null,
            query: null,
            cursor: null,
            limit: 2,
          })
        )
      )

      expect(firstPage).toHaveLength(2)
      const lastFirstPageRow = firstPage.at(-1)

      if (lastFirstPageRow === undefined) {
        throw new Error("Expected the first provider asset page to contain rows.")
      }

      const secondPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            evidenceState: null,
            query: null,
            cursor: {
              discoveredAt: lastFirstPageRow.providerAsset.discoveredAt,
              providerAssetRowId: lastFirstPageRow.providerAsset.id,
            },
            limit: 2,
          })
        )
      )

      expect(secondPage).toHaveLength(1)
      expect(
        new Set([...firstPage, ...secondPage].map((review) => review.providerAsset.currencyCode))
      ).toEqual(new Set(["ADA", "ETH", "SOL"]))
    })

    it("excludes dedicated Coinbase fiat rows without hiding legacy crypto reviews", async () => {
      const entries = [
        {
          providerAssetId: "origin-visibility-fiat",
          currencyCode: "EUR",
          name: "Origin visibility fiat",
          payload: {
            source: "coinbase_fiat_currency_catalog",
            providerPayload: { id: "EUR" },
          },
        },
        {
          providerAssetId: "origin-visibility-legacy",
          currencyCode: "LEG",
          name: "Origin visibility legacy",
          payload: { id: "LEG" },
        },
      ] as const

      await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: entries.map((entry) => ({
              ...entry,
              naturalKey: null,
              exponent: 8,
              providerType: "fiat",
            })),
          })

          const providerAssets = yield* Effect.forEach(entries, (entry) =>
            repository
              .findProviderAssetByProviderAssetId({
                providerKey: "coinbase",
                providerAssetId: entry.providerAssetId,
              })
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.die("Expected Coinbase origin fixture"),
                    onSome: Effect.succeed,
                  })
                )
              )
          )

          yield* repository.upsertProviderAssetMappings({
            mappings: providerAssets.map((providerAsset) => ({
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset" as const,
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review" as const,
              reviewerNotes: null,
              sourceNotes: "Coinbase origin visibility test",
            })),
          })
        })
      )

      const reviews = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            evidenceState: null,
            query: "origin visibility",
            cursor: null,
            limit: 1,
          })
        )
      )

      expect(reviews.map((review) => review.providerAsset.providerAssetId)).toEqual([
        "origin-visibility-legacy",
      ])
    })

    it("treats review search wildcards as literal text", async () => {
      const providerKey = "literal-wildcard-review-search"
      const entries = [
        {
          providerAssetId: "literal%-review",
          currencyCode: "PCT",
          name: "Percent marker",
        },
        {
          providerAssetId: "literal_-review",
          currencyCode: "UND",
          name: "Underscore marker",
        },
        {
          providerAssetId: "literal\\-review",
          currencyCode: "BSL",
          name: "Backslash marker",
        },
        {
          providerAssetId: "ordinary-review",
          currencyCode: "ORD",
          name: "Ordinary search target",
        },
        {
          providerAssetId: "unrelated-review",
          currencyCode: "DST",
          name: "Unrelated target",
        },
      ] as const

      await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey,
            entries: entries.map((entry) => ({
              ...entry,
              naturalKey: null,
              exponent: null,
              providerType: "crypto",
              payload: { source: "literal wildcard review search test" },
            })),
          })

          const providerAssets = yield* Effect.forEach(entries, (entry) =>
            repository
              .findProviderAssetByProviderAssetId({
                providerKey,
                providerAssetId: entry.providerAssetId,
              })
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.die("Expected wildcard search provider asset"),
                    onSome: Effect.succeed,
                  })
                )
              )
          )

          yield* repository.upsertProviderAssetMappings({
            mappings: providerAssets.map((providerAsset) => ({
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset" as const,
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review" as const,
              reviewerNotes: null,
              sourceNotes: "Literal wildcard review search test",
            })),
          })
        })
      )

      const search = (query: string) =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository
              .listProviderAssetReviews({
                providerKey,
                mappingStatus: "pending_review",
                evidenceState: null,
                query,
                cursor: null,
                limit: 10,
              })
              .pipe(
                Effect.map((reviews) =>
                  reviews.map((review) => review.providerAsset.providerAssetId)
                )
              )
          )
        )

      expect(await search("%")).toEqual(["literal%-review"])
      expect(await search("_")).toEqual(["literal_-review"])
      expect(await search("\\")).toEqual(["literal\\-review"])
      expect(await search("ordinary")).toEqual(["ordinary-review"])
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
