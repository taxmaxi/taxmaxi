import * as DateTime from "effect/DateTime"
import { SOLANA_USDC_MINT } from "@my/core/assets"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncService } from "@my/sync-engine/services"
import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { AssetResolutionJobRepositoryLive } from "../../../persistence/src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import {
  CoinbaseSyncClient,
  type CoinbaseCryptoCurrencyRecord,
  type CoinbaseFiatCurrencyRecord,
} from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import { HeliusSolanaAssetResolutionServiceLive } from "../../src/providers/helius-solana/layers/HeliusSolanaAssetResolutionServiceLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { HeliusSolanaAssetResolutionService } from "../../src/providers/helius-solana/services/HeliusSolanaAssetResolutionService.ts"
import { HeliusSolanaSyncClient } from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { AssetResolutionJobRepository } from "../../src/services/AssetResolutionJobRepository.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_asset_resolution_job",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-0000-0000-000000000171"
const principalId = "00000000-0000-0000-0000-000000000172"
const secondUserId = "00000000-0000-0000-0000-000000000173"
const secondUserPrincipalId = "00000000-0000-0000-0000-000000000174"
const firstSourceId = "00000000-0000-0000-0000-000000000271"
const secondSourceId = "00000000-0000-0000-0000-000000000272"
const secondUserSourceId = "00000000-0000-0000-0000-000000000273"
const BTC_ASSET_ID = "00000000-0000-0000-0000-000000000571"
const USDC_ASSET_ID = "00000000-0000-0000-0000-000000000572"
const USDC_REPRESENTATION_ID = "00000000-4000-4000-8000-000000000572"

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt,
    payload,
  })

const accountRecord = makeCoinbaseRecord({
  recordType: "coinbase_account",
  externalRecordId: "coinbase-account-1",
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  payload: {
    id: "coinbase-account-1",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  },
})

const btcBuyRecord = makeCoinbaseRecord({
  externalRecordId: "tx-btc-buy-1",
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
  payload: {
    id: "tx-btc-buy-1",
    type: "buy",
    status: "completed",
    amount: { amount: "1.00000000", currency: "BTC" },
    native_amount: { amount: "10000.00", currency: "EUR" },
    created_at: "2025-01-01T10:00:00.000Z",
    resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-btc-buy-1",
    description: "Known BTC buy",
  },
})

const hypeBuyRecord = makeCoinbaseRecord({
  externalRecordId: "tx-hype-buy-1",
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
  payload: {
    id: "tx-hype-buy-1",
    type: "buy",
    status: "completed",
    amount: { amount: "25.00000000", currency: "HYPE" },
    native_amount: { amount: "1050.00", currency: "EUR" },
    created_at: "2025-05-01T10:00:00.000Z",
    resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-hype-buy-1",
    description: "Unknown HYPE buy",
  },
})

const defaultFiatCurrencies = [
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
] as const

const btcCryptoCurrency = {
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
} as const

const hypeCryptoCurrency = {
  currencyCode: "HYPE",
  name: "Hyperliquid",
  providerAssetId: "hype-provider-asset",
  exponent: 8,
  providerType: "crypto",
  payload: {
    code: "HYPE",
    name: "Hyperliquid",
    exponent: 8,
    type: "crypto",
    asset_id: "hype-provider-asset",
  },
} as const

let activeSyncRecords: ReadonlyArray<ProviderRawRecord> = [accountRecord, hypeBuyRecord]
let activeFiatCurrencies: ReadonlyArray<CoinbaseFiatCurrencyRecord> = defaultFiatCurrencies
let activeCryptoCurrencies: ReadonlyArray<CoinbaseCryptoCurrencyRecord> = [hypeCryptoCurrency]
let researchCallCount = 0

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.succeed({
      records: activeSyncRecords
        .filter((record) => record.recordType === "coinbase_account")
        .map((record) => ({
          id: record.externalRecordId,
          occurredAt: record.occurredAt,
          payload: record.payload,
        })),
      nextCursor: null,
    }),
  fetchTransactionsPage: ({ accountId }) =>
    Effect.succeed({
      records: activeSyncRecords
        .filter((record) => record.recordType === "coinbase_transaction")
        .map((record) => ({
          id: record.externalRecordId,
          accountId: record.externalAccountId ?? accountId,
          parentId: record.externalParentId,
          occurredAt: record.occurredAt,
          payload: record.payload,
        })),
      nextCursor: null,
    }),
  fetchFiatCurrencies: Effect.sync(() => activeFiatCurrencies),
  fetchCryptoCurrencies: Effect.sync(() => activeCryptoCurrencies),
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
  Layer.provide(AssetRepositoryLive)
)

const SourceSyncJobExecutorTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationServiceLive),
  Layer.provide(
    SourceProviderRegistryLive.pipe(
      Layer.provide(CoinbaseSourceSyncProviderWithDepsLive),
      Layer.provide(HeliusSolanaSourceSyncProviderLive)
    )
  ),
  Layer.provide(CoinbaseSourceSyncProviderWithDepsLive)
)

const SourceSyncLayer = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineExecutorTestLive),
  Layer.provide(SourceSyncJobExecutorTestLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(CoinbaseSourceSyncProviderWithDepsLive),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const HeliusAssetResolutionTestLive = HeliusSolanaAssetResolutionServiceLive.pipe(
  Layer.provide(AssetRepositoryLive),
  Layer.provide(AssetResolutionJobRepositoryLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(
    Layer.succeed(HeliusSolanaSyncClient, {
      fetchTransactionsForAddress: () =>
        Effect.die("fetchTransactionsForAddress should not be called"),
      fetchAssetBatch: () =>
        Effect.sync(() => {
          researchCallCount += 1
          return []
        }).pipe(Effect.flatMap(() => Effect.die("DAS should not be called for a local mapping"))),
      fetchTransfersForAddress: () => Effect.die("fetchTransfersForAddress should not be called"),
    })
  )
)

const seedFirstCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* seedSyncEngineRepositoryFixture({
      userId,
      principalId,
      sourceId: firstSourceId,
    })

    yield* db.insert(schema.assets).values({
      id: BTC_ASSET_ID,
      name: "Bitcoin",
      symbol: "BTC",
      coingeckoCoinId: "bitcoin",
      type: "fungible",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const seedSecondUserCoinbaseSource = () =>
  seedSyncEngineRepositoryFixture({
    userId: secondUserId,
    principalId: secondUserPrincipalId,
    sourceId: secondUserSourceId,
  }).pipe(Effect.asVoid, Effect.provide(TestPgClientLive))

const seedSecondCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [cex] = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)
    if (cex === undefined) {
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
    }

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: cex.id,
        principalId,
        providerUserId: `coinbase-user-${secondSourceId}`,
        providerAccountId: "coinbase-account-2",
        accessToken: "test-access-token-2",
        refreshToken: "test-refresh-token-2",
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })
    if (createdAccount === undefined) {
      return yield* Effect.die("Failed to create second cex account fixture")
    }

    yield* db.insert(schema.sources).values({
      id: secondSourceId,
      principalId,
      name: `Coinbase Source ${secondSourceId}`,
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      addressId: null,
      createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    })
  }).pipe(Effect.provide(TestPgClientLive))

const seedKnownSolanaUsdc = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [solanaBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "solana"))
      .limit(1)
    if (solanaBlockchain === undefined) {
      return yield* Effect.die("Missing seeded Solana blockchain")
    }

    yield* db.insert(schema.assets).values({
      id: USDC_ASSET_ID,
      name: "USD Coin",
      symbol: "USDC",
      type: "fungible",
    })
    yield* db.insert(schema.assetRepresentations).values({
      id: USDC_REPRESENTATION_ID,
      assetId: USDC_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_USDC_MINT,
      decimals: 6,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = ({
  sourceId,
  ownerPrincipalId = principalId,
}: {
  readonly sourceId: string
  readonly ownerPrincipalId?: string
}) =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({
      principalId: ownerPrincipalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchJobDetails = ({
  sourceId,
  jobId,
  ownerPrincipalId = principalId,
}: {
  readonly sourceId: string
  readonly jobId: string
  readonly ownerPrincipalId?: string
}) =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.getSourceSyncJob({
      principalId: ownerPrincipalId,
      sourceId,
      jobId,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchUnknownObservationState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const rawRows = yield* db
      .select({
        sourceId: schema.sourceRecordsRaw.sourceId,
        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
        normalizedAt: schema.sourceRecordsRaw.normalizedAt,
        normalizationError: schema.sourceRecordsRaw.normalizationError,
      })
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.externalRecordId, "tx-hype-buy-1"))

    const [providerAsset] = yield* db
      .select({
        id: schema.providerAssets.id,
        providerAssetId: schema.providerAssets.providerAssetId,
        currencyCode: schema.providerAssets.currencyCode,
        evidenceRevision: schema.providerAssets.evidenceRevision,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "HYPE")
        )
      )
      .limit(1)

    const resolutionJobs = yield* db
      .select({
        id: schema.assetResolutionJobs.id,
        providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
        evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
        status: schema.assetResolutionJobs.status,
      })
      .from(schema.assetResolutionJobs)

    return {
      rawRows,
      providerAsset: providerAsset ?? null,
      resolutionJobs,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchKnownBtcState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [mapping] = yield* db
      .select({
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "BTC")
        )
      )
      .limit(1)

    const resolutionJobs = yield* db
      .select({ id: schema.assetResolutionJobs.id })
      .from(schema.assetResolutionJobs)

    return {
      mapping: mapping ?? null,
      resolutionJobs,
    }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("asset resolution job scheduling", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        activeSyncRecords = [accountRecord, hypeBuyRecord]
        activeFiatCurrencies = defaultFiatCurrencies
        activeCryptoCurrencies = [hypeCryptoCurrency]
        researchCallCount = 0
        yield* context.recreateTestDatabase()
      })
    )
  )

  it.effect("stores an unknown observation and one durable job without delaying source sync", () =>
    Effect.gen(function* () {
      yield* seedFirstCoinbaseSource()

      const summary = yield* runSync({ sourceId: firstSourceId })
      const job = yield* fetchJobDetails({ sourceId: firstSourceId, jobId: summary.jobId })
      const state = yield* fetchUnknownObservationState()

      expect(job.status).toBe("completed")
      expect(state.rawRows).toEqual([
        expect.objectContaining({
          sourceId: firstSourceId,
          externalRecordId: "tx-hype-buy-1",
          normalizationError: null,
        }),
      ])
      expect(state.rawRows[0]?.normalizedAt).not.toBeNull()
      expect(state.providerAsset).toMatchObject({
        providerAssetId: "hype-provider-asset",
        currencyCode: "HYPE",
        evidenceRevision: 1,
        mappingStatus: "pending_review",
        canonicalAssetId: null,
      })
      expect(state.resolutionJobs).toEqual([
        {
          id: expect.any(String),
          providerAssetRowId: state.providerAsset?.id,
          evidenceRevision: 1,
          status: "pending",
        },
      ])
    })
  )

  it.effect("keeps one job when two sources observe the same provider identity", () =>
    Effect.gen(function* () {
      yield* seedFirstCoinbaseSource()
      yield* seedSecondCoinbaseSource()

      const firstSummary = yield* runSync({ sourceId: firstSourceId })
      const secondSummary = yield* runSync({ sourceId: secondSourceId })
      const firstJob = yield* fetchJobDetails({
        sourceId: firstSourceId,
        jobId: firstSummary.jobId,
      })
      const secondJob = yield* fetchJobDetails({
        sourceId: secondSourceId,
        jobId: secondSummary.jobId,
      })
      const state = yield* fetchUnknownObservationState()

      expect(firstJob.status).toBe("completed")
      expect(secondJob.status).toBe("completed")
      expect(state.rawRows).toHaveLength(2)
      expect(state.resolutionJobs).toHaveLength(1)
      expect(state.resolutionJobs[0]).toMatchObject({
        providerAssetRowId: state.providerAsset?.id,
        evidenceRevision: 1,
        status: "pending",
      })
    })
  )

  it.effect("keeps one job when two different users observe the same provider identity", () =>
    Effect.gen(function* () {
      yield* seedFirstCoinbaseSource()
      yield* seedSecondUserCoinbaseSource()

      const firstSummary = yield* runSync({ sourceId: firstSourceId })
      const secondSummary = yield* runSync({
        sourceId: secondUserSourceId,
        ownerPrincipalId: secondUserPrincipalId,
      })
      const firstJob = yield* fetchJobDetails({
        sourceId: firstSourceId,
        jobId: firstSummary.jobId,
      })
      const secondJob = yield* fetchJobDetails({
        sourceId: secondUserSourceId,
        jobId: secondSummary.jobId,
        ownerPrincipalId: secondUserPrincipalId,
      })
      const state = yield* fetchUnknownObservationState()

      expect(firstJob.status).toBe("completed")
      expect(secondJob.status).toBe("completed")
      expect(state.rawRows).toHaveLength(2)
      expect(state.resolutionJobs).toHaveLength(1)
      expect(state.resolutionJobs[0]).toMatchObject({
        providerAssetRowId: state.providerAsset?.id,
        evidenceRevision: 1,
        status: "pending",
      })
    })
  )

  it.effect(
    "treats a second schedule for the same observation and evidence revision as a no-op",
    () =>
      Effect.gen(function* () {
        yield* seedFirstCoinbaseSource()

        const summary = yield* runSync({ sourceId: firstSourceId })
        const afterFirstSync = yield* fetchUnknownObservationState()
        const providerAssetRowId = afterFirstSync.providerAsset?.id
        if (providerAssetRowId === undefined) {
          expect.fail("Expected the unknown HYPE observation to be stored")
        }

        const secondSchedule = yield* context.runWithLayer({
          effect: Effect.flatMap(AssetResolutionJobRepository, (repository) =>
            repository.scheduleUnresolvedResolutionJob({ providerAssetRowId })
          ),
          layer: AssetResolutionJobRepositoryLive,
        })
        const afterSecondSchedule = yield* fetchUnknownObservationState()
        const job = yield* fetchJobDetails({ sourceId: firstSourceId, jobId: summary.jobId })

        expect(job.status).toBe("completed")
        expect(secondSchedule).toEqual({
          created: false,
          providerAssetRowId,
          evidenceRevision: 1,
        })
        expect(afterSecondSchedule.resolutionJobs.map((resolutionJob) => resolutionJob.id)).toEqual(
          afterFirstSync.resolutionJobs.map((resolutionJob) => resolutionJob.id)
        )
      })
  )

  it.effect("keeps one job when the same observation is synced again with unchanged evidence", () =>
    Effect.gen(function* () {
      yield* seedFirstCoinbaseSource()

      yield* runSync({ sourceId: firstSourceId })
      const afterFirstSync = yield* fetchUnknownObservationState()
      yield* runSync({ sourceId: firstSourceId })
      const afterSecondSync = yield* fetchUnknownObservationState()

      expect(afterFirstSync.providerAsset).toMatchObject({ evidenceRevision: 1 })
      expect(afterSecondSync.providerAsset).toMatchObject({ evidenceRevision: 1 })
      expect(afterSecondSync.resolutionJobs).toEqual(afterFirstSync.resolutionJobs)
    })
  )

  it.effect("schedules a new job when observation evidence changes to a new revision", () =>
    Effect.gen(function* () {
      yield* seedFirstCoinbaseSource()

      yield* runSync({ sourceId: firstSourceId })
      const afterFirstSync = yield* fetchUnknownObservationState()

      activeCryptoCurrencies = [
        {
          ...hypeCryptoCurrency,
          exponent: 6,
          payload: {
            ...hypeCryptoCurrency.payload,
            exponent: 6,
          },
        },
      ]
      yield* runSync({ sourceId: firstSourceId })
      const afterChangedEvidence = yield* fetchUnknownObservationState()

      expect(afterFirstSync.providerAsset).toMatchObject({ evidenceRevision: 1 })
      expect(afterChangedEvidence.providerAsset).toMatchObject({
        providerAssetId: "hype-provider-asset",
        evidenceRevision: 2,
        mappingStatus: "pending_review",
      })
      expect(afterChangedEvidence.resolutionJobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerAssetRowId: afterChangedEvidence.providerAsset?.id,
            evidenceRevision: 1,
            status: "pending",
          }),
          expect.objectContaining({
            providerAssetRowId: afterChangedEvidence.providerAsset?.id,
            evidenceRevision: 2,
            status: "pending",
          }),
        ])
      )
      expect(afterChangedEvidence.resolutionJobs).toHaveLength(2)
    })
  )

  it.effect(
    "resolves a known local mapping during sync without external research or a resolution job",
    () =>
      Effect.gen(function* () {
        activeSyncRecords = [accountRecord, btcBuyRecord]
        activeCryptoCurrencies = [btcCryptoCurrency]
        yield* seedFirstCoinbaseSource()

        const summary = yield* runSync({ sourceId: firstSourceId })
        const state = yield* fetchKnownBtcState()
        const syncJob = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [row] = yield* db
            .select({
              status: schema.processingJobs.status,
              mode: schema.processingJobs.mode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.id, summary.jobId))
            .limit(1)
          return row ?? null
        }).pipe(Effect.provide(TestPgClientLive))

        expect(syncJob).toMatchObject({
          status: "completed",
          mode: "sync",
        })
        expect(state.mapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: BTC_ASSET_ID,
        })
        expect(state.resolutionJobs).toEqual([])
        expect(researchCallCount).toBe(0)
      })
  )

  it.effect("resolves an already-known Solana mapping without an external research call", () =>
    Effect.gen(function* () {
      yield* seedKnownSolanaUsdc()

      const result = yield* context.runWithLayer({
        effect: Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
          Effect.gen(function* () {
            yield* service.ensureDefaultMappings
            return yield* service.resolveAsset({
              kind: "spl",
              mintAddress: SOLANA_USDC_MINT,
            })
          })
        ),
        layer: HeliusAssetResolutionTestLive,
      })
      const jobs = yield* Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ id: schema.assetResolutionJobs.id })
          .from(schema.assetResolutionJobs)
      }).pipe(Effect.provide(TestPgClientLive))

      expect(result).toMatchObject({
        kind: "canonical",
        mappingStatus: "approved",
        canonicalAssetId: USDC_ASSET_ID,
        assetRepresentationId: USDC_REPRESENTATION_ID,
      })
      expect(jobs).toEqual([])
      expect(researchCallCount).toBe(0)
    })
  )
})
