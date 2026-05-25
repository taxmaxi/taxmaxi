import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseReferenceMappingService,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClient,
} from "@my/sync-engine/providers/coinbase"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
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

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  externalParentId = null,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly externalParentId?: string | null
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId: "coinbase-account-1",
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
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-principal",
    externalParentId: "unstake-group-1",
    occurredAt: new Date("2025-05-01T10:00:00.000Z"),
    payload: {
      id: "tx-unstake-principal",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "1.25000000", currency: "ETH2" },
      native_amount: { amount: "2500.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-principal",
      description: "Instant unstaking principal release",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-unstake-fee",
    externalParentId: "unstake-group-1",
    occurredAt: new Date("2025-05-01T10:00:05.000Z"),
    payload: {
      id: "tx-unstake-fee",
      type: "retail_instant_unstaking",
      status: "completed",
      amount: { amount: "-0.01500000", currency: "ETH2" },
      native_amount: { amount: "-30.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:05.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-unstake-fee",
      description: "Instant unstaking spread",
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

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.succeed({
      records: syncRecords
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
      records: syncRecords
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
    SourceProviderRegistryLive.pipe(Layer.provide(CoinbaseSourceSyncProviderWithDepsLive))
  ),
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
      email: "coinbase-pr05-mapping@taxmaxi.test",
      name: "Coinbase PR-05 Mapping User",
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
      blockchainId: baseBlockchain.id,
      contractAddress: "eth-pr05-mapping",
      name: "Ethereum",
      symbol: "ETH",
      decimals: 8,
      type: "token",
    })

    yield* db.insert(schema.assets).values({
      blockchainId: baseBlockchain.id,
      contractAddress: "eur-pr05-mapping",
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
}: {
  readonly id: string
  readonly symbol: string
  readonly contractAddress: string
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
      blockchainId: baseBlockchain.id,
      contractAddress,
      name: `${symbol} Fixture`,
      symbol,
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
        canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
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
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const [eth2Mapping] = yield* db
      .select({
        canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
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
      eth2Mapping,
    }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("coinbase reference mappings", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(() =>
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
    }).pipe(Effect.runPromise)
  )

  it("seeds missing canonical default assets as pending review", async () => {
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
      canonicalAssetSymbol: "ADA",
      mappingStatus: "pending_review",
    })
    expect(dotMapping).toMatchObject({
      mappingKind: "asset",
      canonicalAssetId: null,
      canonicalAssetSymbol: "DOT",
      mappingStatus: "pending_review",
    })
    expect(adaMapping?.sourceNotes).toContain("no canonical assets row exists")
  })

  it("seeds existing BTC ETH and SOL default assets as approved canonical id mappings", async () => {
    await Effect.runPromise(
      Effect.all([
        seedCanonicalAsset({
          id: "00000000-0000-0000-0000-000000000902",
          symbol: "BTC",
          contractAddress: "coinbase-default-existing-btc",
        }),
        seedCanonicalAsset({
          id: "00000000-0000-0000-0000-000000000903",
          symbol: "ETH",
          contractAddress: "coinbase-default-existing-eth",
        }),
        seedCanonicalAsset({
          id: "00000000-0000-0000-0000-000000000904",
          symbol: "SOL",
          contractAddress: "coinbase-default-existing-sol",
        }),
      ])
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const mappings = await Effect.runPromise(fetchProviderAssetMappingRows())

    expect(mappings.find((mapping) => mapping.currencyCode === "BTC")).toMatchObject({
      canonicalAssetId: "00000000-0000-0000-0000-000000000902",
      canonicalAssetSymbol: "BTC",
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "ETH")).toMatchObject({
      canonicalAssetId: "00000000-0000-0000-0000-000000000903",
      canonicalAssetSymbol: "ETH",
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "SOL")).toMatchObject({
      canonicalAssetId: "00000000-0000-0000-0000-000000000904",
      canonicalAssetSymbol: "SOL",
      mappingStatus: "approved",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "ADA")).toMatchObject({
      canonicalAssetId: null,
      canonicalAssetSymbol: "ADA",
      mappingStatus: "pending_review",
    })
    expect(mappings.find((mapping) => mapping.currencyCode === "DOT")).toMatchObject({
      canonicalAssetId: null,
      canonicalAssetSymbol: "DOT",
      mappingStatus: "pending_review",
    })
  })

  it("does not overwrite reviewed provider asset mappings on later default refreshes", async () => {
    await Effect.runPromise(
      seedCanonicalAsset({
        id: "00000000-0000-0000-0000-000000000905",
        symbol: "BTC",
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
            canonicalAssetId: "00000000-0000-0000-0000-000000000905",
            canonicalAssetSymbol: "BTC",
            canonicalFiatCurrency: null,
            mappingStatus: "approved",
            reviewerNotes: "Admin reviewed ADA as BTC test fixture",
            sourceNotes: "Admin decision",
          })
          .onConflictDoUpdate({
            target: schema.providerAssetMappings.providerAssetRowId,
            set: {
              canonicalAssetId: "00000000-0000-0000-0000-000000000905",
              canonicalAssetSymbol: "BTC",
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
      canonicalAssetId: "00000000-0000-0000-0000-000000000905",
      canonicalAssetSymbol: "BTC",
      mappingStatus: "approved",
      reviewerNotes: "Admin reviewed ADA as BTC test fixture",
      sourceNotes: "Admin decision",
    })
  })

  it("backfills approved legacy default mappings that only stored a canonical symbol", async () => {
    await Effect.runPromise(
      seedCanonicalAsset({
        id: "00000000-0000-0000-0000-000000000906",
        symbol: "BTC",
        contractAddress: "coinbase-default-legacy-btc",
      })
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const btcMapping = (await Effect.runPromise(fetchProviderAssetMappingRows())).find(
      (mapping) => mapping.currencyCode === "BTC"
    )

    if (btcMapping === undefined) {
      expect.fail("Expected BTC provider asset mapping to exist")
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db
          .update(schema.providerAssetMappings)
          .set({
            canonicalAssetId: null,
            canonicalAssetSymbol: "BTC",
            mappingStatus: "approved",
            reviewerNotes: "Legacy reviewed note",
            sourceNotes: "Legacy seed",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, btcMapping.providerAssetRowId))
      }).pipe(Effect.provide(TestPgClientLive))
    )

    await runReferenceMapping(
      Effect.flatMap(CoinbaseReferenceMappingService, (service) => service.ensureDefaultMappings())
    )

    const refreshedBtcMapping = (await Effect.runPromise(fetchProviderAssetMappingRows())).find(
      (mapping) => mapping.currencyCode === "BTC"
    )

    expect(refreshedBtcMapping).toMatchObject({
      canonicalAssetId: "00000000-0000-0000-0000-000000000906",
      canonicalAssetSymbol: "BTC",
      mappingStatus: "approved",
      reviewerNotes: "Legacy reviewed note",
      sourceNotes: "Legacy seed",
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
      canonicalAssetSymbol: null,
      canonicalFiatCurrency: "EUR",
      mappingStatus: "approved",
    })
  })

  it("normalizes retail_instant_unstaking and retail_eth2_deprecation with mapping-driven behavior", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCoinbaseSource()
        yield* runSync()
        const state = yield* fetchNormalizationState()

        expect(state.rawRows).toHaveLength(5)
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
            externalId: "tx-unstake-fee",
            externalGroupId: "unstake-group-1",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
          {
            externalId: "tx-unstake-principal",
            externalGroupId: "unstake-group-1",
            providerTransactionType: "retail_instant_unstaking",
            transactionType: "staking_withdrawal",
          },
        ])

        expect(
          state.legs
            .map((row) => ({
              externalId: row.externalId,
              kind: row.kind,
              derivationRule: row.derivationRule,
            }))
            .sort((left, right) => String(left.externalId).localeCompare(String(right.externalId)))
        ).toEqual([
          {
            externalId: expect.stringContaining("tx-unstake-fee"),
            kind: "fee",
            derivationRule: "coinbase_retail_instant_unstaking_fee",
          },
          {
            externalId: expect.stringContaining("tx-unstake-principal"),
            kind: "acquisition",
            derivationRule: "coinbase_retail_instant_unstaking_principal",
          },
        ])

        expect(
          state.transactions.find((row) => row.externalId === "tx-unstake-principal")?.metadata
        ).toEqual(
          expect.objectContaining({
            coinbaseReferenceMapping: expect.objectContaining({
              resolutionStrategy: "amount_sign_fee",
              transactionType: "staking_withdrawal",
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
        expect(state.eth2Mapping?.canonicalAssetSymbol).toBe("ETH")
        expect(state.eth2Mapping?.canonicalAssetId).not.toBeNull()
      })
    )
  })
})
