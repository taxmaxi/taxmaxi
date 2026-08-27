import { and, eq, inArray, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseSourceSyncProvider } from "../../src/providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import {
  CoinbaseSyncClient,
  type CoinbaseCryptoCurrencyRecord,
  type CoinbaseFiatCurrencyRecord,
} from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import { AssetExceptionRepository, SourceSyncService } from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { AssetExceptionRepositoryLive } from "../../../persistence/src/layers/AssetExceptionRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  PortfolioRepository,
  TaxCalculationService,
} from "../../../persistence/src/services/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_coinbase_pr04",
})
const TestPgClientLive = context.TestPgClientLive
const recreateTestDatabase = context.recreateTestDatabase
const BTC_ASSET_ID = "00000000-0000-0000-0000-000000000541"
const BTC_BASE_REPRESENTATION_ID = "00000000-0000-0000-0000-000000000543"
const DOT_ASSET_ID = "00000000-0000-0000-0000-000000000542"

const expectDecimalAmount = (actual: string, expected: string) => {
  const actualDecimal = BigDecimal.fromString(actual)
  const expectedDecimal = BigDecimal.fromString(expected)

  expect(Option.isSome(actualDecimal)).toBe(true)
  expect(Option.isSome(expectedDecimal)).toBe(true)
  if (Option.isSome(actualDecimal) && Option.isSome(expectedDecimal)) {
    expect(BigDecimal.equals(actualDecimal.value, expectedDecimal.value)).toBe(true)
  }
}

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

const defaultSyncRecords = [
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
    externalRecordId: "tx-buy-1",
    occurredAt: new Date("2025-01-01T10:00:00.000Z"),
    payload: {
      id: "tx-buy-1",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: "2025-01-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-buy-1",
      description: "Seed buy",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-sell-1",
    occurredAt: new Date("2025-02-01T10:00:00.000Z"),
    payload: {
      id: "tx-sell-1",
      type: "advanced_trade_fill",
      status: "completed",
      amount: { amount: "-0.40000000", currency: "BTC" },
      native_amount: { amount: "-6000.00", currency: "EUR" },
      created_at: "2025-02-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-sell-1",
      advanced_trade_fill: {
        commission: "0.01000000",
        fill_price: "15000.00",
        order_id: "order-sell-1",
        order_side: "sell",
        product_id: "BTC-EUR",
      },
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-income-1",
    occurredAt: new Date("2025-03-01T10:00:00.000Z"),
    payload: {
      id: "tx-income-1",
      type: "staking_reward",
      status: "completed",
      amount: { amount: "0.020123619236", currency: "DOT" },
      native_amount: { amount: "700.00", currency: "EUR" },
      created_at: "2025-03-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-income-1",
      description: "Staking reward",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-send-1",
    occurredAt: new Date("2025-04-01T10:00:00.000Z"),
    payload: {
      id: "tx-send-1",
      type: "send",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: "2025-04-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-send-1",
      network: {
        status: "confirmed",
        hash: "tx-send-hash-1",
        network_name: "base",
        transaction_fee: { amount: "0.00010000", currency: "BTC" },
      },
      to: {
        address: "bc1qexampledestination",
        resource: "address",
      },
    },
  }),
] as const

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

const defaultCryptoCurrencies = [
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
  {
    currencyCode: "ETH",
    name: "Ethereum",
    providerAssetId: "eth-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "ETH",
      name: "Ethereum",
      exponent: 8,
      type: "crypto",
      asset_id: "eth-provider-asset",
    },
  },
  {
    currencyCode: "ETH2",
    name: "Ethereum 2",
    providerAssetId: "eth2-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "ETH2",
      name: "Ethereum 2",
      exponent: 8,
      type: "crypto",
      asset_id: "eth2-provider-asset",
    },
  },
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
  {
    currencyCode: "DOT",
    name: "Polkadot",
    providerAssetId: "dot-provider-asset",
    exponent: 10,
    providerType: "crypto",
    payload: {
      code: "DOT",
      name: "Polkadot",
      exponent: 10,
      type: "crypto",
      asset_id: "dot-provider-asset",
    },
  },
] as const

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

const makeHypeReviewableSyncRecords = () =>
  [
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
      externalRecordId: "tx-hype-buy-1",
      occurredAt: new Date("2025-05-01T10:00:00.000Z"),
      payload: {
        id: "tx-hype-buy-1",
        type: "buy",
        status: "completed",
        amount: { amount: "25.00000000", currency: "HYPE" },
        native_amount: { amount: "1050.00", currency: "EUR" },
        created_at: "2025-05-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-hype-buy-1",
        description: "HYPE buy awaiting provider asset review",
      },
    }),
  ] as const

const makeHypeWithBtcFeeSyncRecords = () =>
  [
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
      externalRecordId: "tx-hype-buy-with-btc-fee",
      occurredAt: new Date("2025-05-01T10:00:00.000Z"),
      payload: {
        id: "tx-hype-buy-with-btc-fee",
        type: "buy",
        status: "completed",
        amount: { amount: "25.00000000", currency: "HYPE" },
        native_amount: { amount: "1050.00", currency: "EUR" },
        network: {
          status: "confirmed",
          network_name: "base",
          transaction_fee: { amount: "0.00010000", currency: "BTC" },
        },
        created_at: "2025-05-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-hype-buy-with-btc-fee",
      },
    }),
  ] as const

let activeSyncRecords: ReadonlyArray<ProviderRawRecord> = defaultSyncRecords
let activeFiatCurrencies: ReadonlyArray<CoinbaseFiatCurrencyRecord> = defaultFiatCurrencies
let activeCryptoCurrencies: ReadonlyArray<CoinbaseCryptoCurrencyRecord> = defaultCryptoCurrencies
let remoteReferenceCatalogAvailable = true

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
  fetchFiatCurrencies: () =>
    remoteReferenceCatalogAvailable
      ? Effect.succeed(activeFiatCurrencies)
      : Effect.die("Remote fiat reference catalog should not be called during replay"),
  fetchCryptoCurrencies: () =>
    remoteReferenceCatalogAvailable
      ? Effect.succeed(activeCryptoCurrencies)
      : Effect.die("Remote crypto reference catalog should not be called during replay"),
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

const userId = "00000000-0000-0000-0000-000000000101"
const principalId = "00000000-0000-0000-0000-000000000102"
const sourceId = "00000000-0000-0000-0000-000000000201"
const ownedOnchainAddressId = "00000000-0000-0000-0000-000000000301"
const ownedOnchainSourceId = "00000000-0000-0000-0000-000000000302"

const seedCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* seedSyncEngineRepositoryFixture({
      userId,
      principalId,
      sourceId,
    })

    yield* db.insert(schema.assets).values([
      {
        id: BTC_ASSET_ID,
        name: "Bitcoin",
        symbol: "BTC",
        coingeckoCoinId: "bitcoin",
        type: "fungible",
      },
      {
        id: DOT_ASSET_ID,
        name: "Polkadot",
        symbol: "DOT",
        coingeckoCoinId: "polkadot",
        type: "fungible",
      },
    ])

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)
    if (baseBlockchain === undefined) {
      return yield* Effect.die("Missing seeded base blockchain")
    }

    yield* db.insert(schema.assetRepresentations).values({
      id: BTC_BASE_REPRESENTATION_ID,
      assetId: BTC_ASSET_ID,
      blockchainId: baseBlockchain.id,
      type: "native",
      decimals: 8,
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

const fetchJobDetails = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.getSourceSyncJob({
      principalId,
      sourceId,
      jobId,
    })
  }).pipe(Effect.provide(TestLayer))

const replaySource = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    const summary = yield* sourceSync.replaySourceSyncJob({
      principalId,
      sourceId,
    })
    return yield* sourceSync.getSourceSyncJob({
      principalId,
      sourceId,
      jobId: summary.jobId,
    })
  }).pipe(Effect.provide(TestLayer))

const calculateTax = () =>
  Effect.gen(function* () {
    const taxCalculation = yield* TaxCalculationService
    return yield* taxCalculation.calculateTax({
      sourceId,
      jurisdiction: "germany",
      year: 2025,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchPortfolioPositions = () =>
  Effect.gen(function* () {
    const portfolio = yield* PortfolioRepository
    return yield* portfolio.listAssetPositions({
      principalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const revertTxMappingToNoLeg = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db
      .update(schema.providerTransactionTypeMappings)
      .set({ resolutionStrategy: "no_leg" })
      .where(
        and(
          eq(schema.providerTransactionTypeMappings.provider, "coinbase"),
          eq(schema.providerTransactionTypeMappings.providerTransactionType, "tx")
        )
      )
  }).pipe(Effect.provide(TestPgClientLive))

const fetchProviderTransferInventoryState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const providerTransferRows = yield* db
      .select({
        id: schema.providerTransfers.id,
        externalId: schema.providerTransfers.externalId,
        direction: schema.providerTransfers.direction,
        amount: schema.providerTransfers.amount,
      })
      .from(schema.providerTransfers)
      .where(eq(schema.providerTransfers.sourceId, sourceId))

    const providerLots = yield* db
      .select({
        sourceProviderTransferId: schema.fifoLots.sourceProviderTransferId,
        assetId: schema.fifoLots.assetId,
        originalAmount: schema.fifoLots.originalAmount,
        remainingAmount: schema.fifoLots.remainingAmount,
        costBasisStatus: schema.fifoLots.costBasisStatus,
      })
      .from(schema.fifoLots)
      .where(eq(schema.fifoLots.sourceId, sourceId))

    return {
      providerTransferRows,
      providerLots,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const makeReceiveSyncRecords = ({
  walletAddress,
  txHash,
}: {
  readonly walletAddress: string
  readonly txHash: string
}) =>
  [
    ...defaultSyncRecords.filter((record) => record.externalRecordId !== "tx-send-1"),
    makeCoinbaseRecord({
      externalRecordId: "tx-receive-1",
      occurredAt: new Date("2025-04-01T10:00:00.000Z"),
      payload: {
        id: "tx-receive-1",
        type: "receive",
        status: "completed",
        amount: { amount: "0.10000000", currency: "BTC" },
        native_amount: { amount: "1500.00", currency: "EUR" },
        created_at: "2025-04-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-receive-1",
        description: "Owned wallet receive",
        network: {
          status: "confirmed",
          hash: txHash,
          network_name: "base",
        },
        from: {
          address: walletAddress,
          resource: "address",
        },
      },
    }),
  ] as const

const seedMatchedOnchainReceipt = ({
  walletAddress,
  txHash,
  amount,
}: {
  readonly walletAddress: string
  readonly txHash: string
  readonly amount: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.die("Failed to load base blockchain fixture for onchain match")
    }

    const [btcAsset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)

    if (btcAsset === undefined) {
      return yield* Effect.die("Failed to load BTC asset fixture for onchain match")
    }

    yield* db.insert(schema.addresses).values({
      id: ownedOnchainAddressId,
      address: walletAddress,
      type: "bitcoin",
      name: "Owned wallet",
      principalId,
      createdAt: new Date("2025-04-01T10:00:00.000Z"),
      updatedAt: new Date("2025-04-01T10:00:00.000Z"),
    })

    yield* db.insert(schema.sources).values({
      id: ownedOnchainSourceId,
      name: "Owned wallet",
      providerKey: "bitcoin",
      sourceableType: "onchain",
      addressId: ownedOnchainAddressId,
      principalId,
      createdAt: new Date("2025-04-01T10:00:00.000Z"),
      updatedAt: new Date("2025-04-01T10:00:00.000Z"),
    })

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ownedOnchainSourceId,
        sourceRawRecordId: null,
        externalId: "onchain-receipt-1",
        externalGroupId: "onchain-receipt-1",
        timestamp: new Date("2025-04-01T10:05:00.000Z"),
        transactionType: null,
        providerTransactionType: null,
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Owned wallet receipt",
        providerCreatedAt: new Date("2025-04-01T10:05:00.000Z"),
        providerUpdatedAt: new Date("2025-04-01T10:05:00.000Z"),
        metadata: { provider: "bitcoin" },
        principalId,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create onchain receipt transaction fixture")
    }

    yield* db.insert(schema.transactionOnchainContext).values({
      transactionId: transaction.id,
      blockchainId: baseBlockchain.id,
      addressId: ownedOnchainAddressId,
      chainTxId: txHash,
      blockHeight: "1",
      blockHash: `block-${txHash}`,
      positionInBlock: "0",
      fromAddress: "0xexternal",
      toAddress: walletAddress,
      gasUsed: null,
      gasPrice: null,
      feeAmount: null,
      feeAssetId: null,
      feeCostBasisAmount: null,
      feeCostBasisCurrency: null,
      isError: false,
      functionName: null,
      metadata: { provider: "bitcoin" },
    })

    yield* db.insert(schema.transfers).values({
      sourceId: ownedOnchainSourceId,
      sourceRawRecordId: null,
      externalId: "onchain-receipt-1:transfer",
      externalGroupId: "onchain-receipt-1",
      addressId: ownedOnchainAddressId,
      blockchainId: baseBlockchain.id,
      txHash,
      timestamp: new Date("2025-04-01T10:05:00.000Z"),
      type: "native",
      fromAddress: "0xexternal",
      toAddress: walletAddress,
      fromAccountRef: null,
      toAccountRef: null,
      fromPartyType: "address",
      fromPartyResourcePath: null,
      toPartyType: "address",
      toPartyResourcePath: null,
      assetId: btcAsset.id,
      assetRepresentationId: BTC_BASE_REPRESENTATION_ID,
      amount,
      tokenId: null,
      notes: null,
      metadata: { provider: "bitcoin" },
      principalId,
      createdAt: new Date("2025-04-01T10:05:00.000Z"),
      updatedAt: new Date("2025-04-01T10:05:00.000Z"),
    })
  }).pipe(Effect.provide(TestPgClientLive))

const seedMatchedOnchainSend = ({
  walletAddress,
  txHash,
  amount,
}: {
  readonly walletAddress: string
  readonly txHash: string
  readonly amount: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)

    if (baseBlockchain === undefined) {
      return yield* Effect.die("Failed to load base blockchain fixture for onchain send")
    }

    const [btcAsset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)

    if (btcAsset === undefined) {
      return yield* Effect.die("Failed to load BTC asset fixture for onchain send")
    }

    yield* db.insert(schema.addresses).values({
      id: ownedOnchainAddressId,
      address: walletAddress,
      type: "bitcoin",
      name: "Owned wallet",
      principalId,
      createdAt: new Date("2025-04-01T10:00:00.000Z"),
      updatedAt: new Date("2025-04-01T10:00:00.000Z"),
    })

    yield* db.insert(schema.sources).values({
      id: ownedOnchainSourceId,
      name: "Owned wallet",
      providerKey: "bitcoin",
      sourceableType: "onchain",
      addressId: ownedOnchainAddressId,
      principalId,
      createdAt: new Date("2025-04-01T10:00:00.000Z"),
      updatedAt: new Date("2025-04-01T10:00:00.000Z"),
    })

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ownedOnchainSourceId,
        sourceRawRecordId: null,
        externalId: "onchain-send-1",
        externalGroupId: "onchain-send-1",
        timestamp: new Date("2025-04-01T10:05:00.000Z"),
        transactionType: null,
        providerTransactionType: null,
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Owned wallet send",
        providerCreatedAt: new Date("2025-04-01T10:05:00.000Z"),
        providerUpdatedAt: new Date("2025-04-01T10:05:00.000Z"),
        metadata: { provider: "bitcoin" },
        principalId,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create onchain send transaction fixture")
    }

    yield* db.insert(schema.transactionOnchainContext).values({
      transactionId: transaction.id,
      blockchainId: baseBlockchain.id,
      addressId: ownedOnchainAddressId,
      chainTxId: txHash,
      blockHeight: "1",
      blockHash: `block-${txHash}`,
      positionInBlock: "0",
      fromAddress: walletAddress,
      toAddress: "coinbase:destination",
      gasUsed: null,
      gasPrice: null,
      feeAmount: null,
      feeAssetId: null,
      feeCostBasisAmount: null,
      feeCostBasisCurrency: null,
      isError: false,
      functionName: null,
      metadata: { provider: "bitcoin" },
    })

    yield* db.insert(schema.transfers).values({
      sourceId: ownedOnchainSourceId,
      sourceRawRecordId: null,
      externalId: "onchain-send-1:transfer",
      externalGroupId: "onchain-send-1",
      addressId: ownedOnchainAddressId,
      blockchainId: baseBlockchain.id,
      txHash,
      timestamp: new Date("2025-04-01T10:05:00.000Z"),
      type: "native",
      fromAddress: walletAddress,
      toAddress: "coinbase:destination",
      fromAccountRef: null,
      toAccountRef: null,
      fromPartyType: "address",
      fromPartyResourcePath: null,
      toPartyType: "exchange",
      toPartyResourcePath: null,
      assetId: btcAsset.id,
      assetRepresentationId: BTC_BASE_REPRESENTATION_ID,
      amount,
      tokenId: null,
      notes: null,
      metadata: { provider: "bitcoin" },
      principalId,
      createdAt: new Date("2025-04-01T10:05:00.000Z"),
      updatedAt: new Date("2025-04-01T10:05:00.000Z"),
    })
  }).pipe(Effect.provide(TestPgClientLive))

const fetchCanonicalizationState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const reconciliations = yield* db
      .select({
        status: schema.transferReconciliations.status,
        matchReason: schema.transferReconciliations.matchReason,
        deterministic: schema.transferReconciliations.deterministic,
        canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
        canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
      })
      .from(schema.transferReconciliations)

    const reviews = yield* db
      .select({
        matchedLayer: schema.transactionReviews.matchedLayer,
      })
      .from(schema.transactionReviews)
      .innerJoin(
        schema.transactions,
        eq(schema.transactions.id, schema.transactionReviews.transactionId)
      )
      .where(eq(schema.transactionReviews.principalId, principalId))

    const legs = yield* db
      .select({
        id: schema.transactionLegs.id,
        externalId: schema.transactionLegs.externalId,
        sourceId: schema.transactionLegs.sourceId,
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(inArray(schema.transactionLegs.sourceId, [sourceId, ownedOnchainSourceId]))

    const fifoLots = yield* db
      .select({
        id: schema.fifoLots.id,
        sourceId: schema.fifoLots.sourceId,
        sourceLegId: schema.fifoLots.sourceLegId,
        originalAmount: schema.fifoLots.originalAmount,
        remainingAmount: schema.fifoLots.remainingAmount,
        costBasisPerToken: schema.fifoLots.costBasisPerToken,
      })
      .from(schema.fifoLots)
      .where(inArray(schema.fifoLots.sourceId, [sourceId, ownedOnchainSourceId]))

    const disposalMatches = yield* db
      .select({
        disposalLegId: schema.disposalMatches.disposalLegId,
        fifoLotId: schema.disposalMatches.fifoLotId,
        matchedAmount: schema.disposalMatches.matchedAmount,
      })
      .from(schema.disposalMatches)

    return {
      reconciliations,
      reviews,
      legs,
      fifoLots,
      disposalMatches,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchCounts = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const rawRows = yield* db
      .select({
        id: schema.sourceRecordsRaw.id,
        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
        normalizedAt: schema.sourceRecordsRaw.normalizedAt,
        normalizationError: schema.sourceRecordsRaw.normalizationError,
      })
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))

    const transactions = yield* db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
        transactionType: schema.transactions.transactionType,
        providerStatus: schema.transactions.providerStatus,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, sourceId))

    const venueContexts = yield* db
      .select({ transactionId: schema.transactionVenueContext.transactionId })
      .from(schema.transactionVenueContext)

    const transactionReviews = yield* db
      .select({
        transactionId: schema.transactionReviews.transactionId,
        reviewStatus: schema.transactionReviews.reviewStatus,
        needsReview: schema.transactionReviews.needsReview,
        originalTypeKey: schema.transactionReviews.originalTypeKey,
        originalConfidence: schema.transactionReviews.originalConfidence,
        currentTypeKey: schema.transactionReviews.currentTypeKey,
        legalRuleSetVersion: schema.transactionReviews.legalRuleSetVersion,
        categorizationReason: schema.transactionReviews.categorizationReason,
        matchedLayer: schema.transactionReviews.matchedLayer,
        userNotes: schema.transactionReviews.userNotes,
        reviewedAt: schema.transactionReviews.reviewedAt,
      })
      .from(schema.transactionReviews)

    const transfers = yield* db
      .select({
        externalId: schema.transfers.externalId,
      })
      .from(schema.transfers)
      .where(eq(schema.transfers.sourceId, sourceId))

    const legs = yield* db
      .select({
        id: schema.transactionLegs.id,
        externalId: schema.transactionLegs.externalId,
        transactionId: schema.transactionLegs.transactionId,
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
        amount: schema.transactionLegs.amount,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const fifoLots = yield* db
      .select({
        id: schema.fifoLots.id,
        assetId: schema.fifoLots.assetId,
        sourceLegId: schema.fifoLots.sourceLegId,
        originalAmount: schema.fifoLots.originalAmount,
        remainingAmount: schema.fifoLots.remainingAmount,
      })
      .from(schema.fifoLots)
      .where(eq(schema.fifoLots.sourceId, sourceId))

    const disposalMatches = yield* db
      .select({
        disposalLegId: schema.disposalMatches.disposalLegId,
        fifoLotId: schema.disposalMatches.fifoLotId,
        matchedAmount: schema.disposalMatches.matchedAmount,
        gainLoss: schema.disposalMatches.gainLoss,
      })
      .from(schema.disposalMatches)

    const inventoryMovements = yield* db
      .select({
        id: schema.inventoryMovements.id,
        transactionId: schema.inventoryMovements.transactionId,
        transactionLegId: schema.inventoryMovements.transactionLegId,
        assetId: schema.inventoryMovements.assetId,
        purpose: schema.inventoryMovements.purpose,
        amount: schema.inventoryMovements.amount,
      })
      .from(schema.inventoryMovements)

    const inventoryMovementAllocations = yield* db
      .select({
        inventoryMovementId: schema.inventoryMovementAllocations.inventoryMovementId,
        fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
        matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
      })
      .from(schema.inventoryMovementAllocations)

    const transactionTypeCatalogRows = yield* db
      .select({
        providerTransactionType: schema.providerTransactionTypeCatalog.providerTransactionType,
      })
      .from(schema.providerTransactionTypeCatalog)
      .where(eq(schema.providerTransactionTypeCatalog.provider, "coinbase"))

    const providerAssetRows = yield* db
      .select({ currencyCode: schema.providerAssets.currencyCode })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.provider, "coinbase"))

    return {
      rawRows,
      transactions,
      transactionReviews,
      transactionCount: transactions.length,
      venueContextCount: venueContexts.length,
      transfers,
      legs,
      fifoLots,
      disposalMatches,
      inventoryMovements,
      inventoryMovementAllocations,
      transactionTypeCatalogCount: transactionTypeCatalogRows.length,
      providerAssetCatalogCount: providerAssetRows.length,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const setTransactionReview = ({
  externalId,
  reviewStatus,
  originalTypeKey,
  originalConfidence,
  currentTypeKey,
  legalRuleSetVersion,
  categorizationReason,
  matchedLayer,
  userNotes,
  reviewedAt,
}: {
  readonly externalId: string
  readonly reviewStatus: "approved" | "changed"
  readonly originalTypeKey: string
  readonly originalConfidence: string
  readonly currentTypeKey: string
  readonly legalRuleSetVersion: string
  readonly categorizationReason: string
  readonly matchedLayer: string
  readonly userNotes: string
  readonly reviewedAt: Date
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [transaction] = yield* db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, externalId)
        )
      )
      .limit(1)

    if (transaction === undefined) {
      return yield* Effect.die(`Missing transaction ${externalId}`)
    }

    yield* db
      .update(schema.transactionReviews)
      .set({
        reviewStatus,
        originalTypeKey,
        originalConfidence,
        currentTypeKey,
        legalRuleSetVersion,
        categorizationReason,
        matchedLayer,
        needsReview: false,
        userNotes,
        reviewedAt,
      })
      .where(eq(schema.transactionReviews.transactionId, transaction.id))
  }).pipe(Effect.provide(TestPgClientLive))

const fetchProviderAssetState = ({ currencyCode }: { readonly currencyCode: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [providerAsset] = yield* db
      .select({
        id: schema.providerAssets.id,
        providerAssetId: schema.providerAssets.providerAssetId,
        currencyCode: schema.providerAssets.currencyCode,
        providerType: schema.providerAssets.providerType,
      })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    const [mapping] =
      providerAsset === undefined
        ? [undefined]
        : yield* db
            .select({
              mappingStatus: schema.providerAssetMappings.mappingStatus,
              mappingKind: schema.providerAssetMappings.mappingKind,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
            .limit(1)

    return {
      providerAsset,
      mapping: mapping ?? null,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const seedPendingProviderAssetMapping = ({
  currencyCode,
  providerAssetId,
  providerType,
}: {
  readonly currencyCode: string
  readonly providerAssetId: string
  readonly providerType: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-15T10:00:00.000Z")

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        providerAssetId,
        naturalKey: null,
        currencyCode,
        name: currencyCode,
        exponent: 8,
        providerType,
        rawProviderPayload: {
          code: currencyCode,
          type: providerType,
          asset_id: providerAssetId,
        },
        discoveredAt: now,
        retrievedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: schema.providerAssets.id,
      })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to seed provider asset fixture")
    }

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "pending_review",
      reviewerNotes: "Fixture pending provider asset review",
      sourceNotes: "Fixture pending provider asset review",
      createdAt: now,
      updatedAt: now,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const seedCanonicalAsset = ({ symbol }: { readonly symbol: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [asset] = yield* db
      .insert(schema.assets)
      .values({
        name: `${symbol} Test Asset`,
        symbol,
        type: "fungible",
      })
      .returning({ id: schema.assets.id })

    if (asset === undefined) {
      return yield* Effect.die(`Failed to seed ${symbol} canonical asset fixture`)
    }

    return asset.id
  }).pipe(Effect.provide(TestPgClientLive))

const approveProviderAssetMappingToCanonicalAsset = ({
  currencyCode,
  canonicalAssetId,
  assetRepresentationId,
}: {
  readonly currencyCode: string
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-16T10:00:00.000Z")
    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die(
        `Missing ${currencyCode} provider asset fixture for mapping approval`
      )
    }

    yield* db
      .update(schema.providerAssetMappings)
      .set({
        mappingKind: "asset",
        canonicalAssetId,
        assetRepresentationId,
        canonicalFiatCurrency: null,
        mappingStatus: "approved",
        reviewerNotes: "Approved after provider asset repair",
        sourceNotes: "Approved after provider asset repair",
        updatedAt: now,
      })
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
  }).pipe(Effect.provide(TestPgClientLive))

const excludeProviderAssetMapping = ({ currencyCode }: { readonly currencyCode: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die(`Missing ${currencyCode} provider asset fixture for exclusion`)
    }

    yield* db
      .update(schema.providerAssetMappings)
      .set({
        mappingStatus: "excluded",
        canonicalAssetId: null,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
        reviewerNotes: "Excluded by administrator",
        sourceNotes: "Settled exclusion fixture",
      })
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(recreateTestDatabase())

describe("coinbase normalization persistence", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      activeSyncRecords = defaultSyncRecords
      activeFiatCurrencies = defaultFiatCurrencies
      activeCryptoCurrencies = defaultCryptoCurrencies
      remoteReferenceCatalogAvailable = true
      yield* recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it("persists normalized Coinbase artifacts idempotently across reruns", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const firstRun = yield* fetchCounts()

        expect(firstRun.rawRows).toHaveLength(5)
        expect(firstRun.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(firstRun.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(firstRun.transactionCount).toBe(4)
        expect(firstRun.transactions.map((row) => row.transactionType).sort()).toEqual([
          "buy_fiat",
          "internal_transfer",
          "sell_fiat",
          "staking_reward",
        ])
        expect(firstRun.venueContextCount).toBe(4)
        expect(firstRun.transfers.map((row) => row.externalId).sort()).toEqual([
          "tx-send-1:network_fee",
        ])
        expect(firstRun.legs).toHaveLength(4)
        expect(firstRun.fifoLots).toHaveLength(2)
        expect(firstRun.disposalMatches).toHaveLength(1)
        expect(firstRun.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "internal_transfer",
            currentTypeKey: "internal_transfer",
          }),
        ])
        expect(firstRun.transactionTypeCatalogCount).toBeGreaterThanOrEqual(29)
        expect(firstRun.providerAssetCatalogCount).toBeGreaterThanOrEqual(3)

        yield* runSync()
        const secondRun = yield* fetchCounts()

        expect(secondRun.transactionCount).toBe(firstRun.transactionCount)
        expect(secondRun.venueContextCount).toBe(firstRun.venueContextCount)
        expect(secondRun.transactionReviews).toHaveLength(firstRun.transactionReviews.length)
        expect(secondRun.transfers).toHaveLength(firstRun.transfers.length)
        expect(secondRun.legs).toHaveLength(firstRun.legs.length)
        expect(secondRun.fifoLots).toHaveLength(firstRun.fifoLots.length)
        expect(secondRun.disposalMatches).toHaveLength(firstRun.disposalMatches.length)
      })
    )
  })

  it("does not mark approved fiat primary currency mappings as unresolved assets", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-fiat-deposit-1",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-fiat-deposit-1",
          type: "fiat_deposit",
          status: "completed",
          amount: { amount: "1000.00", currency: "EUR" },
          native_amount: { amount: "1000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-fiat-deposit-1",
          description: "Fiat deposit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()

        expect(state.rawRows).toHaveLength(2)
        expect(state.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(state.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-fiat-deposit-1",
            transactionType: "internal_transfer",
          }),
        ])
        expect(state.transactionReviews).toHaveLength(0)
        expect(state.legs).toHaveLength(0)
      })
    )
  })

  it("rejects an outbound network fee above the wallet debit without persisting effects", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-fee-above-debit",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-fee-above-debit",
          type: "send",
          status: "completed",
          amount: { amount: "-0.10000000", currency: "BTC" },
          native_amount: { amount: "-1500.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-fee-above-debit",
          network: {
            status: "confirmed",
            hash: "tx-fee-above-debit-hash",
            network_name: "base",
            transaction_fee: { amount: "0.10000001", currency: "BTC" },
          },
          to: {
            address: "bc1qfeeabovedebit",
            resource: "address",
          },
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()
        const failedRawRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-fee-above-debit"
        )

        expect(failedRawRow?.normalizedAt).toBeNull()
        expect(failedRawRow?.normalizationError).toContain(
          "Network fee 0.10000001 BTC exceeds the debited amount -0.10000000 BTC"
        )
        expect(state.transactions).toHaveLength(0)
        expect(state.transfers).toHaveLength(0)
        expect(state.legs).toHaveLength(0)
        expect(state.fifoLots).toHaveLength(0)
        expect(state.disposalMatches).toHaveLength(0)
        expect(state.inventoryMovements).toHaveLength(0)
        expect(state.inventoryMovementAllocations).toHaveLength(0)
      })
    )
  })

  it("applies matched Coinbase withdrawal FIFO effects through sync and replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedMatchedOnchainReceipt({
          walletAddress: "bc1qexampledestination",
          txHash: "tx-send-hash-1",
          amount: "0.09990000",
        })

        yield* runSync()
        const firstRun = yield* fetchCanonicalizationState()

        expect(firstRun.reconciliations).toEqual([
          expect.objectContaining({
            status: "auto_applied",
            matchReason: "deterministic_wallet_receipt_match",
            deterministic: true,
            canonicalTransferId: expect.any(String),
            canonicalTransactionId: expect.any(String),
          }),
        ])

        expect(
          firstRun.reviews.some(
            (review) => review.matchedLayer?.includes("transfer_reconciliation") === true
          )
        ).toBe(true)
        expect(firstRun.legs.some((leg) => leg.derivationRule === "internal_transfer_out")).toBe(
          true
        )
        expect(firstRun.legs.some((leg) => leg.derivationRule === "internal_transfer_in")).toBe(
          true
        )
        expect(firstRun.fifoLots.some((lot) => lot.sourceId === ownedOnchainSourceId)).toBe(true)

        const taxAfterSync = yield* calculateTax()
        expect(taxAfterSync.taxableGains).toBe(2000)
        expect(taxAfterSync.incomeTotal).toBe(700)

        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const secondRun = yield* fetchCanonicalizationState()
        expect(secondRun.reconciliations).toHaveLength(firstRun.reconciliations.length)
        expect(secondRun.reviews).toHaveLength(firstRun.reviews.length)
        expect(secondRun.legs).toHaveLength(firstRun.legs.length)
        expect(secondRun.fifoLots).toHaveLength(firstRun.fifoLots.length)

        const taxAfterReplay = yield* calculateTax()
        expect(taxAfterReplay.taxableGains).toBe(2000)
        expect(taxAfterReplay.incomeTotal).toBe(700)
      })
    )
  }, 15_000)

  it("repairs an already matched transfer after one backdated settlement sync", async () => {
    const makeBackdatedInflow = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-before-matched-transfer",
        occurredAt: new Date("2024-12-31T10:00:00.000Z"),
        payload: {
          id: "tx-before-matched-transfer",
          type: "tx",
          status,
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: "5000.00", currency: "EUR" },
          created_at: "2024-12-31T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-before-matched-transfer",
        },
      })
    activeSyncRecords = [...defaultSyncRecords, makeBackdatedInflow("pending")]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedMatchedOnchainReceipt({
          walletAddress: "bc1qexampledestination",
          txHash: "tx-send-hash-1",
          amount: "0.09990000",
        })
        yield* runSync()
        yield* runSync()

        const beforeSettlement = yield* fetchCanonicalizationState()
        expect(beforeSettlement.reconciliations).toEqual([
          expect.objectContaining({ status: "auto_applied" }),
        ])
        const taxBeforeSettlement = yield* calculateTax()
        expect(taxBeforeSettlement.taxableGains).toBe(2000)
        const positionsBeforeSettlement = yield* fetchPortfolioPositions()
        const btcBeforeSettlement = positionsBeforeSettlement.find(
          (position) => position.assetId === BTC_ASSET_ID
        )
        expectDecimalAmount(String(btcBeforeSettlement?.amount), "0.5")

        activeSyncRecords = [...defaultSyncRecords, makeBackdatedInflow("completed")]
        const db = yield* drizzle
        yield* db.execute(sql`create sequence fail_test_provider_settlement_calls`)
        yield* db.execute(sql`
          create function fail_test_provider_settlement() returns trigger
          language plpgsql as $$
          begin
            if old.provider_status = 'pending' and new.provider_status = 'completed' then
              perform nextval('fail_test_provider_settlement_calls');
              raise exception 'forced provider settlement persistence failure';
            end if;
            return new;
          end;
          $$
        `)
        yield* db.execute(sql`
          create trigger fail_test_provider_settlement
          before update of provider_status on transactions
          for each row execute function fail_test_provider_settlement()
        `)
        const failedSummary = yield* runSync()
        const failedJob = yield* fetchJobDetails({ jobId: failedSummary.jobId })
        const [triggerCall] = yield* db
          .select({
            isCalled: sql<boolean>`is_called`,
            lastValue: sql<string>`last_value::text`,
          })
          .from(sql`fail_test_provider_settlement_calls`)
        yield* db.execute(sql`drop trigger fail_test_provider_settlement on transactions`)
        yield* db.execute(sql`drop function fail_test_provider_settlement()`)
        yield* db.execute(sql`drop sequence fail_test_provider_settlement_calls`)

        expect(failedJob.status).toBe("failed")
        expect(failedJob.message).toContain("sourceNormalizationRepository.upsertTransaction")
        expect(triggerCall).toEqual({ isCalled: true, lastValue: "1" })

        const failedState = yield* fetchCounts()
        const failedTransaction = failedState.transactions.find(
          (transaction) => transaction.externalId === "tx-before-matched-transfer"
        )
        expect(failedTransaction?.providerStatus).toBe("pending")
        expect(
          failedState.rawRows.find((row) => row.externalRecordId === "tx-before-matched-transfer")
            ?.normalizedAt
        ).toBeNull()
        expect(yield* fetchCanonicalizationState()).toEqual(beforeSettlement)
        const taxAfterFailure = yield* calculateTax()
        expect(taxAfterFailure.taxableGains).toBe(2000)
        const positionsAfterFailure = yield* fetchPortfolioPositions()
        const btcAfterFailure = positionsAfterFailure.find(
          (position) => position.assetId === BTC_ASSET_ID
        )
        expectDecimalAmount(String(btcAfterFailure?.amount), "0.5")

        yield* runSync()

        const repaired = yield* fetchCanonicalizationState()
        const backdatedLeg = repaired.legs.find(
          (leg) => leg.externalId === "tx-before-matched-transfer:main"
        )
        const originTransferLeg = repaired.legs.find(
          (leg) => leg.derivationRule === "internal_transfer_out"
        )
        const destinationTransferLeg = repaired.legs.find(
          (leg) => leg.derivationRule === "internal_transfer_in"
        )
        const originMatch = repaired.disposalMatches.find(
          (match) => match.disposalLegId === originTransferLeg?.id
        )
        const originLot = repaired.fifoLots.find((lot) => lot.id === originMatch?.fifoLotId)
        const destinationLot = repaired.fifoLots.find(
          (lot) => lot.sourceLegId === destinationTransferLeg?.id
        )

        expect(repaired.reconciliations).toEqual([
          expect.objectContaining({ status: "auto_applied" }),
        ])
        expect(originLot?.sourceLegId).toBe(backdatedLeg?.id)
        expectDecimalAmount(String(originMatch?.matchedAmount), "0.0999")
        expect(destinationLot?.sourceId).toBe(ownedOnchainSourceId)
        expectDecimalAmount(String(destinationLot?.originalAmount), "0.0999")
        expectDecimalAmount(String(destinationLot?.remainingAmount), "0.0999")
        expectDecimalAmount(String(destinationLot?.costBasisPerToken), "5000")
        const taxAfterRetry = yield* calculateTax()
        expect(taxAfterRetry.taxableGains).toBe(4000)
        const positionsAfterRetry = yield* fetchPortfolioPositions()
        const btcAfterRetry = positionsAfterRetry.find(
          (position) => position.assetId === BTC_ASSET_ID
        )
        expectDecimalAmount(String(btcAfterRetry?.amount), "1.5")
      }).pipe(Effect.provide(TestPgClientLive))
    )
  }, 15_000)

  it("rolls back a matched Coinbase receive without origin inventory", async () => {
    activeSyncRecords = makeReceiveSyncRecords({
      walletAddress: "bc1qexamplesource",
      txHash: "tx-receive-hash-1",
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedMatchedOnchainSend({
          walletAddress: "bc1qexamplesource",
          txHash: "tx-receive-hash-1",
          amount: "0.10000000",
        })

        yield* runSync()
        const state = yield* fetchCanonicalizationState()

        expect(state.reconciliations).toEqual([
          expect.objectContaining({
            status: "needs_review",
            matchReason: "insufficient_fifo_inventory",
            deterministic: false,
            canonicalTransferId: expect.any(String),
            canonicalTransactionId: expect.any(String),
          }),
        ])

        expect(
          state.reviews.some(
            (review) => review.matchedLayer?.includes("transfer_reconciliation") === true
          )
        ).toBe(false)
        expect(state.legs.some((leg) => leg.derivationRule === "internal_transfer_out")).toBe(false)
        expect(state.legs.some((leg) => leg.derivationRule === "internal_transfer_in")).toBe(false)
        expect(state.fifoLots.some((lot) => lot.sourceId === ownedOnchainSourceId)).toBe(false)

        const taxAfterSync = yield* calculateTax()
        expect(taxAfterSync.taxableGains).toBe(2000)
        expect(taxAfterSync.incomeTotal).toBe(700)
      })
    )
  })

  it("treats a positive-amount Coinbase send as a deposit that adds inventory", async () => {
    activeSyncRecords = [
      ...defaultSyncRecords,
      makeCoinbaseRecord({
        externalRecordId: "tx-deposit-send-1",
        occurredAt: new Date("2025-05-01T10:00:00.000Z"),
        payload: {
          id: "tx-deposit-send-1",
          type: "send",
          status: "completed",
          amount: { amount: "87.9500000000", currency: "DOT" },
          native_amount: { amount: "300.00", currency: "EUR" },
          created_at: "2025-05-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-deposit-send-1",
          description: "Staked DOT moved into Coinbase",
          network: {
            status: "confirmed",
            hash: "tx-deposit-send-hash-1",
            network_name: "polkadot",
          },
          from: {
            address: "1exampledotorigin",
            resource: "address",
          },
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()

        const state = yield* fetchProviderTransferInventoryState()

        const depositTransfer = state.providerTransferRows.find(
          (row) => row.externalId === "tx-deposit-send-1:principal"
        )
        expect(depositTransfer).toBeDefined()
        expect(depositTransfer?.direction).toBe("inbound")
        expectDecimalAmount(String(depositTransfer?.amount), "87.95")

        const withdrawalTransfer = state.providerTransferRows.find(
          (row) => row.externalId === "tx-send-1:principal"
        )
        expect(withdrawalTransfer?.direction).toBe("outbound")

        const depositLot = state.providerLots.find(
          (lot) => lot.sourceProviderTransferId === depositTransfer?.id
        )
        expect(depositLot).toBeDefined()
        expect(depositLot?.assetId).toBe(DOT_ASSET_ID)
        expect(depositLot?.costBasisStatus).toBe("pending_review")
        expectDecimalAmount(String(depositLot?.originalAmount), "87.95")
        expectDecimalAmount(String(depositLot?.remainingAmount), "87.95")

        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const replayedState = yield* fetchProviderTransferInventoryState()
        const replayedDepositTransfer = replayedState.providerTransferRows.find(
          (row) => row.externalId === "tx-deposit-send-1:principal"
        )
        expect(replayedDepositTransfer?.direction).toBe("inbound")
        const replayedDepositLot = replayedState.providerLots.find(
          (lot) => lot.sourceProviderTransferId === replayedDepositTransfer?.id
        )
        expectDecimalAmount(String(replayedDepositLot?.remainingAmount), "87.95")

        const positions = yield* fetchPortfolioPositions()
        const dotPosition = positions.find((position) => position.assetId === DOT_ASSET_ID)
        expect(dotPosition).toBeDefined()
        expectDecimalAmount(String(dotPosition?.amount), "87.970123619236")
        expect(dotPosition?.costBasisStatus).toBe("pending_review")
      })
    )
  })

  it("normalizes an unknown Coinbase provider asset into a reviewable partial transaction instead of failing", async () => {
    activeSyncRecords = makeHypeReviewableSyncRecords()
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    await Effect.runPromise(
      Effect.gen(function* () {
        const summary = yield* runSync()
        const job = yield* fetchJobDetails({ jobId: summary.jobId })
        const counts = yield* fetchCounts()
        const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })

        expect(job.status).toBe("completed")
        expect(job.normalizedRecords).toBe(2)
        expect(job.failedRecords).toBe(0)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")?.normalizedAt
        ).not.toBeNull()
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")?.normalizationError
        ).toBeNull()
        expect(counts.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-hype-buy-1",
            transactionType: "buy_fiat",
          }),
        ])
        expect(counts.venueContextCount).toBe(1)
        expect(counts.legs).toHaveLength(0)
        expect(counts.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            matchedLayer: "provider_asset_mapping",
            needsReview: true,
            originalTypeKey: "buy_fiat",
            currentTypeKey: "buy_fiat",
            categorizationReason: expect.stringContaining("provider_asset_mapping"),
          }),
        ])
        expect(providerAssetState.providerAsset).toMatchObject({
          providerAssetId: "hype-provider-asset",
          currencyCode: "HYPE",
        })
        expect(providerAssetState.mapping).toMatchObject({
          mappingStatus: "pending_review",
          mappingKind: "asset",
          canonicalAssetId: null,
        })
      })
    )
  })

  it("keeps a pending provider asset mapping on the reviewable normalization path", async () => {
    activeSyncRecords = makeHypeReviewableSyncRecords()
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })

        const summary = yield* runSync()
        const job = yield* fetchJobDetails({ jobId: summary.jobId })
        const counts = yield* fetchCounts()
        const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })

        expect(job.status).toBe("completed")
        expect(job.normalizedRecords).toBe(2)
        expect(job.failedRecords).toBe(0)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")?.normalizationError
        ).toBeNull()
        expect(counts.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-hype-buy-1",
            transactionType: "buy_fiat",
          }),
        ])
        expect(counts.legs).toHaveLength(0)
        expect(counts.transactionReviews).toEqual([
          expect.objectContaining({
            matchedLayer: "provider_asset_mapping",
            reviewStatus: "needs_review",
          }),
        ])
        expect(providerAssetState.mapping).toMatchObject({
          mappingStatus: "pending_review",
          mappingKind: "asset",
        })
      })
    )
  })

  it("omits an excluded primary leg while preserving approved fee accounting", async () => {
    activeSyncRecords = makeHypeWithBtcFeeSyncRecords()
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })
        yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })

        const jobsBefore = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))
        yield* runSync()
        const counts = yield* fetchCounts()
        const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })
        const resolutionJobsAfter = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))

        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-with-btc-fee")
            ?.normalizationError
        ).toBeNull()
        expect(counts.transactions).toEqual([
          expect.objectContaining({ externalId: "tx-hype-buy-with-btc-fee" }),
        ])
        expect(counts.legs).toEqual([
          expect.objectContaining({
            kind: "fee",
            derivationRule: "coinbase_network_fee",
          }),
        ])
        expect(
          counts.transactionReviews.some(
            (review) => review.matchedLayer?.includes("provider_asset_mapping") === true
          )
        ).toBe(false)
        expect(providerAssetState.mapping).toMatchObject({ mappingStatus: "excluded" })
        expect(resolutionJobsAfter).toHaveLength(jobsBefore.length)

        const btcUsage = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [btcProviderAsset] = yield* db
            .select({
              id: schema.providerAssets.id,
              evidenceRevision: schema.providerAssets.evidenceRevision,
            })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "BTC")
              )
            )
            .limit(1)
          if (btcProviderAsset === undefined) {
            return yield* Effect.die("Missing BTC provider asset after fee normalization")
          }

          const uses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, btcProviderAsset.id))

          return { btcProviderAsset, uses }
        }).pipe(Effect.provide(TestPgClientLive))

        expect(btcUsage.uses).toEqual([{ sourceId }])

        const exclusionFixture = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [decision] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: btcUsage.btcProviderAsset.id,
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              policyRevision: "test:approved-fee",
              outcome: "attach",
              status: "active",
              assetId: BTC_ASSET_ID,
              assetRepresentationId: null,
              actor: "policy:test:approved-fee",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (decision === undefined) {
            return yield* Effect.die("Failed to seed BTC fee decision")
          }
          const [evidence] = yield* db
            .insert(schema.assetResolutionEvidence)
            .values({
              decisionId: decision.id,
              authority: "provider",
              claimKind: "metadata",
              sourceLocator: "coinbase:currency:BTC",
              retrievedAt: new Date("2025-05-01T10:00:00.000Z"),
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              decodedClaim: { currencyCode: "BTC" },
              rawPayload: { currencyCode: "BTC" },
            })
            .returning({ id: schema.assetResolutionEvidence.id })
          if (evidence === undefined) {
            return yield* Effect.die("Failed to seed BTC fee evidence")
          }
          return { decisionId: decision.id, evidenceId: evidence.id }
        }).pipe(Effect.provide(TestPgClientLive))

        const submitted = yield* Effect.gen(function* () {
          const assetExceptionRepository = yield* AssetExceptionRepository
          return yield* assetExceptionRepository.submitDecision({
            actorId: userId,
            input: {
              providerAssetRowId: btcUsage.btcProviderAsset.id,
              claim: { _tag: "exclusion", reason: "confirmed_spam" },
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              activeDecisionRevision: exclusionFixture.decisionId,
              evidenceSnapshotIds: [exclusionFixture.evidenceId],
              rationale: "The approved fee observation was later confirmed as excluded.",
              expectedResultingAssetId: null,
              expectedAssetOutcome: "none",
              expectedRepresentationOutcome: "none",
            },
          })
        }).pipe(
          Effect.provide(AssetExceptionRepositoryLive.pipe(Layer.provideMerge(TestPgClientLive)))
        )
        expect(submitted._tag).toBe("accepted")

        const rematerializations = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              sourceId: schema.assetDecisionRematerializations.sourceId,
              processingJobId: schema.assetDecisionRematerializations.processingJobId,
            })
            .from(schema.assetDecisionRematerializations)
        }).pipe(Effect.provide(TestPgClientLive))
        expect(rematerializations).toEqual([{ sourceId, processingJobId: expect.any(String) }])
      })
    )
  })

  it("does not create mapping review work for an excluded secondary currency", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-btc-with-excluded-fee",
        occurredAt: new Date("2025-05-01T10:00:00.000Z"),
        payload: {
          id: "tx-btc-with-excluded-fee",
          type: "buy",
          status: "completed",
          amount: { amount: "0.01000000", currency: "BTC" },
          native_amount: { amount: "500.00", currency: "EUR" },
          network: {
            status: "confirmed",
            network_name: "base",
            transaction_fee: { amount: "0.10000000", currency: "HYPE" },
          },
          created_at: "2025-05-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-btc-with-excluded-fee",
        },
      }),
    ]
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })
        yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })

        const jobsBefore = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))
        yield* runSync()
        const counts = yield* fetchCounts()
        const jobsAfter = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))

        expect(
          counts.transactionReviews.some(
            (review) => review.matchedLayer?.includes("provider_asset_mapping") === true
          )
        ).toBe(false)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-btc-with-excluded-fee")
            ?.normalizationError
        ).toBeNull()
        expect(counts.legs.length).toBeGreaterThan(0)
        expect(jobsAfter).toHaveLength(jobsBefore.length)
      })
    )
  })

  it("returns source uses without persisting them before normalized artifacts", async () => {
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    const hypeRecord = makeHypeReviewableSyncRecords().find(
      (record) => record.recordType === "coinbase_transaction"
    )
    if (hypeRecord === undefined) {
      expect.fail("Missing HYPE transaction fixture")
    }

    const source: SourceSyncSource = {
      id: sourceId,
      principalId,
      providerKey: "coinbase",
      cexAccountId: null,
      addressId: null,
      walletAddress: null,
    }
    const sourceRecord: SourceRawRecord = {
      id: "00000000-0000-4000-8000-000000000209",
      sourceId,
      provider: "coinbase",
      recordType: hypeRecord.recordType,
      externalAccountId: hypeRecord.externalAccountId,
      externalRecordId: hypeRecord.externalRecordId,
      externalParentId: hypeRecord.externalParentId,
      occurredAt: hypeRecord.occurredAt,
      payload: hypeRecord.payload,
      importedAt: new Date("2025-05-01T10:01:00.000Z"),
      normalizedAt: null,
      normalizationError: null,
      createdAt: new Date("2025-05-01T10:01:00.000Z"),
      updatedAt: new Date("2025-05-01T10:01:00.000Z"),
    }

    const fixture = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* CoinbaseSourceSyncProvider
        yield* provider.refreshReferenceData()
        const lookups = yield* provider.loadNormalizationLookups()
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .select({ id: schema.providerAssets.id, retrievedAt: schema.providerAssets.retrievedAt })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, "coinbase"),
              eq(schema.providerAssets.currencyCode, "HYPE")
            )
          )
          .limit(1)
        if (providerAsset === undefined) {
          return yield* Effect.die("Missing HYPE provider asset fixture")
        }

        return {
          lookups,
          providerAssetRowId: providerAsset.id,
        }
      }).pipe(Effect.provide(TestLayer))
    )

    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* CoinbaseSourceSyncProvider
        return yield* provider.prepareNormalization({
          source,
          sourceRecord,
          lookups: fixture.lookups,
        })
      }).pipe(Effect.provide(TestLayer))
    )

    const state = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const sourceUses = yield* db
          .select({ sourceId: schema.providerAssetSourceUses.sourceId })
          .from(schema.providerAssetSourceUses)
          .where(eq(schema.providerAssetSourceUses.providerAssetRowId, fixture.providerAssetRowId))
        const jobs = yield* db
          .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, sourceId))
        return { jobs, sourceUses }
      })
    )

    expect(prepared.legDerivationStrategy).toBe("skip")
    expect(prepared.providerAssetRowIds).toContain(fixture.providerAssetRowId)
    expect(prepared.transactionReview).toMatchObject({
      matchedLayer: "provider_asset_mapping",
      reviewStatus: "needs_review",
    })
    expect(state.sourceUses).toEqual([])
    expect(state.jobs).toEqual([])
  }, 15_000)

  it("replays reviewable raw rows after approving an economic asset mapping", async () => {
    activeSyncRecords = makeHypeReviewableSyncRecords()
    activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })

        const reviewableSummary = yield* runSync()
        const reviewableJob = yield* fetchJobDetails({ jobId: reviewableSummary.jobId })
        const reviewableCounts = yield* fetchCounts()

        expect(reviewableJob.status).toBe("completed")
        expect(reviewableJob.normalizedRecords).toBe(2)
        expect(reviewableJob.failedRecords).toBe(0)
        expect(
          reviewableCounts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")
            ?.normalizedAt
        ).not.toBeNull()
        expect(
          reviewableCounts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")
            ?.normalizationError
        ).toBeNull()
        expect(reviewableCounts.transactions).toHaveLength(1)
        expect(reviewableCounts.legs).toHaveLength(0)
        const providerAssetUses = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .innerJoin(
              schema.providerAssets,
              eq(schema.providerAssets.id, schema.providerAssetSourceUses.providerAssetRowId)
            )
            .where(eq(schema.providerAssets.currencyCode, "HYPE"))
        }).pipe(Effect.provide(TestPgClientLive))
        expect(providerAssetUses).toEqual([{ sourceId }])

        const hypeAssetId = yield* seedCanonicalAsset({
          symbol: "HYPE",
        })
        yield* approveProviderAssetMappingToCanonicalAsset({
          currencyCode: "HYPE",
          canonicalAssetId: hypeAssetId,
          assetRepresentationId: null,
        })

        activeSyncRecords = []
        const repairedJob = yield* replaySource()
        const repairedCounts = yield* fetchCounts()
        const repairedRawRow = repairedCounts.rawRows.find(
          (row) => row.externalRecordId === "tx-hype-buy-1"
        )

        expect(repairedJob.status).toBe("completed")
        expect(repairedJob.normalizedRecords).toBe(2)
        expect(repairedJob.failedRecords).toBe(0)
        expect(repairedRawRow?.normalizedAt).not.toBeNull()
        expect(repairedRawRow?.normalizationError).toBeNull()
        expect(repairedCounts.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-hype-buy-1",
            transactionType: "buy_fiat",
          }),
        ])
        expect(repairedCounts.legs).toEqual([
          expect.objectContaining({
            kind: "acquisition",
            derivationRule: "coinbase_buy",
          }),
        ])
        expect(repairedCounts.fifoLots).toHaveLength(1)
        expect(repairedCounts.disposalMatches).toHaveLength(0)

        const replay = yield* replaySource()
        const replayedCounts = yield* fetchCounts()

        expect(replay.status).toBe("completed")
        expect(replayedCounts.transactions).toHaveLength(repairedCounts.transactions.length)
        expect(replayedCounts.transfers).toHaveLength(repairedCounts.transfers.length)
        expect(replayedCounts.legs).toHaveLength(repairedCounts.legs.length)
        expect(replayedCounts.fifoLots).toHaveLength(repairedCounts.fifoLots.length)
        expect(replayedCounts.disposalMatches).toHaveLength(repairedCounts.disposalMatches.length)
      })
    )
  })

  it("still fails malformed Coinbase payloads normally", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-malformed-1",
        occurredAt: new Date("2025-05-02T10:00:00.000Z"),
        payload: {
          id: "tx-malformed-1",
          type: "buy",
          status: "completed",
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: "1000.00", currency: "EUR" },
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-malformed-1",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        const summary = yield* runSync()
        const job = yield* fetchJobDetails({ jobId: summary.jobId })
        const counts = yield* fetchCounts()

        expect(job.status).toBe("completed")
        expect(job.normalizedRecords).toBe(1)
        expect(job.failedRecords).toBe(1)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-malformed-1")?.normalizedAt
        ).toBeNull()
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-malformed-1")
            ?.normalizationError
        ).toContain("Failed to decode Coinbase transaction payload")
        expect(counts.transactions).toHaveLength(0)
        expect(counts.transactionReviews).toHaveLength(0)
      })
    )
  })

  it("derives FIFO matches and tax-visible income/disposal amounts from fixture data", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()

        const counts = yield* fetchCounts()
        expect(counts.legs.map((row) => row.kind).sort()).toEqual([
          "acquisition",
          "disposal",
          "fee",
          "income",
        ])
        const remainingAmounts = counts.fifoLots.map((row) => String(row.remainingAmount)).sort()
        expect(remainingAmounts).toHaveLength(2)
        const [firstRemainingAmount, secondRemainingAmount] = remainingAmounts
        if (firstRemainingAmount !== undefined && secondRemainingAmount !== undefined) {
          expectDecimalAmount(firstRemainingAmount, "0.020123619236")
          expectDecimalAmount(secondRemainingAmount, "0.5")
        }
        expect(counts.disposalMatches.map((row) => String(row.gainLoss)).sort()).toEqual([
          "2000.00000000",
        ])
        expect(counts.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "internal_transfer",
            currentTypeKey: "internal_transfer",
          }),
        ])

        const tax = yield* calculateTax()
        expect(tax.currency).toBe("EUR")
        expect(tax.taxableGains).toBe(2000)
        expect(tax.taxableLosses).toBe(0)
        expect(tax.taxFreeGains).toBe(0)
        expect(tax.incomeTotal).toBe(700)
      })
    )
  })

  it("creates inventory from a positive Coinbase tx record so a full-balance sale allocates completely", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-buy-1",
        occurredAt: new Date("2025-01-01T10:00:00.000Z"),
        payload: {
          id: "tx-buy-1",
          type: "buy",
          status: "completed",
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: "10000.00", currency: "EUR" },
          created_at: "2025-01-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-buy-1",
          description: "Seed buy",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-uncategorized-inflow-1",
        occurredAt: new Date("2025-01-05T10:00:00.000Z"),
        payload: {
          id: "tx-uncategorized-inflow-1",
          type: "tx",
          status: "completed",
          amount: { amount: "0.49360000", currency: "BTC" },
          native_amount: { amount: "4936.00", currency: "EUR" },
          created_at: "2025-01-05T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-uncategorized-inflow-1",
          description: "Uncategorized credit",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-full-balance-sell-1",
        occurredAt: new Date("2025-02-01T10:00:00.000Z"),
        payload: {
          id: "tx-full-balance-sell-1",
          type: "sell",
          status: "completed",
          amount: { amount: "-1.41000000", currency: "BTC" },
          native_amount: { amount: "-21150.00", currency: "EUR" },
          created_at: "2025-02-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-full-balance-sell-1",
          description: "Full balance sell",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const firstRun = yield* fetchCounts()

        expect(firstRun.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(firstRun.legs.map((row) => `${row.kind}:${row.derivationRule}`).sort()).toEqual([
          "acquisition:coinbase_buy",
          "acquisition:coinbase_tx_inflow",
          "disposal:coinbase_sell",
        ])

        const remainingAmounts = firstRun.fifoLots
          .map((row) => String(row.remainingAmount))
          .sort((left, right) => left.localeCompare(right))
        expect(remainingAmounts).toHaveLength(2)
        const [emptyLot, remainingLot] = remainingAmounts
        if (emptyLot !== undefined && remainingLot !== undefined) {
          expectDecimalAmount(emptyLot, "0")
          expectDecimalAmount(remainingLot, "0.0836")
        }

        const matchedAmounts = firstRun.disposalMatches
          .map((row) => String(row.matchedAmount))
          .sort()
        expect(matchedAmounts).toHaveLength(2)
        const [firstMatched, secondMatched] = matchedAmounts
        if (firstMatched !== undefined && secondMatched !== undefined) {
          expectDecimalAmount(firstMatched, "0.41")
          expectDecimalAmount(secondMatched, "1")
        }

        expect(firstRun.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "uncategorized",
            currentTypeKey: "uncategorized",
            matchedLayer: "coinbase_reference_mapping",
          }),
        ])

        // Lot 1: proceeds 15000 - cost 10000; lot 2: proceeds 6150 - cost 4100.
        const taxAfterSync = yield* calculateTax()
        expect(taxAfterSync.taxableGains).toBe(7050)

        // Simulate a source last synced while tx still mapped to no_leg: the
        // replay must refresh the stored mapping before re-deriving legs.
        yield* revertTxMappingToNoLeg()
        remoteReferenceCatalogAvailable = false
        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const secondRun = yield* fetchCounts()
        expect(secondRun.legs).toHaveLength(firstRun.legs.length)
        expect(secondRun.fifoLots).toHaveLength(firstRun.fifoLots.length)
        expect(secondRun.disposalMatches).toHaveLength(firstRun.disposalMatches.length)

        const taxAfterReplay = yield* calculateTax()
        expect(taxAfterReplay.taxableGains).toBe(7050)

        const portfolioPositions = yield* fetchPortfolioPositions()
        const btcPosition = portfolioPositions.find((position) => position.assetId === BTC_ASSET_ID)
        expect(btcPosition).toBeDefined()
        expectDecimalAmount(String(btcPosition?.amount), "0.0836")
      })
    )
  })

  it("deducts inventory from a succeeded negative Coinbase tx as a reviewable disposal", async () => {
    activeSyncRecords = [
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
        externalRecordId: "tx-buy-1",
        occurredAt: new Date("2025-01-01T10:00:00.000Z"),
        payload: {
          id: "tx-buy-1",
          type: "buy",
          status: "completed",
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: "10000.00", currency: "EUR" },
          created_at: "2025-01-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-buy-1",
          description: "Seed buy",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-uncategorized-outflow-1",
        occurredAt: new Date("2025-02-01T10:00:00.000Z"),
        payload: {
          id: "tx-uncategorized-outflow-1",
          type: "tx",
          status: "succeeded",
          amount: { amount: "-0.40000000", currency: "BTC" },
          native_amount: { amount: "-4000.00", currency: "EUR" },
          created_at: "2025-02-01T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-uncategorized-outflow-1",
          description: "Uncategorized debit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()

        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(
          state.transactions.some(
            (row) =>
              row.externalId === "tx-uncategorized-outflow-1" && row.providerStatus === "succeeded"
          )
        ).toBe(true)
        expect(state.legs.map((row) => `${row.kind}:${row.derivationRule}`).sort()).toEqual([
          "acquisition:coinbase_buy",
          "disposal:coinbase_tx_outflow",
        ])

        const remainingAmounts = state.fifoLots.map((row) => String(row.remainingAmount))
        expect(remainingAmounts).toHaveLength(1)
        const [remainingAmount] = remainingAmounts
        if (remainingAmount !== undefined) {
          expectDecimalAmount(remainingAmount, "0.6")
        }

        expect(state.disposalMatches).toHaveLength(1)
        expect(state.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "uncategorized",
            currentTypeKey: "uncategorized",
            matchedLayer: "coinbase_reference_mapping",
          }),
        ])
      })
    )
  }, 15_000)

  it("persists zero, pending, and failed Coinbase tx rows for review without inventory legs", async () => {
    activeSyncRecords = [
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
      ...(["completed", "pending", "failed"] as const).map((status, index) =>
        makeCoinbaseRecord({
          externalRecordId: `tx-${status}-without-inventory`,
          occurredAt: new Date(`2025-01-0${index + 2}T10:00:00.000Z`),
          payload: {
            id: `tx-${status}-without-inventory`,
            type: "tx",
            status,
            amount: {
              amount: status === "completed" ? "0.00000000" : "0.40000000",
              currency: "BTC",
            },
            native_amount: {
              amount: status === "completed" ? "0.00" : "4000.00",
              currency: "EUR",
            },
            created_at: `2025-01-0${index + 2}T10:00:00.000Z`,
            resource_path: `/v2/accounts/coinbase-account-1/transactions/tx-${status}-without-inventory`,
            description: `Uncategorized ${status} row`,
          },
        })
      ),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()

        expect(state.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(
          state.transactions
            .map((row) => row.providerStatus)
            .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
        ).toEqual(["completed", "failed", "pending"])
        expect(state.transactionReviews).toHaveLength(3)
        expect(state.transactionReviews.every((row) => row.needsReview)).toBe(true)
        expect(state.legs).toHaveLength(0)
        expect(state.fifoLots).toHaveLength(0)
        expect(state.disposalMatches).toHaveLength(0)
      })
    )
  })

  it("rebuilds a later sale after one sync when an approved failed inflow settles", async () => {
    const makeStatusRecord = (status: "failed" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-inflow",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-backdated-inflow",
          type: "tx",
          status,
          amount: { amount: "0.40000000", currency: "BTC" },
          native_amount: { amount: "8000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-backdated-inflow",
          description: `Uncategorized ${status} credit`,
        },
      })
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const buyRecord = makeCoinbaseRecord({
      externalRecordId: "tx-before-backdated-inflow",
      occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      payload: {
        id: "tx-before-backdated-inflow",
        type: "buy",
        status: "completed",
        amount: { amount: "1.00000000", currency: "BTC" },
        native_amount: { amount: "10000.00", currency: "EUR" },
        created_at: "2025-01-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-before-backdated-inflow",
        description: "Opening acquisition",
      },
    })
    const saleRecord = makeCoinbaseRecord({
      externalRecordId: "tx-after-backdated-inflow",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-backdated-inflow",
        type: "sell",
        status: "completed",
        amount: { amount: "-1.20000000", currency: "BTC" },
        native_amount: { amount: "-18000.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-backdated-inflow",
        description: "Sale after pending inflow",
        network: {
          status: "confirmed",
          hash: "tx-after-backdated-inflow-hash",
          network_name: "base",
          transaction_fee: { amount: "0.00000000", currency: "BTC" },
        },
      },
    })
    activeSyncRecords = [accountRecord, buyRecord, makeStatusRecord("failed"), saleRecord]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        // Default asset approvals can enqueue one initial replay. Drain that
        // baseline work before changing the provider status so the next sync
        // is the single settlement repair being asserted below.
        yield* runSync()
        const failedState = yield* fetchCounts()
        const failedTransaction = failedState.transactions.find(
          (row) => row.externalId === "tx-backdated-inflow"
        )
        const saleTransaction = failedState.transactions.find(
          (row) => row.externalId === "tx-after-backdated-inflow"
        )
        expect(failedTransaction).toEqual(expect.objectContaining({ providerStatus: "failed" }))
        expect(failedState.disposalMatches).toHaveLength(0)
        expect(
          failedState.transactionReviews.find(
            (review) => review.transactionId === saleTransaction?.id
          )
        ).toEqual(
          expect.objectContaining({
            matchedLayer: expect.stringContaining("fifo_inventory"),
            needsReview: true,
          })
        )

        const reviewedAt = new Date("2025-01-04T12:00:00.000Z")
        yield* setTransactionReview({
          externalId: "tx-backdated-inflow",
          reviewStatus: "approved",
          originalTypeKey: "manual_original_inflow",
          originalConfidence: "0.17",
          currentTypeKey: "buy_fiat",
          legalRuleSetVersion: "manual-rules-inflow-v7",
          categorizationReason: "Manual inflow reason",
          matchedLayer: "manual_inflow_layer",
          userNotes: "Approved failed inflow",
          reviewedAt,
        })

        activeSyncRecords = [accountRecord, buyRecord, makeStatusRecord("completed"), saleRecord]
        yield* runSync()

        const completedState = yield* fetchCounts()
        const completedTx = completedState.transactions.find(
          (row) => row.externalId === "tx-backdated-inflow"
        )
        const completedSale = completedState.transactions.find(
          (row) => row.externalId === "tx-after-backdated-inflow"
        )
        const completedReview = completedState.transactionReviews.find(
          (review) => review.transactionId === completedTx?.id
        )
        expect(completedTx).toEqual(expect.objectContaining({ providerStatus: "completed" }))
        expect(completedReview).toEqual(
          expect.objectContaining({
            reviewStatus: "approved",
            originalTypeKey: "manual_original_inflow",
            originalConfidence: "0.17",
            currentTypeKey: "buy_fiat",
            legalRuleSetVersion: "manual-rules-inflow-v7",
            categorizationReason: "Manual inflow reason",
            matchedLayer: "manual_inflow_layer",
            needsReview: false,
            userNotes: "Approved failed inflow",
          })
        )
        expect(completedReview?.reviewedAt?.toISOString()).toBe(reviewedAt.toISOString())
        expect(
          completedState.transactionReviews.find(
            (review) => review.transactionId === completedSale?.id
          )
        ).toBeUndefined()

        const saleLeg = completedState.legs.find(
          (leg) => leg.externalId === "tx-after-backdated-inflow:main"
        )
        const zeroFeeLeg = completedState.legs.find(
          (leg) =>
            leg.transactionId === saleTransaction?.id &&
            leg.kind === "fee" &&
            leg.derivationRule === "coinbase_network_fee"
        )
        const openingLeg = completedState.legs.find(
          (leg) => leg.externalId === "tx-before-backdated-inflow:main"
        )
        const inflowLeg = completedState.legs.find(
          (leg) => leg.externalId === "tx-backdated-inflow:main"
        )
        const openingLot = completedState.fifoLots.find((lot) => lot.sourceLegId === openingLeg?.id)
        const inflowLot = completedState.fifoLots.find((lot) => lot.sourceLegId === inflowLeg?.id)
        const matches = completedState.disposalMatches
          .filter((match) => match.disposalLegId === saleLeg?.id)
          .map((match) => ({
            sourceLegId: completedState.fifoLots.find((lot) => lot.id === match.fifoLotId)
              ?.sourceLegId,
            matchedAmount: String(match.matchedAmount),
            gainLoss: String(match.gainLoss),
          }))
          .sort((left, right) => (left.sourceLegId ?? "").localeCompare(right.sourceLegId ?? ""))

        expect(matches).toHaveLength(2)
        expect(
          matches.map((match) => ({
            sourceLegId: match.sourceLegId,
            matchedAmount: Number(match.matchedAmount),
            gainLoss: Number(match.gainLoss),
          }))
        ).toEqual(
          expect.arrayContaining([
            { sourceLegId: openingLeg?.id, matchedAmount: 1, gainLoss: 5000 },
            { sourceLegId: inflowLeg?.id, matchedAmount: 0.2, gainLoss: -1000 },
          ])
        )
        expectDecimalAmount(String(openingLot?.remainingAmount), "0")
        expectDecimalAmount(String(inflowLot?.remainingAmount), "0.2")
        expectDecimalAmount(String(zeroFeeLeg?.amount), "0")
        expect(
          completedState.inventoryMovements.find(
            (movement) => movement.transactionLegId === zeroFeeLeg?.id
          )
        ).toBeUndefined()
        expect(
          completedState.transactionReviews.find(
            (review) => review.transactionId === saleTransaction?.id
          )
        ).toBeUndefined()

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(5000)
        expect(tax.taxableLosses).toBe(1000)
        const positions = yield* fetchPortfolioPositions()
        const btcPosition = positions.find((position) => position.assetId === BTC_ASSET_ID)
        expectDecimalAmount(String(btcPosition?.amount), "0.2")
      })
    )
  }, 15_000)

  it.each([
    {
      caseName: "the settlement raw ID sorts first",
      settlementRawId: "00000000-0000-4000-8000-000000000301",
      existingBuyRawId: "00000000-0000-4000-8000-000000000302",
      settlementSortsFirst: true,
    },
    {
      caseName: "the existing-buy raw ID sorts first",
      settlementRawId: "00000000-0000-4000-8000-000000000302",
      existingBuyRawId: "00000000-0000-4000-8000-000000000301",
      settlementSortsFirst: false,
    },
  ] as const)(
    "keeps equal-time FIFO order identical after settlement and full replay when $caseName",
    async ({ settlementRawId, existingBuyRawId, settlementSortsFirst }) => {
      const sharedTimestamp = "2025-01-02T10:00:00.000Z"
      const accountRecord = makeCoinbaseRecord({
        recordType: "coinbase_account",
        externalRecordId: "coinbase-account-1",
        occurredAt: new Date("2025-01-01T00:00:00.000Z"),
        payload: {
          id: "coinbase-account-1",
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
        },
      })
      const makeBackdatedInflow = (status: "pending" | "completed") =>
        makeCoinbaseRecord({
          externalRecordId: "tx-equal-time-settlement",
          occurredAt: new Date(sharedTimestamp),
          payload: {
            id: "tx-equal-time-settlement",
            type: "tx",
            status,
            amount: { amount: "1.00000000", currency: "BTC" },
            native_amount: { amount: "5000.00", currency: "EUR" },
            created_at: sharedTimestamp,
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-equal-time-settlement",
          },
        })
      const sameTimeBuy = makeCoinbaseRecord({
        externalRecordId: "tx-equal-time-existing-buy",
        occurredAt: new Date(sharedTimestamp),
        payload: {
          id: "tx-equal-time-existing-buy",
          type: "buy",
          status: "completed",
          amount: { amount: "0.50000000", currency: "BTC" },
          native_amount: { amount: "10000.00", currency: "EUR" },
          created_at: sharedTimestamp,
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-equal-time-existing-buy",
        },
      })
      const saleRecord = makeCoinbaseRecord({
        externalRecordId: "tx-after-equal-time-settlement",
        occurredAt: new Date(sharedTimestamp),
        payload: {
          id: "tx-after-equal-time-settlement",
          type: "sell",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "BTC" },
          native_amount: { amount: "-15000.00", currency: "EUR" },
          created_at: sharedTimestamp,
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-after-equal-time-settlement",
        },
      })
      activeSyncRecords = [accountRecord, makeBackdatedInflow("pending"), sameTimeBuy, saleRecord]

      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create table test_equal_time_raw_ids (
              external_record_id text primary key,
              raw_id uuid not null
            )
          `)
          yield* db.execute(sql`
            insert into test_equal_time_raw_ids (external_record_id, raw_id)
            values
              ('tx-equal-time-settlement', ${settlementRawId}::uuid),
              ('tx-equal-time-existing-buy', ${existingBuyRawId}::uuid)
          `)
          yield* db.execute(sql`
            create function set_test_equal_time_raw_id() returns trigger
            language plpgsql as $$
            declare
              configured_id uuid;
            begin
              select raw_id into configured_id
              from test_equal_time_raw_ids
              where external_record_id = new.external_record_id;
              if configured_id is not null then
                new.id := configured_id;
              end if;
              return new;
            end;
            $$
          `)
          yield* db.execute(sql`
            create trigger set_test_equal_time_raw_id
            before insert on source_records_raw
            for each row execute function set_test_equal_time_raw_id()
          `)
          yield* Effect.gen(function* () {
            yield* runSync()
            yield* runSync()

            yield* db
              .update(schema.sourceRecordsRaw)
              .set({ createdAt: new Date("2025-01-01T00:00:01.000Z") })
              .where(
                and(
                  eq(schema.sourceRecordsRaw.sourceId, sourceId),
                  eq(schema.sourceRecordsRaw.externalRecordId, "tx-equal-time-settlement")
                )
              )
            yield* db
              .update(schema.sourceRecordsRaw)
              .set({ createdAt: new Date("2025-01-01T00:00:01.000Z") })
              .where(
                and(
                  eq(schema.sourceRecordsRaw.sourceId, sourceId),
                  eq(schema.sourceRecordsRaw.externalRecordId, "tx-equal-time-existing-buy")
                )
              )
            yield* db
              .update(schema.sourceRecordsRaw)
              .set({ createdAt: new Date("2025-01-01T00:00:02.000Z") })
              .where(
                and(
                  eq(schema.sourceRecordsRaw.sourceId, sourceId),
                  eq(schema.sourceRecordsRaw.externalRecordId, "tx-after-equal-time-settlement")
                )
              )
            yield* replaySource()

            const beforeSettlement = yield* fetchCounts()
            const saleBefore = beforeSettlement.legs.find(
              (leg) => leg.externalId === "tx-after-equal-time-settlement:main"
            )
            const saleTransactionBefore = beforeSettlement.transactions.find(
              (transaction) => transaction.externalId === "tx-after-equal-time-settlement"
            )
            const observedSettlementRawId = beforeSettlement.rawRows.find(
              (row) => row.externalRecordId === "tx-equal-time-settlement"
            )?.id
            const observedExistingBuyRawId = beforeSettlement.rawRows.find(
              (row) => row.externalRecordId === "tx-equal-time-existing-buy"
            )?.id
            if (observedSettlementRawId === undefined || observedExistingBuyRawId === undefined) {
              return yield* Effect.die("Missing equal-time raw record IDs")
            }
            expect(observedSettlementRawId).toBe(settlementRawId)
            expect(observedExistingBuyRawId).toBe(existingBuyRawId)
            const expectedMatches = settlementSortsFirst
              ? [
                  {
                    sourceExternalId: "tx-equal-time-settlement:main",
                    matchedAmount: 1,
                    gainLoss: 10000,
                  },
                ]
              : [
                  {
                    sourceExternalId: "tx-equal-time-existing-buy:main",
                    matchedAmount: 0.5,
                    gainLoss: -2500,
                  },
                  {
                    sourceExternalId: "tx-equal-time-settlement:main",
                    matchedAmount: 0.5,
                    gainLoss: 5000,
                  },
                ].sort((left, right) => left.sourceExternalId.localeCompare(right.sourceExternalId))
            expect(
              beforeSettlement.disposalMatches.filter(
                (match) => match.disposalLegId === saleBefore?.id
              )
            ).toHaveLength(0)
            expect(
              beforeSettlement.transactionReviews.find(
                (review) => review.transactionId === saleTransactionBefore?.id
              )
            ).toEqual(
              expect.objectContaining({
                matchedLayer: "fifo_inventory",
                needsReview: true,
              })
            )

            activeSyncRecords = [
              accountRecord,
              makeBackdatedInflow("completed"),
              sameTimeBuy,
              saleRecord,
            ]
            yield* runSync()

            const settlementState = yield* fetchCounts()
            const settlementSale = settlementState.legs.find(
              (leg) => leg.externalId === "tx-after-equal-time-settlement:main"
            )
            const settlementInflow = settlementState.legs.find(
              (leg) => leg.externalId === "tx-equal-time-settlement:main"
            )
            const settlementBuy = settlementState.legs.find(
              (leg) => leg.externalId === "tx-equal-time-existing-buy:main"
            )
            const settlementSaleTransaction = settlementState.transactions.find(
              (transaction) => transaction.externalId === "tx-after-equal-time-settlement"
            )
            const settlementMatches = settlementState.disposalMatches
              .filter((match) => match.disposalLegId === settlementSale?.id)
              .map((match) => {
                const lot = settlementState.fifoLots.find(
                  (candidate) => candidate.id === match.fifoLotId
                )
                return {
                  sourceExternalId: settlementState.legs.find((leg) => leg.id === lot?.sourceLegId)
                    ?.externalId,
                  matchedAmount: Number(match.matchedAmount),
                  gainLoss: Number(match.gainLoss),
                }
              })
              .sort((left, right) =>
                (left.sourceExternalId ?? "").localeCompare(right.sourceExternalId ?? "")
              )
            const settlementInflowLot = settlementState.fifoLots.find(
              (lot) => lot.sourceLegId === settlementInflow?.id
            )
            const settlementBuyLot = settlementState.fifoLots.find(
              (lot) => lot.sourceLegId === settlementBuy?.id
            )
            expect(settlementMatches).toEqual(expectedMatches)
            expectDecimalAmount(
              String(settlementInflowLot?.remainingAmount),
              settlementSortsFirst ? "0" : "0.5"
            )
            expectDecimalAmount(
              String(settlementBuyLot?.remainingAmount),
              settlementSortsFirst ? "0.5" : "0"
            )
            expect(
              settlementState.transactionReviews.find(
                (review) => review.transactionId === settlementSaleTransaction?.id
              )
            ).toBeUndefined()

            yield* replaySource()
            const replayState = yield* fetchCounts()
            const replaySale = replayState.legs.find(
              (leg) => leg.externalId === "tx-after-equal-time-settlement:main"
            )
            const replayMatches = replayState.disposalMatches
              .filter((match) => match.disposalLegId === replaySale?.id)
              .map((match) => {
                const lot = replayState.fifoLots.find(
                  (candidate) => candidate.id === match.fifoLotId
                )
                return {
                  sourceExternalId: replayState.legs.find((leg) => leg.id === lot?.sourceLegId)
                    ?.externalId,
                  matchedAmount: Number(match.matchedAmount),
                  gainLoss: Number(match.gainLoss),
                }
              })
              .sort((left, right) =>
                (left.sourceExternalId ?? "").localeCompare(right.sourceExternalId ?? "")
              )
            expect(replayMatches).toEqual(expectedMatches)

            const tax = yield* calculateTax()
            expect(tax.taxableGains).toBe(settlementSortsFirst ? 10000 : 5000)
            expect(tax.taxableLosses).toBe(settlementSortsFirst ? 0 : 2500)
            const positions = yield* fetchPortfolioPositions()
            const btcPosition = positions.find((position) => position.assetId === BTC_ASSET_ID)
            expectDecimalAmount(String(btcPosition?.amount), "0.5")
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* db.execute(
                  sql`drop trigger if exists set_test_equal_time_raw_id on source_records_raw`
                )
                yield* db.execute(sql`drop function if exists set_test_equal_time_raw_id()`)
                yield* db.execute(sql`drop table if exists test_equal_time_raw_ids`)
              }).pipe(Effect.orDie)
            )
          )
        }).pipe(Effect.provide(TestPgClientLive))
      )
    },
    15_000
  )

  it("repairs a later movement without clearing an unrelated fee shortage", async () => {
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const openingBuy = makeCoinbaseRecord({
      externalRecordId: "tx-before-movement-settlement",
      occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      payload: {
        id: "tx-before-movement-settlement",
        type: "buy",
        status: "completed",
        amount: { amount: "0.50000000", currency: "BTC" },
        native_amount: { amount: "5000.00", currency: "EUR" },
        created_at: "2025-01-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-before-movement-settlement",
      },
    })
    const makeBackdatedInflow = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-movement-inflow",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-backdated-movement-inflow",
          type: "tx",
          status,
          amount: { amount: "0.50000000", currency: "BTC" },
          native_amount: { amount: "5000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-backdated-movement-inflow",
        },
      })
    const makeBackdatedFeeInflow = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-fee-inflow",
        occurredAt: new Date("2025-01-02T11:00:00.000Z"),
        payload: {
          id: "tx-backdated-fee-inflow",
          type: "tx",
          status,
          amount: { amount: "0.10000000", currency: "ETH" },
          native_amount: { amount: "500.00", currency: "EUR" },
          created_at: "2025-01-02T11:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-backdated-fee-inflow",
        },
      })
    const laterSend = makeCoinbaseRecord({
      externalRecordId: "tx-after-movement-settlement",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-movement-settlement",
        type: "send",
        status: "completed",
        amount: { amount: "-0.80000000", currency: "BTC" },
        native_amount: { amount: "-8000.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-movement-settlement",
        network: {
          status: "confirmed",
          hash: "tx-after-movement-settlement-hash",
          network_name: "bitcoin",
          transaction_fee: { amount: "0.10000000", currency: "ETH" },
        },
        to: {
          address: "bc1qmovementsettlementdestination",
          resource: "address",
        },
      },
    })
    const pendingFeeOnlySend = makeCoinbaseRecord({
      externalRecordId: "tx-pending-fee-only-send",
      occurredAt: new Date("2025-01-04T10:00:00.000Z"),
      payload: {
        id: "tx-pending-fee-only-send",
        type: "send",
        status: "pending",
        amount: { amount: "-0.01000000", currency: "ETH" },
        native_amount: { amount: "-50.00", currency: "EUR" },
        created_at: "2025-01-04T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-pending-fee-only-send",
        network: {
          status: "pending",
          hash: "tx-pending-fee-only-send-hash",
          network_name: "base",
          transaction_fee: { amount: "0.01000000", currency: "ETH" },
        },
        to: {
          address: "0xpendingfeeonlydestination",
          resource: "address",
        },
      },
    })
    activeSyncRecords = [
      accountRecord,
      openingBuy,
      makeBackdatedInflow("pending"),
      makeBackdatedFeeInflow("pending"),
      laterSend,
      pendingFeeOnlySend,
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const ethAssetId = yield* seedCanonicalAsset({ symbol: "ETH" })
        yield* approveProviderAssetMappingToCanonicalAsset({
          currencyCode: "ETH",
          canonicalAssetId: ethAssetId,
          assetRepresentationId: null,
        })
        yield* replaySource()

        const pendingState = yield* fetchCounts()
        const sendTransaction = pendingState.transactions.find(
          (transaction) => transaction.externalId === "tx-after-movement-settlement"
        )
        expect(pendingState.inventoryMovementAllocations).toHaveLength(0)
        expect(
          pendingState.transactionReviews.find(
            (review) => review.transactionId === sendTransaction?.id
          )
        ).toEqual(
          expect.objectContaining({
            matchedLayer: expect.stringContaining("fifo_inventory"),
            needsReview: true,
          })
        )

        activeSyncRecords = [
          accountRecord,
          openingBuy,
          makeBackdatedInflow("completed"),
          makeBackdatedFeeInflow("pending"),
          laterSend,
          pendingFeeOnlySend,
        ]
        yield* runSync()

        const repairedState = yield* fetchCounts()
        const repairedSend = repairedState.transactions.find(
          (transaction) => transaction.externalId === "tx-after-movement-settlement"
        )
        const principalMovement = repairedState.inventoryMovements.find(
          (movement) =>
            movement.transactionId === repairedSend?.id && movement.purpose === "principal"
        )
        const feeMovement = repairedState.inventoryMovements.find(
          (movement) => movement.transactionId === repairedSend?.id && movement.purpose === "fee"
        )
        const principalAllocations = repairedState.inventoryMovementAllocations.filter(
          (allocation) => allocation.inventoryMovementId === principalMovement?.id
        )
        const feeAllocations = repairedState.inventoryMovementAllocations.filter(
          (allocation) => allocation.inventoryMovementId === feeMovement?.id
        )
        const feeLeg = repairedState.legs.find(
          (leg) => leg.transactionId === repairedSend?.id && leg.kind === "fee"
        )

        expect(principalMovement).toEqual(
          expect.objectContaining({ amount: expect.stringContaining("0.8") })
        )
        expect(principalAllocations).toHaveLength(2)
        expect(principalAllocations.map((allocation) => Number(allocation.matchedAmount))).toEqual([
          0.5, 0.3,
        ])
        expect(feeLeg).toEqual(expect.objectContaining({ amount: expect.stringContaining("0.1") }))
        expect(feeMovement).toBeUndefined()
        expect(feeAllocations).toHaveLength(0)
        expect(
          repairedState.transactionReviews.find(
            (review) => review.transactionId === repairedSend?.id
          )
        ).toEqual(
          expect.objectContaining({
            matchedLayer: expect.stringContaining("fifo_inventory"),
            needsReview: true,
          })
        )

        const openingLeg = repairedState.legs.find(
          (leg) => leg.externalId === "tx-before-movement-settlement:main"
        )
        const settledLeg = repairedState.legs.find(
          (leg) => leg.externalId === "tx-backdated-movement-inflow:main"
        )
        const openingLot = repairedState.fifoLots.find((lot) => lot.sourceLegId === openingLeg?.id)
        const settledLot = repairedState.fifoLots.find((lot) => lot.sourceLegId === settledLeg?.id)
        expectDecimalAmount(String(openingLot?.remainingAmount), "0")
        expectDecimalAmount(String(settledLot?.remainingAmount), "0.2")

        activeSyncRecords = [
          accountRecord,
          openingBuy,
          makeBackdatedInflow("completed"),
          makeBackdatedFeeInflow("completed"),
          laterSend,
          pendingFeeOnlySend,
        ]
        yield* runSync()

        const feeRepairedState = yield* fetchCounts()
        const feeRepairedSend = feeRepairedState.transactions.find(
          (transaction) => transaction.externalId === "tx-after-movement-settlement"
        )
        const repairedFeeMovement = feeRepairedState.inventoryMovements.find(
          (movement) =>
            movement.transactionId === feeRepairedSend?.id &&
            movement.purpose === "fee" &&
            movement.assetId === ethAssetId
        )
        const repairedFeeAllocations = feeRepairedState.inventoryMovementAllocations.filter(
          (allocation) => allocation.inventoryMovementId === repairedFeeMovement?.id
        )
        const feeInflowLeg = feeRepairedState.legs.find(
          (leg) => leg.externalId === "tx-backdated-fee-inflow:main"
        )
        const feeInflowLot = feeRepairedState.fifoLots.find(
          (lot) => lot.sourceLegId === feeInflowLeg?.id
        )
        const pendingFeeTransaction = feeRepairedState.transactions.find(
          (transaction) => transaction.externalId === "tx-pending-fee-only-send"
        )
        const pendingFeeLeg = feeRepairedState.legs.find(
          (leg) => leg.transactionId === pendingFeeTransaction?.id && leg.kind === "fee"
        )

        expect(repairedFeeMovement).toEqual(
          expect.objectContaining({ amount: expect.stringContaining("0.1") })
        )
        expect(repairedFeeAllocations).toHaveLength(1)
        expectDecimalAmount(String(repairedFeeAllocations[0]?.matchedAmount), "0.1")
        expectDecimalAmount(String(feeInflowLot?.remainingAmount), "0")
        expect(pendingFeeTransaction?.providerStatus).toBe("pending")
        expectDecimalAmount(String(pendingFeeLeg?.amount), "0.01")
        expect(
          feeRepairedState.inventoryMovements.find(
            (movement) => movement.transactionLegId === pendingFeeLeg?.id
          )
        ).toBeUndefined()
        const feeRepairedReview = feeRepairedState.transactionReviews.find(
          (review) => review.transactionId === feeRepairedSend?.id
        )
        expect(feeRepairedReview).toEqual(
          expect.objectContaining({
            matchedLayer: "coinbase_reference_mapping",
            needsReview: true,
          })
        )
        expect(feeRepairedReview?.categorizationReason).not.toContain("fifo_inventory:")
        const positions = yield* fetchPortfolioPositions()
        const ethPosition = positions.find((position) => position.assetId === ethAssetId)
        expect(ethPosition).toBeUndefined()
      })
    )
  }, 15_000)

  it("rebuilds a later asset after a cross-asset fee settles", async () => {
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const btcBuy = makeCoinbaseRecord({
      externalRecordId: "tx-cross-fee-btc-buy",
      occurredAt: new Date("2025-01-01T09:00:00.000Z"),
      payload: {
        id: "tx-cross-fee-btc-buy",
        type: "buy",
        status: "completed",
        amount: { amount: "1.00000000", currency: "BTC" },
        native_amount: { amount: "10000.00", currency: "EUR" },
        created_at: "2025-01-01T09:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-cross-fee-btc-buy",
      },
    })
    const ethBuy = makeCoinbaseRecord({
      externalRecordId: "tx-cross-fee-eth-buy",
      occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      payload: {
        id: "tx-cross-fee-eth-buy",
        type: "buy",
        status: "completed",
        amount: { amount: "1.00000000", currency: "ETH" },
        native_amount: { amount: "5000.00", currency: "EUR" },
        created_at: "2025-01-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-cross-fee-eth-buy",
      },
    })
    const makeFeeTransaction = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-cross-asset-fee",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-cross-asset-fee",
          type: "tx",
          status,
          amount: { amount: "-0.10000000", currency: "BTC" },
          native_amount: { amount: "-1000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-cross-asset-fee",
          network: {
            status: "confirmed",
            hash: "tx-cross-asset-fee-hash",
            network_name: "ethereum",
            transaction_fee: { amount: "0.20000000", currency: "ETH" },
          },
          to: {
            address: "0xcrossassetfeedestination",
            resource: "address",
          },
        },
      })
    const ethSale = makeCoinbaseRecord({
      externalRecordId: "tx-after-cross-asset-fee",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-cross-asset-fee",
        type: "sell",
        status: "completed",
        amount: { amount: "-0.90000000", currency: "ETH" },
        native_amount: { amount: "-9000.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-cross-asset-fee",
      },
    })
    activeSyncRecords = [accountRecord, btcBuy, ethBuy, makeFeeTransaction("pending"), ethSale]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        const ethAssetId = yield* seedCanonicalAsset({ symbol: "ETH" })
        yield* approveProviderAssetMappingToCanonicalAsset({
          currencyCode: "ETH",
          canonicalAssetId: ethAssetId,
          assetRepresentationId: null,
        })
        yield* replaySource()

        const beforeSettlement = yield* fetchCounts()
        const saleBefore = beforeSettlement.legs.find(
          (leg) => leg.externalId === "tx-after-cross-asset-fee:main"
        )
        expect(
          beforeSettlement.disposalMatches.filter((match) => match.disposalLegId === saleBefore?.id)
        ).toHaveLength(1)

        activeSyncRecords = [
          accountRecord,
          btcBuy,
          ethBuy,
          makeFeeTransaction("completed"),
          ethSale,
        ]
        yield* runSync()

        const repaired = yield* fetchCounts()
        const saleTransaction = repaired.transactions.find(
          (transaction) => transaction.externalId === "tx-after-cross-asset-fee"
        )
        const saleLeg = repaired.legs.find(
          (leg) => leg.externalId === "tx-after-cross-asset-fee:main"
        )
        const feeTransaction = repaired.transactions.find(
          (transaction) => transaction.externalId === "tx-cross-asset-fee"
        )
        const feeMovement = repaired.inventoryMovements.find(
          (movement) =>
            movement.transactionId === feeTransaction?.id &&
            movement.purpose === "fee" &&
            movement.assetId === ethAssetId
        )
        const feeAllocations = repaired.inventoryMovementAllocations.filter(
          (allocation) => allocation.inventoryMovementId === feeMovement?.id
        )
        const ethLot = repaired.fifoLots.find((lot) => lot.assetId === ethAssetId)

        expect(
          repaired.disposalMatches.filter((match) => match.disposalLegId === saleLeg?.id)
        ).toHaveLength(0)
        expect(feeAllocations).toHaveLength(1)
        expectDecimalAmount(String(feeAllocations[0]?.matchedAmount), "0.2")
        expectDecimalAmount(String(ethLot?.remainingAmount), "0.8")
        expect(
          repaired.transactionReviews.find((review) => review.transactionId === saleTransaction?.id)
        ).toEqual(
          expect.objectContaining({
            matchedLayer: "fifo_inventory",
            needsReview: true,
          })
        )

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(0)
        expect(tax.taxableLosses).toBe(0)
        const positions = yield* fetchPortfolioPositions()
        const ethPosition = positions.find((position) => position.assetId === ethAssetId)
        expectDecimalAmount(String(ethPosition?.amount), "0.8")
      })
    )
  }, 15_000)

  it("rebuilds a later sale after one sync when a pending backdated fee fails", async () => {
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const refreshedAccountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-04T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-04T00:00:00.000Z",
      },
    })
    const openingBuy = makeCoinbaseRecord({
      externalRecordId: "tx-before-failed-fee",
      occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      payload: {
        id: "tx-before-failed-fee",
        type: "buy",
        status: "completed",
        amount: { amount: "1.00000000", currency: "BTC" },
        native_amount: { amount: "10000.00", currency: "EUR" },
        created_at: "2025-01-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-before-failed-fee",
      },
    })
    const makeBackdatedFee = (status: "pending" | "failed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-failed-fee",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-backdated-failed-fee",
          type: "send",
          status,
          amount: { amount: "-0.10000000", currency: "BTC" },
          native_amount: { amount: "-1000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-backdated-failed-fee",
          network: {
            status,
            hash: "tx-backdated-failed-fee-hash",
            network_name: "bitcoin",
            transaction_fee: { amount: "0.10000000", currency: "BTC" },
          },
          to: {
            address: "bc1qfailedfeeonlydestination",
            resource: "address",
          },
        },
      })
    const laterSale = makeCoinbaseRecord({
      externalRecordId: "tx-after-failed-fee",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-failed-fee",
        type: "sell",
        status: "completed",
        amount: { amount: "-0.95000000", currency: "BTC" },
        native_amount: { amount: "-14250.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-failed-fee",
      },
    })
    activeSyncRecords = [accountRecord, openingBuy, makeBackdatedFee("pending"), laterSale]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* runSync()

        const beforeFailure = yield* fetchCounts()
        const saleBeforeFailure = beforeFailure.transactions.find(
          (transaction) => transaction.externalId === "tx-after-failed-fee"
        )
        const saleLegBeforeFailure = beforeFailure.legs.find(
          (leg) => leg.transactionId === saleBeforeFailure?.id && leg.kind === "disposal"
        )
        const matchesBeforeFailure = beforeFailure.disposalMatches.filter(
          (match) => match.disposalLegId === saleLegBeforeFailure?.id
        )
        expect(matchesBeforeFailure).toHaveLength(1)
        expectDecimalAmount(String(matchesBeforeFailure[0]?.matchedAmount), "0.95")
        expectDecimalAmount(String(matchesBeforeFailure[0]?.gainLoss), "4750")

        activeSyncRecords = [
          refreshedAccountRecord,
          openingBuy,
          makeBackdatedFee("failed"),
          laterSale,
        ]
        yield* runSync()

        const afterFailure = yield* fetchCounts()
        const failedFeeTransaction = afterFailure.transactions.find(
          (transaction) => transaction.externalId === "tx-backdated-failed-fee"
        )
        const saleAfterFailure = afterFailure.transactions.find(
          (transaction) => transaction.externalId === "tx-after-failed-fee"
        )
        const saleLegAfterFailure = afterFailure.legs.find(
          (leg) => leg.transactionId === saleAfterFailure?.id && leg.kind === "disposal"
        )
        const feeMovement = afterFailure.inventoryMovements.find(
          (movement) =>
            movement.transactionId === failedFeeTransaction?.id && movement.purpose === "fee"
        )
        const feeAllocations = afterFailure.inventoryMovementAllocations.filter(
          (allocation) => allocation.inventoryMovementId === feeMovement?.id
        )
        const openingLeg = afterFailure.legs.find(
          (leg) => leg.externalId === "tx-before-failed-fee:main"
        )
        const openingLot = afterFailure.fifoLots.find((lot) => lot.sourceLegId === openingLeg?.id)

        expect(failedFeeTransaction?.providerStatus).toBe("failed")
        expectDecimalAmount(String(feeMovement?.amount), "0.1")
        expect(feeAllocations).toHaveLength(1)
        expectDecimalAmount(String(feeAllocations[0]?.matchedAmount), "0.1")
        expect(
          afterFailure.disposalMatches.filter(
            (match) => match.disposalLegId === saleLegAfterFailure?.id
          )
        ).toHaveLength(0)
        expectDecimalAmount(String(openingLot?.remainingAmount), "0.9")
        expect(
          afterFailure.transactionReviews.find(
            (review) => review.transactionId === saleAfterFailure?.id
          )
        ).toEqual(expect.objectContaining({ matchedLayer: "fifo_inventory", needsReview: true }))

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(0)
        expect(tax.taxableLosses).toBe(0)
        const positions = yield* fetchPortfolioPositions()
        const btcPosition = positions.find((position) => position.assetId === BTC_ASSET_ID)
        expectDecimalAmount(String(btcPosition?.amount), "0.9")
      })
    )
  }, 15_000)

  it("reorders later matches after one sync when a changed backdated outflow settles", async () => {
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const makeBuyRecord = ({
      id,
      at,
      fiat,
    }: {
      readonly id: string
      readonly at: string
      readonly fiat: string
    }) =>
      makeCoinbaseRecord({
        externalRecordId: id,
        occurredAt: new Date(at),
        payload: {
          id,
          type: "buy",
          status: "completed",
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: fiat, currency: "EUR" },
          created_at: at,
          resource_path: `/v2/accounts/coinbase-account-1/transactions/${id}`,
          description: id,
        },
      })
    const makeBackdatedOutflow = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-outflow",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-backdated-outflow",
          type: "tx",
          status,
          amount: { amount: "-0.50000000", currency: "BTC" },
          native_amount: { amount: "-5000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-backdated-outflow",
          description: `Uncategorized ${status} debit`,
        },
      })
    const saleRecord = makeCoinbaseRecord({
      externalRecordId: "tx-after-backdated-outflow",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-backdated-outflow",
        type: "sell",
        status: "completed",
        amount: { amount: "-1.20000000", currency: "BTC" },
        native_amount: { amount: "-18000.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-backdated-outflow",
        description: "Sale after pending outflow",
      },
    })
    const firstBuy = makeBuyRecord({
      id: "tx-first-cost-lot",
      at: "2025-01-01T10:00:00.000Z",
      fiat: "10000.00",
    })
    const secondBuy = makeBuyRecord({
      id: "tx-second-cost-lot",
      at: "2025-01-01T11:00:00.000Z",
      fiat: "20000.00",
    })
    activeSyncRecords = [
      accountRecord,
      firstBuy,
      secondBuy,
      makeBackdatedOutflow("pending"),
      saleRecord,
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        // Drain the initial mapping replay before the provider settlement.
        yield* runSync()
        const taxBeforeSettlement = yield* calculateTax()
        expect(taxBeforeSettlement.taxableGains).toBe(5000)
        expect(taxBeforeSettlement.taxableLosses).toBe(1000)

        const reviewedAt = new Date("2025-01-04T13:00:00.000Z")
        yield* setTransactionReview({
          externalId: "tx-backdated-outflow",
          reviewStatus: "changed",
          originalTypeKey: "manual_original_outflow",
          originalConfidence: "0.29",
          currentTypeKey: "cashback",
          legalRuleSetVersion: "manual-rules-outflow-v9",
          categorizationReason: "Manual outflow reason",
          matchedLayer: "manual_outflow_layer",
          userNotes: "Changed pending outflow",
          reviewedAt,
        })

        activeSyncRecords = [
          accountRecord,
          firstBuy,
          secondBuy,
          makeBackdatedOutflow("completed"),
          saleRecord,
        ]
        yield* runSync()

        const state = yield* fetchCounts()
        const outflowTransaction = state.transactions.find(
          (transaction) => transaction.externalId === "tx-backdated-outflow"
        )
        const review = state.transactionReviews.find(
          (candidate) => candidate.transactionId === outflowTransaction?.id
        )
        expect(review).toEqual(
          expect.objectContaining({
            reviewStatus: "changed",
            originalTypeKey: "manual_original_outflow",
            originalConfidence: "0.29",
            currentTypeKey: "cashback",
            legalRuleSetVersion: "manual-rules-outflow-v9",
            categorizationReason: "Manual outflow reason",
            matchedLayer: "manual_outflow_layer",
            needsReview: false,
            userNotes: "Changed pending outflow",
          })
        )
        expect(review?.reviewedAt?.toISOString()).toBe(reviewedAt.toISOString())

        const firstBuyLeg = state.legs.find((leg) => leg.externalId === "tx-first-cost-lot:main")
        const secondBuyLeg = state.legs.find((leg) => leg.externalId === "tx-second-cost-lot:main")
        const backdatedLeg = state.legs.find(
          (leg) => leg.externalId === "tx-backdated-outflow:main"
        )
        const laterSaleLeg = state.legs.find(
          (leg) => leg.externalId === "tx-after-backdated-outflow:main"
        )
        const matchesFor = (disposalLegId: string | undefined) =>
          state.disposalMatches
            .filter((match) => match.disposalLegId === disposalLegId)
            .map((match) => ({
              sourceLegId: state.fifoLots.find((lot) => lot.id === match.fifoLotId)?.sourceLegId,
              matchedAmount: Number(match.matchedAmount),
              gainLoss: Number(match.gainLoss),
            }))

        expect(matchesFor(backdatedLeg?.id)).toEqual([
          { sourceLegId: firstBuyLeg?.id, matchedAmount: 0.5, gainLoss: 0 },
        ])
        const laterSaleMatches = matchesFor(laterSaleLeg?.id)
        expect(laterSaleMatches).toHaveLength(2)
        expect(laterSaleMatches).toEqual(
          expect.arrayContaining([
            { sourceLegId: firstBuyLeg?.id, matchedAmount: 0.5, gainLoss: 2500 },
            { sourceLegId: secondBuyLeg?.id, matchedAmount: 0.7, gainLoss: -3500 },
          ])
        )
        const firstLot = state.fifoLots.find((lot) => lot.sourceLegId === firstBuyLeg?.id)
        const secondLot = state.fifoLots.find((lot) => lot.sourceLegId === secondBuyLeg?.id)
        expectDecimalAmount(String(firstLot?.remainingAmount), "0")
        expectDecimalAmount(String(secondLot?.remainingAmount), "0.3")

        const taxAfterSettlement = yield* calculateTax()
        expect(taxAfterSettlement.taxableGains).toBe(2500)
        expect(taxAfterSettlement.taxableLosses).toBe(3500)
        const positions = yield* fetchPortfolioPositions()
        const btcPosition = positions.find((position) => position.assetId === BTC_ASSET_ID)
        expectDecimalAmount(String(btcPosition?.amount), "0.3")
      })
    )
  })

  it("clears stale sale effects when a backdated outflow creates a shortage", async () => {
    const accountRecord = makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    })
    const makeBuy = ({
      id,
      at,
      fiat,
    }: {
      readonly id: string
      readonly at: string
      readonly fiat: string
    }) =>
      makeCoinbaseRecord({
        externalRecordId: id,
        occurredAt: new Date(at),
        payload: {
          id,
          type: "buy",
          status: "completed",
          amount: { amount: "0.75000000", currency: "BTC" },
          native_amount: { amount: fiat, currency: "EUR" },
          created_at: at,
          resource_path: `/v2/accounts/coinbase-account-1/transactions/${id}`,
        },
      })
    const firstBuy = makeBuy({
      id: "tx-shortage-first-lot",
      at: "2025-01-01T10:00:00.000Z",
      fiat: "7500.00",
    })
    const secondBuy = makeBuy({
      id: "tx-shortage-second-lot",
      at: "2025-01-01T11:00:00.000Z",
      fiat: "15000.00",
    })
    const makeBackdatedOutflow = (status: "pending" | "completed") =>
      makeCoinbaseRecord({
        externalRecordId: "tx-backdated-shortage-outflow",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        payload: {
          id: "tx-backdated-shortage-outflow",
          type: "tx",
          status,
          amount: { amount: "-0.50000000", currency: "BTC" },
          native_amount: { amount: "-5000.00", currency: "EUR" },
          created_at: "2025-01-02T10:00:00.000Z",
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-backdated-shortage-outflow",
        },
      })
    const saleRecord = makeCoinbaseRecord({
      externalRecordId: "tx-after-shortage-outflow",
      occurredAt: new Date("2025-01-03T10:00:00.000Z"),
      payload: {
        id: "tx-after-shortage-outflow",
        type: "sell",
        status: "completed",
        amount: { amount: "-1.20000000", currency: "BTC" },
        native_amount: { amount: "-18000.00", currency: "EUR" },
        created_at: "2025-01-03T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-after-shortage-outflow",
      },
    })
    activeSyncRecords = [
      accountRecord,
      firstBuy,
      secondBuy,
      makeBackdatedOutflow("pending"),
      saleRecord,
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runSync()
        yield* runSync()

        const beforeSettlement = yield* fetchCounts()
        const saleBeforeSettlement = beforeSettlement.transactions.find(
          (transaction) => transaction.externalId === "tx-after-shortage-outflow"
        )
        const saleLegBeforeSettlement = beforeSettlement.legs.find(
          (leg) => leg.transactionId === saleBeforeSettlement?.id && leg.kind === "disposal"
        )
        expect(
          beforeSettlement.disposalMatches.filter(
            (match) => match.disposalLegId === saleLegBeforeSettlement?.id
          )
        ).toHaveLength(2)

        activeSyncRecords = [
          accountRecord,
          firstBuy,
          secondBuy,
          makeBackdatedOutflow("completed"),
          saleRecord,
        ]
        yield* runSync()

        const repairedState = yield* fetchCounts()
        const sale = repairedState.transactions.find(
          (transaction) => transaction.externalId === "tx-after-shortage-outflow"
        )
        const saleLeg = repairedState.legs.find(
          (leg) => leg.transactionId === sale?.id && leg.kind === "disposal"
        )
        expect(
          repairedState.disposalMatches.filter((match) => match.disposalLegId === saleLeg?.id)
        ).toHaveLength(0)
        expect(
          repairedState.transactionReviews.find((review) => review.transactionId === sale?.id)
        ).toEqual(
          expect.objectContaining({
            matchedLayer: "fifo_inventory",
            needsReview: true,
          })
        )

        const firstLeg = repairedState.legs.find(
          (leg) => leg.externalId === "tx-shortage-first-lot:main"
        )
        const secondLeg = repairedState.legs.find(
          (leg) => leg.externalId === "tx-shortage-second-lot:main"
        )
        const firstLot = repairedState.fifoLots.find((lot) => lot.sourceLegId === firstLeg?.id)
        const secondLot = repairedState.fifoLots.find((lot) => lot.sourceLegId === secondLeg?.id)
        expectDecimalAmount(String(firstLot?.remainingAmount), "0.25")
        expectDecimalAmount(String(secondLot?.remainingAmount), "0.75")

        const tax = yield* calculateTax()
        expect(tax.taxableGains).toBe(0)
        expect(tax.taxableLosses).toBe(0)
        const positions = yield* fetchPortfolioPositions()
        const btcPosition = positions.find((position) => position.assetId === BTC_ASSET_ID)
        expectDecimalAmount(String(btcPosition?.amount), "1")
      })
    )
  }, 15_000)
})
