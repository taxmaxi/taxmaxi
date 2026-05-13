import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import {
  TransferReconciliationRepository,
  TransferReconciliationService,
} from "@my/sync-engine/services"
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

  it("can canonicalize one admin-approved reconciliation without sweeping the source", async () => {
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

    await runPg(
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

        yield* db.insert(schema.fifoLots).values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
          originalAmount: "1.00000000",
          remainingAmount: "1.00000000",
          costBasisPerToken: "50000.000000000000000000",
          costBasisCurrency: "EUR",
          sourceLegId: leg.id,
          sourceLegSequence: 0,
        })
      })
    )

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
  })
})
