import * as DateTime from "effect/DateTime"
import { asc, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { AssetResolutionJobRepositoryLive } from "../../src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../src/layers/ProviderReferenceRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
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
await Effect.runPromise(context.recreateTestDatabase())

const loadSourceRepresentationUses = (sourceId: string) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      return yield* db
        .select({
          representationType: schema.sourceRepresentationUses.representationType,
          contractAddress: schema.sourceRepresentationUses.contractAddress,
          mintAddress: schema.sourceRepresentationUses.mintAddress,
        })
        .from(schema.sourceRepresentationUses)
        .where(eq(schema.sourceRepresentationUses.sourceId, sourceId))
        .orderBy(
          asc(schema.sourceRepresentationUses.representationType),
          asc(schema.sourceRepresentationUses.contractAddress),
          asc(schema.sourceRepresentationUses.mintAddress)
        )
    })
  )

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchAccountsPage"),
  fetchTransactionsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchTransactionsPage"),
  fetchFiatCurrencies: Effect.succeed([
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
  fetchCryptoCurrencies: Effect.succeed([
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

    yield* referenceDataService.refreshReferenceData
    const lookups = yield* coinbaseSourceSyncProvider.loadNormalizationLookups
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
            providerAssetRowIds: prepared.providerAssetRowIds,
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
            providerAssetRowIds: prepared.providerAssetRowIds,
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
        providerFiatAmount: null,
        providerFiatCurrency: null,
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
      providerAssetRowIds: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    }) as const

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
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
        )
        yield* Effect.promise(() =>
          runPg(
            seedRawRecord({
              rawRecordId: TEST_RAW_RECORD_ID,
              externalRecordId: "raw-acquire-1",
              occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            })
          )
        )
      })
    )
  )

  it.effect("keeps the canonical transaction ID stable after deletion and re-creation", () =>
    Effect.gen(function* () {
      const transaction = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: null,
        externalGroupId: "group-stable-rematerialization",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath:
          "/v2/accounts/coinbase-account-1/transactions/tx-stable-rematerialization",
        providerDescription: "Stable rematerialization fixture",
        providerCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        providerUpdatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        metadata: { provider: "coinbase" },
        providerFiatAmount: null,
        providerFiatCurrency: null,
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
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const first = yield* Effect.promise(() => persist(null))
      const repeated = yield* Effect.promise(() => persist(null))
      expect(repeated.transaction.id).toBe(first.transaction.id)
      const discovered = yield* Effect.promise(() => persist("discovered-stable-external-id"))
      const corrected = yield* Effect.promise(() => persist("corrected-stable-external-id"))
      expect(discovered.transaction.id).toBe(first.transaction.id)
      expect(corrected.transaction.id).toBe(first.transaction.id)
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.id, first.transaction.id))
          })
        )
      )
      const recreated = yield* Effect.promise(() => persist("corrected-stable-external-id"))

      expect(recreated.transaction.id).toBe(first.transaction.id)
    })
  )

  it.effect("keeps transaction-level provider asset uses in step with each persist", () =>
    Effect.gen(function* () {
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const [assetA, assetB] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const rows = yield* db
              .insert(schema.providerAssets)
              .values([
                {
                  provider: "coinbase",
                  providerAssetId: "tx-use-asset-a",
                  currencyCode: "TXA",
                  retrievedAt: timestamp,
                },
                {
                  provider: "coinbase",
                  providerAssetId: "tx-use-asset-b",
                  currencyCode: "TXB",
                  retrievedAt: timestamp,
                },
              ])
              .returning({ id: schema.providerAssets.id })
            if (rows.length !== 2) return yield* Effect.die("Failed to seed provider assets")
            return rows
          })
        )
      )
      if (assetA === undefined || assetB === undefined) {
        throw new Error("Failed to seed provider assets")
      }

      const persist = (providerAssetRowIds: ReadonlyArray<string>) =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "transaction-with-provider-asset-uses",
                externalGroupId: null,
                timestamp,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Transaction with provider asset uses",
                providerCreatedAt: timestamp,
                providerUpdatedAt: timestamp,
                metadata: { provider: "test" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
              providerAssetRowIds,
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const selectUses = (transactionId: string) =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
                sourceId: schema.providerAssetTransactionUses.sourceId,
              })
              .from(schema.providerAssetTransactionUses)
              .where(eq(schema.providerAssetTransactionUses.transactionId, transactionId))
              .orderBy(asc(schema.providerAssetTransactionUses.providerAssetRowId))
          })
        )

      const persisted = yield* Effect.promise(() => persist([assetA.id, assetB.id, assetA.id]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual(
        [assetA.id, assetB.id]
          .sort()
          .map((providerAssetRowId) => ({ providerAssetRowId, sourceId: TEST_SOURCE_ID }))
      )

      // A replay can change the record's dependencies; stale rows must go.
      yield* Effect.promise(() => persist([assetB.id]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual([
        { providerAssetRowId: assetB.id, sourceId: TEST_SOURCE_ID },
      ])

      yield* Effect.promise(() => persist([]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual([])
    })
  )

  it.effect("keeps an external-only transaction ID stable after deletion and re-creation", () =>
    Effect.gen(function* () {
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const first = yield* Effect.promise(() => persist())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.id, first.transaction.id))
          })
        )
      )
      const recreated = yield* Effect.promise(() => persist())

      expect(recreated.transaction.id).toBe(first.transaction.id)
    })
  )

  it.effect("reserves replay credits atomically before derived state can be reset", () =>
    Effect.gen(function* () {
      const secondRawRecordId = "00000000-0000-0000-0000-000000000484"
      yield* Effect.promise(() =>
        runPg(
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
              occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
            })
          })
        )
      )

      const replayCreditError = yield* Effect.promise(() =>
        runRepository(
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
      )

      expect(replayCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(replayCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(Number(usage[0]?.count ?? 0)).toBe(0)
    })
  )

  it.effect("releases only the credits inserted by a failed replay reservation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
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
      )

      const references = yield* Effect.promise(() =>
        runRepository(
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
      )

      expect(references).toEqual([
        {
          reference: `transaction:${TEST_SOURCE_ID}:external:replay-credit-compensation`,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
        },
      ])

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.releaseReplayTransactionCredits({
              reservationId: "replay-credit-compensation",
              references: references.map(({ reference }) => reference),
            })
          )
        )
      )

      const ledger = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                kind: schema.creditLedger.kind,
                reference: schema.creditLedger.reference,
              })
              .from(schema.creditLedger)
          })
        )
      )

      expect(ledger).toEqual([
        { kind: "manual_adjustment", reference: "test:replay-credit-compensation" },
      ])
    })
  )

  it.effect("lets a successor adopt a replay reservation before stale cleanup runs", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      } as const
      yield* Effect.promise(() =>
        runPg(
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
      )

      const first = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-old",
              transactions: [transaction],
            })
          )
        )
      )
      const adopted = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              transactions: [transaction],
            })
          )
        )
      )
      const stalePersistence = yield* Effect.promise(() =>
        runRepository(
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
                providerAssetRowIds: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: APPROVED_MAPPING,
              })
              .pipe(Effect.result)
          )
        )
      )
      yield* Effect.promise(() =>
        runRepository(
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
              providerAssetRowIds: [],
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
      )

      const usage = yield* Effect.promise(() =>
        runPg(
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
  )

  it.effect("releases an adopted replay reservation when the successor fails", () =>
    Effect.gen(function* () {
      const transaction = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "replay-credit-adoption-failure",
        principalId: TEST_PRINCIPAL_ID,
      }
      yield* Effect.promise(() =>
        runPg(
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
      )

      const first = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-old",
              transactions: [transaction],
            })
          )
        )
      )
      const adopted = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              transactions: [transaction],
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runRepository(
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
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ reference: schema.creditLedger.reference })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(adopted).toEqual(first)
      expect(usage).toEqual([])
    })
  )

  it.effect("consumes one credit for a registered user transaction across source replay", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
          providerFiatAmount: null,
          providerFiatCurrency: null,
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
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts)
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.sourceRecordsRaw)
              .set({
                importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
                updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
              })
              .where(eq(schema.sourceRecordsRaw.id, TEST_RAW_RECORD_ID))
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.externalId, "transaction-with-credit"))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts)
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(Number(usage[0]?.count ?? 0)).toBe(1)
      expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
    })
  )

  it.effect(
    "commits an earlier transaction and fails a typed credit-exhausted error once a registered user's balance runs out",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
        const secondRawRecordId = "00000000-0000-0000-0000-000000000382"

        yield* Effect.promise(() =>
          runPg(
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
        )
        yield* Effect.promise(() =>
          runPg(
            seedRawRecord({
              rawRecordId: secondRawRecordId,
              externalRecordId: "raw-acquire-2",
              occurredAt,
            })
          )
        )

        yield* Effect.promise(() =>
          runRepository(
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
        )

        const error = yield* Effect.promise(() =>
          runRepository(
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
        )

        expect(error).toBeInstanceOf(SourceSyncCreditExhaustedError)
        expect(error).toMatchObject({
          _tag: "SourceSyncCreditExhaustedError",
          reasonCode: "no_usable_credits",
          availableCredits: 0,
        })

        const persistedTransactions = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ externalId: schema.transactions.externalId })
                .from(schema.transactions)
                .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
            })
          )
        )

        expect(persistedTransactions.map((row) => row.externalId)).toEqual([
          "transaction-covered-by-credit",
        ])

        const usage = yield* Effect.promise(() =>
          runPg(
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
        )

        expect(Number(usage[0]?.count ?? 0)).toBe(1)
        expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
      })
  )

  it.effect("continues after a credit top-up and never charges a covered transaction twice", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const secondRawRecordId = "00000000-0000-0000-0000-000000000383"

      yield* Effect.promise(() =>
        runPg(
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
      )
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: secondRawRecordId,
            externalRecordId: "raw-continue-2",
            occurredAt,
          })
        )
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

      yield* Effect.promise(() => persist(coveredArtifacts))
      const pauseError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(pausedArtifacts)
            )
          )
        )
      )
      expect(pauseError).toBeInstanceOf(SourceSyncCreditExhaustedError)

      yield* Effect.promise(() =>
        runPg(
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
      )

      // The continue pass replays the paused transaction and may also revisit the
      // covered one; neither may produce a second usage charge.
      yield* Effect.promise(() => persist(pausedArtifacts))
      yield* Effect.promise(() => persist(coveredArtifacts))
      yield* Effect.promise(() => persist(pausedArtifacts))

      const persistedTransactions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
              .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
              .orderBy(asc(schema.transactions.externalId))
          })
        )
      )
      expect(persistedTransactions.map((row) => row.externalId)).toEqual([
        "transaction-continue-covered",
        "transaction-continue-paused",
      ])

      const usage = yield* Effect.promise(() =>
        runPg(
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
      )
      expect(usage).toHaveLength(2)
      expect(usage.map((row) => Number(row.delta))).toEqual([-1, -1])
      expect(new Set(usage.map((row) => row.reference)).size).toBe(2)
    })
  )

  it.live("aggregates active credit entries by expiry before choosing a bucket", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const depletedExpiry = DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour"))
      const availableExpiry = DateTime.toDateUtc(
        DateTime.addDuration(yield* DateTime.now, "2 hours")
      )

      yield* Effect.promise(() =>
        runPg(
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
                expiresAt: DateTime.toDateUtc(
                  DateTime.subtractDuration(yield* DateTime.now, "1 hour")
                ),
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
      )

      yield* Effect.promise(() =>
        runRepository(
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
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(usage).toEqual([{ expiresAt: availableExpiry }])
    })
  )

  it.effect("keeps a raw-record credit when replay later discovers external ids", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
            providerFiatAmount: null,
            providerFiatCurrency: null,
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
          providerAssetRowIds: [],
          legs: [],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        }) as const

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts(null))
          )
        )
      )
      const firstReservation = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-discovers-external-a",
              transactions: [artifacts("discovered-external-a").transaction],
            })
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts("discovered-external-a"))
          )
        )
      )
      const secondReservation = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-discovers-external-b",
              transactions: [artifacts("discovered-external-b").transaction],
            })
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ reference: schema.creditLedger.reference })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(firstReservation).toEqual([])
      expect(secondReservation).toEqual([])
      expect(usage).toEqual([
        { reference: `transaction:${TEST_SOURCE_ID}:raw:${TEST_RAW_RECORD_ID}` },
      ])
    })
  )

  it.effect(
    "migrates a corrected external credit identity and still deduplicates another raw row",
    () =>
      Effect.gen(function* () {
        const secondRawRecordId = "00000000-0000-0000-0000-000000000485"
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
              providerFiatAmount: null,
              providerFiatCurrency: null,
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
            providerAssetRowIds: [],
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

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(original)
            )
          )
        )
        const correctionReservation = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.reserveReplayTransactionCredits({
                reservationId: "replay-corrects-external",
                transactions: [corrected.transaction],
              })
            )
          )
        )
        yield* Effect.promise(() =>
          runPg(
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
        )
        yield* Effect.promise(() =>
          runRepository(
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
        )

        const usage = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  delta: schema.creditLedger.delta,
                  reference: schema.creditLedger.reference,
                })
                .from(schema.creditLedger)
                .where(eq(schema.creditLedger.kind, "transaction_usage"))
            })
          )
        )

        expect(correctionReservation).toEqual([])
        expect(usage).toEqual([
          {
            delta: -1,
            reference: `transaction:${TEST_SOURCE_ID}:external:external-after-correction`,
          },
        ])
      })
  )

  it.effect("allows only one concurrent transaction when one credit remains across sources", () =>
    Effect.gen(function* () {
      const secondSourceId = "00000000-0000-0000-0000-000000000481"
      const secondRawRecordId = "00000000-0000-0000-0000-000000000482"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(
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
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2030-01-01T00:00:00.000Z")),
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
          providerFiatAmount: null,
          providerFiatCurrency: null,
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
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      })
      const results = yield* Effect.promise(() =>
        Promise.allSettled([
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
      )

      const state = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
      expect(Number(state.usage[0]?.count ?? 0)).toBe(1)
      expect(Number(state.usage[0]?.delta ?? 0)).toBe(-1)
      expect(
        state.transactions.filter(({ externalId }) => externalId?.startsWith("concurrent-credit-"))
      ).toHaveLength(1)
    })
  )

  it.effect("preserves x402 payment for raw records retained when a source is claimed", () =>
    Effect.gen(function* () {
      const anonymousPrincipalId = "00000000-0000-0000-0000-000000000491"
      const postClaimRawRecordId = "00000000-0000-0000-0000-000000000492"
      const claimConsumedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
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
          providerFiatAmount: null,
          providerFiatCurrency: null,
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
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      yield* Effect.promise(() =>
        runPg(
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
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(paidArtifacts)
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.externalId, "claimed-x402-paid-transaction"))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(paidArtifacts)
          )
        )
      )

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: postClaimRawRecordId,
            externalRecordId: "raw-after-x402-claim",
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
          })
        )
      )
      const postClaimCreditError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts({
                ...paidArtifacts,
                transaction: {
                  ...paidArtifacts.transaction,
                  sourceRawRecordId: postClaimRawRecordId,
                  externalId: "transaction-after-x402-claim",
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
                  providerCreatedAt: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")
                  ),
                  providerUpdatedAt: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")
                  ),
                },
              })
            )
          )
        )
      )

      expect(postClaimCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(postClaimCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const state = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(Number(state.usage[0]?.count ?? 0)).toBe(0)
      expect(state.transactions.map(({ externalId }) => externalId)).toContain(
        "claimed-x402-paid-transaction"
      )
      expect(state.transactions.map(({ externalId }) => externalId)).not.toContain(
        "transaction-after-x402-claim"
      )
    })
  )

  it.effect("rolls back a registered user transaction when credits are exhausted", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
          })
        )
      )

      const noCreditError = yield* Effect.promise(() =>
        runRepository(
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
                  providerFiatAmount: null,
                  providerFiatCurrency: null,
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
                providerAssetRowIds: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: APPROVED_MAPPING,
              })
            )
          )
        )
      )

      expect(noCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(noCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const persistedTransactions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "transaction-without-credit"))
          })
        )
      )

      expect(Number(persistedTransactions[0]?.count ?? 0)).toBe(0)
    })
  )

  it.effect("persists exact observed provider transfer representations", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const smallestU8DecimalAmount = `0.${"0".repeat(254)}1`
      const globalRepresentationCountBefore = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.assetRepresentations)
            return Number(row?.count ?? 0)
          })
        )
      )
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
          observedContractAddress: "0xAbCd000000000000000000000000000000000096",
          observedDecimals: 6,
        },
        {
          ...sharedTransfer,
          externalId: "observed-case-sensitive-contract",
          observedRepresentationType: "token" as const,
          observedContractAddress: "CaseSensitiveContractAddress",
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
          providerFiatAmount: null,
          providerFiatCurrency: null,
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
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(normalizedArtifacts)
          )
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
            observedContractAddress: "0xAbCd000000000000000000000000000000000096",
            observedMintAddress: null,
            observedDecimals: 6,
          }),
          expect.objectContaining({
            externalId: "observed-case-sensitive-contract",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "token",
            observedContractAddress: "CaseSensitiveContractAddress",
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

      const sourceUses = yield* Effect.promise(() => loadSourceRepresentationUses(TEST_SOURCE_ID))
      const globalRepresentationCount = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [globalCount] = yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.assetRepresentations)
            return Number(globalCount?.count ?? 0)
          })
        )
      )

      expect({ sourceUses, globalRepresentationCount }).toEqual({
        sourceUses: [
          {
            representationType: "native",
            contractAddress: null,
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: "0xabcd000000000000000000000000000000000096",
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: "CaseSensitiveContractAddress",
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: null,
            mintAddress: "MaxDecimalsMint111111111111111111111111111111",
          },
          {
            representationType: "nft",
            contractAddress: null,
            mintAddress: "NftMint111111111111111111111111111111111111",
          },
        ],
        globalRepresentationCount: globalRepresentationCountBefore,
      })

      const observedNativeTransfer = result.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-native"
      )
      expect(observedNativeTransfer).toBeDefined()
      if (observedNativeTransfer === undefined) {
        return
      }

      yield* Effect.promise(() =>
        runPg(
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
      )

      yield* Effect.promise(() =>
        expect(
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
      )

      yield* Effect.promise(() =>
        expect(
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
      )

      yield* Effect.promise(() =>
        expect(
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
      )

      yield* Effect.promise(() =>
        expect(
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
      )

      yield* Effect.promise(() =>
        expect(
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
      )

      const partialRetryResult = yield* Effect.promise(() =>
        runRepository(
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

      const retryResult = yield* Effect.promise(() =>
        runRepository(
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

      const correctedResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-token"
                  ? {
                      ...transfer,
                      observedContractAddress: null,
                      observedMintAddress: "0xAbCd000000000000000000000000000000000097",
                      observedDecimals: 9,
                      amount: "3",
                      metadata: {
                        provider: "corrected-mint-observation",
                        rawUnits: "3000000000",
                      },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      const correctedToken = correctedResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-token"
      )

      expect(correctedToken).toMatchObject({
        observedBlockchainId: fixture.baseBlockchainId,
        observedRepresentationType: "token",
        observedContractAddress: null,
        observedMintAddress: "0xAbCd000000000000000000000000000000000097",
        observedDecimals: 9,
        amount: expect.stringMatching(/^3(?:\.0+)?$/),
        metadata: { provider: "corrected-mint-observation", rawUnits: "3000000000" },
      })

      const nativeCorrectionResult = yield* Effect.promise(() =>
        runRepository(
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

      const accountingOnlyResult = yield* Effect.promise(() =>
        runRepository(
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

      yield* Effect.promise(() =>
        expect(persistWithoutObservedTransfers()).rejects.toThrow(
          "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
        )
      )

      const stateAfterRejectedRemoval = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const activeReconciliations = yield* db
              .select()
              .from(schema.transferReconciliations)
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
            const preservedTransfers = yield* db
              .select()
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))

            return { activeReconciliations, preservedTransfers }
          })
        )
      )

      expect(stateAfterRejectedRemoval.activeReconciliations).toEqual([
        expect.objectContaining({
          providerTransferId: observedNativeTransfer.id,
          status: "auto_applied",
        }),
      ])
      expect(stateAfterRejectedRemoval.preservedTransfers).toHaveLength(6)
      expect(stateAfterRejectedRemoval.preservedTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "observed-native",
            observedRepresentationType: "native",
            observedDecimals: 18,
          }),
        ])
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transferReconciliations)
              .set({ status: "approved" })
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
          })
        )
      )
      yield* Effect.promise(() =>
        expect(persistWithoutObservedTransfers()).rejects.toThrow(
          "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
        )
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transferReconciliations)
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: [],
            })
          )
        )
      )

      const staleProviderTransfers = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))
          })
        )
      )

      expect(staleProviderTransfers).toHaveLength(6)
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

      const historicalAndFutureUses = yield* Effect.promise(() =>
        loadSourceRepresentationUses(TEST_SOURCE_ID)
      )

      expect(historicalAndFutureUses).toEqual([
        { representationType: "native", contractAddress: null, mintAddress: null },
        {
          representationType: "token",
          contractAddress: "0xabcd000000000000000000000000000000000096",
          mintAddress: null,
        },
        {
          representationType: "token",
          contractAddress: "CaseSensitiveContractAddress",
          mintAddress: null,
        },
        {
          representationType: "token",
          contractAddress: null,
          mintAddress: "0xabcd000000000000000000000000000000000097",
        },
        {
          representationType: "token",
          contractAddress: null,
          mintAddress: "MaxDecimalsMint111111111111111111111111111111",
        },
        {
          representationType: "nft",
          contractAddress: null,
          mintAddress: "NftMint111111111111111111111111111111111111",
        },
      ])
    })
  )

  it.effect("persists a reviewable partial normalization with no canonical legs", () =>
    Effect.gen(function* () {
      const partialRawRecordId = "00000000-0000-0000-0000-000000000591"

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: partialRawRecordId,
            externalRecordId: "raw-partial-review-1",
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")),
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: partialRawRecordId,
                externalId: "tx-partial-review-1",
                externalGroupId: "group-partial-review-1",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")),
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath:
                  "/v2/accounts/coinbase-account-1/transactions/tx-partial-review-1",
                providerDescription: "Fixture partial normalization",
                providerCreatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")
                ),
                providerUpdatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")
                ),
                metadata: { provider: "coinbase", partial: true },
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
              providerAssetRowIds: [],
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
      )

      expect(result.transaction.externalId).toBe("tx-partial-review-1")
      expect(result.legs).toHaveLength(0)

      const counts = yield* Effect.promise(() =>
        runPg(
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
  )

  it.effect("resets reconciliation when replay changes only the asset representation", () =>
    Effect.gen(function* () {
      const rawRecordId = "00000000-0000-0000-0000-000000000710"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
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

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId,
            externalRecordId: "raw-representation-replay-send",
            occurredAt,
            payload,
          })
        )
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

      yield* Effect.promise(() => normalize())
      yield* Effect.promise(() =>
        runPg(
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
      )

      yield* Effect.promise(() => normalize())

      const [movement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.purpose, "principal"))
          })
        )
      )

      expect(movement).toEqual(
        expect.objectContaining({
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          taxTreatment: "non_taxable",
          reconciliationStatus: "unmatched",
        })
      )
    })
  )

  it.effect("keeps a receive whose sender-paid network fee exceeds the credited amount", () =>
    Effect.gen(function* () {
      const receiveRawRecordId = "00000000-0000-0000-0000-000000000729"
      const receivedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z"))
      const receivePayload = {
        id: "tx-small-receive",
        type: "receive",
        status: "completed",
        amount: { amount: "0.00005000", currency: "BTC" },
        native_amount: { amount: "0.50", currency: "EUR" },
        created_at: receivedAt.toISOString(),
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-small-receive",
        network: {
          status: "confirmed",
          hash: "tx-small-receive-hash",
          network_name: "base",
          transaction_fee: { amount: "0.00010000", currency: "BTC" },
        },
        from: {
          address: "bc1qsmallreceiveorigin",
          resource: "address",
        },
      }

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: receiveRawRecordId,
            externalRecordId: "raw-small-receive",
            occurredAt: receivedAt,
            payload: receivePayload,
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
            sourceRecord: buildSeededRawRecord({
              rawRecordId: receiveRawRecordId,
              externalRecordId: "raw-small-receive",
              occurredAt: receivedAt,
              payload: receivePayload,
            }),
          })
        )
      )

      expect(result.providerTransfers).toEqual([
        expect.objectContaining({
          externalId: "tx-small-receive:principal",
          direction: "inbound",
          amount: expect.stringContaining("0.00005000"),
        }),
      ])
      expect(result.canonicalTransfers).toHaveLength(0)
      expect(result.legs).toEqual([
        expect.objectContaining({
          kind: "acquisition",
          amount: expect.stringContaining("0.00005000"),
        }),
      ])
    })
  )

  it.effect("moves a replayed fee movement to the leg's current transaction and raw record", () =>
    Effect.gen(function* () {
      const newRawRecordId = "00000000-0000-0000-0000-000000000710"
      const oldTransactionId = "00000000-0000-0000-0000-000000000712"
      const feeLegExternalId = "fee-leg-moved-between-transactions"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedRawRecord({
              rawRecordId: newRawRecordId,
              externalRecordId: "raw-fee-new-parent",
              occurredAt,
            })
            yield* db.insert(schema.transactions).values({
              id: oldTransactionId,
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "fee-old-parent",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
              principalId: TEST_PRINCIPAL_ID,
            })
            const [feeLeg] = yield* db
              .insert(schema.transactionLegs)
              .values({
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                externalId: feeLegExternalId,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.10000000",
                kind: "fee",
                provenance: "deterministic",
                transactionId: oldTransactionId,
                feeForTransactionId: oldTransactionId,
              })
              .returning({ id: schema.transactionLegs.id })

            if (feeLeg === undefined) {
              return yield* Effect.die("Failed to create replayed fee movement leg")
            }

            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                transactionId: oldTransactionId,
                transactionLegId: feeLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
                direction: "outbound",
                purpose: "fee",
                taxTreatment: "non_taxable",
                reconciliationStatus: "matched",
                amount: "0.10000000",
              })
              .returning({ id: schema.inventoryMovements.id })

            if (movement === undefined) {
              return yield* Effect.die("Failed to create replayed fee movement")
            }
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
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
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
              providerAssetRowIds: [],
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
      )

      const [movement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db.select().from(schema.inventoryMovements)
          })
        )
      )

      expect(movement).toEqual(
        expect.objectContaining({
          transactionId: result.transaction.id,
          sourceRawRecordId: newRawRecordId,
          taxTreatment: "non_taxable",
          reconciliationStatus: "unmatched",
        })
      )
    })
  )

  it.effect("keeps Coinbase provider transfer persistence idempotent on replay", () =>
    Effect.gen(function* () {
      const rawRecordId = "00000000-0000-0000-0000-000000000693"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))
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

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId,
            externalRecordId: "raw-provider-send-replay-1",
            occurredAt,
            payload,
          })
        )
      )

      const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
      const sourceRecord = buildSeededRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-send-replay-1",
        occurredAt,
        payload,
      })

      yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
          })
        )
      )

      yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
          })
        )
      )

      const counts = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(counts.providerTransfers).toHaveLength(1)
      expect(counts.transactions).toHaveLength(1)
      expect(counts.inventoryMovements).toHaveLength(1)
    })
  )
})
