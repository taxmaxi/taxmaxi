import { asc, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { AssetResolutionJobRepositoryLive } from "../../src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../src/layers/ProviderReferenceRepositoryLive.ts"
import { PortfolioRepositoryLive } from "../../src/layers/PortfolioRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { TransferReconciliationRepositoryLive } from "../../src/layers/TransferReconciliationRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PortfolioRepository } from "../../src/services/PortfolioRepository.ts"
import {
  TEST_EUR_ASSET_ID,
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_RAW_RECORD_ID,
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  SourceNormalizationRepository,
  SourceSyncCreditExhaustedError,
  TransferReconciliationRepository,
} from "@my/sync-engine/services"
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
const TEST_SOL_ASSET_ID = "00000000-0000-0000-0000-000000000483"

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const runTransferReconciliationRepository = <A, E>(
  effect: Effect.Effect<A, E, TransferReconciliationRepository>
) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: TransferReconciliationRepositoryLive }))

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchAccountsPage"),
  fetchTransactionsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchTransactionsPage"),
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
      {
        currencyCode: "SOL",
        name: "Solana",
        providerAssetId: "sol-provider-asset",
        exponent: 9,
        providerType: "crypto",
        payload: {
          code: "SOL",
          name: "Solana",
          exponent: 9,
          type: "crypto",
          asset_id: "sol-provider-asset",
        },
      },
    ] as const),
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(AssetResolutionJobRepositoryLive),
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
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(SourceRawRecordRepositoryLive)
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
  principalId: TEST_PRINCIPAL_ID,
  providerKey: "coinbase",
  cexAccountId,
  addressId: null,
  walletAddress: null,
})

const buildSeededRawRecord = ({
  rawRecordId,
  externalRecordId,
  occurredAt,
  payload,
  externalParentId = null,
  externalAccountId = "coinbase-account-1",
}: {
  readonly rawRecordId: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly externalParentId?: string | null
  readonly externalAccountId?: string
}): SourceRawRecord => ({
  id: rawRecordId,
  sourceId: TEST_SOURCE_ID,
  provider: "coinbase",
  recordType: "coinbase_transaction",
  externalAccountId,
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
  skipLegDerivation = false,
  omitProviderTransfers = false,
  providerTransferRole,
}: {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
  readonly skipLegDerivation?: boolean
  readonly omitProviderTransfers?: boolean
  readonly providerTransferRole?: "principal" | "fee"
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
    const providerTransfers = omitProviderTransfers
      ? []
      : prepared.providerTransfers.map((providerTransfer) => ({
          ...providerTransfer,
          metadata:
            providerTransferRole === undefined
              ? providerTransfer.metadata
              : { role: providerTransferRole },
        }))

    return yield* sourceNormalizationRepository.persistNormalizedArtifacts(
      prepared.legDerivationStrategy === "derive" && !skipLegDerivation
        ? {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers,
            canonicalTransfers: prepared.canonicalTransfers,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            deriveLegs: ({ transaction, venueContext, canonicalTransfers }) =>
              coinbaseSourceSyncProvider.deriveLegs({
                transaction,
                venueContext,
                primaryAsset: prepared.primaryAsset,
                canonicalTransfers,
                deriveMainLeg: prepared.deriveMainLeg,
              }),
          }
        : {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers,
            canonicalTransfers: prepared.canonicalTransfers,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            legs: [],
          }
    )
  })

describe("SourceNormalizationRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  // Shared by the credit tests: minimal billable buy artifacts for one raw record.
  const buildBuyArtifacts = ({
    externalId,
    occurredAt,
    sourceRawRecordId,
  }: {
    readonly externalId: string
    readonly occurredAt: Date
    readonly sourceRawRecordId: string
  }) =>
    ({
      transaction: {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId,
        externalId,
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "cex" as const,
        cexAccountId: fixture.cexAccountId,
        externalAccountId: "coinbase-account-1",
        externalOrderId: null,
        externalFillId: null,
        side: "buy" as const,
        instrument: "BTC-EUR",
        fillPrice: "10000.00",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: null,
      },
      providerTransfers: [],
      canonicalTransfers: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    }) as const

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
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({
            id: TEST_BTC_ASSET_ID,
            name: "Bitcoin",
            symbol: "BTC",
            type: "fungible",
          })
          .onConflictDoNothing({ target: schema.assets.id })
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

  it("keeps the canonical transaction ID stable after deletion and re-creation", async () => {
    const transaction = {
      sourceId: TEST_SOURCE_ID,
      sourceRawRecordId: TEST_RAW_RECORD_ID,
      externalId: null,
      externalGroupId: "group-stable-rematerialization",
      timestamp: new Date("2025-01-01T10:00:00.000Z"),
      transactionType: "buy_fiat",
      providerTransactionType: "buy",
      providerStatus: "completed",
      providerResourcePath:
        "/v2/accounts/coinbase-account-1/transactions/tx-stable-rematerialization",
      providerDescription: "Stable rematerialization fixture",
      providerCreatedAt: new Date("2025-01-01T10:00:00.000Z"),
      providerUpdatedAt: new Date("2025-01-01T10:00:00.000Z"),
      metadata: { provider: "coinbase" },
      principalId: TEST_PRINCIPAL_ID,
    } as const
    const venueContext = {
      venueType: "cex",
      cexAccountId: fixture.cexAccountId,
      externalAccountId: "coinbase-account-1",
      externalOrderId: null,
      externalFillId: null,
      side: "buy",
      instrument: "BTC-EUR",
      fillPrice: "10000",
      commissionAmount: null,
      commissionCurrency: null,
      metadata: { provider: "coinbase" },
    } as const
    const persist = (externalId: string | null) =>
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            transaction: { ...transaction, externalId },
            venueContext,
            providerTransfers: [],
            canonicalTransfers: [],
            legs: [],
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          })
        )
      )

    const first = await persist(null)
    const repeated = await persist(null)
    expect(repeated.transaction.id).toBe(first.transaction.id)
    const discovered = await persist("discovered-stable-external-id")
    const corrected = await persist("corrected-stable-external-id")
    expect(discovered.transaction.id).toBe(first.transaction.id)
    expect(corrected.transaction.id).toBe(first.transaction.id)
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.id, first.transaction.id))
      })
    )
    const recreated = await persist("corrected-stable-external-id")

    expect(recreated.transaction.id).toBe(first.transaction.id)
  })

  it("keeps an external-only transaction ID stable after deletion and re-creation", async () => {
    const timestamp = new Date("2025-01-01T10:00:00.000Z")
    const persist = () =>
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            transaction: {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: null,
              externalId: "external-only-stable-transaction",
              externalGroupId: null,
              timestamp,
              transactionType: "buy_fiat",
              providerTransactionType: "buy",
              providerStatus: "completed",
              providerResourcePath: null,
              providerDescription: "External-only stable transaction",
              providerCreatedAt: timestamp,
              providerUpdatedAt: timestamp,
              metadata: { provider: "test" },
              principalId: TEST_PRINCIPAL_ID,
            },
            venueContext: {
              venueType: "cex",
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "test-account",
              externalOrderId: null,
              externalFillId: null,
              side: "buy",
              instrument: "BTC-EUR",
              fillPrice: "10000",
              commissionAmount: null,
              commissionCurrency: null,
              metadata: { provider: "test" },
            },
            providerTransfers: [],
            canonicalTransfers: [],
            legs: [],
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          })
        )
      )

    const first = await persist()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.id, first.transaction.id))
      })
    )
    const recreated = await persist()

    expect(recreated.transaction.id).toBe(first.transaction.id)
  })

  it("reserves replay credits atomically before derived state can be reset", async () => {
    const secondRawRecordId = "00000000-0000-0000-0000-000000000484"
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:single-replay-credit",
          paymentReference: null,
          expiresAt: null,
        })
        yield* seedRawRecord({
          rawRecordId: secondRawRecordId,
          externalRecordId: "raw-replay-credit-second",
          occurredAt: new Date("2025-01-02T10:00:00.000Z"),
        })
      })
    )

    const replayCreditError = await runRepository(
      Effect.flip(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.reserveReplayTransactionCredits({
            reservationId: "replay-credit-atomicity",
            transactions: [
              {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                externalId: "replay-credit-first",
                principalId: TEST_PRINCIPAL_ID,
              },
              {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: secondRawRecordId,
                externalId: "replay-credit-second",
                principalId: TEST_PRINCIPAL_ID,
              },
            ],
          })
        )
      )
    )

    expect(replayCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
    expect(replayCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ count: sql<number>`count(*)` })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(Number(usage[0]?.count ?? 0)).toBe(0)
  })

  it("releases only the credits inserted by a failed replay reservation", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:replay-credit-compensation",
          paymentReference: null,
          expiresAt: null,
        })
      })
    )

    const references = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-credit-compensation",
          transactions: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "replay-credit-compensation",
              principalId: TEST_PRINCIPAL_ID,
            },
          ],
        })
      )
    )

    expect(references).toEqual([
      {
        reference: `transaction:${TEST_SOURCE_ID}:external:replay-credit-compensation`,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
      },
    ])

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.releaseReplayTransactionCredits({
          reservationId: "replay-credit-compensation",
          references: references.map(({ reference }) => reference),
        })
      )
    )

    const ledger = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ kind: schema.creditLedger.kind, reference: schema.creditLedger.reference })
          .from(schema.creditLedger)
      })
    )

    expect(ledger).toEqual([
      { kind: "manual_adjustment", reference: "test:replay-credit-compensation" },
    ])
  })

  it("lets a successor adopt a replay reservation before stale cleanup runs", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const transaction = {
      sourceId: TEST_SOURCE_ID,
      sourceRawRecordId: TEST_RAW_RECORD_ID,
      externalId: "replay-credit-adoption",
      externalGroupId: null,
      timestamp: occurredAt,
      transactionType: "buy_fiat",
      providerTransactionType: "buy",
      providerStatus: "completed",
      providerResourcePath: null,
      providerDescription: null,
      providerCreatedAt: occurredAt,
      providerUpdatedAt: occurredAt,
      metadata: null,
      principalId: TEST_PRINCIPAL_ID,
    } as const
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:replay-credit-adoption",
          paymentReference: null,
          expiresAt: null,
        })
      })
    )

    const first = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-owner-old",
          transactions: [transaction],
        })
      )
    )
    const adopted = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-owner-successor",
          transactions: [transaction],
        })
      )
    )
    const stalePersistence = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository
          .persistNormalizedArtifacts({
            replayReservationId: "replay-owner-old",
            transaction,
            venueContext: {
              venueType: "cex",
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "coinbase-account-1",
              externalOrderId: null,
              externalFillId: null,
              side: "buy",
              instrument: "BTC-EUR",
              fillPrice: "10000.00",
              commissionAmount: null,
              commissionCurrency: null,
              metadata: null,
            },
            providerTransfers: [],
            canonicalTransfers: [],
            legs: [],
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          })
          .pipe(Effect.result)
      )
    )
    await runRepository(
      Effect.gen(function* () {
        const repository = yield* SourceNormalizationRepository
        yield* repository.releaseReplayTransactionCredits({
          reservationId: "replay-owner-old",
          references: first.map(({ reference }) => reference),
        })
        yield* repository.persistNormalizedArtifacts({
          replayReservationId: "replay-owner-successor",
          transaction,
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: null,
          },
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
        yield* repository.releaseReplayTransactionCredits({
          reservationId: "replay-owner-successor",
          references: first.map(({ reference }) => reference),
        })
      })
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            reference: schema.creditLedger.reference,
            replayReservationId: schema.creditLedger.replayReservationId,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(stalePersistence._tag).toBe("Failure")
    expect(adopted).toEqual(first)
    expect(usage).toEqual([
      {
        reference: `transaction:${TEST_SOURCE_ID}:external:replay-credit-adoption`,
        replayReservationId: null,
      },
    ])
  })

  it("releases an adopted replay reservation when the successor fails", async () => {
    const transaction = {
      sourceId: TEST_SOURCE_ID,
      sourceRawRecordId: TEST_RAW_RECORD_ID,
      externalId: "replay-credit-adoption-failure",
      principalId: TEST_PRINCIPAL_ID,
    }
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:replay-credit-adoption-failure",
          paymentReference: null,
          expiresAt: null,
        })
      })
    )

    const first = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-owner-old",
          transactions: [transaction],
        })
      )
    )
    const adopted = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-owner-successor",
          transactions: [transaction],
        })
      )
    )

    await runRepository(
      Effect.gen(function* () {
        const repository = yield* SourceNormalizationRepository
        yield* repository.releaseReplayTransactionCredits({
          reservationId: "replay-owner-old",
          references: first.map(({ reference }) => reference),
        })
        yield* repository.releaseReplayTransactionCredits({
          reservationId: "replay-owner-successor",
          references: adopted.map(({ reference }) => reference),
        })
      })
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ reference: schema.creditLedger.reference })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(adopted).toEqual(first)
    expect(usage).toEqual([])
  })

  it("consumes one credit for a registered user transaction across source replay", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const artifacts = {
      transaction: {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "transaction-with-credit",
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "cex" as const,
        cexAccountId: fixture.cexAccountId,
        externalAccountId: "coinbase-account-1",
        externalOrderId: null,
        externalFillId: null,
        side: "buy" as const,
        instrument: "BTC-EUR",
        fillPrice: "10000.00",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: null,
      },
      providerTransfers: [],
      canonicalTransfers: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    } as const

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(artifacts)
      )
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.sourceRecordsRaw)
          .set({
            importedAt: new Date("2025-01-03T00:00:00.000Z"),
            updatedAt: new Date("2025-01-03T00:00:00.000Z"),
          })
          .where(eq(schema.sourceRecordsRaw.id, TEST_RAW_RECORD_ID))
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.externalId, "transaction-with-credit"))
      })
    )
    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(artifacts)
      )
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            count: sql<number>`count(*)`,
            totalDelta: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(Number(usage[0]?.count ?? 0)).toBe(1)
    expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
  })

  it("commits an earlier transaction and fails a typed credit-exhausted error once a registered user's balance runs out", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const secondRawRecordId = "00000000-0000-0000-0000-000000000382"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:single-usable-credit",
          expiresAt: null,
        })
      })
    )
    await runPg(
      seedRawRecord({
        rawRecordId: secondRawRecordId,
        externalRecordId: "raw-acquire-2",
        occurredAt,
      })
    )

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(
          buildBuyArtifacts({
            occurredAt,
            externalId: "transaction-covered-by-credit",
            sourceRawRecordId: TEST_RAW_RECORD_ID,
          })
        )
      )
    )

    const error = await runRepository(
      Effect.flip(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts(
            buildBuyArtifacts({
              occurredAt,
              externalId: "transaction-blocked-by-exhaustion",
              sourceRawRecordId: secondRawRecordId,
            })
          )
        )
      )
    )

    expect(error).toBeInstanceOf(SourceSyncCreditExhaustedError)
    expect(error).toMatchObject({
      _tag: "SourceSyncCreditExhaustedError",
      reasonCode: "no_usable_credits",
      availableCredits: 0,
    })

    const persistedTransactions = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ externalId: schema.transactions.externalId })
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
      })
    )

    expect(persistedTransactions.map((row) => row.externalId)).toEqual([
      "transaction-covered-by-credit",
    ])

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            count: sql<number>`count(*)`,
            totalDelta: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(Number(usage[0]?.count ?? 0)).toBe(1)
    expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
  })

  it("continues after a credit top-up and never charges a covered transaction twice", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const secondRawRecordId = "00000000-0000-0000-0000-000000000383"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:continue-initial-credit",
          expiresAt: null,
        })
      })
    )
    await runPg(
      seedRawRecord({
        rawRecordId: secondRawRecordId,
        externalRecordId: "raw-continue-2",
        occurredAt,
      })
    )

    const coveredArtifacts = buildBuyArtifacts({
      occurredAt,
      externalId: "transaction-continue-covered",
      sourceRawRecordId: TEST_RAW_RECORD_ID,
    })
    const pausedArtifacts = buildBuyArtifacts({
      occurredAt,
      externalId: "transaction-continue-paused",
      sourceRawRecordId: secondRawRecordId,
    })
    const persist = (artifacts: ReturnType<typeof buildBuyArtifacts>) =>
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts(artifacts)
        )
      )

    await persist(coveredArtifacts)
    const pauseError = await runRepository(
      Effect.flip(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts(pausedArtifacts)
        )
      )
    )
    expect(pauseError).toBeInstanceOf(SourceSyncCreditExhaustedError)

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 2,
          kind: "manual_adjustment",
          reference: "test:continue-top-up",
          expiresAt: null,
        })
      })
    )

    // The continue pass replays the paused transaction and may also revisit the
    // covered one; neither may produce a second usage charge.
    await persist(pausedArtifacts)
    await persist(coveredArtifacts)
    await persist(pausedArtifacts)

    const persistedTransactions = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ externalId: schema.transactions.externalId })
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
          .orderBy(asc(schema.transactions.externalId))
      })
    )
    expect(persistedTransactions.map((row) => row.externalId)).toEqual([
      "transaction-continue-covered",
      "transaction-continue-paused",
    ])

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            reference: schema.creditLedger.reference,
            delta: schema.creditLedger.delta,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
          .orderBy(asc(schema.creditLedger.reference))
      })
    )
    expect(usage).toHaveLength(2)
    expect(usage.map((row) => Number(row.delta))).toEqual([-1, -1])
    expect(new Set(usage.map((row) => row.reference)).size).toBe(2)
  })

  it("aggregates active credit entries by expiry before choosing a bucket", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const depletedExpiry = new Date(Date.now() + 60 * 60 * 1_000)
    const availableExpiry = new Date(Date.now() + 2 * 60 * 60 * 1_000)

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values([
          {
            userId: fixture.userId,
            delta: 2,
            kind: "manual_adjustment",
            reference: "test:depleted-expiring-grant",
            expiresAt: depletedExpiry,
          },
          {
            userId: fixture.userId,
            delta: -2,
            kind: "transaction_usage",
            reference: "test:depleted-expiring-usage",
            expiresAt: depletedExpiry,
          },
          {
            userId: fixture.userId,
            delta: 1,
            kind: "manual_adjustment",
            reference: "test:available-expiring-grant:first",
            expiresAt: availableExpiry,
          },
          {
            userId: fixture.userId,
            delta: 1,
            kind: "manual_adjustment",
            reference: "test:available-expiring-grant:second",
            expiresAt: availableExpiry,
          },
          {
            userId: fixture.userId,
            delta: 100,
            kind: "manual_adjustment",
            reference: "test:expired-grant",
            expiresAt: new Date(Date.now() - 60 * 60 * 1_000),
          },
          {
            userId: fixture.userId,
            delta: 2,
            kind: "manual_adjustment",
            reference: "test:permanent-grant",
            expiresAt: null,
          },
        ])
      })
    )

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "transaction-using-aggregated-credit-bucket",
            externalGroupId: null,
            timestamp: occurredAt,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: occurredAt,
            providerUpdatedAt: occurredAt,
            metadata: null,
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: null,
          },
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ expiresAt: schema.creditLedger.expiresAt })
          .from(schema.creditLedger)
          .where(
            eq(
              schema.creditLedger.reference,
              `transaction:${TEST_SOURCE_ID}:external:transaction-using-aggregated-credit-bucket`
            )
          )
      })
    )

    expect(usage).toEqual([{ expiresAt: availableExpiry }])
  })

  it("keeps a raw-record credit when replay later discovers external ids", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const artifacts = (externalId: string | null) =>
      ({
        transaction: {
          sourceId: TEST_SOURCE_ID,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
          externalId,
          externalGroupId: null,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex" as const,
          cexAccountId: fixture.cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy",
          instrument: "BTC-EUR",
          fillPrice: "10000.00",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      }) as const

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(artifacts(null))
      )
    )
    const firstReservation = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-discovers-external-a",
          transactions: [artifacts("discovered-external-a").transaction],
        })
      )
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
      })
    )
    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(artifacts("discovered-external-a"))
      )
    )
    const secondReservation = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-discovers-external-b",
          transactions: [artifacts("discovered-external-b").transaction],
        })
      )
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ reference: schema.creditLedger.reference })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(firstReservation).toEqual([])
    expect(secondReservation).toEqual([])
    expect(usage).toEqual([
      { reference: `transaction:${TEST_SOURCE_ID}:raw:${TEST_RAW_RECORD_ID}` },
    ])
  })

  it("migrates a corrected external credit identity and still deduplicates another raw row", async () => {
    const secondRawRecordId = "00000000-0000-0000-0000-000000000485"
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const artifacts = ({
      externalId,
      sourceRawRecordId,
    }: {
      readonly externalId: string
      readonly sourceRawRecordId: string
    }) =>
      ({
        transaction: {
          sourceId: TEST_SOURCE_ID,
          sourceRawRecordId,
          externalId,
          externalGroupId: null,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex" as const,
          cexAccountId: fixture.cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy",
          instrument: "BTC-EUR",
          fillPrice: "10000.00",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      }) as const
    const original = artifacts({
      externalId: "external-before-correction",
      sourceRawRecordId: TEST_RAW_RECORD_ID,
    })
    const corrected = artifacts({
      externalId: "external-after-correction",
      sourceRawRecordId: TEST_RAW_RECORD_ID,
    })

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(original)
      )
    )
    const correctionReservation = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.reserveReplayTransactionCredits({
          reservationId: "replay-corrects-external",
          transactions: [corrected.transaction],
        })
      )
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
        yield* seedRawRecord({
          rawRecordId: secondRawRecordId,
          externalRecordId: "raw-corrected-duplicate",
          occurredAt,
        })
      })
    )
    await runRepository(
      Effect.gen(function* () {
        const repository = yield* SourceNormalizationRepository
        yield* repository.persistNormalizedArtifacts(corrected)
        yield* repository.persistNormalizedArtifacts(
          artifacts({
            externalId: "external-after-correction",
            sourceRawRecordId: secondRawRecordId,
          })
        )
      })
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ delta: schema.creditLedger.delta, reference: schema.creditLedger.reference })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(correctionReservation).toEqual([])
    expect(usage).toEqual([
      {
        delta: -1,
        reference: `transaction:${TEST_SOURCE_ID}:external:external-after-correction`,
      },
    ])
  })

  it("allows only one concurrent transaction when one credit remains across sources", async () => {
    const secondSourceId = "00000000-0000-0000-0000-000000000481"
    const secondRawRecordId = "00000000-0000-0000-0000-000000000482"
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const secondCexAccountId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.insert(schema.creditLedger).values({
          userId: fixture.userId,
          delta: 1,
          kind: "manual_adjustment",
          reference: "test:one-concurrent-credit",
          paymentReference: null,
          expiresAt: null,
        })
        const [currentAccount] = yield* db
          .select({ cexId: schema.cexAccount.cexId })
          .from(schema.cexAccount)
          .where(eq(schema.cexAccount.id, fixture.cexAccountId))
          .limit(1)
        if (currentAccount === undefined) {
          return yield* Effect.die("Missing primary CEX account fixture")
        }
        const [secondAccount] = yield* db
          .insert(schema.cexAccount)
          .values({
            cexId: currentAccount.cexId,
            principalId: TEST_PRINCIPAL_ID,
            providerUserId: "coinbase-concurrent-user",
            providerAccountId: "coinbase-concurrent-account",
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            scopes: "wallet:accounts:read wallet:transactions:read",
          })
          .returning({ id: schema.cexAccount.id })
        if (secondAccount === undefined) {
          return yield* Effect.die("Failed to create second CEX account fixture")
        }
        yield* db.insert(schema.sources).values({
          id: secondSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Concurrent Coinbase Source",
          providerKey: "coinbase",
          sourceableType: "cex",
          cexAccountId: secondAccount.id,
          addressId: null,
        })
        yield* db.insert(schema.sourceRecordsRaw).values({
          id: secondRawRecordId,
          sourceId: secondSourceId,
          provider: "coinbase",
          recordType: "coinbase_transaction",
          externalAccountId: "coinbase-concurrent-account",
          externalRecordId: "raw-concurrent-second",
          occurredAt,
          payload: { id: "raw-concurrent-second" },
          importedAt: occurredAt,
        })
        return secondAccount.id
      })
    )

    const artifacts = ({
      sourceId,
      sourceRawRecordId,
      externalId,
      cexAccountId,
      externalAccountId,
    }: {
      readonly sourceId: string
      readonly sourceRawRecordId: string
      readonly externalId: string
      readonly cexAccountId: string
      readonly externalAccountId: string
    }) => ({
      transaction: {
        sourceId,
        sourceRawRecordId,
        externalId,
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat" as const,
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "cex" as const,
        cexAccountId,
        externalAccountId,
        externalOrderId: null,
        externalFillId: null,
        side: "buy" as const,
        instrument: "BTC-EUR",
        fillPrice: "10000.00",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: null,
      },
      providerTransfers: [],
      canonicalTransfers: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    })
    const results = await Promise.allSettled([
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts(
            artifacts({
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "concurrent-credit-first",
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "coinbase-account-1",
            })
          )
        )
      ),
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts(
            artifacts({
              sourceId: secondSourceId,
              sourceRawRecordId: secondRawRecordId,
              externalId: "concurrent-credit-second",
              cexAccountId: secondCexAccountId,
              externalAccountId: "coinbase-concurrent-account",
            })
          )
        )
      ),
    ])

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const usage = yield* db
          .select({
            count: sql<number>`count(*)`,
            delta: sql<number>`sum(${schema.creditLedger.delta})`,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
        const transactions = yield* db
          .select({ externalId: schema.transactions.externalId })
          .from(schema.transactions)
        return { usage, transactions }
      })
    )

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
    expect(Number(state.usage[0]?.count ?? 0)).toBe(1)
    expect(Number(state.usage[0]?.delta ?? 0)).toBe(-1)
    expect(
      state.transactions.filter(({ externalId }) => externalId?.startsWith("concurrent-credit-"))
    ).toHaveLength(1)
  })

  it("preserves x402 payment for raw records retained when a source is claimed", async () => {
    const anonymousPrincipalId = "00000000-0000-0000-0000-000000000491"
    const postClaimRawRecordId = "00000000-0000-0000-0000-000000000492"
    const claimConsumedAt = new Date("2025-01-02T00:00:00.000Z")
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const paidArtifacts = {
      transaction: {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "claimed-x402-paid-transaction",
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "cex" as const,
        cexAccountId: fixture.cexAccountId,
        externalAccountId: "coinbase-account-1",
        externalOrderId: null,
        externalFillId: null,
        side: "buy" as const,
        instrument: "BTC-EUR",
        fillPrice: "10000.00",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: null,
      },
      providerTransfers: [],
      canonicalTransfers: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    } as const

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
        yield* db.delete(schema.billingAccounts)
        yield* db.insert(schema.principals).values({
          id: anonymousPrincipalId,
          kind: "anonymous_wallet",
          userId: null,
        })
        yield* db.insert(schema.principalClaims).values({
          principalId: anonymousPrincipalId,
          sourceId: TEST_SOURCE_ID,
          requestId: "00000000-0000-0000-0000-000000000493",
          claimType: "x402_receipt",
          claimValueHash: "claimed-x402-paid-replay",
          consumedAt: claimConsumedAt,
        })
      })
    )

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(paidArtifacts)
      )
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transactions)
          .where(eq(schema.transactions.externalId, "claimed-x402-paid-transaction"))
      })
    )
    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(paidArtifacts)
      )
    )

    await runPg(
      seedRawRecord({
        rawRecordId: postClaimRawRecordId,
        externalRecordId: "raw-after-x402-claim",
        occurredAt: new Date("2025-01-03T00:00:00.000Z"),
      })
    )
    const postClaimCreditError = await runRepository(
      Effect.flip(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            ...paidArtifacts,
            transaction: {
              ...paidArtifacts.transaction,
              sourceRawRecordId: postClaimRawRecordId,
              externalId: "transaction-after-x402-claim",
              timestamp: new Date("2025-01-03T00:00:00.000Z"),
              providerCreatedAt: new Date("2025-01-03T00:00:00.000Z"),
              providerUpdatedAt: new Date("2025-01-03T00:00:00.000Z"),
            },
          })
        )
      )
    )

    expect(postClaimCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
    expect(postClaimCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const usage = yield* db
          .select({ count: sql<number>`count(*)` })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
        const transactions = yield* db
          .select({ externalId: schema.transactions.externalId })
          .from(schema.transactions)
        return { usage, transactions }
      })
    )

    expect(Number(state.usage[0]?.count ?? 0)).toBe(0)
    expect(state.transactions.map(({ externalId }) => externalId)).toContain(
      "claimed-x402-paid-transaction"
    )
    expect(state.transactions.map(({ externalId }) => externalId)).not.toContain(
      "transaction-after-x402-claim"
    )
  })

  it("rolls back a registered user transaction when credits are exhausted", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.creditLedger)
      })
    )

    const noCreditError = await runRepository(
      Effect.flip(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            transaction: {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "transaction-without-credit",
              externalGroupId: null,
              timestamp: occurredAt,
              transactionType: "buy_fiat",
              providerTransactionType: "buy",
              providerStatus: "completed",
              providerResourcePath: null,
              providerDescription: null,
              providerCreatedAt: occurredAt,
              providerUpdatedAt: occurredAt,
              metadata: null,
              principalId: TEST_PRINCIPAL_ID,
            },
            venueContext: {
              venueType: "cex",
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "coinbase-account-1",
              externalOrderId: null,
              externalFillId: null,
              side: "buy",
              instrument: "BTC-EUR",
              fillPrice: "10000.00",
              commissionAmount: null,
              commissionCurrency: null,
              metadata: null,
            },
            providerTransfers: [],
            canonicalTransfers: [],
            legs: [],
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          })
        )
      )
    )

    expect(noCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
    expect(noCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

    const persistedTransactions = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ count: sql<number>`count(*)` })
          .from(schema.transactions)
          .where(eq(schema.transactions.externalId, "transaction-without-credit"))
      })
    )

    expect(Number(persistedTransactions[0]?.count ?? 0)).toBe(0)
  })

  it("persists exact observed provider transfer representations", async () => {
    const occurredAt = new Date("2025-01-01T10:00:00.000Z")
    const smallestU8DecimalAmount = `0.${"0".repeat(254)}1`
    const sharedTransfer = {
      sourceId: TEST_SOURCE_ID,
      sourceRawRecordId: TEST_RAW_RECORD_ID,
      externalGroupId: "group-observed-representations",
      providerAssetId: null,
      timestamp: occurredAt,
      direction: "inbound" as const,
      processingMode: "accounting_and_evidence" as const,
      fromAccountRef: null,
      toAccountRef: null,
      fromAddress: "external-address",
      toAddress: "owned-address",
      networkName: "base",
      networkHash: "hash-observed-representations",
      observedBlockchainId: fixture.baseBlockchainId,
      observedContractAddress: null,
      observedMintAddress: null,
      amount: "1",
      metadata: { provider: "test-onchain-adapter" },
    }
    const providerTransfers = [
      {
        ...sharedTransfer,
        externalId: "observed-native",
        observedRepresentationType: "native" as const,
        observedDecimals: 18,
      },
      {
        ...sharedTransfer,
        externalId: "observed-token",
        observedRepresentationType: "token" as const,
        observedContractAddress: "0x0000000000000000000000000000000000000096",
        observedDecimals: 6,
      },
      {
        ...sharedTransfer,
        externalId: "observed-nft",
        observedRepresentationType: "nft" as const,
        observedMintAddress: "NftMint111111111111111111111111111111111111",
        observedDecimals: 0,
      },
      {
        ...sharedTransfer,
        externalId: "observed-unknown-type",
        observedRepresentationType: null,
        observedMintAddress: "UnknownMint11111111111111111111111111111111",
        observedDecimals: 5,
      },
      {
        ...sharedTransfer,
        externalId: "observed-max-decimals",
        observedRepresentationType: "token" as const,
        observedMintAddress: "MaxDecimalsMint111111111111111111111111111111",
        observedDecimals: 255,
        amount: smallestU8DecimalAmount,
      },
    ]

    const normalizedArtifacts = {
      transaction: {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "tx-observed-representations",
        externalGroupId: "group-observed-representations",
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: { provider: "test-onchain-adapter" },
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "dex",
        cexAccountId: null,
        externalAccountId: "owned-address",
        externalOrderId: null,
        externalFillId: null,
        side: null,
        instrument: null,
        fillPrice: null,
        commissionAmount: null,
        commissionCurrency: null,
        metadata: { provider: "test-onchain-adapter" },
      },
      providerTransfers,
      canonicalTransfers: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    } as const

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts(normalizedArtifacts)
      )
    )

    expect(result.providerTransfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "observed-native",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "native",
          observedContractAddress: null,
          observedMintAddress: null,
          observedDecimals: 18,
        }),
        expect.objectContaining({
          externalId: "observed-token",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "token",
          observedContractAddress: "0x0000000000000000000000000000000000000096",
          observedMintAddress: null,
          observedDecimals: 6,
        }),
        expect.objectContaining({
          externalId: "observed-nft",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: "nft",
          observedContractAddress: null,
          observedMintAddress: "NftMint111111111111111111111111111111111111",
          observedDecimals: 0,
        }),
        expect.objectContaining({
          externalId: "observed-unknown-type",
          observedBlockchainId: fixture.baseBlockchainId,
          observedRepresentationType: null,
          observedContractAddress: null,
          observedMintAddress: "UnknownMint11111111111111111111111111111111",
          observedDecimals: 5,
        }),
        expect.objectContaining({
          externalId: "observed-max-decimals",
          observedRepresentationType: "token",
          observedMintAddress: "MaxDecimalsMint111111111111111111111111111111",
          observedDecimals: 255,
          amount: smallestU8DecimalAmount,
        }),
      ])
    )

    const observedNativeTransfer = result.providerTransfers.find(
      (transfer) => transfer.externalId === "observed-native"
    )
    expect(observedNativeTransfer).toBeDefined()
    if (observedNativeTransfer === undefined) {
      return
    }

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [canonicalTransfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            principalId: TEST_PRINCIPAL_ID,
            externalId: "canonical-observed-native",
            externalGroupId: "group-observed-representations",
            addressId: null,
            blockchainId: null,
            txHash: null,
            timestamp: occurredAt,
            type: "cex",
            fromAddress: "external-address",
            toAddress: "owned-address",
            fromAccountRef: null,
            toAccountRef: null,
            fromPartyType: null,
            fromPartyResourcePath: null,
            toPartyType: null,
            toPartyResourcePath: null,
            assetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: null,
            amount: "1",
            tokenId: null,
            notes: null,
            metadata: { provider: "test-onchain-adapter" },
          })
          .returning({ id: schema.transfers.id })

        if (canonicalTransfer === undefined) {
          return yield* Effect.die("Failed to create canonical transfer fixture")
        }

        yield* db.insert(schema.transferReconciliations).values({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId: observedNativeTransfer.id,
          canonicalTransferId: canonicalTransfer.id,
          canonicalTransactionId: result.transaction.id,
          status: "auto_applied",
          matchReason: "test_stale_observation",
          confidence: "1",
          deterministic: true,
          reviewMetadata: null,
        })
      })
    )

    await expect(
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerTransfers)
            .set({ observedMintAddress: null })
            .where(eq(schema.providerTransfers.externalId, "observed-unknown-type"))
        })
      )
    ).rejects.toThrow()

    await expect(
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerTransfers)
            .set({ processingMode: "accounting_only" })
            .where(eq(schema.providerTransfers.externalId, "observed-native"))
        })
      )
    ).rejects.toThrow()

    await expect(
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerTransfers)
            .set({ processingMode: "stale" })
            .where(eq(schema.providerTransfers.externalId, "observed-native"))
        })
      )
    ).rejects.toThrow()

    await expect(
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerTransfers)
            .set({
              observedContractAddress: "0x0000000000000000000000000000000000000096",
            })
            .where(eq(schema.providerTransfers.externalId, "observed-unknown-type"))
        })
      )
    ).rejects.toThrow()

    await expect(
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerTransfers)
            .set({ observedDecimals: -1 })
            .where(eq(schema.providerTransfers.externalId, "observed-native"))
        })
      )
    ).rejects.toThrow()

    const partialRetryResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: providerTransfers.map((transfer) =>
            transfer.externalId === "observed-unknown-type"
              ? {
                  ...transfer,
                  observedDecimals: null,
                  amount: "2",
                  metadata: {
                    provider: "retry-without-exact-decimal-evidence",
                    rawUnits: "2",
                  },
                }
              : transfer
          ),
        })
      )
    )
    const partiallyRetriedUnknownType = partialRetryResult.providerTransfers.find(
      (transfer) => transfer.externalId === "observed-unknown-type"
    )

    expect(partiallyRetriedUnknownType).toMatchObject({
      observedBlockchainId: fixture.baseBlockchainId,
      observedRepresentationType: null,
      observedContractAddress: null,
      observedMintAddress: "UnknownMint11111111111111111111111111111111",
      observedDecimals: 5,
      amount: expect.stringMatching(/^2(?:\.0+)?$/),
      metadata: {
        provider: "retry-without-exact-decimal-evidence",
        rawUnits: "2",
      },
    })

    const retryResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: providerTransfers.map((transfer) =>
            transfer.externalId === "observed-unknown-type"
              ? {
                  ...transfer,
                  observedBlockchainId: null,
                  observedRepresentationType: null,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: null,
                  amount: "3",
                  metadata: {
                    provider: "retry-without-observed-representation",
                    rawUnits: "3",
                  },
                }
              : transfer
          ),
        })
      )
    )
    const retriedUnknownType = retryResult.providerTransfers.find(
      (transfer) => transfer.externalId === "observed-unknown-type"
    )

    expect(retriedUnknownType).toMatchObject({
      observedBlockchainId: fixture.baseBlockchainId,
      observedRepresentationType: null,
      observedContractAddress: null,
      observedMintAddress: "UnknownMint11111111111111111111111111111111",
      observedDecimals: 5,
      amount: expect.stringMatching(/^3(?:\.0+)?$/),
      metadata: {
        provider: "retry-without-observed-representation",
        rawUnits: "3",
      },
    })

    const correctedResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: providerTransfers.map((transfer) =>
            transfer.externalId === "observed-token"
              ? {
                  ...transfer,
                  observedContractAddress: null,
                  observedMintAddress: "CorrectedMint1111111111111111111111111111111",
                  observedDecimals: 9,
                  amount: "3",
                  metadata: { provider: "corrected-mint-observation", rawUnits: "3000000000" },
                }
              : transfer
          ),
        })
      )
    )
    const correctedToken = correctedResult.providerTransfers.find(
      (transfer) => transfer.externalId === "observed-token"
    )

    expect(correctedToken).toMatchObject({
      observedBlockchainId: fixture.baseBlockchainId,
      observedRepresentationType: "token",
      observedContractAddress: null,
      observedMintAddress: "CorrectedMint1111111111111111111111111111111",
      observedDecimals: 9,
      amount: expect.stringMatching(/^3(?:\.0+)?$/),
      metadata: { provider: "corrected-mint-observation", rawUnits: "3000000000" },
    })

    const nativeCorrectionResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: providerTransfers.map((transfer) =>
            transfer.externalId === "observed-token"
              ? {
                  ...transfer,
                  observedRepresentationType: "native" as const,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: 18,
                  amount: "4",
                  metadata: {
                    provider: "corrected-native-observation",
                    rawUnits: "4000000000000000000",
                  },
                }
              : transfer
          ),
        })
      )
    )
    const correctedNative = nativeCorrectionResult.providerTransfers.find(
      (transfer) => transfer.externalId === "observed-token"
    )

    expect(correctedNative).toMatchObject({
      observedBlockchainId: fixture.baseBlockchainId,
      observedRepresentationType: "native",
      observedContractAddress: null,
      observedMintAddress: null,
      observedDecimals: 18,
      amount: expect.stringMatching(/^4(?:\.0+)?$/),
      metadata: {
        provider: "corrected-native-observation",
        rawUnits: "4000000000000000000",
      },
    })

    const accountingOnlyResult = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: providerTransfers.map((transfer) =>
            transfer.externalId === "observed-nft"
              ? {
                  ...transfer,
                  observedBlockchainId: null,
                  observedRepresentationType: null,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: null,
                  processingMode: "accounting_only" as const,
                  metadata: { provider: "test-onchain-adapter" },
                }
              : transfer
          ),
        })
      )
    )
    expect(
      accountingOnlyResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-nft"
      )
    ).toMatchObject({
      observedBlockchainId: null,
      observedRepresentationType: null,
      observedContractAddress: null,
      observedMintAddress: null,
      observedDecimals: null,
      processingMode: "accounting_only",
      metadata: { provider: "test-onchain-adapter" },
    })

    const persistWithoutObservedTransfers = () =>
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            ...normalizedArtifacts,
            providerTransfers: [],
          })
        )
      )

    await expect(persistWithoutObservedTransfers()).rejects.toThrow(
      "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
    )

    const stateAfterRejectedRemoval = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const activeReconciliations = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id))
        const preservedTransfers = yield* db
          .select()
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))

        return { activeReconciliations, preservedTransfers }
      })
    )

    expect(stateAfterRejectedRemoval.activeReconciliations).toEqual([
      expect.objectContaining({
        providerTransferId: observedNativeTransfer.id,
        status: "auto_applied",
      }),
    ])
    expect(stateAfterRejectedRemoval.preservedTransfers).toHaveLength(5)
    expect(stateAfterRejectedRemoval.preservedTransfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "observed-native",
          observedRepresentationType: "native",
          observedDecimals: 18,
        }),
      ])
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transferReconciliations)
          .set({ status: "approved" })
          .where(eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id))
      })
    )
    await expect(persistWithoutObservedTransfers()).rejects.toThrow(
      "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id))
      })
    )
    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          ...normalizedArtifacts,
          providerTransfers: [],
        })
      )
    )

    const staleProviderTransfers = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))
      })
    )

    expect(staleProviderTransfers).toHaveLength(5)
    expect(staleProviderTransfers).toEqual(
      expect.arrayContaining(
        providerTransfers.map((transfer) =>
          expect.objectContaining({
            externalId: transfer.externalId,
            observedBlockchainId: null,
            observedRepresentationType: null,
            observedContractAddress: null,
            observedMintAddress: null,
            observedDecimals: null,
            processingMode: "stale",
          })
        )
      )
    )
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
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
              principalId: TEST_PRINCIPAL_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquire-1",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
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
            principalId: TEST_PRINCIPAL_ID,
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
    expect(acquisitionResult.canonicalTransfers).toHaveLength(1)
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
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
              principalId: TEST_PRINCIPAL_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
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
            principalId: TEST_PRINCIPAL_ID,
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: "00000000-0000-0000-0000-000000000382",
              externalId: "leg-dispose-1",
              txHash: null,
              timestamp: new Date("2025-02-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
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
    expect(counts.lot?.assetRepresentationId).toBe(TEST_BTC_REPRESENTATION_ID)
  })

  it("stores cost basis for the smallest supported acquisition quantity", async () => {
    const amount = `0.${"0".repeat(254)}1`
    const expectedCostBasisPerToken = `1${"0".repeat(255)}.000000000000000000`
    const timestamp = new Date("2025-01-01T10:00:00.000Z")

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-smallest-supported-acquisition",
            externalGroupId: "group-smallest-supported-acquisition",
            timestamp,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "test" },
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "test-account",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: null,
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "test" },
          },
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-smallest-supported-acquisition",
              txHash: null,
              timestamp,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount,
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "test_smallest_quantity",
              metadata: { provider: "test" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "1",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )
    const leg = result.legs[0]
    expect(leg).toBeDefined()
    if (leg === undefined) {
      return
    }

    const fifoLots = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceLegId, leg.id))
      })
    )

    expect(fifoLots).toEqual([
      expect.objectContaining({
        originalAmount: amount,
        remainingAmount: amount,
        costBasisPerToken: expectedCostBasisPerToken,
      }),
    ])
  })

  it("marks a fresh acquisition lot pending when its fiat value is missing", async () => {
    const timestamp = new Date("2025-01-01T10:00:00.000Z")

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-acquisition-without-fiat-value",
            externalGroupId: null,
            timestamp,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "test" },
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "test-account",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: null,
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "test" },
          },
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquisition-without-fiat-value",
              txHash: null,
              timestamp,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.5",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "test_missing_fiat_value",
              metadata: { provider: "test" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )
    const leg = result.legs[0]
    expect(leg).toBeDefined()
    if (leg === undefined) {
      return
    }

    const [lot] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceLegId, leg.id))
      })
    )

    expect(lot).toEqual(
      expect.objectContaining({
        costBasisPerToken: "0.000000000000000000",
        costBasisCurrency: "EUR",
        costBasisStatus: "pending_review",
      })
    )
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-acquire-2",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: insufficientRawRecordId,
              externalId: "leg-dispose-insufficient-1",
              txHash: null,
              timestamp: new Date("2025-02-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
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

  it("keeps FIFO inventory isolated by source for the same principal", async () => {
    const dependentSourceId = "00000000-0000-0000-0000-000000000282"
    const originTransactionId = "00000000-0000-0000-0000-000000000283"

    const lotId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            address: "bc1qcrosssourcefifo",
            type: "bitcoin",
            name: "Cross-source FIFO",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.addresses.id })

        if (address === undefined) {
          return yield* Effect.die("Failed to create cross-source FIFO address")
        }

        yield* db.insert(schema.sources).values({
          id: dependentSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Cross-source FIFO",
          providerKey: "bitcoin-rpc",
          sourceableType: "onchain",
          cexAccountId: null,
          addressId: address.id,
        })
        yield* db.insert(schema.transactions).values({
          id: originTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "cross-source-fifo-origin",
          timestamp: new Date("2025-01-01T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
        })
        const [originLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "cross-source-fifo-origin-leg",
            timestamp: new Date("2025-01-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: originTransactionId,
          })
          .returning({ id: schema.transactionLegs.id })

        if (originLeg === undefined) {
          return yield* Effect.die("Failed to create cross-source FIFO origin leg")
        }

        const [lot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
            originalAmount: "1.00000000",
            remainingAmount: "1.00000000",
            costBasisPerToken: "10000.00",
            costBasisCurrency: "EUR",
            sourceLegId: originLeg.id,
          })
          .returning({ id: schema.fifoLots.id })

        if (lot === undefined) {
          return yield* Effect.die("Failed to create cross-source FIFO lot")
        }

        return lot.id
      })
    )

    await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: dependentSourceId,
            sourceRawRecordId: null,
            externalId: "cross-source-fifo-disposal",
            externalGroupId: null,
            timestamp: new Date("2025-02-01T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "sell",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: null,
            providerUpdatedAt: null,
            metadata: null,
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "cross-source-fifo",
            externalOrderId: null,
            externalFillId: null,
            side: "sell",
            instrument: "BTC-EUR",
            fillPrice: "12000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: null,
          },
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [
            {
              sourceId: dependentSourceId,
              sourceRawRecordId: null,
              externalId: "cross-source-fifo-disposal-leg",
              txHash: null,
              timestamp: new Date("2025-02-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.40000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: "spot_sell",
              metadata: null,
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "4800.00",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
          resolvedTransactionType: {
            ...APPROVED_MAPPING,
            providerTransactionType: "sell",
            transactionType: "sell_fiat",
            inventoryEffect: "disposal",
          },
        })
      )
    )

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots).where(eq(schema.fifoLots.id, lotId))
        const matches = yield* db.select().from(schema.disposalMatches)
        const reviews = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.matchedLayer, "fifo_inventory"))
        return { lot, matches, reviews }
      })
    )
    expect(state.lot?.remainingAmount).toContain("1.00000000")
    expect(state.matches).toHaveLength(0)
    expect(state.reviews).toEqual([
      expect.objectContaining({
        reviewStatus: "needs_review",
        matchedLayer: "fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Insufficient FIFO inventory"),
      }),
    ])
  })

  it("serializes concurrent FIFO allocations for one principal", async () => {
    const firstRawRecordId = "00000000-0000-0000-0000-000000000721"
    const secondRawRecordId = "00000000-0000-0000-0000-000000000722"
    const openingTransactionId = "00000000-0000-0000-0000-000000000723"
    const occurredAt = new Date("2025-03-02T10:00:00.000Z")

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* Effect.forEach(
          [
            { id: firstRawRecordId, externalId: "raw-concurrent-fee-1" },
            { id: secondRawRecordId, externalId: "raw-concurrent-fee-2" },
          ],
          (record) =>
            seedRawRecord({
              rawRecordId: record.id,
              externalRecordId: record.externalId,
              occurredAt,
            })
        )
        yield* db.insert(schema.transactions).values({
          id: openingTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "tx-concurrent-opening",
          timestamp: new Date("2025-03-01T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
        })
        const [openingLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "leg-concurrent-opening",
            timestamp: new Date("2025-03-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: openingTransactionId,
          })
          .returning({ id: schema.transactionLegs.id })

        if (openingLeg === undefined) {
          return yield* Effect.die("Failed to seed concurrent FIFO opening leg")
        }

        yield* db.insert(schema.fifoLots).values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: new Date("2025-03-01T10:00:00.000Z"),
          originalAmount: "1.00000000",
          remainingAmount: "1.00000000",
          costBasisPerToken: "10000.00",
          costBasisCurrency: "EUR",
          sourceLegId: openingLeg.id,
        })
      })
    )

    const persistFee = ({ rawRecordId, sequence }: { rawRecordId: string; sequence: number }) =>
      runRepository(
        Effect.flatMap(SourceNormalizationRepository, (repository) =>
          repository.persistNormalizedArtifacts({
            transaction: {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawRecordId,
              externalId: `tx-concurrent-fee-${sequence}`,
              externalGroupId: null,
              timestamp: occurredAt,
              transactionType: "fee",
              providerTransactionType: "fee",
              providerStatus: "completed",
              providerResourcePath: null,
              providerDescription: "Concurrent fee fixture",
              providerCreatedAt: occurredAt,
              providerUpdatedAt: occurredAt,
              metadata: { provider: "fixture" },
              principalId: TEST_PRINCIPAL_ID,
            },
            venueContext: {
              venueType: "cex",
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "coinbase-account-1",
              externalOrderId: null,
              externalFillId: null,
              side: null,
              instrument: null,
              fillPrice: null,
              commissionAmount: null,
              commissionCurrency: null,
              metadata: { provider: "fixture" },
            },
            providerTransfers: [],
            canonicalTransfers: [],
            deriveLegs: ({ transaction }) =>
              Effect.succeed([
                {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: rawRecordId,
                  externalId: `leg-concurrent-fee-${sequence}`,
                  txHash: null,
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  addressId: null,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.60000000",
                  kind: "fee",
                  provenance: "deterministic",
                  derivationRule: "fixture_fee",
                  metadata: { provider: "fixture" },
                  transactionId: transaction.id,
                  sourceTransferId: null,
                  fiatAmount: null,
                  fiatCurrency: null,
                  feeForTransactionId: null,
                },
              ]),
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          })
        )
      )

    await Promise.all([
      persistFee({ rawRecordId: firstRawRecordId, sequence: 1 }),
      persistFee({ rawRecordId: secondRawRecordId, sequence: 2 }),
    ])

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const reviews = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.matchedLayer, "fifo_inventory"))
        return { lot, allocations, reviews }
      })
    )

    expect(state.lot?.remainingAmount).toContain("0.40000000")
    expect(state.allocations).toHaveLength(1)
    expect(state.allocations[0]?.matchedAmount).toContain("0.60000000")
    expect(state.reviews).toHaveLength(1)
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
            principalId: TEST_PRINCIPAL_ID,
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
          canonicalTransfers: [],
          legs: [],
          transactionReview: {
            principalId: TEST_PRINCIPAL_ID,
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
          .where(eq(schema.transactionReviews.principalId, TEST_PRINCIPAL_ID))
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

  it("persists Coinbase send movements without duplicating matching fee inventory", async () => {
    const acquisitionRawRecordId = "00000000-0000-0000-0000-000000000690"
    const acquiredAt = new Date("2025-03-01T10:00:00.000Z")
    const acquisitionPayload = {
      id: "tx-send-provider-transfer-opening-inventory",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: acquiredAt.toISOString(),
      resource_path:
        "/v2/accounts/coinbase-account-1/transactions/tx-send-provider-transfer-opening-inventory",
    }
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
      Effect.all([
        seedRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-provider-send-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
        seedRawRecord({
          rawRecordId,
          externalRecordId: "raw-provider-send-1",
          occurredAt,
          payload,
        }),
      ])
    )

    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-provider-send-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
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
    expect(result.canonicalTransfers).toHaveLength(1)
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
        const lots = yield* db.select().from(schema.fifoLots)
        const inventoryMovements = yield* db.select().from(schema.inventoryMovements)
        const reviews = yield* db.select().from(schema.transactionReviews)
        return {
          providerTransfers,
          legs,
          lots,
          inventoryMovements,
          reviews,
        }
      })
    )

    expect(counts.providerTransfers).toHaveLength(1)
    expect(counts.legs).toHaveLength(2)
    expect(counts.legs.filter((leg) => leg.kind === "disposal")).toHaveLength(0)
    expect(counts.lots).toEqual([
      expect.objectContaining({
        sourceId: TEST_SOURCE_ID,
        remainingAmount: expect.stringContaining("0.89990000"),
      }),
    ])
    expect(counts.inventoryMovements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "outbound",
          purpose: "principal",
          taxTreatment: "pending_review",
        }),
        expect.objectContaining({
          direction: "outbound",
          purpose: "fee",
          amount: expect.stringContaining("0.0001"),
        }),
      ])
    )
    expect(counts.reviews).toContainEqual(
      expect.objectContaining({
        reviewStatus: "needs_review",
        needsReview: true,
      })
    )

    const feeRoleRawRecordId = "00000000-0000-0000-0000-000000000698"
    const feeRoleAt = new Date("2025-03-03T10:00:00.000Z")
    const feeRolePayload = {
      ...payload,
      id: "tx-provider-fee-role-1",
      amount: { amount: "-0.00010000", currency: "BTC" },
      native_amount: { amount: "-150.00", currency: "EUR" },
      created_at: feeRoleAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-provider-fee-role-1",
      network: {
        ...payload.network,
        hash: "tx-provider-fee-role-hash-1",
      },
    }

    await runPg(
      seedRawRecord({
        rawRecordId: feeRoleRawRecordId,
        externalRecordId: "raw-provider-fee-role-1",
        occurredAt: feeRoleAt,
        payload: feeRolePayload,
      })
    )
    const feeRoleResult = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId: feeRoleRawRecordId,
          externalRecordId: "raw-provider-fee-role-1",
          occurredAt: feeRoleAt,
          payload: feeRolePayload,
        }),
        providerTransferRole: "fee",
      })
    )
    const feeRoleProviderTransfer = feeRoleResult.providerTransfers[0]
    const feeRoleState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [feeRoleMovement] = yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(
            eq(schema.inventoryMovements.providerTransferId, feeRoleProviderTransfer?.id ?? "")
          )
        const allocations = yield* db
          .select({
            matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
            providerTransferId: schema.inventoryMovements.providerTransferId,
            transactionLegId: schema.inventoryMovements.transactionLegId,
          })
          .from(schema.inventoryMovementAllocations)
          .innerJoin(
            schema.inventoryMovements,
            eq(
              schema.inventoryMovementAllocations.inventoryMovementId,
              schema.inventoryMovements.id
            )
          )
          .where(eq(schema.inventoryMovements.transactionId, feeRoleResult.transaction.id))
        const [lot] = yield* db.select().from(schema.fifoLots).limit(1)

        return { allocations, feeRoleMovement, lot }
      })
    )

    expect(feeRoleState.feeRoleMovement).toEqual(
      expect.objectContaining({
        direction: "outbound",
        purpose: "fee",
      })
    )
    expect(feeRoleState.allocations).toEqual([
      expect.objectContaining({
        matchedAmount: expect.stringContaining("0.00010000"),
        providerTransferId: null,
        transactionLegId: expect.any(String),
      }),
    ])
    expect(feeRoleState.lot?.remainingAmount).toContain("0.89980000")
  })

  it("does not allocate an internal-transfer outflow after its disposal leg consumed inventory", async () => {
    const acquisitionRawRecordId = "00000000-0000-0000-0000-000000000698"
    const acquiredAt = new Date("2025-03-01T10:00:00.000Z")
    const acquisitionPayload = {
      id: "tx-internal-transfer-opening-inventory",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: acquiredAt.toISOString(),
      resource_path:
        "/v2/accounts/coinbase-account-1/transactions/tx-internal-transfer-opening-inventory",
    }
    const rawRecordId = "00000000-0000-0000-0000-000000000699"
    const occurredAt = new Date("2025-04-01T10:00:00.000Z")
    const payload = {
      id: "tx-internal-transfer-outflow",
      type: "intx_withdrawal",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-internal-transfer-outflow",
    }

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-internal-transfer-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
        seedRawRecord({
          rawRecordId,
          externalRecordId: "raw-internal-transfer-outflow",
          occurredAt,
          payload,
        }),
      ])
    )

    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-internal-transfer-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
      })
    )

    const result = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
        sourceRecord: buildSeededRawRecord({
          rawRecordId,
          externalRecordId: "raw-internal-transfer-outflow",
          occurredAt,
          payload,
        }),
      })
    )

    expect(result.providerTransfers).toHaveLength(1)
    expect(result.legs).toEqual([expect.objectContaining({ kind: "disposal" })])

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const lots = yield* db.select().from(schema.fifoLots)
        const inventoryMovements = yield* db.select().from(schema.inventoryMovements)
        const inventoryMovementAllocations = yield* db
          .select()
          .from(schema.inventoryMovementAllocations)
        const disposalMatches = yield* db.select().from(schema.disposalMatches)

        return {
          lots,
          inventoryMovements,
          inventoryMovementAllocations,
          disposalMatches,
        }
      })
    )

    expect(state.lots).toEqual([
      expect.objectContaining({
        sourceId: TEST_SOURCE_ID,
        remainingAmount: expect.stringContaining("0.90000000"),
      }),
    ])
    expect(state.inventoryMovements).toEqual([
      expect.objectContaining({
        direction: "outbound",
        purpose: "principal",
        amount: expect.stringContaining("0.10000000"),
      }),
    ])
    expect(state.inventoryMovementAllocations).toHaveLength(0)
    expect(state.disposalMatches).toEqual([
      expect.objectContaining({ matchedAmount: expect.stringContaining("0.10000000") }),
    ])
  })

  it("rebuilds changed movement allocations and clears them for a pending replay", async () => {
    const acquisitionRawRecordId = "00000000-0000-0000-0000-000000000700"
    const acquiredAt = new Date("2025-03-01T10:00:00.000Z")
    const acquisitionPayload = {
      id: "tx-movement-replay-opening-inventory",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: acquiredAt.toISOString(),
      resource_path:
        "/v2/accounts/coinbase-account-1/transactions/tx-movement-replay-opening-inventory",
    }
    const rawRecordId = "00000000-0000-0000-0000-000000000701"
    const occurredAt = new Date("2025-04-01T10:00:00.000Z")
    const buildSendPayload = ({
      status,
      amount,
      feeAmount,
    }: {
      readonly status: "completed" | "pending" | "succeeded"
      readonly amount: string
      readonly feeAmount: string
    }) => ({
      id: "tx-movement-replay-send",
      type: "send",
      status,
      amount: { amount, currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-movement-replay-send",
      network: {
        status: "confirmed",
        hash: "tx-movement-replay-hash",
        network_name: "base",
        transaction_fee: { amount: feeAmount, currency: "BTC" },
      },
      to: {
        address: "bc1qmovementreplaydestination",
        resource: "address",
      },
    })
    const initialSendPayload = buildSendPayload({
      status: "completed",
      amount: "-0.10000000",
      feeAmount: "0.01000000",
    })

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-movement-replay-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
        seedRawRecord({
          rawRecordId,
          externalRecordId: "raw-movement-replay-send",
          occurredAt,
          payload: initialSendPayload,
        }),
      ])
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    const normalizeSend = (payload: ReturnType<typeof buildSendPayload>) =>
      runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source,
          sourceRecord: buildSeededRawRecord({
            rawRecordId,
            externalRecordId: "raw-movement-replay-send",
            occurredAt,
            payload,
          }),
        })
      )

    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-movement-replay-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
      })
    )
    await normalizeSend(initialSendPayload)
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.inventoryMovements)
          .set({
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
          })
          .where(eq(schema.inventoryMovements.sourceId, TEST_SOURCE_ID))
      })
    )
    await normalizeSend(
      buildSendPayload({
        status: "completed",
        amount: "-0.20000000",
        feeAmount: "0.02000000",
      })
    )

    const changedState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const movements = yield* db.select().from(schema.inventoryMovements)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        return { lot, movements, allocations }
      })
    )

    expect(changedState.lot?.remainingAmount).toContain("0.78000000")
    expect(changedState.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "principal",
          amount: expect.stringContaining("0.2"),
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
        }),
        expect.objectContaining({ purpose: "fee", amount: expect.stringContaining("0.02") }),
      ])
    )
    expect(changedState.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matchedAmount: expect.stringContaining("0.2") }),
        expect.objectContaining({ matchedAmount: expect.stringContaining("0.02") }),
      ])
    )

    await normalizeSend(
      buildSendPayload({
        status: "succeeded",
        amount: "-0.20000000",
        feeAmount: "0.02000000",
      })
    )

    const succeededState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const movements = yield* db.select().from(schema.inventoryMovements)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        return { lot, movements, allocations }
      })
    )

    expect(succeededState.lot?.remainingAmount).toContain("0.78000000")
    expect(succeededState.movements).toHaveLength(2)
    expect(succeededState.allocations).toHaveLength(2)

    await normalizeSend(
      buildSendPayload({
        status: "completed",
        amount: "-0.20000000",
        feeAmount: "0",
      })
    )

    const zeroFeeState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const movements = yield* db.select().from(schema.inventoryMovements)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        return { lot, movements, allocations }
      })
    )

    expect(zeroFeeState.lot?.remainingAmount).toContain("0.80000000")
    expect(zeroFeeState.movements).toEqual([
      expect.objectContaining({ purpose: "principal", amount: expect.stringContaining("0.2") }),
    ])
    expect(zeroFeeState.allocations).toEqual([
      expect.objectContaining({ matchedAmount: expect.stringContaining("0.2") }),
    ])

    await normalizeSend(
      buildSendPayload({
        status: "pending",
        amount: "-0.20000000",
        feeAmount: "0.02000000",
      })
    )

    const pendingState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const movements = yield* db.select().from(schema.inventoryMovements)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        return { lot, movements, allocations }
      })
    )

    expect(pendingState.lot?.remainingAmount).toContain("1.00000000")
    expect(pendingState.movements).toHaveLength(0)
    expect(pendingState.allocations).toHaveLength(0)
  })

  it("resets reconciliation when replay changes only the asset representation", async () => {
    const rawRecordId = "00000000-0000-0000-0000-000000000710"
    const occurredAt = new Date("2025-04-10T10:00:00.000Z")
    const payload = {
      id: "tx-representation-replay-send",
      type: "send",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-representation-replay-send",
      network: {
        status: "confirmed",
        hash: "tx-representation-replay-hash",
        network_name: "bitcoin",
      },
      to: {
        address: "bc1qrepresentationreplaydestination",
        resource: "address",
      },
    }

    await runPg(
      seedRawRecord({
        rawRecordId,
        externalRecordId: "raw-representation-replay-send",
        occurredAt,
        payload,
      })
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    const normalize = () =>
      runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source,
          sourceRecord: buildSeededRawRecord({
            rawRecordId,
            externalRecordId: "raw-representation-replay-send",
            occurredAt,
            payload,
          }),
        })
      )

    await normalize()
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .select({ id: schema.providerAssets.id })
          .from(schema.providerAssets)
          .where(eq(schema.providerAssets.currencyCode, "BTC"))
          .limit(1)

        if (providerAsset === undefined) {
          return yield* Effect.die("Missing Coinbase BTC provider asset")
        }

        yield* db
          .update(schema.providerAssetMappings)
          .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
        yield* db
          .update(schema.inventoryMovements)
          .set({ taxTreatment: "non_taxable", reconciliationStatus: "matched" })
          .where(eq(schema.inventoryMovements.purpose, "principal"))
      })
    )

    await normalize()

    const [movement] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.purpose, "principal"))
      })
    )

    expect(movement).toEqual(
      expect.objectContaining({
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
      })
    )
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
        skipLegDerivation: true,
        providerTransferRole: "principal",
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

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db.select().from(schema.providerTransfers)
        const [movement] = yield* db.select().from(schema.inventoryMovements)
        const lots = yield* db.select().from(schema.fifoLots)
        return { providerTransfer, movement, lots }
      })
    )
    const positions = await Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(PortfolioRepository, (repository) =>
          repository.listAssetPositions({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        ),
        layer: PortfolioRepositoryLive,
      })
    )

    expect(state.providerTransfer).toEqual(
      expect.objectContaining({
        externalId: "tx-receive-provider-transfer-1:principal",
        direction: "inbound",
        fromAddress: "bc1qprovidertransfersource",
        toAccountRef: "coinbase-account-1",
      })
    )
    expect(state.movement).toEqual(
      expect.objectContaining({
        providerTransferId: state.providerTransfer?.id,
        direction: "inbound",
        purpose: "principal",
        amount: expect.stringContaining("0.25000000"),
      })
    )
    expect(state.lots).toEqual([
      expect.objectContaining({
        sourceProviderTransferId: state.providerTransfer?.id,
        sourceLegId: null,
        costBasisStatus: "pending_review",
        originalAmount: expect.stringContaining("0.25000000"),
        remainingAmount: expect.stringContaining("0.25000000"),
      }),
    ])
    expect(positions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.25",
        costBasis: null,
        costBasisCurrency: null,
        costBasisStatus: "pending_review",
      }),
    ])
  })

  it("removes provider movements that disappear on replay and restores them when they return", async () => {
    const rawRecordId = "00000000-0000-0000-0000-000000000713"
    const occurredAt = new Date("2025-04-02T10:00:00.000Z")
    const receivePayload = {
      id: "tx-provider-transfer-disappears",
      type: "receive",
      status: "completed",
      amount: { amount: "0.25000000", currency: "BTC" },
      native_amount: { amount: "2500.00", currency: "EUR" },
      created_at: occurredAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-provider-transfer-disappears",
      from: { address: "bc1qprovidertransfersource", resource: "address" },
    }
    await runPg(
      seedRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-transfer-disappears",
        occurredAt,
        payload: receivePayload,
      })
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    const normalize = ({ omitProviderTransfers = false } = {}) =>
      runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source,
          sourceRecord: buildSeededRawRecord({
            rawRecordId,
            externalRecordId: "raw-provider-transfer-disappears",
            occurredAt,
            payload: receivePayload,
          }),
          skipLegDerivation: true,
          omitProviderTransfers,
        })
      )

    const initialResult = await normalize()
    const initialProviderTransfer = initialResult.providerTransfers[0]
    expect(initialProviderTransfer).toBeDefined()
    if (initialProviderTransfer === undefined) {
      return
    }

    await normalize({ omitProviderTransfers: true })

    const removedState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .select()
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, initialProviderTransfer.id))
        const movements = yield* db.select().from(schema.inventoryMovements)
        const lots = yield* db.select().from(schema.fifoLots)
        return { providerTransfer, movements, lots }
      })
    )

    expect(removedState.providerTransfer).toEqual(
      expect.objectContaining({
        id: initialProviderTransfer.id,
        processingMode: "stale",
      })
    )
    expect(removedState.movements).toHaveLength(0)
    expect(removedState.lots).toHaveLength(0)
    const staleReconciliationCandidates = await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.listProviderTransfersForReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    expect(
      staleReconciliationCandidates.some(
        ({ providerTransferId }) => providerTransferId === initialProviderTransfer.id
      )
    ).toBe(false)

    const restoredResult = await normalize()
    expect(restoredResult.providerTransfers).toEqual([
      expect.objectContaining({
        id: initialProviderTransfer.id,
        processingMode: "accounting_and_evidence",
      }),
    ])

    const restoredState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .select()
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, initialProviderTransfer.id))
        const movements = yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, initialProviderTransfer.id))
        const lots = yield* db.select().from(schema.fifoLots)
        return { providerTransfer, movements, lots }
      })
    )

    expect(restoredState.providerTransfer).toEqual(
      expect.objectContaining({
        id: initialProviderTransfer.id,
        processingMode: "accounting_and_evidence",
      })
    )
    expect(restoredState.movements).toEqual([
      expect.objectContaining({
        providerTransferId: initialProviderTransfer.id,
        direction: "inbound",
      }),
    ])
    expect(restoredState.lots).toEqual([
      expect.objectContaining({
        sourceProviderTransferId: initialProviderTransfer.id,
        originalAmount: expect.stringContaining("0.25000000"),
        remainingAmount: expect.stringContaining("0.25000000"),
      }),
    ])
    const restoredReconciliationCandidates = await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.listProviderTransfersForReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    expect(restoredReconciliationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerTransferId: initialProviderTransfer.id }),
      ])
    )
  })

  it("does not spend an unreconciled inbound provider lot", async () => {
    const receiveRawRecordId = "00000000-0000-0000-0000-000000000704"
    const sendRawRecordId = "00000000-0000-0000-0000-000000000705"
    const receiveAt = new Date("2025-04-02T10:00:00.000Z")
    const sendAt = new Date("2025-04-03T10:00:00.000Z")
    const receivePayload = {
      id: "tx-consumed-provider-receive",
      type: "receive",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: receiveAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-consumed-provider-receive",
      from: { address: "bc1qconsumedproviderlot", resource: "address" },
    }
    const sendPayload = {
      id: "tx-consuming-provider-send",
      type: "send",
      status: "completed",
      amount: { amount: "-0.80000000", currency: "BTC" },
      native_amount: { amount: "-8000.00", currency: "EUR" },
      created_at: sendAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-consuming-provider-send",
      to: { address: "bc1qconsumedproviderdestination", resource: "address" },
    }

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: receiveRawRecordId,
          externalRecordId: "raw-consumed-provider-receive",
          occurredAt: receiveAt,
          payload: receivePayload,
        }),
        seedRawRecord({
          rawRecordId: sendRawRecordId,
          externalRecordId: "raw-consuming-provider-send",
          occurredAt: sendAt,
          payload: sendPayload,
        }),
      ])
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: receiveRawRecordId,
          externalRecordId: "raw-consumed-provider-receive",
          occurredAt: receiveAt,
          payload: receivePayload,
        }),
        skipLegDerivation: true,
      })
    )
    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: sendRawRecordId,
          externalRecordId: "raw-consuming-provider-send",
          occurredAt: sendAt,
          payload: sendPayload,
        }),
        skipLegDerivation: true,
      })
    )

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [inboundLot] = yield* db
          .select()
          .from(schema.fifoLots)
          .where(sql`${schema.fifoLots.sourceProviderTransferId} is not null`)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const reviews = yield* db.select().from(schema.transactionReviews)
        return { inboundLot, allocations, reviews }
      })
    )

    expect(state.inboundLot).toEqual(
      expect.objectContaining({
        originalAmount: expect.stringContaining("1.00000000"),
        remainingAmount: expect.stringContaining("1.00000000"),
      })
    )
    expect(state.allocations).toHaveLength(0)
    expect(state.reviews).toContainEqual(
      expect.objectContaining({
        matchedLayer: "coinbase_reference_mapping,fifo_inventory",
        needsReview: true,
        categorizationReason: expect.stringContaining("Insufficient FIFO inventory"),
      })
    )
  })

  it("allocates a completed Coinbase send network fee separately from its principal", async () => {
    const acquisitionRawRecordId = "00000000-0000-0000-0000-000000000720"
    const sendRawRecordId = "00000000-0000-0000-0000-000000000721"
    const acquiredAt = new Date("2025-04-01T10:00:00.000Z")
    const sentAt = new Date("2025-04-02T10:00:00.000Z")
    const acquisitionPayload = {
      id: "tx-partial-movement-opening-inventory",
      type: "buy",
      status: "completed",
      amount: { amount: "0.25000000", currency: "BTC" },
      native_amount: { amount: "2500.00", currency: "EUR" },
      created_at: acquiredAt.toISOString(),
      resource_path:
        "/v2/accounts/coinbase-account-1/transactions/tx-partial-movement-opening-inventory",
    }
    const sendPayload = {
      id: "tx-partial-movement-send",
      type: "send",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1000.00", currency: "EUR" },
      created_at: sentAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-partial-movement-send",
      network: {
        status: "confirmed",
        hash: "tx-partial-movement-send-hash",
        network_name: "base",
        transaction_fee: { amount: "0.10000000", currency: "BTC" },
      },
      to: {
        address: "bc1qpartialmovementdestination",
        resource: "address",
      },
    }

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-partial-movement-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
        seedRawRecord({
          rawRecordId: sendRawRecordId,
          externalRecordId: "raw-partial-movement-send",
          occurredAt: sentAt,
          payload: sendPayload,
        }),
      ])
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: acquisitionRawRecordId,
          externalRecordId: "raw-partial-movement-opening-inventory",
          occurredAt: acquiredAt,
          payload: acquisitionPayload,
        }),
      })
    )
    const result = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: sendRawRecordId,
          externalRecordId: "raw-partial-movement-send",
          occurredAt: sentAt,
          payload: sendPayload,
        }),
      })
    )

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots).limit(1)
        const movements = yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.transactionId, result.transaction.id))
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const [review] = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
        return { lot, movements, allocations, review }
      })
    )

    expect(state.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: "principal", amount: expect.stringContaining("0.1") }),
        expect.objectContaining({ purpose: "fee", amount: expect.stringContaining("0.1") }),
      ])
    )
    expect(state.allocations).toEqual([
      expect.objectContaining({ matchedAmount: expect.stringContaining("0.1") }),
      expect.objectContaining({ matchedAmount: expect.stringContaining("0.1") }),
    ])
    expect(state.lot?.remainingAmount).toContain("0.05000000")
    expect(state.review).toEqual(
      expect.objectContaining({
        reviewStatus: "needs_review",
        matchedLayer: "coinbase_reference_mapping",
        needsReview: true,
      })
    )
  })

  it("allocates a completed Coinbase send network fee paid in another asset", async () => {
    const btcOpeningAt = new Date("2025-04-01T10:00:00.000Z")
    const solOpeningAt = new Date("2025-04-01T11:00:00.000Z")
    const sentAt = new Date("2025-04-02T10:00:00.000Z")
    const records = [
      {
        rawRecordId: "00000000-0000-0000-0000-000000000722",
        externalRecordId: "btc-opening-for-cross-asset-fee",
        occurredAt: btcOpeningAt,
        payload: {
          id: "btc-opening-for-cross-asset-fee",
          type: "buy",
          status: "completed",
          amount: { amount: "1.00000000", currency: "BTC" },
          native_amount: { amount: "10000.00", currency: "EUR" },
          created_at: btcOpeningAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/btc-opening-for-cross-asset-fee",
        },
      },
      {
        rawRecordId: "00000000-0000-0000-0000-000000000723",
        externalRecordId: "sol-opening-for-cross-asset-fee",
        occurredAt: solOpeningAt,
        payload: {
          id: "sol-opening-for-cross-asset-fee",
          type: "buy",
          status: "completed",
          amount: { amount: "1.000000000", currency: "SOL" },
          native_amount: { amount: "100.00", currency: "EUR" },
          created_at: solOpeningAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/sol-opening-for-cross-asset-fee",
        },
      },
      {
        rawRecordId: "00000000-0000-0000-0000-000000000724",
        externalRecordId: "btc-send-with-sol-network-fee",
        occurredAt: sentAt,
        payload: {
          id: "btc-send-with-sol-network-fee",
          type: "send",
          status: "completed",
          amount: { amount: "-0.10000000", currency: "BTC" },
          native_amount: { amount: "-1000.00", currency: "EUR" },
          created_at: sentAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-account-1/transactions/btc-send-with-sol-network-fee",
          network: {
            status: "confirmed",
            hash: "btc-send-with-sol-network-fee-hash",
            network_name: "bitcoin",
            transaction_fee: { amount: "0.010000000", currency: "SOL" },
          },
          to: {
            address: "bc1qcrossassetfeedestination",
            resource: "address",
          },
        },
      },
    ] as const

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_SOL_ASSET_ID,
          name: "Sync Engine Solana Cross-Asset Fee Fixture",
          symbol: "SOL",
          coingeckoCoinId: "solana",
          type: "fungible",
        })

        yield* Effect.forEach(records, (record) => seedRawRecord(record))
      })
    )

    for (const record of records) {
      await runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
          sourceRecord: buildSeededRawRecord(record),
        })
      )
    }

    const positions = await Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(PortfolioRepository, (repository) =>
          repository.listAssetPositions({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        ),
        layer: PortfolioRepositoryLive,
      })
    )

    expect(positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: TEST_BTC_ASSET_ID, amount: "0.9" }),
        expect.objectContaining({ assetId: TEST_SOL_ASSET_ID, amount: "0.99" }),
      ])
    )
  })

  it("moves a replayed fee movement to the leg's current transaction and raw record", async () => {
    const newRawRecordId = "00000000-0000-0000-0000-000000000710"
    const openingTransactionId = "00000000-0000-0000-0000-000000000711"
    const oldTransactionId = "00000000-0000-0000-0000-000000000712"
    const feeLegExternalId = "fee-leg-moved-between-transactions"
    const occurredAt = new Date("2025-04-03T10:00:00.000Z")

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* seedRawRecord({
          rawRecordId: newRawRecordId,
          externalRecordId: "raw-fee-new-parent",
          occurredAt,
        })
        yield* db.insert(schema.transactions).values([
          {
            id: openingTransactionId,
            sourceId: TEST_SOURCE_ID,
            externalId: "fee-opening-transaction",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          },
          {
            id: oldTransactionId,
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "fee-old-parent",
            timestamp: new Date("2025-04-02T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          },
        ])
        const [openingLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "fee-opening-leg",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            transactionId: openingTransactionId,
          })
          .returning({ id: schema.transactionLegs.id })
        const [feeLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: feeLegExternalId,
            timestamp: new Date("2025-04-02T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "fee",
            provenance: "deterministic",
            transactionId: oldTransactionId,
            feeForTransactionId: oldTransactionId,
          })
          .returning({ id: schema.transactionLegs.id })

        if (openingLeg === undefined || feeLeg === undefined) {
          return yield* Effect.die("Failed to create replayed fee movement legs")
        }

        const [lot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "1.00000000",
            remainingAmount: "0.90000000",
            costBasisPerToken: "10000.00",
            costBasisCurrency: "EUR",
            sourceLegId: openingLeg.id,
          })
          .returning({ id: schema.fifoLots.id })
        const [movement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            transactionId: oldTransactionId,
            transactionLegId: feeLeg.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-02T10:00:00.000Z"),
            direction: "outbound",
            purpose: "fee",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (lot === undefined || movement === undefined) {
          return yield* Effect.die("Failed to create replayed fee movement allocation")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: movement.id,
          fifoLotId: lot.id,
          matchedAmount: "0.10000000",
        })
      })
    )

    const result = await runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: newRawRecordId,
            externalId: "fee-new-parent",
            externalGroupId: null,
            timestamp: occurredAt,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: occurredAt,
            providerUpdatedAt: occurredAt,
            metadata: { provider: "coinbase" },
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "fee-new-parent-order",
            externalFillId: null,
            side: null,
            instrument: null,
            fillPrice: null,
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          canonicalTransfers: [],
          deriveLegs: ({ transaction }) =>
            Effect.succeed([
              {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: newRawRecordId,
                externalId: feeLegExternalId,
                txHash: null,
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                addressId: null,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.10000000",
                kind: "fee" as const,
                provenance: "deterministic" as const,
                derivationRule: "commission",
                metadata: { provider: "coinbase" },
                transactionId: transaction.id,
                sourceTransferId: null,
                fiatAmount: null,
                fiatCurrency: null,
                feeForTransactionId: transaction.id,
              },
            ]),
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

    const [movement] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.inventoryMovements)
      })
    )

    expect(movement).toEqual(
      expect.objectContaining({
        transactionId: result.transaction.id,
        sourceRawRecordId: newRawRecordId,
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
      })
    )
  })

  it("removes an unused inbound provider lot before replaying the transfer as outbound", async () => {
    const openingRawRecordId = "00000000-0000-0000-0000-000000000706"
    const correctedRawRecordId = "00000000-0000-0000-0000-000000000707"
    const openingAt = new Date("2025-04-01T10:00:00.000Z")
    const correctedAt = new Date("2025-04-02T10:00:00.000Z")
    const openingPayload = {
      id: "tx-direction-flip-opening",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: openingAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-direction-flip-opening",
    }
    const buildCorrectedPayload = (direction: "inbound" | "outbound") => ({
      id: "tx-direction-flip",
      type: direction === "inbound" ? "receive" : "send",
      status: "completed",
      amount: { amount: direction === "inbound" ? "0.50000000" : "-0.50000000", currency: "BTC" },
      native_amount: { amount: "5000.00", currency: "EUR" },
      created_at: correctedAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-direction-flip",
      from:
        direction === "inbound" ? { address: "bc1qfliporigin", resource: "address" } : undefined,
      to:
        direction === "outbound"
          ? { address: "bc1qflipdestination", resource: "address" }
          : undefined,
    })

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: openingRawRecordId,
          externalRecordId: "raw-direction-flip-opening",
          occurredAt: openingAt,
          payload: openingPayload,
        }),
        seedRawRecord({
          rawRecordId: correctedRawRecordId,
          externalRecordId: "raw-direction-flip",
          occurredAt: correctedAt,
          payload: buildCorrectedPayload("inbound"),
        }),
      ])
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: openingRawRecordId,
          externalRecordId: "raw-direction-flip-opening",
          occurredAt: openingAt,
          payload: openingPayload,
        }),
      })
    )

    for (const direction of ["inbound", "outbound"] as const) {
      await runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source,
          sourceRecord: buildSeededRawRecord({
            rawRecordId: correctedRawRecordId,
            externalRecordId: "raw-direction-flip",
            occurredAt: correctedAt,
            payload: buildCorrectedPayload(direction),
          }),
          skipLegDerivation: true,
        })
      )
    }

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const lots = yield* db.select().from(schema.fifoLots)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        return { lots, allocations }
      })
    )

    expect(state.lots).toEqual([
      expect.objectContaining({
        sourceProviderTransferId: null,
        remainingAmount: expect.stringContaining("0.50000000"),
      }),
    ])
    expect(state.allocations).toEqual([
      expect.objectContaining({ matchedAmount: expect.stringContaining("0.50000000") }),
    ])
  })

  it("records a failed Coinbase network fee leg as a custody movement", async () => {
    const openingRawRecordId = "00000000-0000-0000-0000-000000000708"
    const feeRawRecordId = "00000000-0000-0000-0000-000000000709"
    const openingAt = new Date("2025-04-01T10:00:00.000Z")
    const feeAt = new Date("2025-04-02T10:00:00.000Z")
    const openingPayload = {
      id: "tx-failed-fee-opening",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: openingAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-failed-fee-opening",
    }
    const failedFeePayload = {
      id: "tx-failed-onchain-fee",
      type: "send",
      status: "failed",
      amount: { amount: "-0.01000000", currency: "BTC" },
      native_amount: { amount: "-100.00", currency: "EUR" },
      created_at: feeAt.toISOString(),
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-failed-onchain-fee",
      to: { address: "bc1qfailedfeedestination", resource: "address" },
      network: {
        status: "failed",
        transaction_fee: { amount: "0.01000000", currency: "BTC" },
      },
    }

    await runPg(
      Effect.all([
        seedRawRecord({
          rawRecordId: openingRawRecordId,
          externalRecordId: "raw-failed-fee-opening",
          occurredAt: openingAt,
          payload: openingPayload,
        }),
        seedRawRecord({
          rawRecordId: feeRawRecordId,
          externalRecordId: "raw-failed-onchain-fee",
          occurredAt: feeAt,
          payload: failedFeePayload,
        }),
      ])
    )

    const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
    await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: openingRawRecordId,
          externalRecordId: "raw-failed-fee-opening",
          occurredAt: openingAt,
          payload: openingPayload,
        }),
      })
    )
    const result = await runCoinbaseNormalization(
      persistCoinbaseNormalization({
        source,
        sourceRecord: buildSeededRawRecord({
          rawRecordId: feeRawRecordId,
          externalRecordId: "raw-failed-onchain-fee",
          occurredAt: feeAt,
          payload: failedFeePayload,
        }),
      })
    )

    expect(result.legs).toEqual([expect.objectContaining({ kind: "fee" })])

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [lot] = yield* db.select().from(schema.fifoLots)
        const [movement] = yield* db.select().from(schema.inventoryMovements)
        return { lot, movement }
      })
    )

    expect(state.lot?.remainingAmount).toContain("0.99000000")
    expect(state.movement).toEqual(
      expect.objectContaining({
        direction: "outbound",
        purpose: "fee",
        amount: expect.stringContaining("0.01000000"),
        providerTransferId: null,
        transactionLegId: expect.any(String),
      })
    )
  })

  it("projects the exact SOL balance after instant unstaking and an unmatched send", async () => {
    const openingAt = new Date("2025-05-01T09:00:00.000Z")
    const unstakingAt = new Date("2025-05-02T10:00:00.000Z")
    const sendAt = new Date("2025-05-03T11:00:00.000Z")
    const records = [
      {
        rawRecordId: "00000000-0000-0000-0000-000000000694",
        externalRecordId: "sol-opening-inventory",
        externalAccountId: "coinbase-sol-primary",
        externalParentId: null,
        occurredAt: openingAt,
        payload: {
          id: "sol-opening-inventory",
          type: "buy",
          status: "completed",
          amount: { amount: "45.99611069037", currency: "SOL" },
          native_amount: { amount: "4599.611069037", currency: "EUR" },
          created_at: openingAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-sol-primary/transactions/sol-opening-inventory",
        },
      },
      {
        // Live instant-unstaking rows can omit both `idem` and an order id, so
        // neither side has a durable provider group identifier.
        rawRecordId: "00000000-0000-0000-0000-000000000695",
        externalRecordId: "sol-instant-unstaking-credit",
        externalAccountId: "coinbase-sol-primary",
        externalParentId: null,
        occurredAt: unstakingAt,
        payload: {
          id: "sol-instant-unstaking-credit",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "0.95693779863", currency: "SOL" },
          native_amount: { amount: "99.08", currency: "EUR" },
          created_at: unstakingAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-sol-primary/transactions/sol-instant-unstaking-credit",
        },
      },
      {
        rawRecordId: "00000000-0000-0000-0000-000000000696",
        externalRecordId: "sol-instant-unstaking-release",
        externalAccountId: "coinbase-sol-staking",
        externalParentId: null,
        occurredAt: unstakingAt,
        payload: {
          id: "sol-instant-unstaking-release",
          type: "retail_instant_unstaking",
          status: "completed",
          amount: { amount: "-0.966603837", currency: "SOL" },
          native_amount: { amount: "-100.08", currency: "EUR" },
          created_at: unstakingAt.toISOString(),
          resource_path:
            "/v2/accounts/coinbase-sol-staking/transactions/sol-instant-unstaking-release",
        },
      },
      {
        rawRecordId: "00000000-0000-0000-0000-000000000697",
        externalRecordId: "sol-external-send",
        externalAccountId: "coinbase-sol-primary",
        externalParentId: null,
        occurredAt: sendAt,
        payload: {
          id: "sol-external-send",
          type: "send",
          status: "completed",
          amount: { amount: "-0.956937799", currency: "SOL" },
          native_amount: { amount: "-99.06", currency: "EUR" },
          created_at: sendAt.toISOString(),
          resource_path: "/v2/accounts/coinbase-sol-primary/transactions/sol-external-send",
          network: {
            status: "confirmed",
            hash: "sol-external-send-hash",
            network_name: "solana",
            transaction_fee: { amount: "0.0001", currency: "SOL" },
          },
          to: {
            address: "sol-external-destination",
            resource: "address",
          },
        },
      },
    ] as const

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: TEST_SOL_ASSET_ID,
          name: "Sync Engine Solana Fixture",
          symbol: "SOL",
          coingeckoCoinId: "solana",
          type: "fungible",
        })

        yield* Effect.forEach(records, (record) =>
          seedRawRecord({
            ...record,
          })
        )
      })
    )

    for (const record of records) {
      await runCoinbaseNormalization(
        persistCoinbaseNormalization({
          source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
          sourceRecord: buildSeededRawRecord({ ...record }),
        })
      )
    }

    const positions = await Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(PortfolioRepository, (repository) =>
          repository.listAssetPositions({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        ),
        layer: PortfolioRepositoryLive,
      })
    )
    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const movements = yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.assetId, TEST_SOL_ASSET_ID))
        const legs = yield* db
          .select()
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.assetId, TEST_SOL_ASSET_ID))
        return { movements, legs }
      })
    )

    expect(positions).toEqual([
      expect.objectContaining({
        assetId: TEST_SOL_ASSET_ID,
        symbol: "SOL",
        amount: "45.029406853",
      }),
    ])
    expect(state.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "fee",
          amount: expect.stringContaining("0.00966603837"),
        }),
        expect.objectContaining({
          purpose: "principal",
          amount: expect.stringContaining("0.956937799"),
          taxTreatment: "pending_review",
        }),
      ])
    )
    expect(state.legs.filter((leg) => leg.kind === "disposal")).toHaveLength(0)
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
        const inventoryMovements = yield* db.select().from(schema.inventoryMovements)
        return {
          providerTransfers,
          transactions,
          inventoryMovements,
        }
      })
    )

    expect(counts.providerTransfers).toHaveLength(1)
    expect(counts.transactions).toHaveLength(1)
    expect(counts.inventoryMovements).toHaveLength(1)
  })
})
