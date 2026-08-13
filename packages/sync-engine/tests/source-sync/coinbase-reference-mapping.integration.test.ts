import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseReferenceMappingService } from "../../src/providers/coinbase/services/CoinbaseReferenceMappingService.ts"
import { CoinbaseSyncClient } from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import { SourceSyncService } from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../../persistence/tests/support/integration-test-kit.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_coinbase_mapping_pr04",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-0000-0000-000000000161"
const principalId = "00000000-0000-0000-0000-000000000162"
const sourceId = "00000000-0000-0000-0000-000000000261"
const BTC_ASSET_ID = "00000000-0000-0000-0000-000000000561"
const ETH_ASSET_ID = "00000000-0000-0000-0000-000000000562"
const SOL_ASSET_ID = "00000000-0000-0000-0000-000000000563"

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  externalAccountId = "coinbase-account-1",
  externalParentId = null,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly externalAccountId?: string
  readonly externalParentId?: string | null
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId,
    externalParentId,
    occurredAt,
    payload,
  })

const syncRecords = [
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
  // Real Coinbase instant unstaking emits two principal-sized rows at the same
  // timestamp: the full release from the staked balance and the net credit to
  // the spot balance. Only the spread between them is a fee.
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-credit",
    externalParentId: "unstake-group-1",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-unstake-credit",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "1.25000000", currency: "ETH2" },
      native_amount: { amount: "2500.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-credit",
      description: "Instant unstaking net principal credit",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-release",
    externalParentId: "unstake-group-1",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-unstake-release",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "-1.26500000", currency: "ETH2" },
      native_amount: { amount: "-2530.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-release",
      description: "Instant unstaking principal release",
    },
  }),
  // Second unstaking pair at the exact same timestamp and currency but in a
  // different provider group. Pairing must match on the group, not just on
  // timestamp + currency, so the two pairs do not block each other.
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-alt-credit",
    externalParentId: "unstake-group-2",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-unstake-alt-credit",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "0.50000000", currency: "ETH2" },
      native_amount: { amount: "1000.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-alt-credit",
      description: "Second instant unstaking net principal credit",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-alt-release",
    externalParentId: "unstake-group-2",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-unstake-alt-release",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "-0.51000000", currency: "ETH2" },
      native_amount: { amount: "-1020.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-alt-release",
      description: "Second instant unstaking principal release",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-eth2-migration-out",
    externalParentId: "eth2-migration-1",
    occurredAt: new Date("2025-06-01T09:00:00.000Z"),
    payload: {
      id: "tx-eth2-migration-out",
      type: "retail_eth2_deprecation",
      status: "completed",
      amount: { amount: "-1.00000000", currency: "ETH2" },
      native_amount: { amount: "0.00", currency: "EUR" },
      created_at: "2025-06-01T09:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-eth2-migration-out",
      description: "ETH2 deprecation outflow",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-eth2-migration-in",
    externalParentId: "eth2-migration-1",
    occurredAt: new Date("2025-06-01T09:00:02.000Z"),
    payload: {
      id: "tx-eth2-migration-in",
      type: "retail_eth2_deprecation",
      status: "completed",
      amount: { amount: "1.00000000", currency: "ETH" },
      native_amount: { amount: "0.00", currency: "EUR" },
      created_at: "2025-06-01T09:00:02.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-eth2-migration-in",
      description: "ETH2 deprecation inflow",
    },
  }),
] as const

let activeSyncRecords: ReadonlyArray<ProviderRawRecord> = syncRecords

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
      {
        currencyCode: "USD",
        name: "US Dollar",
        minSize: "0.01",
        payload: {
          id: "USD",
          name: "US Dollar",
          min_size: "0.01",
        },
      },
    ] as const),
  fetchCryptoCurrencies: () =>
    Effect.succeed([
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

const seedCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: "coinbase-pr05-mapping@taxmaxi.test",
      name: "Coinbase PR-05 Mapping User",
    })
    yield* db.insert(schema.billingAccounts).values({ userId })
    yield* db.insert(schema.creditLedger).values({
      userId,
      delta: 100_000,
      kind: "manual_adjustment",
      reference: "test:coinbase-reference-mapping-credits",
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
        providerUserId: "coinbase-user-pr05-mapping",
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
      id: ETH_ASSET_ID,
      name: "Ethereum",
      symbol: "ETH",
      coingeckoCoinId: "ethereum",
      type: "fungible",
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

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({
      principalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const runReferenceMapping = <A, E>(effect: Effect.Effect<A, E, CoinbaseReferenceMappingService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        CoinbaseReferenceMappingWithDepsLive.pipe(Layer.provideMerge(TestPgClientLive))
      ),
      Effect.scoped
    )
  )

const seedCanonicalAsset = ({
  id,
  symbol,
  contractAddress,
  coingeckoCoinId,
}: {
  readonly id: string
  readonly symbol: string
  readonly contractAddress: string
  readonly coingeckoCoinId?: string
}) =>
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
      id,
      name: `${symbol} Fixture`,
      symbol,
      coingeckoCoinId,
      type: "fungible",
    })
    yield* db.insert(schema.assetRepresentations).values({
      assetId: id,
      blockchainId: baseBlockchain.id,
      contractAddress,
      mintAddress: null,
      decimals: 8,
      type: "token",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const fetchProviderAssetMappingRows = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    return yield* db
      .select({
        currencyCode: schema.providerAssets.currencyCode,
        providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
        mappingKind: schema.providerAssetMappings.mappingKind,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        canonicalFiatCurrency: schema.providerAssetMappings.canonicalFiatCurrency,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        reviewerNotes: schema.providerAssetMappings.reviewerNotes,
        sourceNotes: schema.providerAssetMappings.sourceNotes,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
  }).pipe(Effect.provide(TestPgClientLive))

const fetchNormalizationState = () =>
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
        externalGroupId: schema.transactions.externalGroupId,
        providerTransactionType: schema.transactions.providerTransactionType,
        transactionType: schema.transactions.transactionType,
        metadata: schema.transactions.metadata,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, sourceId))

    const legs = yield* db
      .select({
        externalId: schema.transactionLegs.externalId,
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
        amount: schema.transactionLegs.amount,
        fiatAmount: schema.transactionLegs.fiatAmount,
        fiatCurrency: schema.transactionLegs.fiatCurrency,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const inventoryMovements = yield* db
      .select({
        direction: schema.inventoryMovements.direction,
        purpose: schema.inventoryMovements.purpose,
        amount: schema.inventoryMovements.amount,
      })
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.sourceId, sourceId))

    const [eth2Mapping] = yield* db
      .select({
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ETH2"))
      .limit(1)

    return {
      rawRows,
      transactions,
      legs,
      inventoryMovements,
      eth2Mapping,
    }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("coinbase reference mappings", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(() =>
    Effect.gen(function* () {
      activeSyncRecords = syncRecords
      yield* context.recreateTestDatabase()
    }).pipe(Effect.runPromise)
  )

  it("does not bind a default mapping to an unrelated asset with the same symbol", async () => {
    await Effect.runPromise(
      seedCanonicalAsset({
        id: "00000000-0000-0000-0000-000000000901",
        symbol: "BTC",
        contractAddress: "coinbase-default-btc",
      })
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const mappings = await Effect.runPromise(fetchProviderAssetMappingRows())
    const adaMapping = mappings.find((mapping) => mapping.currencyCode === "ADA")
    const dotMapping = mappings.find((mapping) => mapping.currencyCode === "DOT")

    expect(adaMapping).toMatchObject({
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      mappingStatus: "pending_review",
    })
    expect(dotMapping).toMatchObject({
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      mappingStatus: "pending_review",
    })
    expect(adaMapping?.sourceNotes).toContain("no assets row exists")
  })

  it("seeds existing BTC ETH and SOL default assets as approved canonical id mappings", async () => {
    await Effect.runPromise(
      Effect.all([
        seedCanonicalAsset({
          id: BTC_ASSET_ID,
          symbol: "BTC",
          coingeckoCoinId: "bitcoin",
          contractAddress: "coinbase-default-existing-btc",
        }),
        seedCanonicalAsset({
          id: ETH_ASSET_ID,
          symbol: "ETH",
          coingeckoCoinId: "ethereum",
          contractAddress: "coinbase-default-existing-eth",
        }),
        seedCanonicalAsset({
          id: SOL_ASSET_ID,
          symbol: "SOL",
          coingeckoCoinId: "solana",
          contractAddress: "coinbase-default-existing-sol",
        }),
      ])
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const mappings = await Effect.runPromise(fetchProviderAssetMappingRows())

    expect(mappings.find((mapping) => mapping.currencyCode === "BTC")).toMatchObject({
      canonicalAssetId: BTC_ASSET_ID,
      assetRepresentationId: null,
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "ETH")).toMatchObject({
      canonicalAssetId: ETH_ASSET_ID,
      assetRepresentationId: null,
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "SOL")).toMatchObject({
      canonicalAssetId: SOL_ASSET_ID,
      assetRepresentationId: null,
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "ADA")).toMatchObject({
      canonicalAssetId: null,
      assetRepresentationId: null,
      mappingStatus: "pending_review",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "DOT")).toMatchObject({
      canonicalAssetId: null,
      assetRepresentationId: null,
      mappingStatus: "pending_review",
    })
  })

  it("does not overwrite reviewed provider asset mappings on later default refreshes", async () => {
    await Effect.runPromise(
      seedCanonicalAsset({
        id: BTC_ASSET_ID,
        symbol: "BTC",
        coingeckoCoinId: "bitcoin",
        contractAddress: "coinbase-default-reviewed-btc",
      })
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const [adaMapping] = (await Effect.runPromise(fetchProviderAssetMappingRows())).filter(
      (mapping) => mapping.currencyCode === "ADA"
    )

    if (adaMapping === undefined) {
      expect.fail("Expected ADA provider asset mapping to exist")
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db
          .insert(schema.providerAssetMappings)
          .values({
            providerAssetRowId: adaMapping.providerAssetRowId,
            mappingKind: "asset",
            canonicalAssetId: BTC_ASSET_ID,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "approved",
            reviewerNotes: "Admin reviewed ADA as BTC test fixture",
            sourceNotes: "Admin decision",
          })
          .onConflictDoUpdate({
            target: schema.providerAssetMappings.providerAssetRowId,
            set: {
              canonicalAssetId: BTC_ASSET_ID,
              assetRepresentationId: null,
              mappingStatus: "approved",
              reviewerNotes: "Admin reviewed ADA as BTC test fixture",
              sourceNotes: "Admin decision",
            },
          })
      }).pipe(Effect.provide(TestPgClientLive))
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const refreshedAdaMapping = (await Effect.runPromise(fetchProviderAssetMappingRows())).find(
      (mapping) => mapping.currencyCode === "ADA"
    )

    expect(refreshedAdaMapping).toMatchObject({
      canonicalAssetId: BTC_ASSET_ID,
      assetRepresentationId: null,
      mappingStatus: "approved",
      reviewerNotes: "Admin reviewed ADA as BTC test fixture",
      sourceNotes: "Admin decision",
    })
  })

  it("maps a chainless custody observation to an economic asset only", async () => {
    await Effect.runPromise(
      seedCanonicalAsset({
        id: BTC_ASSET_ID,
        symbol: "BTC",
        coingeckoCoinId: "bitcoin",
        contractAddress: "coinbase-default-legacy-btc",
      })
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const btcMapping = await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) =>
        service.resolveCurrency({ currencyCode: "BTC" })
      )
    )

    expect(btcMapping).toMatchObject({
      canonicalAssetId: BTC_ASSET_ID,
      assetRepresentationId: null,
      mappingStatus: "approved",
    })
  })

  it("resolves EUR as fiat without requiring a canonical asset row", async () => {
    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const eurMapping = await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) =>
        service.resolveCurrency({
          currencyCode: "EUR",
        })
      )
    )

    expect(eurMapping).toMatchObject({
      currencyCode: "EUR",
      mappingKind: "fiat",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: "EUR",
      mappingStatus: "approved",
    })
  })

  it("does not pair a grouped unstaking row with an ungrouped candidate", async () => {
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
        externalRecordId: "tx-grouped-release-without-sibling",
        externalParentId: "unstake-group-without-sibling",
        occurredAt: new Date("2025-05-01T10:00:00.000Z"),
        payload: {
          id: "tx-grouped-release-without-sibling",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: "2025-05-01T10:00:00.000Z",
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-grouped-release-without-sibling",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-unrelated-ungrouped-credit",
        occurredAt: new Date("2025-05-01T10:00:30.000Z"),
        payload: {
          id: "tx-unrelated-ungrouped-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.99000000", currency: "ETH2" },
          native_amount: { amount: "1980.00", currency: "EUR" },
          created_at: "2025-05-01T10:00:30.000Z",
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-unrelated-ungrouped-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const groupedRawRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-grouped-release-without-sibling"
        )

        expect(groupedRawRow?.normalizedAt).toBeNull()
        expect(groupedRawRow?.normalizationError).toContain(
          "Expected one unambiguous paired principal row"
        )
        expect(state.transactions.map((row) => row.externalId)).toEqual([
          "tx-unrelated-ungrouped-credit",
        ])
      })
    )
  })

  it("does not pair grouped unstaking rows with different native currencies", async () => {
    const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
        externalRecordId: "tx-mixed-native-release",
        externalAccountId: "coinbase-account-1",
        externalParentId: "mixed-native-group",
        occurredAt,
        payload: {
          id: "tx-mixed-native-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-mixed-native-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-mixed-native-credit",
        externalAccountId: "coinbase-account-2",
        externalParentId: "mixed-native-group",
        occurredAt,
        payload: {
          id: "tx-mixed-native-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.99000000", currency: "ETH2" },
          native_amount: { amount: "1980.00", currency: "USD" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-2/transactions/tx-mixed-native-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const releaseRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-mixed-native-release"
        )

        expect(releaseRow?.normalizedAt).toBeNull()
        expect(releaseRow?.normalizationError).toContain(
          "Expected one unambiguous paired principal row"
        )
        expect(state.transactions.map((row) => row.externalId)).toEqual(["tx-mixed-native-credit"])
        expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
      })
    )
  })

  it("does not pair a grouped unstaking release with a zero-valued credit", async () => {
    const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
        externalRecordId: "tx-zero-credit-release",
        externalAccountId: "coinbase-account-1",
        externalParentId: "zero-credit-group",
        occurredAt,
        payload: {
          id: "tx-zero-credit-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-zero-credit-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-zero-credit",
        externalAccountId: "coinbase-account-2",
        externalParentId: "zero-credit-group",
        occurredAt,
        payload: {
          id: "tx-zero-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.00000000", currency: "ETH2" },
          native_amount: { amount: "0.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-2/transactions/tx-zero-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const releaseRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-zero-credit-release"
        )

        expect(releaseRow?.normalizedAt).toBeNull()
        expect(releaseRow?.normalizationError).toContain(
          "Expected one unambiguous paired principal row"
        )
        expect(state.transactions.map((row) => row.externalId)).toEqual(["tx-zero-credit"])
        expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
        expect(state.inventoryMovements).toHaveLength(0)
      })
    )
  })

  it("does not pair a grouped unstaking row with multiple compatible credits", async () => {
    const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
        externalRecordId: "tx-ambiguous-grouped-release",
        externalParentId: "ambiguous-unstake-group",
        occurredAt,
        payload: {
          id: "tx-ambiguous-grouped-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-ambiguous-grouped-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-first-grouped-credit",
        externalParentId: "ambiguous-unstake-group",
        occurredAt,
        payload: {
          id: "tx-first-grouped-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.99000000", currency: "ETH2" },
          native_amount: { amount: "1980.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-first-grouped-credit",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-second-grouped-credit",
        externalParentId: "ambiguous-unstake-group",
        occurredAt: new Date("2025-05-01T10:00:01.000Z"),
        payload: {
          id: "tx-second-grouped-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.98000000", currency: "ETH2" },
          native_amount: { amount: "1960.00", currency: "EUR" },
          created_at: "2025-05-01T10:00:01.000Z",
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-second-grouped-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const releaseRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-ambiguous-grouped-release"
        )

        expect(releaseRow?.normalizedAt).toBeNull()
        expect(releaseRow?.normalizationError).toContain(
          "Expected one unambiguous paired principal row"
        )
        expect(
          state.transactions
            .map((row) => row.externalId)
            .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
        ).toEqual(["tx-first-grouped-credit", "tx-second-grouped-credit"])
        expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
      })
    )
  })

  it.each([
    {
      caseName: "a candidate from a provider group",
      candidateAccountId: "coinbase-account-1",
      candidateParentId: "unrelated-unstake-group",
      candidateType: "retail_instant_unstaking",
      candidateOccurredAt: "2025-05-01T10:00:30.000Z",
      secondCandidateAccountId: null,
      expectedTransactionIds: ["tx-unrelated-credit"],
    },
    {
      caseName: "an ungrouped candidate from another account",
      candidateAccountId: "coinbase-account-2",
      candidateParentId: null,
      candidateType: "retail_instant_unstaking",
      candidateOccurredAt: "2025-05-01T10:00:30.000Z",
      secondCandidateAccountId: null,
      expectedTransactionIds: ["tx-unrelated-credit"],
    },
    {
      caseName: "an ungrouped candidate from the same account",
      candidateAccountId: "coinbase-account-1",
      candidateParentId: null,
      candidateType: "retail_instant_unstaking",
      candidateOccurredAt: "2025-05-01T10:00:30.000Z",
      secondCandidateAccountId: null,
      expectedTransactionIds: ["tx-unrelated-credit"],
    },
    {
      caseName: "a complementary ungrouped candidate from the same account",
      candidateAccountId: "coinbase-account-1",
      candidateParentId: null,
      candidateType: "unstaking_transfer",
      candidateOccurredAt: "2025-05-01T10:00:30.000Z",
      secondCandidateAccountId: null,
      expectedTransactionIds: ["tx-unrelated-credit"],
    },
    {
      caseName: "multiple same-type candidates at the exact timestamp",
      candidateAccountId: "coinbase-account-2",
      candidateParentId: null,
      candidateType: "retail_instant_unstaking",
      candidateOccurredAt: "2025-05-01T10:00:00.000Z",
      secondCandidateAccountId: "coinbase-account-3",
      expectedTransactionIds: ["tx-second-unrelated-credit", "tx-unrelated-credit"],
    },
  ])("does not pair an ungrouped unstaking row with $caseName", async (testCase) => {
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
        externalRecordId: "tx-ungrouped-release-without-sibling",
        occurredAt: new Date("2025-05-01T10:00:00.000Z"),
        payload: {
          id: "tx-ungrouped-release-without-sibling",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: "2025-05-01T10:00:00.000Z",
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/tx-ungrouped-release-without-sibling",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-unrelated-credit",
        externalAccountId: testCase.candidateAccountId,
        externalParentId: testCase.candidateParentId,
        occurredAt: new Date(testCase.candidateOccurredAt),
        payload: {
          id: "tx-unrelated-credit",
          type: testCase.candidateType,
          status: "completed",
          amount: { amount: "0.99000000", currency: "ETH2" },
          native_amount: { amount: "1980.00", currency: "EUR" },
          created_at: testCase.candidateOccurredAt,
          resource_path: `/v2/accounts/${testCase.candidateAccountId}/transactions/tx-unrelated-credit`,
        },
      }),
      ...(testCase.secondCandidateAccountId === null
        ? []
        : [
            makeCoinbaseRecord({
              externalRecordId: "tx-second-unrelated-credit",
              externalAccountId: testCase.secondCandidateAccountId,
              occurredAt: new Date(testCase.candidateOccurredAt),
              payload: {
                id: "tx-second-unrelated-credit",
                type: testCase.candidateType,
                status: "completed",
                amount: { amount: "0.98000000", currency: "ETH2" },
                native_amount: { amount: "1960.00", currency: "EUR" },
                created_at: testCase.candidateOccurredAt,
                resource_path: `/v2/accounts/${testCase.secondCandidateAccountId}/transactions/tx-second-unrelated-credit`,
              },
            }),
          ]),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const releaseRawRow = state.rawRows.find(
          (row) => row.externalRecordId === "tx-ungrouped-release-without-sibling"
        )

        expect(releaseRawRow?.normalizedAt).toBeNull()
        expect(releaseRawRow?.normalizationError).toContain(
          "Expected one unambiguous paired principal row"
        )
        expect(state.transactions.map((row) => row.externalId).sort()).toEqual(
          testCase.expectedTransactionIds
        )
      })
    )
  })

  it("does not pair two ungrouped releases with the same positive row", async () => {
    const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
        externalRecordId: "tx-first-competing-release",
        externalAccountId: "coinbase-account-1",
        occurredAt,
        payload: {
          id: "tx-first-competing-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-first-competing-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-second-competing-release",
        externalAccountId: "coinbase-account-2",
        occurredAt,
        payload: {
          id: "tx-second-competing-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.01000000", currency: "ETH2" },
          native_amount: { amount: "-2020.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-2/transactions/tx-second-competing-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-shared-credit",
        externalAccountId: "coinbase-account-3",
        occurredAt,
        payload: {
          id: "tx-shared-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.99000000", currency: "ETH2" },
          native_amount: { amount: "1980.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-3/transactions/tx-shared-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()
        const releaseRows = state.rawRows.filter((row) =>
          row.externalRecordId.endsWith("competing-release")
        )

        expect(releaseRows).toHaveLength(2)
        expect(releaseRows.every((row) => row.normalizedAt === null)).toBe(true)
        expect(
          releaseRows.every((row) =>
            row.normalizationError?.includes("Expected one unambiguous paired principal row")
          )
        ).toBe(true)
        expect(state.transactions.map((row) => row.externalId)).toEqual(["tx-shared-credit"])
        expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
      })
    )
  })

  it.each([
    { releaseStatus: "completed", creditStatus: "pending" },
    { releaseStatus: "completed", creditStatus: "failed" },
    { releaseStatus: "pending", creditStatus: "completed" },
    { releaseStatus: "failed", creditStatus: "completed" },
  ] as const)(
    "does not pair a $releaseStatus release with a $creditStatus credit",
    async ({ releaseStatus, creditStatus }) => {
      const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
          externalRecordId: "tx-status-release",
          externalParentId: "status-pair-group",
          occurredAt,
          payload: {
            id: "tx-status-release",
            type: "retail_instant_unstaking",
            status: releaseStatus,
            amount: { amount: "-1.00000000", currency: "ETH2" },
            native_amount: { amount: "-2000.00", currency: "EUR" },
            created_at: occurredAt.toISOString(),
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-status-release",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-status-credit",
          externalParentId: "status-pair-group",
          occurredAt,
          payload: {
            id: "tx-status-credit",
            type: "retail_instant_unstaking",
            status: creditStatus,
            amount: { amount: "0.99000000", currency: "ETH2" },
            native_amount: { amount: "1980.00", currency: "EUR" },
            created_at: occurredAt.toISOString(),
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-status-credit",
          },
        }),
      ]

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* seedCoinbaseSource()
          yield* runSync()
          const state = yield* fetchNormalizationState()
          const releaseRow = state.rawRows.find(
            (row) => row.externalRecordId === "tx-status-release"
          )
          const creditRow = state.rawRows.find((row) => row.externalRecordId === "tx-status-credit")

          expect(releaseRow?.normalizedAt).toBeNull()
          expect(releaseRow?.normalizationError).toContain(
            "Expected one unambiguous paired principal row"
          )
          expect(creditRow?.normalizedAt).not.toBeNull()
          expect(state.transactions.map((row) => row.externalId)).toEqual(["tx-status-credit"])
          expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
        })
      )
    }
  )

  it.each([
    { releaseStatus: "succeeded", creditStatus: "completed" },
    { releaseStatus: "completed", creditStatus: "succeeded" },
    { releaseStatus: "succeeded", creditStatus: "succeeded" },
  ] as const)(
    "pairs a $releaseStatus release with a $creditStatus credit",
    async ({ releaseStatus, creditStatus }) => {
      const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
          externalRecordId: "tx-success-status-release",
          externalParentId: "success-status-pair-group",
          occurredAt,
          payload: {
            id: "tx-success-status-release",
            type: "retail_instant_unstaking",
            status: releaseStatus,
            amount: { amount: "-1.00000000", currency: "ETH2" },
            native_amount: { amount: "-2000.00", currency: "EUR" },
            created_at: occurredAt.toISOString(),
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-success-status-release",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-success-status-credit",
          externalParentId: "success-status-pair-group",
          occurredAt,
          payload: {
            id: "tx-success-status-credit",
            type: "retail_instant_unstaking",
            status: creditStatus,
            amount: { amount: "0.99000000", currency: "ETH2" },
            native_amount: { amount: "1980.00", currency: "EUR" },
            created_at: occurredAt.toISOString(),
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-success-status-credit",
          },
        }),
      ]

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* seedCoinbaseSource()
          yield* runSync()
          const state = yield* fetchNormalizationState()

          expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
          expect(state.transactions.map((row) => row.externalId).sort()).toEqual([
            "tx-success-status-credit",
            "tx-success-status-release",
          ])
          expect(state.legs.filter((leg) => leg.kind === "fee")).toEqual([
            expect.objectContaining({
              derivationRule: "coinbase_retail_instant_unstaking_spread_fee",
              amount: expect.stringContaining("0.01000000"),
            }),
          ])
        })
      )
    }
  )

  it("pairs zero-spread ungrouped unstaking rows", async () => {
    const occurredAt = new Date("2025-05-01T10:00:00.000Z")
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
        externalRecordId: "tx-zero-spread-release",
        occurredAt,
        payload: {
          id: "tx-zero-spread-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-1.00000000", currency: "ETH2" },
          native_amount: { amount: "-2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-zero-spread-release",
        },
      }),
      makeCoinbaseRecord({
        externalRecordId: "tx-zero-spread-credit",
        externalAccountId: "coinbase-account-2",
        occurredAt,
        payload: {
          id: "tx-zero-spread-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "1.00000000", currency: "ETH2" },
          native_amount: { amount: "2000.00", currency: "EUR" },
          created_at: occurredAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-account-2/transactions/tx-zero-spread-credit",
        },
      }),
    ]

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()

        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(state.transactions.map((row) => row.externalId).sort()).toEqual([
          "tx-zero-spread-credit",
          "tx-zero-spread-release",
        ])
        expect(
          state.transactions.find((row) => row.externalId === "tx-zero-spread-release")?.metadata
        ).toEqual(
          expect.objectContaining({
            pairedRecord: expect.objectContaining({
              externalId: "tx-zero-spread-credit",
              pairingRule: "coinbase_unstaking_pair_v1",
              pairingKind: "exact_time_same_type",
              timestampDistanceMillis: 0,
            }),
          })
        )
        expect(state.legs.filter((leg) => leg.kind === "fee")).toHaveLength(0)
      })
    )
  })

  it("normalizes retail_instant_unstaking and retail_eth2_deprecation with mapping-driven behavior", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()

        expect(state.rawRows).toHaveLength(7)
        expect(state.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)

        expect(
          state.transactions
            .map((row) => ({
              externalId: row.externalId,
              externalGroupId: row.externalGroupId,
              providerTransactionType: row.providerTransactionType,
              transactionType: row.transactionType,
            }))
            .sort((left, right) => String(left.externalId).localeCompare(String(right.externalId)))
        ).toEqual([
          {
            externalId: "tx-eth2-migration-in",
            externalGroupId: "eth2-migration-1",
            providerTransactionType: "retail_eth2_deprecation",
            transactionType: "token_migration_transfer",
          },
          {
            externalId: "tx-eth2-migration-out",
            externalGroupId: "eth2-migration-1",
            providerTransactionType: "retail_eth2_deprecation",
            transactionType: "token_migration_transfer",
          },
          {
            externalId: "tx-unstake-alt-credit",
            externalGroupId: "unstake-group-2",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
          {
            externalId: "tx-unstake-alt-release",
            externalGroupId: "unstake-group-2",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
          {
            externalId: "tx-unstake-credit",
            externalGroupId: "unstake-group-1",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
          {
            externalId: "tx-unstake-release",
            externalGroupId: "unstake-group-1",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
        ])

        const sortedLegs = [...state.legs].sort((left, right) =>
          String(left.externalId).localeCompare(String(right.externalId))
        )
        expect(
          sortedLegs.map((row) => ({
            externalId: row.externalId,
            kind: row.kind,
            derivationRule: row.derivationRule,
          }))
        ).toEqual([
          {
            externalId: expect.stringContaining("tx-unstake-alt-release"),
            kind: "fee",
            derivationRule: "coinbase_retail_instant_unstaking_spread_fee",
          },
          {
            externalId: expect.stringContaining("tx-unstake-release"),
            kind: "fee",
            derivationRule: "coinbase_retail_instant_unstaking_spread_fee",
          },
        ])

        const [altSpreadFeeLeg, spreadFeeLeg] = sortedLegs
        expect(Number(spreadFeeLeg?.amount)).toBeCloseTo(0.015, 9)
        expect(Number(spreadFeeLeg?.fiatAmount)).toBeCloseTo(30, 6)
        expect(spreadFeeLeg?.fiatCurrency).toBe("EUR")
        expect(Number(altSpreadFeeLeg?.amount)).toBeCloseTo(0.01, 9)
        expect(Number(altSpreadFeeLeg?.fiatAmount)).toBeCloseTo(20, 6)
        expect(altSpreadFeeLeg?.fiatCurrency).toBe("EUR")

        expect(
          state.transactions.find((row) => row.externalId === "tx-unstake-release")?.metadata
        ).toEqual(
          expect.objectContaining({
            coinbaseReferenceMapping: expect.objectContaining({
              resolutionStrategy: "paired_spread_fee",
              transactionType: "staking_withdrawal",
            }),
            pairedRecord: expect.objectContaining({
              externalId: "tx-unstake-credit",
              pairingRule: "coinbase_unstaking_pair_v1",
              pairingKind: "provider_group",
              timestampDistanceMillis: 0,
            }),
          })
        )
        expect(
          state.transactions.find((row) => row.externalId === "tx-unstake-alt-release")?.metadata
        ).toEqual(
          expect.objectContaining({
            pairedRecord: expect.objectContaining({
              externalId: "tx-unstake-alt-credit",
              pairingRule: "coinbase_unstaking_pair_v1",
              pairingKind: "provider_group",
              timestampDistanceMillis: 0,
            }),
          })
        )
        expect(
          state.transactions.find((row) => row.externalId === "tx-eth2-migration-out")?.metadata
        ).toEqual(
          expect.objectContaining({
            coinbaseReferenceMapping: expect.objectContaining({
              resolutionStrategy: "no_leg",
              transactionType: "token_migration_transfer",
            }),
          })
        )
        expect(state.eth2Mapping?.assetRepresentationId).toBeNull()
        expect(state.eth2Mapping?.canonicalAssetId).toBe(ETH_ASSET_ID)
      })
    )
  })
})
