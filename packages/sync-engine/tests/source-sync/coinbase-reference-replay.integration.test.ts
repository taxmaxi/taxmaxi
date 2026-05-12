import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClient,
} from "@my/sync-engine/providers/coinbase"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import {
  SourceSyncService,
  SourceSyncProvider,
  type SourceSyncProviderShape,
} from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../../persistence/tests/support/integration-test-kit.ts"
import { FetchProviderRawBatchResult, ProviderRawRecord } from "@my/sync-engine/services"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_coinbase_replay_pr04",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-0000-0000-000000000151"
const principalId = "00000000-0000-0000-0000-000000000152"
const sourceId = "00000000-0000-0000-0000-000000000251"

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

const initialSyncRecords = [
  makeCoinbaseRecord({
    recordType: "coinbase_account",
    externalRecordId: "coinbase-account-1",
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    payload: {
      id: "coinbase-account-1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-tao-receive-1",
    occurredAt: new Date("2025-01-02T12:00:00.000Z"),
    payload: {
      id: "tx-tao-receive-1",
      type: "receive",
      status: "completed",
      amount: { amount: "2.50000000", currency: "TAO" },
      native_amount: { amount: "900.00", currency: "EUR" },
      created_at: "2025-01-02T12:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-tao-receive-1",
      description: "TAO receive",
    },
  }),
] as const

let providerFetchCount = 0

const SourceSyncProviderTestLive = Layer.succeed(SourceSyncProvider, {
  fetchRawBatch: () =>
    Effect.sync(() => {
      providerFetchCount += 1
      if (providerFetchCount === 1) {
        return FetchProviderRawBatchResult.make({
          records: initialSyncRecords,
          cursorPayload: { step: "done" },
          highWatermark: new Date("2025-01-02T12:00:00.000Z"),
          done: true,
        })
      }

      return FetchProviderRawBatchResult.make({
        records: [],
        cursorPayload: { step: "done" },
        highWatermark: new Date("2025-01-02T12:00:00.000Z"),
        done: true,
      })
    }),
} satisfies SourceSyncProviderShape)

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
        payload: { id: "EUR", name: "Euro", min_size: "0.01" },
      },
    ] as const),
  fetchCryptoCurrencies: () =>
    Effect.succeed([
      {
        currencyCode: "TAO",
        name: "Bittensor",
        providerAssetId: "tao-provider-asset",
        exponent: 8,
        providerType: "crypto",
        payload: {
          code: "TAO",
          name: "Bittensor",
          exponent: 8,
          type: "crypto",
          asset_id: "tao-provider-asset",
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
  Layer.provide(AssetRepositoryLive)
)

const SourceSyncJobExecutorTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationServiceLive),
  Layer.provide(SourceSyncProviderTestLive),
  Layer.provide(CoinbaseSourceSyncProviderWithDepsLive)
)

const SourceSyncLayer = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineExecutorTestLive),
  Layer.provide(SourceSyncJobExecutorTestLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const seedCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: "coinbase-pr05@taxmaxi.test",
      name: "Coinbase PR-05 Replay User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })

    const [coinbaseCex] = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)

    if (coinbaseCex === undefined) {
      return yield* Effect.dieMessage("Missing seeded coinbase CEX fixture")
    }

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: coinbaseCex.id,
        principalId,
        providerUserId: "coinbase-user-pr05",
        providerAccountId: "coinbase-account-1",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (createdAccount === undefined) {
      return yield* Effect.dieMessage("Failed to create cex account fixture")
    }

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.dieMessage("Failed to load base blockchain fixture")
    }

    yield* db.insert(schema.assets).values({
      blockchainId: baseBlockchain.id,
      contractAddress: "eur-pr05",
      name: "Euro",
      symbol: "EUR",
      decimals: 2,
      type: "token",
    })

    yield* db.insert(schema.sources).values({
      id: sourceId,
      name: "Coinbase",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      principalId,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const insertTaoAsset = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.dieMessage("Failed to load base blockchain fixture")
    }

    yield* db.insert(schema.assets).values({
      blockchainId: baseBlockchain.id,
      contractAddress: "tao-pr05",
      name: "Bittensor",
      symbol: "TAO",
      decimals: 8,
      type: "token",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({
      principalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchReplayState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const rawRows = yield* db
      .select({
        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
        normalizedAt: schema.sourceRecordsRaw.normalizedAt,
        normalizationError: schema.sourceRecordsRaw.normalizationError,
      })
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))

    const transactions = yield* db
      .select({
        externalId: schema.transactions.externalId,
        transactionType: schema.transactions.transactionType,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, sourceId))

    const legs = yield* db
      .select({
        externalId: schema.transactionLegs.externalId,
        kind: schema.transactionLegs.kind,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const [taoMapping] = yield* db
      .select({
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "TAO"))
      .limit(1)

    return {
      rawRows,
      transactions,
      legs,
      taoMapping,
    }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("coinbase reference-data replay", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(() =>
    Effect.gen(function* () {
      providerFetchCount = 0
      yield* context.recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it("keeps missing Coinbase asset bindings reviewable until explicitly approved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const firstRun = yield* fetchReplayState()

        expect(firstRun.rawRows).toHaveLength(2)
        expect(
          firstRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")?.normalizedAt
        ).not.toBeNull()
        expect(
          firstRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")
            ?.normalizationError
        ).toBeNull()
        expect(firstRun.transactions).toEqual([
          {
            externalId: "tx-tao-receive-1",
            transactionType: "internal_transfer",
          },
        ])
        expect(firstRun.legs).toHaveLength(0)
        expect(firstRun.taoMapping?.mappingStatus).toBe("pending_review")
        expect(firstRun.taoMapping?.canonicalAssetSymbol).toBe("TAO")

        yield* insertTaoAsset()
        yield* runSync()
        const secondRun = yield* fetchReplayState()

        expect(
          secondRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")?.normalizedAt
        ).not.toBeNull()
        expect(
          secondRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")
            ?.normalizationError
        ).toBeNull()
        expect(secondRun.transactions).toEqual([
          {
            externalId: "tx-tao-receive-1",
            transactionType: "internal_transfer",
          },
        ])
        expect(secondRun.legs).toHaveLength(0)
        expect(secondRun.taoMapping?.mappingStatus).toBe("pending_review")
        expect(secondRun.taoMapping?.canonicalAssetId).toBeNull()
      })
    )
  })
})
