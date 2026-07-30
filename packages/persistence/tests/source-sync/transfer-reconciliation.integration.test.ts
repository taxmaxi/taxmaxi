import { asc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import {
  SourceNormalizationRepository,
  TransferReconciliationRepository,
  TransferReconciliationService,
} from "@my/sync-engine/services"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { TransferReconciliationRepositoryLive } from "../../src/layers/TransferReconciliationRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_transfer_reconciliation_repo",
})

const runPg = context.runPg

const TransferReconciliationTestLayer = TransferReconciliationServiceLive.pipe(
  Layer.provide(TransferReconciliationRepositoryLive)
)

const runTransferReconciliation = <A, E>(
  effect: Effect.Effect<A, E, TransferReconciliationService>
) => Effect.runPromise(context.runWithLayer({ effect, layer: TransferReconciliationTestLayer }))

const runTransferReconciliationRepository = <A, E>(
  effect: Effect.Effect<A, E, TransferReconciliationRepository>
) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: TransferReconciliationRepositoryLive }))

const runSourceNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const ONCHAIN_ADDRESS_ID = "00000000-0000-0000-0000-000000000701"
const ONCHAIN_SOURCE_ID = "00000000-0000-0000-0000-000000000702"

await Effect.runPromise(context.recreateTestDatabase())

const seedApprovedProviderAsset = ({
  providerAssetId = "btc-provider-asset",
}: {
  readonly providerAssetId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-10T00:00:00.000Z")

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        providerAssetId,
        naturalKey: null,
        currencyCode: "BTC",
        name: "Bitcoin",
        exponent: 8,
        providerType: "crypto",
        rawProviderPayload: { asset_id: providerAssetId, code: "BTC" },
        retrievedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.dieMessage("Failed to create provider asset fixture")
    }

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: TEST_BTC_ASSET_ID,
      canonicalAssetSymbol: "BTC",
      canonicalFiatCurrency: null,
      mappingStatus: "approved",
      reviewerNotes: null,
      sourceNotes: null,
      createdAt: now,
      updatedAt: now,
    })

    return providerAsset.id
  })

const seedOwnedOnchainSource = ({ walletAddress }: { readonly walletAddress: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-10T00:00:00.000Z")

    yield* db.insert(schema.addresses).values({
      id: ONCHAIN_ADDRESS_ID,
      address: walletAddress,
      type: "bitcoin",
      name: "Owned bitcoin wallet",
      principalId: TEST_PRINCIPAL_ID,
      createdAt: now,
      updatedAt: now,
    })

    yield* db.insert(schema.sources).values({
      id: ONCHAIN_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      name: "Owned bitcoin source",
      providerKey: "bitcoin",
      sourceableType: "onchain",
      addressId: ONCHAIN_ADDRESS_ID,
      cexAccountId: null,
      createdAt: now,
      updatedAt: now,
    })
  })

const seedProviderTransfer = ({
  providerAssetRowId,
  externalId,
  timestamp,
  amount,
  toAddress,
  networkHash,
}: {
  readonly providerAssetRowId: string
  readonly externalId: string
  readonly timestamp: Date
  readonly amount: string
  readonly toAddress: string
  readonly networkHash: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: `${externalId}:tx`,
        externalGroupId: `${externalId}:group`,
        timestamp,
        transactionType: null,
        providerTransactionType: "send",
        providerStatus: "completed",
        providerResourcePath: `/v2/accounts/coinbase-account-1/transactions/${externalId}`,
        providerDescription: "Provider transfer fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: "coinbase" },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.dieMessage("Failed to create provider transfer transaction fixture")
    }

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: null,
        transactionId: transaction.id,
        externalId,
        externalGroupId: `${externalId}:group`,
        providerAssetId: providerAssetRowId,
        timestamp,
        direction: "outbound",
        fromAccountRef: "coinbase-account-1",
        toAccountRef: null,
        fromAddress: null,
        toAddress,
        networkName: "bitcoin",
        networkHash,
        amount,
        metadata: { provider: "coinbase" },
      })
      .returning({ id: schema.providerTransfers.id })

    if (providerTransfer === undefined) {
      return yield* Effect.dieMessage("Failed to create provider transfer fixture")
    }

    return providerTransfer.id
  })

const seedOnchainReceipt = ({
  externalId,
  txHash,
  timestamp,
  amount,
  walletAddress,
  blockchainId,
}: {
  readonly externalId: string
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: `${externalId}:transaction`,
        externalGroupId: externalId,
        timestamp,
        transactionType: null,
        providerTransactionType: null,
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Onchain receipt fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: "bitcoin" },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.dieMessage("Failed to create onchain transaction fixture")
    }

    yield* db.insert(schema.transactionOnchainContext).values({
      transactionId: transaction.id,
      blockchainId,
      addressId: ONCHAIN_ADDRESS_ID,
      chainTxId: txHash,
      blockHeight: "1",
      blockHash: `block-${txHash}`,
      positionInBlock: "0",
      fromAddress: "bc1qexternalorigin0000000000000000000000000",
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

    const [transfer] = yield* db
      .insert(schema.transfers)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        externalId,
        externalGroupId: externalId,
        addressId: ONCHAIN_ADDRESS_ID,
        blockchainId,
        txHash,
        timestamp,
        type: "utxo",
        fromAddress: "bc1qexternalorigin0000000000000000000000000",
        toAddress: walletAddress,
        fromAccountRef: null,
        toAccountRef: null,
        fromPartyType: "address",
        fromPartyResourcePath: null,
        toPartyType: "address",
        toPartyResourcePath: null,
        assetId: TEST_BTC_ASSET_ID,
        amount,
        tokenId: null,
        notes: null,
        metadata: { provider: "bitcoin" },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transfers.id })

    if (transfer === undefined) {
      return yield* Effect.dieMessage("Failed to create onchain transfer fixture")
    }

    return {
      transferId: transfer.id,
      transactionId: transaction.id,
    }
  })

describe("TransferReconciliationServiceLive", () => {
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
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("links a Coinbase withdrawal to a deterministic owned onchain receipt", async () => {
    const walletAddress = "bc1qownedwalletdeterministic00000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-deterministic",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-deterministic-hash-1",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-deterministic",
        txHash: "btc-deterministic-hash-1",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const [reconciliation] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(summary).toEqual(
      expect.objectContaining({
        evaluatedProviderTransfers: 1,
        autoApplied: 1,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        providerTransferId,
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
        deterministic: true,
      })
    )
  })

  it("marks competing owned receipts as needs_review instead of forcing a match", async () => {
    const walletAddress = "bc1qownedwalletambiguous000000000000000000"
    const timestamp = new Date("2025-04-11T10:00:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-ambiguous",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-ambiguous",
        timestamp,
        amount: "0.25000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )

    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-ambiguous-1",
        txHash: "btc-ambiguous-hash-1",
        timestamp: new Date("2025-04-11T10:05:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-ambiguous-2",
        txHash: "btc-ambiguous-hash-2",
        timestamp: new Date("2025-04-11T10:08:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const [reconciliation] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(summary).toEqual(
      expect.objectContaining({
        evaluatedProviderTransfers: 1,
        needsReview: 1,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        providerTransferId,
        canonicalTransferId: null,
        canonicalTransactionId: null,
        status: "needs_review",
        matchReason: "multiple_candidate_onchain_receipts",
        deterministic: false,
      })
    )
  })

  it("keeps reconciliation reruns idempotent for the same provider transfer", async () => {
    const walletAddress = "bc1qownedwalletrerun00000000000000000000000"
    const timestamp = new Date("2025-04-12T10:00:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-rerun",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-rerun",
        timestamp,
        amount: "0.05000000",
        toAddress: walletAddress,
        networkHash: "btc-rerun-hash-1",
      })
    )

    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-rerun",
        txHash: "btc-rerun-hash-1",
        timestamp: new Date("2025-04-12T10:03:00.000Z"),
        amount: "0.05000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const reconciliations = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliations).toHaveLength(1)
    expect(reconciliations[0]).toEqual(
      expect.objectContaining({
        providerTransferId,
        status: "auto_applied",
        deterministic: true,
      })
    )
  })

  it("does not overwrite an admin-reviewed reconciliation on later upserts", async () => {
    const walletAddress = "bc1qownedwalletreviewlocked00000000000000000"
    const timestamp = new Date("2025-04-13T10:00:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-reviewed",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-reviewed",
        timestamp,
        amount: "0.20000000",
        toAddress: walletAddress,
        networkHash: "btc-reviewed-hash-1",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-reviewed",
        txHash: "btc-reviewed-hash-1",
        timestamp: new Date("2025-04-13T10:05:00.000Z"),
        amount: "0.20000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.upsertTransferReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId,
          canonicalTransferId: receipt.transferId,
          canonicalTransactionId: receipt.transactionId,
          status: "approved",
          matchReason: "admin_locked_match",
          confidence: "1.0000",
          deterministic: true,
          reviewMetadata: {
            adminReview: {
              action: "approved",
            },
          },
        })
      )
    )

    await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.upsertTransferReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "pending",
          matchReason: "rerun_should_not_win",
          confidence: "0.1000",
          deterministic: false,
          reviewMetadata: {},
        })
      )
    )

    const [reconciliation] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toEqual(
      expect.objectContaining({
        providerTransferId,
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "approved",
        matchReason: "admin_locked_match",
        deterministic: true,
      })
    )
  })

  it("moves reconciled FIFO lots between sources before destination disposal", async () => {
    const walletAddress = "bc1qownedwalletscopedreplay000000000000000000"
    const timestamp = new Date("2025-04-14T10:00:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-scoped-replay",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const firstProviderTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-scoped-replay-1",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-scoped-replay-hash-1",
      })
    )
    const firstReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-scoped-replay-1",
        txHash: "btc-scoped-replay-hash-1",
        timestamp: new Date("2025-04-14T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const secondProviderTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-scoped-replay-2",
        timestamp: new Date("2025-04-14T11:00:00.000Z"),
        amount: "0.20000000",
        toAddress: walletAddress,
        networkHash: "btc-scoped-replay-hash-2",
      })
    )
    const secondReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-scoped-replay-2",
        txHash: "btc-scoped-replay-hash-2",
        timestamp: new Date("2025-04-14T11:05:00.000Z"),
        amount: "0.20000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const [firstReconciliationId, secondReconciliationId] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const now = new Date("2025-04-14T12:00:00.000Z")

        const rows = yield* db
          .insert(schema.transferReconciliations)
          .values([
            {
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: firstProviderTransferId,
              canonicalTransferId: firstReceipt.transferId,
              canonicalTransactionId: firstReceipt.transactionId,
              status: "approved",
              matchReason: "admin_approved_fixture",
              confidence: "1.0000",
              deterministic: true,
              reviewMetadata: {},
              createdAt: now,
              updatedAt: now,
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: secondProviderTransferId,
              canonicalTransferId: secondReceipt.transferId,
              canonicalTransactionId: secondReceipt.transactionId,
              status: "approved",
              matchReason: "admin_approved_fixture",
              confidence: "1.0000",
              deterministic: true,
              reviewMetadata: {},
              createdAt: now,
              updatedAt: now,
            },
          ])
          .returning({ id: schema.transferReconciliations.id })

        const first = rows[0]
        const second = rows[1]
        if (first === undefined || second === undefined) {
          return yield* Effect.dieMessage("Failed to create reconciliation fixtures")
        }

        return [first.id, second.id] as const
      })
    )

    const providerOriginLotId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [leg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "scoped-replay-acquisition-leg",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "50000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (leg === undefined) {
          return yield* Effect.dieMessage("Failed to create acquisition leg fixture")
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
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: leg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [providerTransfer] = yield* db
          .select({ transactionId: schema.providerTransfers.transactionId })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, firstProviderTransferId))
          .limit(1)

        if (lot === undefined || providerTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create custody allocation fixture")
        }

        const [movement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId: firstProviderTransferId,
            transactionLegId: null,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (movement === undefined) {
          return yield* Effect.dieMessage("Failed to create inventory movement fixture")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: movement.id,
          fifoLotId: lot.id,
          matchedAmount: "0.10000000",
        })

        const [providerOriginLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-03-01T10:00:00.000Z"),
            originalAmount: "0.20000000",
            remainingAmount: "0.20000000",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            sourceLegId: null,
            sourceProviderTransferId: firstProviderTransferId,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })

        if (providerOriginLot === undefined) {
          return yield* Effect.dieMessage("Failed to create provider-origin lot fixture")
        }

        return providerOriginLot.id
      })
    )

    await runSourceNormalization(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "destination-disposal-before-reconciliation",
            externalGroupId: null,
            timestamp: new Date("2025-04-20T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "sell",
            providerStatus: "confirmed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: null,
            providerUpdatedAt: null,
            metadata: null,
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "dex",
            cexAccountId: null,
            externalAccountId: null,
            externalOrderId: null,
            externalFillId: null,
            side: "sell",
            instrument: "BTC-EUR",
            fillPrice: "60000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: null,
          },
          providerTransfers: [],
          feeTransfers: [],
          deriveLegs: ({ transaction }) =>
            Effect.succeed([
              {
                sourceId: ONCHAIN_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "destination-disposal-before-reconciliation:leg",
                txHash: null,
                timestamp: new Date("2025-04-20T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                addressId: ONCHAIN_ADDRESS_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.15000000",
                kind: "disposal",
                provenance: "deterministic",
                derivationRule: "fixture_disposal",
                metadata: null,
                transactionId: transaction.id,
                sourceTransferId: null,
                fiatAmount: "9000.00",
                fiatCurrency: "EUR",
                feeForTransactionId: null,
              },
            ]),
          transactionReview: null,
          resolvedTransactionType: {
            providerTransactionType: "sell",
            transactionType: "sell_fiat",
            inventoryEffect: "disposal",
            taxTreatment: "taxable_by_default",
            resolutionStrategy: "static",
            pairedRecordRequired: false,
            mappingStatus: "approved",
          },
        })
      )
    )

    const reviewsBeforeReconciliation = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.matchedLayer, "fifo_inventory"))
      })
    )
    expect(reviewsBeforeReconciliation).toHaveLength(1)

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: firstReconciliationId,
        })
      )
    )

    expect(summary).toEqual({ canonicalizedPairs: 1 })

    const secondSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: secondReconciliationId,
        })
      )
    )

    expect(secondSummary).toEqual({ canonicalizedPairs: 1 })

    const movedLots = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            id: schema.fifoLots.id,
            acquiredAt: schema.fifoLots.acquiredAt,
            originalAmount: schema.fifoLots.originalAmount,
            remainingAmount: schema.fifoLots.remainingAmount,
            costBasisPerToken: schema.fifoLots.costBasisPerToken,
            costBasisCurrency: schema.fifoLots.costBasisCurrency,
          })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceId, ONCHAIN_SOURCE_ID))
          .orderBy(asc(schema.fifoLots.createdAt))
      })
    )

    expect(movedLots).toEqual([
      expect.objectContaining({
        acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
        originalAmount: expect.stringContaining("0.10000000"),
        remainingAmount: expect.stringContaining("0.00000000"),
        costBasisPerToken: expect.stringContaining("50000.000000000000000000"),
        costBasisCurrency: "EUR",
      }),
      expect.objectContaining({
        acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
        originalAmount: expect.stringContaining("0.20000000"),
        remainingAmount: expect.stringContaining("0.15000000"),
        costBasisPerToken: expect.stringContaining("50000.000000000000000000"),
        costBasisCurrency: "EUR",
      }),
    ])

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const lots = yield* db
          .select({
            sourceId: schema.fifoLots.sourceId,
            remainingAmount: schema.fifoLots.remainingAmount,
          })
          .from(schema.fifoLots)
        const [movement] = yield* db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, firstProviderTransferId))
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const reviews = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.matchedLayer, "fifo_inventory"))
        const disposalMatches = yield* db
          .select({
            fifoLotId: schema.disposalMatches.fifoLotId,
            matchedAmount: schema.disposalMatches.matchedAmount,
          })
          .from(schema.disposalMatches)
          .where(
            inArray(
              schema.disposalMatches.fifoLotId,
              movedLots.map((lot) => lot.id)
            )
          )
        const [providerOriginLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, providerOriginLotId))
        return { lots, movement, allocations, disposalMatches, providerOriginLot, reviews }
      })
    )

    expect(state.movement).toEqual(
      expect.objectContaining({
        reconciliationStatus: "matched",
        taxTreatment: "non_taxable",
      })
    )
    expect(state.allocations).toHaveLength(0)
    expect(state.reviews).toHaveLength(0)
    expect(state.disposalMatches).toEqual([
      {
        fifoLotId: movedLots[0]?.id,
        matchedAmount: expect.stringContaining("0.10000000"),
      },
      {
        fifoLotId: movedLots[1]?.id,
        matchedAmount: expect.stringContaining("0.05000000"),
      },
    ])
    expect(state.providerOriginLot?.remainingAmount).toContain("0.20000000")
    expect(state.lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: TEST_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.70000000"),
        }),
        expect.objectContaining({
          sourceId: ONCHAIN_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.00000000"),
        }),
        expect.objectContaining({
          sourceId: ONCHAIN_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.15000000"),
        }),
      ])
    )
  })

  it("rolls back canonicalization when custody allocations do not match the transfer amount", async () => {
    const walletAddress = "bc1qownedwalletcustodymismatch000000000000000"
    const timestamp = new Date("2025-04-15T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-asset-custody-mismatch" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-custody-mismatch",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-custody-mismatch-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-custody-mismatch",
        txHash: "btc-custody-mismatch-hash",
        timestamp: new Date("2025-04-15T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const fixtureIds = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .select({ transactionId: schema.providerTransfers.transactionId })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, providerTransferId))
          .limit(1)
        const [reconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: receipt.transferId,
            canonicalTransactionId: receipt.transactionId,
            status: "approved",
            matchReason: "custody_mismatch_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })
        const [leg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "custody-mismatch-opening-leg",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "50000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (providerTransfer === undefined || reconciliation === undefined || leg === undefined) {
          return yield* Effect.dieMessage("Failed to create custody mismatch fixtures")
        }

        const [lot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "1.00000000",
            remainingAmount: "0.95000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: leg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })

        if (lot === undefined) {
          return yield* Effect.dieMessage("Failed to create custody mismatch lot")
        }

        const [movement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId,
            transactionLegId: null,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.05000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (movement === undefined) {
          return yield* Effect.dieMessage("Failed to create custody mismatch movement")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: movement.id,
          fifoLotId: lot.id,
          matchedAmount: "0.05000000",
        })

        return {
          reconciliationId: reconciliation.id,
          providerTransactionId: providerTransfer.transactionId,
          lotId: lot.id,
        }
      })
    )

    await expect(
      runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.applyDeterministicInternalTransferCanonicalization({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            reconciliationId: fixtureIds.reconciliationId,
          })
        )
      )
    ).rejects.toThrow("Custody allocations differ from internal transfer amount")

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransaction] = yield* db
          .select({ transactionType: schema.transactions.transactionType })
          .from(schema.transactions)
          .where(eq(schema.transactions.id, fixtureIds.providerTransactionId))
        const [canonicalTransaction] = yield* db
          .select({ transactionType: schema.transactions.transactionType })
          .from(schema.transactions)
          .where(eq(schema.transactions.id, receipt.transactionId))
        const legs = yield* db.select().from(schema.transactionLegs)
        const reviews = yield* db.select().from(schema.transactionReviews)
        const matches = yield* db.select().from(schema.disposalMatches)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const [lot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, fixtureIds.lotId))
        return {
          providerTransaction,
          canonicalTransaction,
          legs,
          reviews,
          matches,
          allocations,
          lot,
        }
      })
    )

    expect(state.providerTransaction?.transactionType).toBeNull()
    expect(state.canonicalTransaction?.transactionType).toBeNull()
    expect(state.legs).toHaveLength(1)
    expect(state.reviews).toHaveLength(0)
    expect(state.matches).toHaveLength(0)
    expect(state.allocations).toHaveLength(1)
    expect(state.lot?.remainingAmount).toContain("0.95000000")
  })

  it("uses the canonical outbound custody movement and removes the redundant inbound lot", async () => {
    const walletAddress = "bc1qownedwalletexactcustody000000000000000"
    const timestamp = new Date("2025-04-12T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-asset-exact-custody" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const fixtureIds = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "provider-inbound-exact-custody:tx",
            externalGroupId: "provider-inbound-exact-custody",
            timestamp,
            transactionType: null,
            providerTransactionType: "receive",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: "Inbound provider transfer fixture",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "coinbase" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        const [canonicalTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "exact-custody-signature",
            externalGroupId: "exact-custody-signature",
            timestamp,
            transactionType: null,
            providerTransactionType: "transfer",
            providerStatus: "succeeded",
            providerResourcePath: null,
            providerDescription: "Onchain send fixture",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "helius-solana" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (providerTransaction === undefined || canonicalTransaction === undefined) {
          return yield* Effect.dieMessage("Failed to create exact custody transactions")
        }

        const [inboundProviderTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: null,
            transactionId: providerTransaction.id,
            externalId: "provider-inbound-exact-custody",
            externalGroupId: "exact-custody-group",
            providerAssetId: providerAssetRowId,
            timestamp,
            direction: "inbound",
            fromAccountRef: null,
            toAccountRef: "coinbase-account-1",
            fromAddress: walletAddress,
            toAddress: null,
            networkName: "bitcoin",
            networkHash: "exact-custody-signature",
            amount: "0.10000000",
            metadata: { provider: "coinbase", role: "principal" },
          })
          .returning({ id: schema.providerTransfers.id })
        const canonicalTransfers = yield* db
          .insert(schema.transfers)
          .values(
            [0, 1].map((position) => ({
              sourceId: ONCHAIN_SOURCE_ID,
              sourceRawRecordId: null,
              externalId: `exact-custody-signature:principal:${position}`,
              externalGroupId: "exact-custody-signature",
              addressId: ONCHAIN_ADDRESS_ID,
              blockchainId: fixture.bitcoinBlockchainId,
              txHash: "exact-custody-signature",
              timestamp,
              type: "native" as const,
              fromAddress: walletAddress,
              toAddress: `bc1qexactcustodydestination${position}`,
              fromAccountRef: null,
              toAccountRef: null,
              fromPartyType: "address",
              fromPartyResourcePath: null,
              toPartyType: "address",
              toPartyResourcePath: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.10000000",
              tokenId: null,
              notes: null,
              metadata: {
                provider: "helius-solana",
                role: "principal",
                position,
              },
              principalId: TEST_PRINCIPAL_ID,
            }))
          )
          .returning({ id: schema.transfers.id, externalId: schema.transfers.externalId })
        const outboundProviderTransfers = yield* db
          .insert(schema.providerTransfers)
          .values(
            [0, 1].map((position) => ({
              sourceId: ONCHAIN_SOURCE_ID,
              sourceRawRecordId: null,
              transactionId: canonicalTransaction.id,
              externalId: `exact-custody-signature:provider:principal:${position}`,
              externalGroupId: "exact-custody-signature",
              providerAssetId: providerAssetRowId,
              timestamp,
              direction: "outbound" as const,
              fromAccountRef: null,
              toAccountRef: null,
              fromAddress: walletAddress,
              toAddress: `bc1qexactcustodydestination${position}`,
              networkName: "bitcoin",
              networkHash: "exact-custody-signature",
              amount: "0.10000000",
              metadata: {
                provider: "helius-solana",
                role: "principal",
                position,
                canonicalTransferExternalId: `exact-custody-signature:principal:${position}`,
              },
            }))
          )
          .returning({
            id: schema.providerTransfers.id,
            externalId: schema.providerTransfers.externalId,
          })

        const canonicalTransfer = canonicalTransfers.find((row) => row.externalId?.endsWith(":1"))
        const exactProviderTransfer = outboundProviderTransfers.find((row) =>
          row.externalId?.endsWith(":1")
        )
        const unrelatedProviderTransfer = outboundProviderTransfers.find((row) =>
          row.externalId?.endsWith(":0")
        )

        if (
          inboundProviderTransfer === undefined ||
          canonicalTransfer === undefined ||
          exactProviderTransfer === undefined ||
          unrelatedProviderTransfer === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create exact custody transfer fixtures")
        }

        const acquisitionLegs = yield* db
          .insert(schema.transactionLegs)
          .values(
            [0, 1].map((position) => ({
              sourceId: ONCHAIN_SOURCE_ID,
              externalId: `exact-custody-opening-leg-${position}`,
              timestamp: new Date("2025-04-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.10000000",
              kind: "acquisition" as const,
              provenance: "deterministic" as const,
              fiatAmount: "1000.00",
              fiatCurrency: "EUR",
            }))
          )
          .returning({ id: schema.transactionLegs.id })
        const lots = yield* db
          .insert(schema.fifoLots)
          .values(
            acquisitionLegs.map((leg, position) => ({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: ONCHAIN_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date(`2025-04-0${position + 1}T10:00:00.000Z`),
              originalAmount: "0.10000000",
              remainingAmount: "0",
              costBasisPerToken: "10000.000000000000000000",
              costBasisCurrency: "EUR",
              sourceLegId: leg.id,
              sourceLegSequence: 0,
            }))
          )
          .returning({ id: schema.fifoLots.id })
        const movements = yield* db
          .insert(schema.inventoryMovements)
          .values(
            outboundProviderTransfers.map((providerTransfer) => ({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: ONCHAIN_SOURCE_ID,
              transactionId: canonicalTransaction.id,
              providerTransferId: providerTransfer.id,
              transactionLegId: null,
              assetId: TEST_BTC_ASSET_ID,
              timestamp,
              direction: "outbound" as const,
              purpose: "principal" as const,
              taxTreatment: "pending_review" as const,
              reconciliationStatus: "unmatched" as const,
              amount: "0.10000000",
            }))
          )
          .returning({
            id: schema.inventoryMovements.id,
            providerTransferId: schema.inventoryMovements.providerTransferId,
          })

        yield* db.insert(schema.inventoryMovementAllocations).values(
          movements.map((movement, position) => ({
            inventoryMovementId: movement.id,
            fifoLotId: lots[position]?.id ?? "",
            matchedAmount: "0.10000000",
          }))
        )
        const [inboundMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransaction.id,
            providerTransferId: inboundProviderTransfer.id,
            transactionLegId: null,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "inbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (inboundMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create inbound movement fixture")
        }

        yield* db.insert(schema.fifoLots).values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: timestamp,
          originalAmount: "0.10000000",
          remainingAmount: "0.10000000",
          costBasisPerToken: "0",
          costBasisCurrency: "EUR",
          sourceLegId: null,
          sourceProviderTransferId: inboundProviderTransfer.id,
          sourceLegSequence: 0,
        })
        const [reconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: inboundProviderTransfer.id,
            canonicalTransferId: canonicalTransfer.id,
            canonicalTransactionId: canonicalTransaction.id,
            status: "auto_applied",
            matchReason: "deterministic_wallet_receipt_match",
            confidence: "1.00",
            deterministic: true,
            reviewMetadata: null,
          })
          .returning({ id: schema.transferReconciliations.id })

        if (reconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create exact custody reconciliation")
        }

        return {
          reconciliationId: reconciliation.id,
          inboundProviderTransferId: inboundProviderTransfer.id,
          exactProviderTransferId: exactProviderTransfer.id,
          unrelatedProviderTransferId: unrelatedProviderTransfer.id,
        }
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: fixtureIds.reconciliationId,
        })
      )
    )

    expect(summary).toEqual({ canonicalizedPairs: 1 })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const movements = yield* db.select().from(schema.inventoryMovements)
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const inboundLots = yield* db
          .select()
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceProviderTransferId, fixtureIds.inboundProviderTransferId))
        return { movements, allocations, inboundLots }
      })
    )

    expect(
      state.movements.find(
        (movement) => movement.providerTransferId === fixtureIds.exactProviderTransferId
      )
    ).toEqual(
      expect.objectContaining({ reconciliationStatus: "matched", taxTreatment: "non_taxable" })
    )
    expect(
      state.movements.find(
        (movement) => movement.providerTransferId === fixtureIds.unrelatedProviderTransferId
      )
    ).toEqual(
      expect.objectContaining({ reconciliationStatus: "unmatched", taxTreatment: "pending_review" })
    )
    expect(state.allocations).toHaveLength(1)
    expect(state.inboundLots).toHaveLength(0)
  })
})
