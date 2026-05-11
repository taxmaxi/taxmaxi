import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../src/layers/ProviderReferenceRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_ASSET_ID,
  TEST_RAW_RECORD_ID,
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { SourceNormalizationRepository } from "@my/sync-engine/services"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataService,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClient,
} from "@my/sync-engine/providers/coinbase"
import type { SourceRawRecord, SourceSyncSource } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_normalization_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () => Effect.dieMessage("CoinbaseSyncClient test stub: fetchAccountsPage"),
  fetchTransactionsPage: () =>
    Effect.dieMessage("CoinbaseSyncClient test stub: fetchTransactionsPage"),
  fetchFiatCurrencies: () =>
    Effect.succeed([
      {
        currencyCode: "EUR",
        name: "Euro",
        minSize: "0.01",
        payload: {
          id: "EUR",
          name: "Euro",
          min_size: "0.01",
        },
      },
    ] as const),
  fetchCryptoCurrencies: () =>
    Effect.succeed([
      {
        currencyCode: "BTC",
        name: "Bitcoin",
        providerAssetId: "btc-provider-asset",
        exponent: 8,
        providerType: "crypto",
        payload: {
          code: "BTC",
          name: "Bitcoin",
          exponent: 8,
          type: "crypto",
          asset_id: "btc-provider-asset",
        },
      },
    ] as const),
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(AssetRepositoryLive)
)

const CoinbaseReferenceDataWithDepsLive = CoinbaseReferenceDataServiceLive.pipe(
  Layer.provideMerge(CoinbaseSyncClientTestLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive)
)

const CoinbaseSourceSyncProviderWithDepsLive = CoinbaseSourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseRecordNormalizerLive),
  Layer.provide(CoinbaseLegDerivationServiceLive),
  Layer.provide(CoinbaseReferenceDataWithDepsLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(CoinbaseSyncClientTestLive),
  Layer.provide(AssetRepositoryLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive)
)

const CoinbaseNormalizationTestLayer = Layer.mergeAll(
  SourceNormalizationRepositoryLive,
  CoinbaseReferenceDataWithDepsLive,
  CoinbaseSourceSyncProviderWithDepsLive
)

const runCoinbaseNormalization = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    CoinbaseReferenceDataService | CoinbaseSourceSyncProvider | SourceNormalizationRepository
  >
) => Effect.runPromise(context.runWithLayer({ effect, layer: CoinbaseNormalizationTestLayer }))

const APPROVED_MAPPING = {
  providerTransactionType: "buy",
  transactionType: "buy_fiat",
  inventoryEffect: "acquisition",
  taxTreatment: "non_taxable_by_default",
  resolutionStrategy: "static",
  pairedRecordRequired: false,
  mappingStatus: "approved",
} as const

const seedRawRecord = ({
  rawRecordId,
  externalRecordId,
  occurredAt,
  payload,
  externalAccountId = "coinbase-account-1",
  externalParentId = null,
}: {
  readonly rawRecordId: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload?: unknown
  readonly externalAccountId?: string
  readonly externalParentId?: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: rawRecordId,
      sourceId: TEST_SOURCE_ID,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId,
      externalRecordId,
      externalParentId,
      occurredAt,
      payload: payload ?? { id: externalRecordId },
      importedAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
  })

const buildCoinbaseSource = ({
  cexAccountId,
}: {
  readonly cexAccountId: string
}): SourceSyncSource => ({
  id: TEST_SOURCE_ID,
  userId: TEST_USER_ID,
  providerKey: "coinbase",
  cexAccountId,
  addressId: null,
})

const buildSeededRawRecord = ({
  rawRecordId,
  externalRecordId,
  occurredAt,
  payload,
  externalParentId = null,
}: {
  readonly rawRecordId: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly externalParentId?: string | null
}): SourceRawRecord => ({
  id: rawRecordId,
  sourceId: TEST_SOURCE_ID,
  provider: "coinbase",
  recordType: "coinbase_transaction",
  externalAccountId: "coinbase-account-1",
  externalRecordId,
  externalParentId,
  occurredAt,
  payload,
  importedAt: occurredAt,
  normalizedAt: null,
  normalizationError: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
})

const persistCoinbaseNormalization = ({
  source,
  sourceRecord,
}: {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
}) =>
  Effect.gen(function* () {
    const referenceDataService = yield* CoinbaseReferenceDataService
    const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider
    const sourceNormalizationRepository = yield* SourceNormalizationRepository

    yield* referenceDataService.refreshReferenceData()
    const lookups = yield* coinbaseSourceSyncProvider.loadNormalizationLookups()
    const prepared = yield* coinbaseSourceSyncProvider.prepareNormalization({
      source,
      sourceRecord,
      lookups,
    })

    return yield* sourceNormalizationRepository.persistNormalizedArtifacts(
      prepared.legDerivationStrategy === "derive"
        ? {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers: prepared.providerTransfers,
            feeTransfers: prepared.feeTransfers,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            deriveLegs: ({ transaction, venueContext, feeTransfers }) =>
              coinbaseSourceSyncProvider.deriveLegs({
                transaction,
                venueContext,
                primaryAsset: prepared.primaryAsset,
                feeTransfers,
              }),
          }
        : {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers: prepared.providerTransfers,
            feeTransfers: prepared.feeTransfers,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            legs: [],
          }
    )
  })

describe("SourceNormalizationRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    fixture = await runPg(seedSyncEngineRepositoryFixture())
    await runPg(
      seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      seedRawRecord({
        rawRecordId: TEST_RAW_RECORD_ID,
        externalRecordId: "raw-acquire-1",
        occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      })
    )
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("persists normalized artifacts idempotently and feeds FIFO side effects", async () => {
    const acquisitionResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-acquire-1",
            externalGroupId: "group-acquire-1",
            timestamp: new Date("2025-01-01T10:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-acquire-1",
            providerDescription: "Seed buy",
            providerCreatedAt: new Date("2025-01-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-01-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-acquire-1",
            externalFillId: "fill-acquire-1",
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: "10.00",
            commissionCurrency: "EUR",
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "tx-acquire-1:commission",
              externalGroupId: "group-acquire-1",
              addressId: null,
              blockchainId: null,
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              type: "fee",
              fromAddress: null,
              toAddress: null,
              fromAccountRef: "coinbase-account-1",
              toAccountRef: "coinbase:commission",
              fromPartyType: "account",
              fromPartyResourcePath: "/v2/accounts/coinbase-account-1",
              toPartyType: "fee",
              toPartyResourcePath: null,
              assetId: TEST_EUR_ASSET_ID,
              amount: "10.00",
              tokenId: null,
              notes: "Coinbase trade commission",
              metadata: { provider: "coinbase" },
            },
          ],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquire-1",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              userId: TEST_USER_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "spot_buy",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "10000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: {
            userId: TEST_USER_ID,
            reviewStatus: "needs_review",
            originalTypeKey: "buy_fiat",
            originalConfidence: "0.95",
            currentTypeKey: "buy_fiat",
            legalRuleSetVersion: "de-2025-01",
            categorizationReason: "Fixture review",
            matchedLayer: "fixture",
            needsReview: true,
            userNotes: null,
            reviewedAt: null,
          },
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    expect(acquisitionResult.transaction.externalId).toBe("tx-acquire-1")
    expect(acquisitionResult.feeTransfers).toHaveLength(1)
    expect(acquisitionResult.legs).toHaveLength(1)

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-acquire-1",
            externalGroupId: "group-acquire-1",
            timestamp: new Date("2025-01-01T10:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-acquire-1",
            providerDescription: "Seed buy",
            providerCreatedAt: new Date("2025-01-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-01-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-acquire-1",
            externalFillId: "fill-acquire-1",
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: "10.00",
            commissionCurrency: "EUR",
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "tx-acquire-1:commission",
              externalGroupId: "group-acquire-1",
              addressId: null,
              blockchainId: null,
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              type: "fee",
              fromAddress: null,
              toAddress: null,
              fromAccountRef: "coinbase-account-1",
              toAccountRef: "coinbase:commission",
              fromPartyType: "account",
              fromPartyResourcePath: "/v2/accounts/coinbase-account-1",
              toPartyType: "fee",
              toPartyResourcePath: null,
              assetId: TEST_EUR_ASSET_ID,
              amount: "10.00",
              tokenId: null,
              notes: "Coinbase trade commission",
              metadata: { provider: "coinbase" },
            },
          ],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquire-1",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              userId: TEST_USER_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "spot_buy",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "10000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: {
            userId: TEST_USER_ID,
            reviewStatus: "needs_review",
            originalTypeKey: "buy_fiat",
            originalConfidence: "0.95",
            currentTypeKey: "buy_fiat",
            legalRuleSetVersion: "de-2025-01",
            categorizationReason: "Fixture review",
            matchedLayer: "fixture",
            needsReview: true,
            userNotes: null,
            reviewedAt: null,
          },
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    await runPg(
      seedRawRecord({
        rawRecordId: "00000000-0000-0000-0000-000000000382",
        externalRecordId: "raw-dispose-1",
        occurredAt: new Date("2025-02-01T10:00:00.000Z"),
      })
    )

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: "00000000-0000-0000-0000-000000000382",
            externalId: "tx-dispose-1",
            externalGroupId: "group-dispose-1",
            timestamp: new Date("2025-02-01T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "advanced_trade_fill",
            providerStatus: "completed",
            providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-dispose-1",
            providerDescription: "Fixture sell",
            providerCreatedAt: new Date("2025-02-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-02-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-dispose-1",
            externalFillId: "fill-dispose-1",
            side: "sell",
            instrument: "BTC-EUR",
            fillPrice: "15000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: "00000000-0000-0000-0000-000000000382",
              externalId: "leg-dispose-1",
              txHash: null,
              timestamp: new Date("2025-02-01T10:00:00.000Z"),
              userId: TEST_USER_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.40000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: "spot_sell",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "6000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: {
            ...APPROVED_MAPPING,
            providerTransactionType: "advanced_trade_fill",
            transactionType: "sell_fiat",
            inventoryEffect: "disposal",
          },
        })
      )
    )

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const transactions = yield* db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
        const reviews = yield* db.select().from(schema.transactionReviews)
        const [lot] = yield* db.select().from(schema.fifoLots).limit(1)
        const matches = yield* db.select().from(schema.disposalMatches)
        const legs = yield* db.select().from(schema.transactionLegs)
        const transfers = yield* db.select().from(schema.transfers)
        return {
          transactions,
          reviews,
          lot,
          matches,
          legs,
          transfers,
        }
      })
    )

    expect(counts.transactions).toHaveLength(2)
    expect(counts.legs).toHaveLength(2)
    expect(counts.transfers).toHaveLength(1)
    expect(counts.matches).toHaveLength(1)
    expect(counts.reviews).toHaveLength(1)
    expect(String(counts.lot?.remainingAmount)).toContain("0.6")
  })

  it("marks disposals with missing FIFO inventory for review instead of failing", async () => {
    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-acquire-2",
            externalGroupId: "group-acquire-2",
            timestamp: new Date("2025-01-01T10:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-acquire-2",
            providerDescription: "Seed buy",
            providerCreatedAt: new Date("2025-01-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-01-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-acquire-2",
            externalFillId: "fill-acquire-2",
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquire-2",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              userId: TEST_USER_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "spot_buy",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "10000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    const insufficientRawRecordId = "00000000-0000-0000-0000-000000000492"

    await runPg(
      seedRawRecord({
        rawRecordId: insufficientRawRecordId,
        externalRecordId: "raw-dispose-insufficient-1",
        occurredAt: new Date("2025-02-01T10:00:00.000Z"),
      })
    )

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: insufficientRawRecordId,
            externalId: "tx-dispose-insufficient-1",
            externalGroupId: "group-dispose-insufficient-1",
            timestamp: new Date("2025-02-01T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "advanced_trade_fill",
            providerStatus: "completed",
            providerResourcePath:
              "/v2/accounts/coinbase-account-1/transactions/tx-dispose-insufficient-1",
            providerDescription: "Fixture sell with missing opening inventory",
            providerCreatedAt: new Date("2025-02-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-02-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-dispose-insufficient-1",
            externalFillId: "fill-dispose-insufficient-1",
            side: "sell",
            instrument: "BTC-EUR",
            fillPrice: "15000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: insufficientRawRecordId,
              externalId: "leg-dispose-insufficient-1",
              txHash: null,
              timestamp: new Date("2025-02-01T10:00:00.000Z"),
              userId: TEST_USER_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "2.00000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: "spot_sell",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "30000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: {
            ...APPROVED_MAPPING,
            providerTransactionType: "advanced_trade_fill",
            transactionType: "sell_fiat",
            inventoryEffect: "disposal",
          },
        })
      )
    )

    expect(result.legs).toHaveLength(1)

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const reviews = yield* db.select().from(schema.transactionReviews)
        const matches = yield* db.select().from(schema.disposalMatches)
        const [lot] = yield* db.select().from(schema.fifoLots).limit(1)
        const [rawRecord] = yield* db
          .select({
            normalizedAt: schema.sourceRecordsRaw.normalizedAt,
            normalizationError: schema.sourceRecordsRaw.normalizationError,
          })
          .from(schema.sourceRecordsRaw)
          .where(eq(schema.sourceRecordsRaw.id, insufficientRawRecordId))
          .limit(1)

        return {
          reviews,
          matches,
          lot,
          rawRecord,
        }
      })
    )

    expect(counts.matches).toHaveLength(0)
    expect(counts.reviews).toHaveLength(1)
    expect(counts.reviews).toEqual([
      expect.objectContaining({
        reviewStatus: "needs_review",
        originalTypeKey: "sell_fiat",
        currentTypeKey: "sell_fiat",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Insufficient FIFO inventory"),
      }),
    ])
    expect(counts.rawRecord?.normalizedAt).not.toBeNull()
    expect(counts.rawRecord?.normalizationError).toBeNull()
    expect(String(counts.lot?.remainingAmount)).toContain("1")
  })

  it("persists a reviewable partial normalization with no canonical legs", async () => {
    const partialRawRecordId = "00000000-0000-0000-0000-000000000591"

    await runPg(
      seedRawRecord({
        rawRecordId: partialRawRecordId,
        externalRecordId: "raw-partial-review-1",
        occurredAt: new Date("2025-01-15T10:00:00.000Z"),
      })
    )

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: partialRawRecordId,
            externalId: "tx-partial-review-1",
            externalGroupId: "group-partial-review-1",
            timestamp: new Date("2025-01-15T10:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath:
              "/v2/accounts/coinbase-account-1/transactions/tx-partial-review-1",
            providerDescription: "Fixture partial normalization",
            providerCreatedAt: new Date("2025-01-15T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-01-15T10:00:00.000Z"),
            metadata: { provider: "coinbase", partial: true },
            userId: TEST_USER_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-partial-review-1",
            externalFillId: "fill-partial-review-1",
            side: "buy",
            instrument: "HYPE-EUR",
            fillPrice: "42.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase", partial: true },
          },
          providerTransfers: [],
          feeTransfers: [],
          legs: [],
          transactionReview: {
            userId: TEST_USER_ID,
            reviewStatus: "needs_review",
            originalTypeKey: "buy_fiat",
            originalConfidence: null,
            currentTypeKey: "buy_fiat",
            legalRuleSetVersion: null,
            categorizationReason:
              "provider_asset_mapping: Coinbase provider asset mapping review is required.",
            matchedLayer: "provider_asset_mapping",
            needsReview: true,
            userNotes: null,
            reviewedAt: null,
          },
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    expect(result.transaction.externalId).toBe("tx-partial-review-1")
    expect(result.legs).toHaveLength(0)

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [review] = yield* db
          .select({
            reviewStatus: schema.transactionReviews.reviewStatus,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
            categorizationReason: schema.transactionReviews.categorizationReason,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.userId, TEST_USER_ID))
          .orderBy(schema.transactionReviews.createdAt)
          .limit(1)
        const legs = yield* db.select().from(schema.transactionLegs)
        const [rawRecord] = yield* db
          .select({
            normalizedAt: schema.sourceRecordsRaw.normalizedAt,
            normalizationError: schema.sourceRecordsRaw.normalizationError,
          })
          .from(schema.sourceRecordsRaw)
          .where(eq(schema.sourceRecordsRaw.id, partialRawRecordId))
          .limit(1)

        return {
          review,
          legs,
          rawRecord,
        }
      })
    )

    expect(counts.review).toEqual(
      expect.objectContaining({
        reviewStatus: "needs_review",
        matchedLayer: "provider_asset_mapping",
        needsReview: true,
        categorizationReason: expect.stringContaining("provider_asset_mapping"),
      })
    )
    expect(counts.legs).toHaveLength(0)
    expect(counts.rawRecord?.normalizedAt).not.toBeNull()
    expect(counts.rawRecord?.normalizationError).toBeNull()
  })

  it("persists a Coinbase send provider transfer without creating a canonical principal leg", async () => {
    const rawRecordId = "00000000-0000-0000-0000-000000000691"
    const occurredAt = new Date("2025-04-01T10:00:00.000Z")
    const payload = {
      id: "tx-send-provider-transfer-1",
      type: "send",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-send-provider-transfer-1",
      network: {
        status: "confirmed",
        hash: "tx-send-provider-transfer-hash-1",
        network_name: "base",
        transaction_fee: { amount: "0.00010000", currency: "BTC" },
      },
      to: {
        address: "bc1qprovidertransferdestination",
        resource: "address",
      },
    }

    await runPg(
      seedRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-send-1",
        occurredAt,
        payload,
      })
    )

    const result = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId,
          externalRecordId: "raw-provider-send-1",
          occurredAt,
          payload,
        }),
      })
    )

    expect(result.providerTransfers).toHaveLength(1)
    expect(result.legs).toHaveLength(1)
    expect(result.legs).toEqual([expect.objectContaining({ kind: "fee" })])
    expect(result.feeTransfers).toHaveLength(1)
    expect(result.providerTransfers[0]).toEqual(
      expect.objectContaining({
        externalId: "tx-send-provider-transfer-1:principal",
        providerAssetId: expect.any(String),
        direction: "outbound",
        fromAccountRef: "coinbase-account-1",
        toAddress: "bc1qprovidertransferdestination",
        networkName: "base",
        networkHash: "tx-send-provider-transfer-hash-1",
      })
    )
    expect(result.providerTransfers[0]?.amount).toContain("0.10000000")

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const providerTransfers = yield* db.select().from(schema.providerTransfers)
        const legs = yield* db.select().from(schema.transactionLegs)
        return {
          providerTransfers,
          legs,
        }
      })
    )

    expect(counts.providerTransfers).toHaveLength(1)
    expect(counts.legs).toHaveLength(1)
  })

  it("persists a Coinbase receive provider transfer with source and destination context", async () => {
    const rawRecordId = "00000000-0000-0000-0000-000000000692"
    const occurredAt = new Date("2025-04-02T10:00:00.000Z")
    const payload = {
      id: "tx-receive-provider-transfer-1",
      type: "receive",
      status: "completed",
      amount: { amount: "0.25000000", currency: "BTC" },
      native_amount: { amount: "3750.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-receive-provider-transfer-1",
      from: {
        address: "bc1qprovidertransfersource",
        resource: "address",
      },
      to: {
        id: "coinbase-account-1",
        resource: "account",
        resource_path: "/v2/accounts/coinbase-account-1",
      },
    }

    await runPg(
      seedRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-receive-1",
        occurredAt,
        payload,
      })
    )

    const result = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId,
          externalRecordId: "raw-provider-receive-1",
          occurredAt,
          payload,
        }),
      })
    )

    expect(result.providerTransfers).toHaveLength(1)
    expect(result.providerTransfers[0]).toEqual(
      expect.objectContaining({
        externalId: "tx-receive-provider-transfer-1:principal",
        providerAssetId: expect.any(String),
        direction: "inbound",
        fromAddress: "bc1qprovidertransfersource",
        toAccountRef: "coinbase-account-1",
      })
    )
    expect(result.providerTransfers[0]?.amount).toContain("0.25000000")

    const [providerTransfer] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.providerTransfers)
      })
    )

    expect(providerTransfer).toEqual(
      expect.objectContaining({
        externalId: "tx-receive-provider-transfer-1:principal",
        direction: "inbound",
        fromAddress: "bc1qprovidertransfersource",
        toAccountRef: "coinbase-account-1",
      })
    )
  })

  it("keeps Coinbase provider transfer persistence idempotent on replay", async () => {
    const rawRecordId = "00000000-0000-0000-0000-000000000693"
    const occurredAt = new Date("2025-04-03T10:00:00.000Z")
    const payload = {
      id: "tx-send-provider-transfer-replay-1",
      type: "send",
      status: "completed",
      amount: { amount: "-0.05000000", currency: "BTC" },
      native_amount: { amount: "-750.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path:
        "/v2/accounts/coinbase-account-1/transactions/tx-send-provider-transfer-replay-1",
      network: {
        status: "confirmed",
        hash: "tx-send-provider-transfer-replay-hash-1",
        network_name: "base",
      },
      to: {
        address: "bc1qprovidertransferreplaydestination",
        resource: "address",
      },
    }

    await runPg(
      seedRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-send-replay-1",
        occurredAt,
        payload,
      })
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    const sourceRecord = buildSeededRawRecord({
      rawRecordId,
      externalRecordId: "raw-provider-send-replay-1",
      occurredAt,
      payload,
    })

    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord,
      })
    )

    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord,
      })
    )

    const counts = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const providerTransfers = yield* db.select().from(schema.providerTransfers)
        const transactions = yield* db.select().from(schema.transactions)
        return {
          providerTransfers,
          transactions,
        }
      })
    )

    expect(counts.providerTransfers).toHaveLength(1)
    expect(counts.transactions).toHaveLength(1)
  })
})
