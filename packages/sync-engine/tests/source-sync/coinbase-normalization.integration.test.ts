import { and, eq, inArray } from "drizzle-orm"
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
import { SourceSyncService } from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import { TaxCalculationService } from "../../../persistence/src/services/index.ts"
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

let activeSyncRecords: ReadonlyArray<ProviderRawRecord> = defaultSyncRecords
let activeFiatCurrencies: ReadonlyArray<CoinbaseFiatCurrencyRecord> = defaultFiatCurrencies
let activeCryptoCurrencies: ReadonlyArray<CoinbaseCryptoCurrencyRecord> = defaultCryptoCurrencies

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
  fetchFiatCurrencies: () => Effect.succeed(activeFiatCurrencies),
  fetchCryptoCurrencies: () => Effect.succeed(activeCryptoCurrencies),
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
      return yield* Effect.dieMessage("Missing seeded base blockchain")
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
      return yield* Effect.dieMessage("Failed to load base blockchain fixture for onchain match")
    }

    const [btcAsset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)

    if (btcAsset === undefined) {
      return yield* Effect.dieMessage("Failed to load BTC asset fixture for onchain match")
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
      return yield* Effect.dieMessage("Failed to create onchain receipt transaction fixture")
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
      return yield* Effect.dieMessage("Failed to load base blockchain fixture for onchain send")
    }

    const [btcAsset] = yield* db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.symbol, "BTC"))
      .limit(1)

    if (btcAsset === undefined) {
      return yield* Effect.dieMessage("Failed to load BTC asset fixture for onchain send")
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
      return yield* Effect.dieMessage("Failed to create onchain send transaction fixture")
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
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(inArray(schema.transactionLegs.sourceId, [sourceId, ownedOnchainSourceId]))

    const fifoLots = yield* db
      .select({
        sourceId: schema.fifoLots.sourceId,
      })
      .from(schema.fifoLots)
      .where(inArray(schema.fifoLots.sourceId, [sourceId, ownedOnchainSourceId]))

    return {
      reconciliations,
      reviews,
      legs,
      fifoLots,
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
        currentTypeKey: schema.transactionReviews.currentTypeKey,
        categorizationReason: schema.transactionReviews.categorizationReason,
        matchedLayer: schema.transactionReviews.matchedLayer,
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
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const fifoLots = yield* db
      .select({
        originalAmount: schema.fifoLots.originalAmount,
        remainingAmount: schema.fifoLots.remainingAmount,
      })
      .from(schema.fifoLots)
      .where(eq(schema.fifoLots.sourceId, sourceId))

    const disposalMatches = yield* db
      .select({
        matchedAmount: schema.disposalMatches.matchedAmount,
        gainLoss: schema.disposalMatches.gainLoss,
      })
      .from(schema.disposalMatches)

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
      transactionTypeCatalogCount: transactionTypeCatalogRows.length,
      providerAssetCatalogCount: providerAssetRows.length,
    }
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
      return yield* Effect.dieMessage("Failed to seed provider asset fixture")
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
      return yield* Effect.dieMessage(`Failed to seed ${symbol} canonical asset fixture`)
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
      return yield* Effect.dieMessage(
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

await Effect.runPromise(recreateTestDatabase())

describe("coinbase normalization persistence", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      activeSyncRecords = defaultSyncRecords
      activeFiatCurrencies = defaultFiatCurrencies
      activeCryptoCurrencies = defaultCryptoCurrencies
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

  it("applies matched Coinbase withdrawal FIFO effects through sync and replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedMatchedOnchainReceipt({
          walletAddress: "bc1qexampledestination",
          txHash: "tx-send-hash-1",
          amount: "0.10000000",
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
  })

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
          return yield* Effect.dieMessage("Missing HYPE provider asset fixture")
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
          expectDecimalAmount(secondRemainingAmount, "0.4999")
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
})
