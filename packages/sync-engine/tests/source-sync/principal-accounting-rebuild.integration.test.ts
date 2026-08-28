import { eq } from "drizzle-orm"
import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
import { PrincipalAccountingRebuildServiceLive } from "../../src/layers/PrincipalAccountingRebuildServiceLive.ts"
import { TransferReconciliationServiceLive } from "../../src/layers/TransferReconciliationServiceLive.ts"
import { PrincipalAccountingRebuildService } from "../../src/services/PrincipalAccountingRebuildService.ts"
import { PortfolioRepositoryLive } from "../../../persistence/src/layers/PortfolioRepositoryLive.ts"
import { PrincipalAccountingRebuildRepositoryLive } from "../../../persistence/src/layers/PrincipalAccountingRebuildRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../../persistence/src/layers/SourceRawRecordRepositoryLive.ts"
import { SyncEngineSourceRepositoryLive } from "../../../persistence/src/layers/SyncEngineSourceRepositoryLive.ts"
import { TaxCalculationServiceLive } from "../../../persistence/src/layers/TaxCalculationServiceLive.ts"
import { TransferReconciliationRepositoryLive } from "../../../persistence/src/layers/TransferReconciliationRepositoryLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  PortfolioRepository,
  TaxCalculationService,
} from "../../../persistence/src/services/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import {
  SourceRawRecordRepository,
  TransferReconciliationRepository,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_accounting_rebuild",
})

const TransferReconciliationTestLayer = TransferReconciliationServiceLive.pipe(
  Layer.provide(TransferReconciliationRepositoryLive)
)

const PrincipalAccountingRebuildTestLayer = PrincipalAccountingRebuildServiceLive.pipe(
  Layer.provide(PrincipalAccountingRebuildRepositoryLive),
  Layer.provide(SyncEngineSourceRepositoryLive),
  Layer.provide(TransferReconciliationTestLayer)
)

const TestLayer = Layer.mergeAll(
  PrincipalAccountingRebuildTestLayer,
  PortfolioRepositoryLive,
  SourceRawRecordRepositoryLive,
  TaxCalculationServiceLive,
  TransferReconciliationRepositoryLive
).pipe(Layer.provideMerge(context.TestPgClientLive))

const rebuildFrom = new Date("2025-02-01T00:00:00.000Z")
const OLD_BTC_ASSET_ID = "00000000-0000-4000-8000-000000000480"
const SECONDARY_SOURCE_ID = "00000000-0000-0000-0000-000000000681"
const SECONDARY_ADDRESS_ID = "00000000-0000-0000-0000-000000000682"
const BTC_PROVIDER_ASSET_ID = "00000000-0000-0000-0000-000000000683"
const EUR_PROVIDER_ASSET_ID = "00000000-0000-0000-0000-000000000684"

await Effect.runPromise(context.recreateTestDatabase())

const runTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | PrincipalAccountingRebuildService
    | PgClient.PgClient
    | PortfolioRepository
    | SourceRawRecordRepository
    | TaxCalculationService
    | TransferReconciliationRepository
  >
) => Effect.runPromise(effect.pipe(Effect.provide(TestLayer), Effect.scoped))

type TestDb = Effect.Success<typeof drizzle>

const ACCOUNTING_TRANSACTIONS = [
  ["00000000-0000-0000-0000-000000000601", "pre-acquisition", "2025-01-01"],
  ["00000000-0000-0000-0000-000000000602", "pre-disposal", "2025-01-15"],
  ["00000000-0000-0000-0000-000000000603", "post-acquisition", "2025-02-01"],
  ["00000000-0000-0000-0000-000000000604", "post-disposal", "2025-03-01"],
  ["00000000-0000-0000-0000-000000000605", "post-income", "2025-03-15"],
  ["00000000-0000-0000-0000-000000000606", "post-fee", "2025-04-01"],
  ["00000000-0000-0000-0000-000000000607", "unrelated-acquisition", "2025-03-01"],
] as const

const PRE_ACQUISITION_LEG_ID = "00000000-0000-0000-0000-000000000701"
const PRE_DISPOSAL_LEG_ID = "00000000-0000-0000-0000-000000000702"
const POST_ACQUISITION_LEG_ID = "00000000-0000-0000-0000-000000000703"
const POST_DISPOSAL_LEG_ID = "00000000-0000-0000-0000-000000000704"
const POST_INCOME_LEG_ID = "00000000-0000-0000-0000-000000000705"
const POST_FEE_LEG_ID = "00000000-0000-0000-0000-000000000706"
const UNRELATED_ACQUISITION_LEG_ID = "00000000-0000-0000-0000-000000000707"
const SECONDARY_ACQUISITION_LEG_ID = "00000000-0000-0000-0000-000000000708"
const PRE_LOT_ID = "00000000-0000-0000-0000-000000000801"
const SECONDARY_LOT_ID = "00000000-0000-0000-0000-000000000803"

const seedAccountingReferences = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.assets).values({
      id: OLD_BTC_ASSET_ID,
      name: "Old Bitcoin identity",
      symbol: "OLD-BTC",
    })
    yield* db.insert(schema.providerAssets).values([
      {
        id: BTC_PROVIDER_ASSET_ID,
        provider: "coinbase",
        providerAssetId: "btc-accounting-rebuild",
        currencyCode: "BTC",
        retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      {
        id: EUR_PROVIDER_ASSET_ID,
        provider: "coinbase",
        providerAssetId: "eur-accounting-rebuild",
        currencyCode: "EUR",
        retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ])
    yield* db.insert(schema.providerAssetMappings).values([
      {
        providerAssetRowId: BTC_PROVIDER_ASSET_ID,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        mappingStatus: "approved",
      },
      {
        providerAssetRowId: EUR_PROVIDER_ASSET_ID,
        mappingKind: "asset",
        canonicalAssetId: TEST_EUR_ASSET_ID,
        mappingStatus: "approved",
      },
    ])
    yield* db.insert(schema.addresses).values({
      id: SECONDARY_ADDRESS_ID,
      principalId: TEST_PRINCIPAL_ID,
      address: "bc1q-secondary-accounting-rebuild",
      type: "bitcoin",
      name: "Secondary accounting source",
    })
    yield* db.insert(schema.sources).values({
      id: SECONDARY_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      name: "Secondary accounting source",
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      addressId: SECONDARY_ADDRESS_ID,
    })
  })

const seedAccountingTransactions = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.transactions).values(
      ACCOUNTING_TRANSACTIONS.map(([id, externalId, date]) => ({
        id,
        sourceId: TEST_SOURCE_ID,
        externalId,
        timestamp: new Date(`${date}T10:00:00.000Z`),
        principalId: TEST_PRINCIPAL_ID,
        providerStatus: "completed",
      }))
    )
    yield* db.insert(schema.transactions).values({
      id: "00000000-0000-0000-0000-000000000608",
      sourceId: SECONDARY_SOURCE_ID,
      externalId: "secondary-pre-acquisition",
      timestamp: new Date("2025-01-05T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      providerStatus: "completed",
    })
  })

const seedAccountingLegs = (db: TestDb) =>
  db.insert(schema.transactionLegs).values([
    {
      id: PRE_ACQUISITION_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "pre-acquisition-leg",
      timestamp: new Date("2025-01-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "10",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[0][0],
      fiatAmount: "1000",
      fiatCurrency: "EUR",
    },
    {
      id: PRE_DISPOSAL_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "pre-disposal-leg",
      timestamp: new Date("2025-01-15T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "2",
      kind: "disposal",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[1][0],
      fiatAmount: "300",
      fiatCurrency: "EUR",
    },
    {
      id: POST_ACQUISITION_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "post-acquisition-leg",
      timestamp: new Date("2025-02-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "5",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[2][0],
      fiatAmount: "500",
      fiatCurrency: "EUR",
    },
    {
      id: POST_DISPOSAL_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "post-disposal-leg",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "6",
      kind: "disposal",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[3][0],
      fiatAmount: "1200",
      fiatCurrency: "EUR",
    },
    {
      id: POST_INCOME_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "post-income-leg",
      timestamp: new Date("2025-03-15T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "2",
      kind: "income",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[4][0],
      fiatAmount: "300",
      fiatCurrency: "EUR",
    },
    {
      id: POST_FEE_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "post-fee-leg",
      timestamp: new Date("2025-04-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "fee",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[5][0],
      fiatAmount: "100",
      fiatCurrency: "EUR",
    },
    {
      id: UNRELATED_ACQUISITION_LEG_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "unrelated-acquisition-leg",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_EUR_ASSET_ID,
      amount: "3",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: ACCOUNTING_TRANSACTIONS[6][0],
      fiatAmount: "30",
      fiatCurrency: "EUR",
    },
  ])

const seedSecondaryAccountingLeg = (db: TestDb) =>
  db.insert(schema.transactionLegs).values({
    id: SECONDARY_ACQUISITION_LEG_ID,
    sourceId: SECONDARY_SOURCE_ID,
    externalId: "secondary-pre-acquisition-leg",
    timestamp: new Date("2025-01-05T10:00:00.000Z"),
    principalId: TEST_PRINCIPAL_ID,
    assetId: TEST_BTC_ASSET_ID,
    amount: "6",
    kind: "acquisition",
    provenance: "deterministic",
    transactionId: "00000000-0000-0000-0000-000000000608",
    fiatAmount: "600",
    fiatCurrency: "EUR",
  })

const seedAccountingLots = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.fifoLots).values([
      {
        id: PRE_LOT_ID,
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "10",
        remainingAmount: "8",
        costBasisPerToken: "100",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: PRE_ACQUISITION_LEG_ID,
      },
      {
        id: "00000000-0000-0000-0000-000000000802",
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_EUR_ASSET_ID,
        acquiredAt: new Date("2025-03-01T10:00:00.000Z"),
        originalAmount: "3",
        remainingAmount: "3",
        costBasisPerToken: "10",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: UNRELATED_ACQUISITION_LEG_ID,
      },
      {
        id: SECONDARY_LOT_ID,
        principalId: TEST_PRINCIPAL_ID,
        sourceId: SECONDARY_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-05T10:00:00.000Z"),
        originalAmount: "6",
        remainingAmount: "0",
        costBasisPerToken: "100",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: SECONDARY_ACQUISITION_LEG_ID,
      },
      {
        id: "00000000-0000-0000-0000-000000000804",
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: OLD_BTC_ASSET_ID,
        acquiredAt: new Date("2025-02-01T10:00:00.000Z"),
        originalAmount: "5",
        remainingAmount: "5",
        costBasisPerToken: "1",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: POST_ACQUISITION_LEG_ID,
      },
    ])

    yield* db.insert(schema.disposalMatches).values({
      disposalLegId: PRE_DISPOSAL_LEG_ID,
      fifoLotId: PRE_LOT_ID,
      matchedAmount: "2",
      costBasis: "200",
      proceeds: "300",
      gainLoss: "100",
    })
    yield* db.insert(schema.disposalMatches).values({
      disposalLegId: POST_DISPOSAL_LEG_ID,
      fifoLotId: SECONDARY_LOT_ID,
      matchedAmount: "6",
      costBasis: "6",
      proceeds: "12",
      gainLoss: "6",
    })
  })

const seedAccountingTransfers = (db: TestDb) =>
  Effect.gen(function* () {
    const [matchingProviderTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: TEST_SOURCE_ID,
        transactionId: ACCOUNTING_TRANSACTIONS[3][0],
        externalId: "post-disposal-provider-transfer",
        timestamp: new Date("2025-03-01T10:00:00.000Z"),
        direction: "outbound",
        processingMode: "accounting_only",
        providerAssetId: BTC_PROVIDER_ASSET_ID,
        fromAccountRef: "coinbase-account-1",
        toAccountRef: "external",
        amount: "6.0",
      })
      .returning({ id: schema.providerTransfers.id })
    if (matchingProviderTransfer === undefined) {
      return yield* Effect.die("Failed to create matching provider transfer")
    }

    yield* db.insert(schema.providerTransfers).values([
      {
        sourceId: TEST_SOURCE_ID,
        transactionId: ACCOUNTING_TRANSACTIONS[1][0],
        externalId: "pre-boundary-provider-transfer",
        timestamp: new Date("2025-01-15T10:00:00.000Z"),
        direction: "outbound",
        processingMode: "accounting_only",
        providerAssetId: BTC_PROVIDER_ASSET_ID,
        fromAccountRef: "coinbase-account-1",
        toAccountRef: "external",
        amount: "2",
      },
      {
        sourceId: TEST_SOURCE_ID,
        transactionId: ACCOUNTING_TRANSACTIONS[6][0],
        externalId: "unrelated-asset-provider-transfer",
        timestamp: new Date("2025-03-01T10:00:00.000Z"),
        direction: "outbound",
        processingMode: "accounting_only",
        providerAssetId: EUR_PROVIDER_ASSET_ID,
        fromAccountRef: "coinbase-account-1",
        toAccountRef: "external",
        amount: "3",
      },
    ])

    yield* db.insert(schema.inventoryMovements).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: TEST_SOURCE_ID,
      transactionId: ACCOUNTING_TRANSACTIONS[3][0],
      providerTransferId: matchingProviderTransfer.id,
      assetId: TEST_BTC_ASSET_ID,
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      direction: "outbound",
      purpose: "principal",
      taxTreatment: "pending_review",
      reconciliationStatus: "unmatched",
      amount: "6.0",
    })

    yield* db.insert(schema.inventoryMovements).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: TEST_SOURCE_ID,
      transactionId: ACCOUNTING_TRANSACTIONS[5][0],
      transactionLegId: POST_FEE_LEG_ID,
      assetId: TEST_BTC_ASSET_ID,
      timestamp: new Date("2025-04-01T10:00:00.000Z"),
      direction: "outbound",
      purpose: "fee",
      taxTreatment: "pending_review",
      reconciliationStatus: "unmatched",
      amount: "1",
    })

    return matchingProviderTransfer.id
  })

const seedAccountingState = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* seedAccountingReferences(db)
      yield* seedAccountingTransactions(db)
      yield* seedAccountingLegs(db)
      yield* seedSecondaryAccountingLeg(db)
      yield* seedAccountingLots(db)
      return yield* seedAccountingTransfers(db)
    })
  )

const seedUnrelatedRawSource = (db: TestDb) =>
  Effect.gen(function* () {
    const sourceId = "00000000-0000-0000-0000-000000000611"
    const addressId = "00000000-0000-0000-0000-000000000612"
    const transactionId = "00000000-0000-0000-0000-000000000613"
    const legId = "00000000-0000-0000-0000-000000000614"
    const rawRecordId = "00000000-0000-0000-0000-000000000615"

    yield* db.insert(schema.addresses).values({
      id: addressId,
      principalId: TEST_PRINCIPAL_ID,
      address: "bc1q-unrelated-accounting-rebuild",
      type: "bitcoin",
      name: "Unrelated accounting source",
    })
    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: "Unrelated accounting source",
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      addressId,
    })
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: rawRecordId,
      sourceId,
      provider: "bitcoin-rpc",
      recordType: "transaction",
      externalAccountId: "unrelated-account",
      externalRecordId: "unrelated-record",
      occurredAt: new Date("2025-03-01T10:00:00.000Z"),
      payload: { id: "unrelated-record" },
      normalizedAt: new Date("2025-03-01T10:01:00.000Z"),
    })
    yield* db.insert(schema.transactions).values({
      id: transactionId,
      sourceId,
      sourceRawRecordId: rawRecordId,
      externalId: "unrelated-transaction",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
    })
    yield* db.insert(schema.transactionLegs).values({
      id: legId,
      sourceId,
      sourceRawRecordId: rawRecordId,
      externalId: "unrelated-leg",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_EUR_ASSET_ID,
      amount: "7",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId,
      fiatAmount: "70",
      fiatCurrency: "EUR",
    })
    yield* db.insert(schema.fifoLots).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId,
      assetId: TEST_EUR_ASSET_ID,
      acquiredAt: new Date("2025-03-01T10:00:00.000Z"),
      originalAmount: "7",
      remainingAmount: "7",
      costBasisPerToken: "10",
      costBasisCurrency: "EUR",
      costBasisStatus: "known",
      sourceLegId: legId,
    })

    return sourceId
  })

const seedOtherPrincipalAccounting = (db: TestDb) =>
  Effect.gen(function* () {
    const otherUserId = "00000000-0000-0000-0000-000000000621"
    const otherPrincipalId = "00000000-0000-0000-0000-000000000622"
    const otherSourceId = "00000000-0000-0000-0000-000000000623"
    const otherTransactionId = "00000000-0000-0000-0000-000000000624"
    const otherLegId = "00000000-0000-0000-0000-000000000625"
    const otherFixture = yield* seedSyncEngineRepositoryFixture({
      userId: otherUserId,
      principalId: otherPrincipalId,
      sourceId: otherSourceId,
    })
    yield* db.insert(schema.transactions).values({
      id: otherTransactionId,
      sourceId: otherFixture.sourceId,
      externalId: "other-principal-acquisition",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: otherFixture.principalId,
    })
    yield* db.insert(schema.transactionLegs).values({
      id: otherLegId,
      sourceId: otherFixture.sourceId,
      externalId: "other-principal-acquisition-leg",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: otherFixture.principalId,
      assetId: TEST_BTC_ASSET_ID,
      amount: "4",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: otherTransactionId,
      fiatAmount: "400",
      fiatCurrency: "EUR",
    })
    yield* db.insert(schema.fifoLots).values({
      principalId: otherFixture.principalId,
      sourceId: otherFixture.sourceId,
      assetId: TEST_BTC_ASSET_ID,
      acquiredAt: new Date("2025-03-01T10:00:00.000Z"),
      originalAmount: "4",
      remainingAmount: "4",
      costBasisPerToken: "100",
      costBasisCurrency: "EUR",
      costBasisStatus: "known",
      sourceLegId: otherLegId,
    })

    return otherPrincipalId
  })

const seedIsolationState = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const unrelatedSourceId = yield* seedUnrelatedRawSource(db)
      const otherPrincipalId = yield* seedOtherPrincipalAccounting(db)
      return { otherPrincipalId, unrelatedSourceId }
    })
  )

const seedSameTimeInventoryMovementState = () => {
  const movementTimestamp = new Date("2025-03-01T10:00:00.000Z")
  const inboundTransactionId = "00000000-0000-0000-0000-000000000910"
  const outboundTransactionId = "00000000-0000-0000-0000-000000000911"
  const inboundProviderTransferId = "00000000-0000-0000-0000-000000000912"
  const outboundProviderTransferId = "00000000-0000-0000-0000-000000000913"

  return context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* db.insert(schema.transactions).values([
        {
          id: inboundTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "same-time-inbound",
          timestamp: movementTimestamp,
          principalId: TEST_PRINCIPAL_ID,
          providerStatus: "completed",
        },
        {
          id: outboundTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "same-time-outbound",
          timestamp: movementTimestamp,
          principalId: TEST_PRINCIPAL_ID,
          providerStatus: "completed",
        },
      ])
      yield* db.insert(schema.providerTransfers).values([
        {
          id: inboundProviderTransferId,
          sourceId: TEST_SOURCE_ID,
          transactionId: inboundTransactionId,
          externalId: "same-time-inbound-transfer",
          timestamp: movementTimestamp,
          direction: "inbound",
          processingMode: "evidence_only",
          fromAccountRef: "external",
          toAccountRef: "principal",
          amount: "2",
        },
        {
          id: outboundProviderTransferId,
          sourceId: TEST_SOURCE_ID,
          transactionId: outboundTransactionId,
          externalId: "same-time-outbound-transfer",
          timestamp: movementTimestamp,
          direction: "outbound",
          processingMode: "evidence_only",
          fromAccountRef: "principal",
          toAccountRef: "external",
          amount: "2",
        },
      ])
      yield* db.insert(schema.inventoryMovements).values([
        {
          id: "00000000-0000-0000-0000-000000000920",
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          transactionId: outboundTransactionId,
          providerTransferId: outboundProviderTransferId,
          assetId: TEST_BTC_ASSET_ID,
          timestamp: movementTimestamp,
          direction: "outbound",
          purpose: "principal",
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
          amount: "2",
        },
        {
          id: "00000000-0000-0000-0000-000000000921",
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          transactionId: inboundTransactionId,
          providerTransferId: inboundProviderTransferId,
          assetId: TEST_BTC_ASSET_ID,
          timestamp: movementTimestamp,
          direction: "inbound",
          purpose: "principal",
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
          amount: "2",
        },
      ])
      return {
        outboundMovementId: "00000000-0000-0000-0000-000000000920",
        outboundProviderTransferId,
        outboundTransactionId,
      }
    })
  )
}

const FIFO_REVIEW_TRANSACTION_ID = "00000000-0000-0000-0000-000000000940"
const FIFO_REVIEW_ACQUISITION_LEG_ID = "00000000-0000-0000-0000-000000000941"
const FIFO_REVIEW_DISPOSAL_LEG_ID = "00000000-0000-0000-0000-000000000942"
const FIFO_REVIEW_ACQUISITION_TRANSACTION_ID = "00000000-0000-0000-0000-000000000943"

const seedFifoReviewTransactionsAndLegs = (db: TestDb, acquisitionAssetId: string) =>
  Effect.gen(function* () {
    yield* db.insert(schema.transactions).values([
      {
        id: FIFO_REVIEW_ACQUISITION_TRANSACTION_ID,
        sourceId: TEST_SOURCE_ID,
        externalId: "fifo-review-acquisition",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      },
      {
        id: FIFO_REVIEW_TRANSACTION_ID,
        sourceId: TEST_SOURCE_ID,
        externalId: "fifo-review-disposal",
        timestamp: new Date("2025-03-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      },
    ])
    yield* db.insert(schema.transactionLegs).values([
      {
        id: FIFO_REVIEW_ACQUISITION_LEG_ID,
        sourceId: TEST_SOURCE_ID,
        externalId: "fifo-review-acquisition:leg",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: acquisitionAssetId,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: FIFO_REVIEW_ACQUISITION_TRANSACTION_ID,
        fiatAmount: "100",
        fiatCurrency: "EUR",
      },
      {
        id: FIFO_REVIEW_DISPOSAL_LEG_ID,
        sourceId: TEST_SOURCE_ID,
        externalId: "fifo-review-disposal:leg",
        timestamp: new Date("2025-03-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "1",
        kind: "disposal",
        provenance: "deterministic",
        transactionId: FIFO_REVIEW_TRANSACTION_ID,
        fiatAmount: "200",
        fiatCurrency: "EUR",
      },
    ])
  })

const seedFifoReviewMatch = (db: TestDb, acquisitionAssetId: string) =>
  Effect.gen(function* () {
    const [staleLot] = yield* db
      .insert(schema.fifoLots)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: acquisitionAssetId,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "1",
        remainingAmount: "0",
        costBasisPerToken: "100",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: FIFO_REVIEW_ACQUISITION_LEG_ID,
      })
      .returning({ id: schema.fifoLots.id })
    if (staleLot === undefined) return yield* Effect.die("Failed to seed stale FIFO lot")
    yield* db.insert(schema.disposalMatches).values({
      disposalLegId: FIFO_REVIEW_DISPOSAL_LEG_ID,
      fifoLotId: staleLot.id,
      matchedAmount: "1",
      costBasis: "100",
      proceeds: "200",
      gainLoss: "100",
    })
  })

const seedFifoReviewRow = (db: TestDb, existingFifoReview: boolean) =>
  db.insert(schema.transactionReviews).values({
    transactionId: FIFO_REVIEW_TRANSACTION_ID,
    principalId: TEST_PRINCIPAL_ID,
    reviewStatus: "needs_review",
    categorizationReason: existingFifoReview
      ? "classification: Existing classification concern.\nfifo_inventory: Previous inventory shortage."
      : "classification: Existing classification concern.",
    matchedLayer: existingFifoReview ? "classification,fifo_inventory" : "classification",
    needsReview: true,
  })

const seedFifoReviewState = ({
  acquisitionAssetId,
  existingFifoReview,
}: {
  readonly acquisitionAssetId: string
  readonly existingFifoReview: boolean
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* db.insert(schema.assets).values({
        id: OLD_BTC_ASSET_ID,
        name: "Old Bitcoin identity",
        symbol: "OLD-BTC",
      })
      yield* seedFifoReviewTransactionsAndLegs(db, acquisitionAssetId)
      yield* seedFifoReviewMatch(db, acquisitionAssetId)
      yield* seedFifoReviewRow(db, existingFifoReview)
    })
  )

const seedPartialUnrelatedFifoEffect = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const acquisitionTransactionId = "00000000-0000-0000-0000-000000000970"
      const acquisitionLegId = "00000000-0000-0000-0000-000000000971"
      const disposalLegId = "00000000-0000-0000-0000-000000000972"
      yield* db.insert(schema.transactions).values({
        id: acquisitionTransactionId,
        sourceId: TEST_SOURCE_ID,
        externalId: "partial-unrelated-acquisition",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      yield* db.insert(schema.transactionLegs).values([
        {
          id: acquisitionLegId,
          sourceId: TEST_SOURCE_ID,
          externalId: "partial-unrelated-acquisition:leg",
          timestamp: new Date("2025-01-02T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_EUR_ASSET_ID,
          amount: "2",
          kind: "acquisition",
          provenance: "deterministic",
          transactionId: acquisitionTransactionId,
          fiatAmount: "20",
          fiatCurrency: "EUR",
        },
        {
          id: disposalLegId,
          sourceId: TEST_SOURCE_ID,
          externalId: "partial-unrelated-disposal:leg",
          timestamp: new Date("2025-03-01T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_EUR_ASSET_ID,
          amount: "2",
          kind: "disposal",
          provenance: "deterministic",
          transactionId: FIFO_REVIEW_TRANSACTION_ID,
          fiatAmount: "20",
          fiatCurrency: "EUR",
        },
      ])
      const [lot] = yield* db
        .insert(schema.fifoLots)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_EUR_ASSET_ID,
          acquiredAt: new Date("2025-01-02T10:00:00.000Z"),
          originalAmount: "2",
          remainingAmount: "1",
          costBasisPerToken: "10",
          costBasisCurrency: "EUR",
          costBasisStatus: "known",
          sourceLegId: acquisitionLegId,
        })
        .returning({ id: schema.fifoLots.id })
      if (lot === undefined) return yield* Effect.die("Failed to seed partial FIFO lot")
      yield* db.insert(schema.disposalMatches).values({
        disposalLegId,
        fifoLotId: lot.id,
        matchedAmount: "1",
        costBasis: "10",
        proceeds: "10",
        gainLoss: "0",
      })
    })
  )

const DISPOSAL_ELIGIBILITY_IDS = {
  acquisitionTransaction: "00000000-0000-0000-0000-000000000950",
  providerTransaction: "00000000-0000-0000-0000-000000000951",
  disposalTransaction: "00000000-0000-0000-0000-000000000952",
  futureTransferTransaction: "00000000-0000-0000-0000-000000000953",
  acquisitionLeg: "00000000-0000-0000-0000-000000000954",
  disposalLeg: "00000000-0000-0000-0000-000000000955",
  futureTransferLeg: "00000000-0000-0000-0000-000000000956",
  providerTransfer: "00000000-0000-0000-0000-000000000957",
} as const

const seedDisposalEligibilityTransactions = (db: TestDb) =>
  db.insert(schema.transactions).values([
    {
      id: DISPOSAL_ELIGIBILITY_IDS.acquisitionTransaction,
      sourceId: TEST_SOURCE_ID,
      externalId: "eligible-acquisition",
      timestamp: new Date("2025-01-03T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      providerStatus: "completed",
    },
    {
      id: DISPOSAL_ELIGIBILITY_IDS.providerTransaction,
      sourceId: TEST_SOURCE_ID,
      externalId: "provider-only-acquisition",
      timestamp: new Date("2025-01-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      providerStatus: "completed",
    },
    {
      id: DISPOSAL_ELIGIBILITY_IDS.disposalTransaction,
      sourceId: TEST_SOURCE_ID,
      externalId: "eligible-disposal",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      providerStatus: "completed",
    },
    {
      id: DISPOSAL_ELIGIBILITY_IDS.futureTransferTransaction,
      sourceId: TEST_SOURCE_ID,
      externalId: "future-internal-transfer",
      timestamp: new Date("2025-03-10T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      providerStatus: "completed",
    },
  ])

const seedDisposalEligibilityLegs = (db: TestDb) =>
  db.insert(schema.transactionLegs).values([
    {
      id: DISPOSAL_ELIGIBILITY_IDS.acquisitionLeg,
      sourceId: TEST_SOURCE_ID,
      externalId: "eligible-acquisition:leg",
      timestamp: new Date("2025-01-03T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "acquisition",
      provenance: "deterministic",
      transactionId: DISPOSAL_ELIGIBILITY_IDS.acquisitionTransaction,
      fiatAmount: "100",
      fiatCurrency: "EUR",
    },
    {
      id: DISPOSAL_ELIGIBILITY_IDS.disposalLeg,
      sourceId: TEST_SOURCE_ID,
      externalId: "eligible-disposal:leg",
      timestamp: new Date("2025-03-01T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "disposal",
      provenance: "deterministic",
      transactionId: DISPOSAL_ELIGIBILITY_IDS.disposalTransaction,
      fiatAmount: "200",
      fiatCurrency: "EUR",
    },
    {
      id: DISPOSAL_ELIGIBILITY_IDS.futureTransferLeg,
      sourceId: TEST_SOURCE_ID,
      externalId: "future-internal-transfer:leg",
      timestamp: new Date("2025-03-10T10:00:00.000Z"),
      principalId: TEST_PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "acquisition",
      provenance: "deterministic",
      derivationRule: "internal_transfer_in",
      transactionId: DISPOSAL_ELIGIBILITY_IDS.futureTransferTransaction,
      fiatAmount: "50",
      fiatCurrency: "EUR",
    },
  ])

const seedDisposalEligibilityLots = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.providerTransfers).values({
      id: DISPOSAL_ELIGIBILITY_IDS.providerTransfer,
      sourceId: TEST_SOURCE_ID,
      transactionId: DISPOSAL_ELIGIBILITY_IDS.providerTransaction,
      externalId: "provider-only-acquisition:transfer",
      timestamp: new Date("2025-01-01T10:00:00.000Z"),
      direction: "inbound",
      processingMode: "evidence_only",
      fromAccountRef: "external",
      toAccountRef: "principal",
      amount: "1",
    })
    yield* db.insert(schema.fifoLots).values([
      {
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "1",
        remainingAmount: "1",
        costBasisPerToken: "0",
        costBasisCurrency: "EUR",
        costBasisStatus: "pending_review",
        sourceProviderTransferId: DISPOSAL_ELIGIBILITY_IDS.providerTransfer,
      },
      {
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-02T10:00:00.000Z"),
        originalAmount: "1",
        remainingAmount: "1",
        costBasisPerToken: "50",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: DISPOSAL_ELIGIBILITY_IDS.futureTransferLeg,
      },
      {
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-03T10:00:00.000Z"),
        originalAmount: "1",
        remainingAmount: "1",
        costBasisPerToken: "100",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: DISPOSAL_ELIGIBILITY_IDS.acquisitionLeg,
      },
    ])
  })

const seedDisposalLotEligibilityState = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* seedDisposalEligibilityTransactions(db)
      yield* seedDisposalEligibilityLegs(db)
      yield* seedDisposalEligibilityLots(db)
    })
  )

const seedCarriedInternalTransferState = () => {
  const destinationTransactionId = "00000000-0000-0000-0000-000000000930"
  const destinationLegId = "00000000-0000-0000-0000-000000000931"
  const disposalTransactionId = "00000000-0000-0000-0000-000000000932"
  const disposalLegId = "00000000-0000-0000-0000-000000000933"
  const carriedLotId = "00000000-0000-0000-0000-000000000934"
  const postBoundaryCarriedLotId = "00000000-0000-0000-0000-000000000935"

  return context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* db.insert(schema.transactions).values([
        {
          id: destinationTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "internal-transfer-destination",
          timestamp: new Date("2025-02-15T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
        },
        {
          id: disposalTransactionId,
          sourceId: TEST_SOURCE_ID,
          externalId: "post-transfer-disposal",
          timestamp: new Date("2025-03-01T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
        },
      ])
      yield* db.insert(schema.transactionLegs).values([
        {
          id: destinationLegId,
          sourceId: TEST_SOURCE_ID,
          externalId: "internal-transfer-destination:leg",
          timestamp: new Date("2025-02-15T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "3",
          kind: "acquisition",
          provenance: "deterministic",
          derivationRule: "internal_transfer_in",
          transactionId: destinationTransactionId,
          fiatAmount: "200",
          fiatCurrency: "EUR",
        },
        {
          id: disposalLegId,
          sourceId: TEST_SOURCE_ID,
          externalId: "post-transfer-disposal:leg",
          timestamp: new Date("2025-03-01T10:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "1",
          kind: "disposal",
          provenance: "deterministic",
          transactionId: disposalTransactionId,
          fiatAmount: "150",
          fiatCurrency: "EUR",
        },
      ])
      yield* db.insert(schema.fifoLots).values([
        {
          id: carriedLotId,
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
          originalAmount: "2",
          remainingAmount: "1",
          costBasisPerToken: "100",
          costBasisCurrency: "EUR",
          costBasisStatus: "known",
          sourceLegId: destinationLegId,
          sourceLegSequence: 0,
        },
        {
          id: postBoundaryCarriedLotId,
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: new Date("2025-02-10T10:00:00.000Z"),
          originalAmount: "1",
          remainingAmount: "1",
          costBasisPerToken: "250",
          costBasisCurrency: "EUR",
          costBasisStatus: "known",
          sourceLegId: destinationLegId,
          sourceLegSequence: 1,
        },
      ])
      yield* db.insert(schema.disposalMatches).values({
        disposalLegId,
        fifoLotId: carriedLotId,
        matchedAmount: "1",
        costBasis: "100",
        proceeds: "150",
        gainLoss: "50",
      })
    })
  )
}

const CANONICALIZATION_IDS = {
  openingTransaction: "00000000-0000-0000-0000-000000000940",
  openingLeg: "00000000-0000-0000-0000-000000000941",
  openingLot: "00000000-0000-0000-0000-000000000942",
  providerTransaction: "00000000-0000-0000-0000-000000000943",
  providerTransfer: "00000000-0000-0000-0000-000000000944",
  destinationTransaction: "00000000-0000-0000-0000-000000000945",
  canonicalTransfer: "00000000-0000-0000-0000-000000000946",
  staleDestinationLeg: "00000000-0000-0000-0000-000000000947",
  staleDestinationLot: "00000000-0000-0000-0000-000000000948",
  laterTransaction: "00000000-0000-0000-0000-000000000949",
  collidingDisposalAndMovement: "00000000-0000-0000-0000-000000000950",
  laterFeeLeg: "00000000-0000-0000-0000-000000000951",
} as const
const canonicalizationTransferTimestamp = new Date("2025-02-15T10:00:00.000Z")
const canonicalizationLaterTimestamp = new Date("2025-03-01T10:00:00.000Z")

const seedCanonicalizationTransactionsAndLegs = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.transactions).values([
      {
        id: CANONICALIZATION_IDS.openingTransaction,
        sourceId: TEST_SOURCE_ID,
        externalId: "canonicalization-opening-inventory",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      },
      {
        id: CANONICALIZATION_IDS.providerTransaction,
        sourceId: TEST_SOURCE_ID,
        externalId: "canonicalization-provider-send",
        timestamp: canonicalizationTransferTimestamp,
        principalId: TEST_PRINCIPAL_ID,
        providerStatus: "completed",
      },
      {
        id: CANONICALIZATION_IDS.destinationTransaction,
        sourceId: SECONDARY_SOURCE_ID,
        externalId: "canonicalization-wallet-receipt",
        timestamp: canonicalizationTransferTimestamp,
        principalId: TEST_PRINCIPAL_ID,
      },
      {
        id: CANONICALIZATION_IDS.laterTransaction,
        sourceId: SECONDARY_SOURCE_ID,
        externalId: "canonicalization-later-effects",
        timestamp: canonicalizationLaterTimestamp,
        principalId: TEST_PRINCIPAL_ID,
      },
    ])
    yield* db.insert(schema.transactionLegs).values([
      {
        id: CANONICALIZATION_IDS.openingLeg,
        sourceId: TEST_SOURCE_ID,
        externalId: "canonicalization-opening-inventory:leg",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "2",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: CANONICALIZATION_IDS.openingTransaction,
        fiatAmount: "200",
        fiatCurrency: "EUR",
      },
      {
        id: CANONICALIZATION_IDS.staleDestinationLeg,
        sourceId: SECONDARY_SOURCE_ID,
        externalId: "canonicalization-wallet-receipt:stale-leg",
        timestamp: canonicalizationTransferTimestamp,
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "2",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: CANONICALIZATION_IDS.destinationTransaction,
        fiatAmount: "220",
        fiatCurrency: "EUR",
      },
      {
        id: CANONICALIZATION_IDS.collidingDisposalAndMovement,
        sourceId: SECONDARY_SOURCE_ID,
        externalId: "canonicalization-later-disposal:leg",
        timestamp: canonicalizationLaterTimestamp,
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "1",
        kind: "disposal",
        provenance: "deterministic",
        transactionId: CANONICALIZATION_IDS.laterTransaction,
        fiatAmount: "150",
        fiatCurrency: "EUR",
      },
      {
        id: CANONICALIZATION_IDS.laterFeeLeg,
        sourceId: SECONDARY_SOURCE_ID,
        externalId: "canonicalization-later-fee:leg",
        timestamp: canonicalizationLaterTimestamp,
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.5",
        kind: "fee",
        provenance: "deterministic",
        transactionId: CANONICALIZATION_IDS.laterTransaction,
        fiatAmount: "75",
        fiatCurrency: "EUR",
      },
    ])
  })

const seedCanonicalizationFifoEffects = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.fifoLots).values([
      {
        id: CANONICALIZATION_IDS.openingLot,
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "2",
        remainingAmount: "2",
        costBasisPerToken: "100",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: CANONICALIZATION_IDS.openingLeg,
      },
      {
        id: CANONICALIZATION_IDS.staleDestinationLot,
        principalId: TEST_PRINCIPAL_ID,
        sourceId: SECONDARY_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: canonicalizationTransferTimestamp,
        originalAmount: "2",
        remainingAmount: "0.5",
        costBasisPerToken: "110",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
        sourceLegId: CANONICALIZATION_IDS.staleDestinationLeg,
      },
    ])
    yield* db.insert(schema.disposalMatches).values({
      disposalLegId: CANONICALIZATION_IDS.collidingDisposalAndMovement,
      fifoLotId: CANONICALIZATION_IDS.staleDestinationLot,
      matchedAmount: "1",
      costBasis: "110",
      proceeds: "150",
      gainLoss: "40",
    })
    yield* db.insert(schema.inventoryMovements).values({
      id: CANONICALIZATION_IDS.collidingDisposalAndMovement,
      principalId: TEST_PRINCIPAL_ID,
      sourceId: SECONDARY_SOURCE_ID,
      transactionId: CANONICALIZATION_IDS.laterTransaction,
      transactionLegId: CANONICALIZATION_IDS.laterFeeLeg,
      assetId: TEST_BTC_ASSET_ID,
      timestamp: canonicalizationLaterTimestamp,
      direction: "outbound",
      purpose: "fee",
      taxTreatment: "pending_review",
      reconciliationStatus: "unmatched",
      amount: "0.5",
    })
    yield* db.insert(schema.inventoryMovementAllocations).values({
      inventoryMovementId: CANONICALIZATION_IDS.collidingDisposalAndMovement,
      fifoLotId: CANONICALIZATION_IDS.staleDestinationLot,
      matchedAmount: "0.5",
    })
  })

const seedCanonicalizationReconciliation = (db: TestDb) =>
  Effect.gen(function* () {
    yield* db.insert(schema.providerTransfers).values({
      id: CANONICALIZATION_IDS.providerTransfer,
      sourceId: TEST_SOURCE_ID,
      transactionId: CANONICALIZATION_IDS.providerTransaction,
      externalId: "canonicalization-provider-transfer",
      providerAssetId: BTC_PROVIDER_ASSET_ID,
      timestamp: canonicalizationTransferTimestamp,
      direction: "outbound",
      processingMode: "accounting_only",
      fromAccountRef: "principal",
      toAddress: "bc1q-secondary-accounting-rebuild",
      amount: "2",
    })
    yield* db.insert(schema.transfers).values({
      id: CANONICALIZATION_IDS.canonicalTransfer,
      sourceId: SECONDARY_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      externalId: "canonicalization-wallet-transfer",
      addressId: SECONDARY_ADDRESS_ID,
      timestamp: canonicalizationTransferTimestamp,
      type: "native",
      fromAddress: "external",
      toAddress: "bc1q-secondary-accounting-rebuild",
      assetId: TEST_BTC_ASSET_ID,
      amount: "2",
    })
    yield* db
      .update(schema.transactionLegs)
      .set({ sourceTransferId: CANONICALIZATION_IDS.canonicalTransfer })
      .where(eq(schema.transactionLegs.id, CANONICALIZATION_IDS.staleDestinationLeg))
    yield* db.insert(schema.transferReconciliations).values({
      principalId: TEST_PRINCIPAL_ID,
      providerTransferId: CANONICALIZATION_IDS.providerTransfer,
      canonicalTransferId: CANONICALIZATION_IDS.canonicalTransfer,
      canonicalTransactionId: CANONICALIZATION_IDS.destinationTransaction,
      status: "auto_applied",
      matchReason: "deterministic_wallet_receipt_match",
      confidence: "1",
      deterministic: true,
    })
  })

const seedCanonicalizationWithDependentFifoState = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const fixture = yield* seedSyncEngineRepositoryFixture()
      yield* seedSyncEngineAssets(fixture)
      yield* seedAccountingReferences(db)
      yield* seedCanonicalizationTransactionsAndLegs(db)
      yield* seedCanonicalizationFifoEffects(db)
      yield* seedCanonicalizationReconciliation(db)
    })
  )

beforeEach(async () => {
  await Effect.runPromise(context.recreateTestDatabase())
})

describe("PrincipalAccountingRebuildService", () => {
  it("records a FIFO review instead of preserving stale matches after a shortage", async () => {
    await seedFifoReviewState({
      acquisitionAssetId: OLD_BTC_ASSET_ID,
      existingFifoReview: false,
    })

    const result = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const taxCalculation = yield* TaxCalculationService
        const db = yield* drizzle
        yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const [review] = yield* db
          .select({
            categorizationReason: schema.transactionReviews.categorizationReason,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, FIFO_REVIEW_TRANSACTION_ID))
        const matches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, FIFO_REVIEW_DISPOSAL_LEG_ID))
        const tax = yield* taxCalculation.calculateTax({
          sourceId: TEST_SOURCE_ID,
          jurisdiction: "germany",
          year: 2025,
        })
        return { matches, review, tax }
      })
    )

    expect(result.review).toEqual({
      categorizationReason: expect.stringContaining("fifo_inventory:"),
      matchedLayer: "classification,fifo_inventory",
      needsReview: true,
    })
    expect(result.matches).toEqual([])
    expect(result.tax.taxableGains).toBe(0)
  })

  it("clears a resolved FIFO review without removing unrelated review state", async () => {
    await seedFifoReviewState({
      acquisitionAssetId: TEST_BTC_ASSET_ID,
      existingFifoReview: true,
    })

    const result = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const db = yield* drizzle
        yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const [review] = yield* db
          .select({
            categorizationReason: schema.transactionReviews.categorizationReason,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, FIFO_REVIEW_TRANSACTION_ID))
        const matches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, FIFO_REVIEW_DISPOSAL_LEG_ID))
        return { matches, review }
      })
    )

    expect(result.review).toEqual({
      categorizationReason: "classification: Existing classification concern.",
      matchedLayer: "classification",
      needsReview: true,
    })
    expect(result.matches).toHaveLength(1)
  })

  it("keeps a FIFO review while another effect remains only partially allocated", async () => {
    await seedFifoReviewState({
      acquisitionAssetId: TEST_BTC_ASSET_ID,
      existingFifoReview: true,
    })
    await seedPartialUnrelatedFifoEffect()

    const review = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const db = yield* drizzle
        yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const [storedReview] = yield* db
          .select({ matchedLayer: schema.transactionReviews.matchedLayer })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, FIFO_REVIEW_TRANSACTION_ID))
        return storedReview
      })
    )

    expect(review).toEqual({ matchedLayer: "classification,fifo_inventory" })
  })

  it("uses only leg-backed lots available by the disposal timestamp", async () => {
    await seedDisposalLotEligibilityState()

    const tax = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const taxCalculation = yield* TaxCalculationService
        yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        return yield* taxCalculation.calculateTax({
          sourceId: TEST_SOURCE_ID,
          jurisdiction: "germany",
          year: 2025,
        })
      })
    )

    expect(tax.taxableGains).toBe(100)
  })

  it("reconciles an affected transfer after its approved asset mapping is removed", async () => {
    await seedCanonicalizationWithDependentFifoState()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssetMappings)
          .set({
            canonicalAssetId: null,
            mappingStatus: "rejected",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, BTC_PROVIDER_ASSET_ID))
      })
    )

    const result = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const db = yield* drizzle
        const rebuild = yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const [reconciliation] = yield* db
          .select({
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(
            eq(
              schema.transferReconciliations.providerTransferId,
              CANONICALIZATION_IDS.providerTransfer
            )
          )
        return { rebuild, reconciliation }
      })
    )

    expect(result.rebuild.transferCandidatesReconciled).toBe(1)
    expect(result.rebuild.transferPairsCanonicalized).toBe(0)
    expect(result.reconciliation).toEqual({
      status: "pending",
      matchReason: "no_candidate_onchain_receipt",
    })
  })

  it("rebuilds affected principal accounting from the earliest event", async () => {
    const affectedProviderTransferId = await seedAccountingState()

    const result = await runTest(
      Effect.gen(function* () {
        const accountingRebuild = yield* PrincipalAccountingRebuildService
        const portfolio = yield* PortfolioRepository
        const taxCalculation = yield* TaxCalculationService
        const reconciliationRepository = yield* TransferReconciliationRepository

        const rebuild = yield* accountingRebuild.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const positions = yield* portfolio.listAssetPositions({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: null,
        })
        const secondaryPositions = yield* portfolio.listAssetPositions({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: SECONDARY_SOURCE_ID,
        })
        const tax = yield* taxCalculation.calculateTax({
          sourceId: TEST_SOURCE_ID,
          jurisdiction: "germany",
          year: 2025,
        })
        const unresolvedReconciliations =
          yield* reconciliationRepository.listUnresolvedTransferReconciliations({
            status: null,
            cursorId: null,
            limit: 10,
          })

        return { rebuild, positions, secondaryPositions, tax, unresolvedReconciliations }
      })
    )

    expect(result.rebuild).toEqual({
      principalId: TEST_PRINCIPAL_ID,
      affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
      rebuildFrom,
      rebuiltSourceIds: [TEST_SOURCE_ID, SECONDARY_SOURCE_ID].sort(),
      fifoLotsRebuilt: 2,
      disposalMatchesRebuilt: 1,
      inventoryAllocationsRebuilt: 1,
      transferCandidatesReconciled: 1,
      transferPairsCanonicalized: 0,
    })
    expect(result.positions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "14",
        costBasis: "1500",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
      }),
      expect.objectContaining({
        assetId: TEST_EUR_ASSET_ID,
        amount: "3",
        costBasis: "30",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
      }),
    ])
    expect(result.secondaryPositions).toEqual([])
    expect(
      result.unresolvedReconciliations.map(({ providerTransferId }) => providerTransferId)
    ).toEqual([affectedProviderTransferId])
    expect(result.tax).toEqual({
      year: 2025,
      currency: "EUR",
      taxableGains: 700,
      taxableLosses: 0,
      taxFreeGains: 0,
      incomeTotal: 300,
    })
  })

  it("leaves unrelated raw sources and another principal unchanged", async () => {
    await seedAccountingState()
    const { otherPrincipalId, unrelatedSourceId } = await seedIsolationState()

    const result = await runTest(
      Effect.gen(function* () {
        const accountingRebuild = yield* PrincipalAccountingRebuildService
        const portfolio = yield* PortfolioRepository
        const rawRecords = yield* SourceRawRecordRepository

        const rebuild = yield* accountingRebuild.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [OLD_BTC_ASSET_ID, TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const unrelatedReplayCandidates = yield* rawRecords.listReplayCandidates({
          sourceId: unrelatedSourceId,
        })
        const otherPrincipalPositions = yield* portfolio.listAssetPositions({
          principalId: otherPrincipalId,
          sourceId: null,
        })

        return { rebuild, unrelatedReplayCandidates, otherPrincipalPositions }
      })
    )

    expect(result.rebuild.rebuiltSourceIds).toEqual([TEST_SOURCE_ID, SECONDARY_SOURCE_ID].sort())
    expect(result.unrelatedReplayCandidates).toEqual([])
    expect(result.otherPrincipalPositions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "4",
        costBasis: "400",
      }),
    ])
  })

  it("rebuilds same-time inbound inventory before outbound inventory", async () => {
    await seedSameTimeInventoryMovementState()

    const result = await runTest(
      Effect.flatMap(PrincipalAccountingRebuildService, (service) =>
        service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
      )
    )

    expect(result.fifoLotsRebuilt).toBe(1)
    expect(result.inventoryAllocationsRebuilt).toBe(1)
  })

  it("records a FIFO review when an outbound movement exceeds available inventory", async () => {
    const movement = await seedSameTimeInventoryMovementState()
    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.inventoryMovements)
          .set({ amount: "3" })
          .where(eq(schema.inventoryMovements.id, movement.outboundMovementId))
        yield* db
          .update(schema.providerTransfers)
          .set({ amount: "3" })
          .where(eq(schema.providerTransfers.id, movement.outboundProviderTransferId))
        yield* db.insert(schema.transactionReviews).values({
          transactionId: movement.outboundTransactionId,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          categorizationReason: "classification: Existing classification concern.",
          matchedLayer: "classification",
          needsReview: true,
        })
      })
    )

    const result = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const db = yield* drizzle
        yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const [review] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, movement.outboundTransactionId))
        const allocations = yield* db
          .select({ id: schema.inventoryMovementAllocations.id })
          .from(schema.inventoryMovementAllocations)
          .where(
            eq(schema.inventoryMovementAllocations.inventoryMovementId, movement.outboundMovementId)
          )
        return { allocations, review }
      })
    )

    expect(result.review).toEqual({
      matchedLayer: "classification,fifo_inventory",
      needsReview: true,
    })
    expect(result.allocations).toEqual([])
  })

  it("preserves carried FIFO slices for internal-transfer acquisition legs", async () => {
    await seedCarriedInternalTransferState()

    const result = await runTest(
      Effect.gen(function* () {
        const service = yield* PrincipalAccountingRebuildService
        const portfolio = yield* PortfolioRepository
        const rebuild = yield* service.rebuildPrincipalAccounting({
          principalId: TEST_PRINCIPAL_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const positions = yield* portfolio.listAssetPositions({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: null,
        })
        return { rebuild, positions }
      })
    )

    expect(result.rebuild.fifoLotsRebuilt).toBe(0)
    expect(result.rebuild.disposalMatchesRebuilt).toBe(1)
    expect(result.positions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "2",
        costBasis: "350",
      }),
    ])
  })

  it("clears affected FIFO usage before canonicalizing a newly internal transfer", async () => {
    await seedCanonicalizationWithDependentFifoState()

    const result = await runTest(
      Effect.gen(function* () {
        const reconciliation = yield* TransferReconciliationRepository
        const portfolio = yield* PortfolioRepository
        const rebuild = yield* reconciliation.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          affectedAssetIds: [TEST_BTC_ASSET_ID],
          rebuildFrom,
        })
        const positions = yield* portfolio.listAssetPositions({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: null,
        })
        return { rebuild, positions }
      })
    )

    expect(result.rebuild.canonicalizedPairs).toBe(1)
    expect(result.positions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.5",
        costBasis: "50",
      }),
    ])
  })
})
