import { and, asc, eq, inArray, ne, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
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
  TEST_BTC_REPRESENTATION_ID,
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
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "approved",
      reviewerNotes: null,
      sourceNotes: null,
      createdAt: now,
      updatedAt: now,
    })

    return providerAsset.id
  })

const seedOwnedOnchainSource = ({
  walletAddress,
  addressType = "bitcoin",
  providerKey = "bitcoin",
}: {
  readonly walletAddress: string
  readonly addressType?: "bitcoin" | "evm" | "solana"
  readonly providerKey?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-10T00:00:00.000Z")

    yield* db.insert(schema.addresses).values({
      id: ONCHAIN_ADDRESS_ID,
      address: walletAddress,
      type: addressType,
      name: `Owned ${addressType} wallet`,
      principalId: TEST_PRINCIPAL_ID,
      createdAt: now,
      updatedAt: now,
    })

    yield* db.insert(schema.sources).values({
      id: ONCHAIN_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      name: `Owned ${addressType} source`,
      providerKey,
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
  networkName = "bitcoin",
  networkHash,
}: {
  readonly providerAssetRowId: string
  readonly externalId: string
  readonly timestamp: Date
  readonly amount: string
  readonly toAddress: string | null
  readonly networkName?: string
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
        toAccountRef: toAddress === null ? "unknown-destination" : null,
        fromAddress: null,
        toAddress,
        networkName,
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
  assetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  transferType = "utxo",
  role,
}: {
  readonly externalId: string
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly assetId?: string
  readonly assetRepresentationId?: string
  readonly transferType?: "erc20" | "native" | "spl" | "utxo"
  readonly role?: "fee" | "principal" | "rent"
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
        type: transferType,
        fromAddress: "bc1qexternalorigin0000000000000000000000000",
        toAddress: walletAddress,
        fromAccountRef: null,
        toAccountRef: null,
        fromPartyType: "address",
        fromPartyResourcePath: null,
        toPartyType: "address",
        toPartyResourcePath: null,
        assetId,
        assetRepresentationId,
        amount,
        tokenId: null,
        notes: null,
        metadata: { provider: "bitcoin", ...(role === undefined ? {} : { role }) },
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

const seedObservedOnchainReceipt = ({
  providerAssetId,
  externalId,
  txHash,
  timestamp,
  amount,
  walletAddress,
  blockchainId,
  blockchainName,
  representationType,
  contractAddress,
  mintAddress,
  decimals,
}: {
  readonly providerAssetId: string
  readonly externalId: string
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly blockchainName: string
  readonly representationType: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = new Date("2025-04-10T00:00:00.000Z")

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "test-onchain-adapter",
        providerAssetId,
        naturalKey: `${blockchainName}:${representationType}:${providerAssetId}`,
        currencyCode: "UNKNOWN",
        name: "Unknown observed asset",
        exponent: decimals,
        providerType: representationType,
        rawProviderPayload: { providerAssetId, blockchainName },
        retrievedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.dieMessage("Failed to create observed provider asset fixture")
    }

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "pending_review",
      reviewerNotes: null,
      sourceNotes: "First observed by test onchain adapter.",
      createdAt: now,
      updatedAt: now,
    })

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: `${externalId}:transaction`,
        externalGroupId: externalId,
        timestamp,
        providerStatus: "confirmed",
        providerDescription: "Observed onchain receipt fixture",
        metadata: { provider: "test-onchain-adapter" },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.dieMessage("Failed to create observed onchain transaction fixture")
    }

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        transactionId: transaction.id,
        externalId,
        externalGroupId: externalId,
        providerAssetId: providerAsset.id,
        timestamp,
        direction: "inbound",
        fromAccountRef: null,
        toAccountRef: null,
        fromAddress: "external-observed-origin",
        toAddress: walletAddress,
        networkName: blockchainName,
        networkHash: txHash,
        observedBlockchainId: blockchainId,
        observedRepresentationType: representationType,
        observedContractAddress: contractAddress,
        observedMintAddress: mintAddress,
        observedDecimals: decimals,
        amount,
        metadata: { provider: "test-onchain-adapter" },
      })
      .returning({ id: schema.providerTransfers.id })

    if (providerTransfer === undefined) {
      return yield* Effect.dieMessage("Failed to create observed onchain transfer fixture")
    }

    return {
      providerAssetRowId: providerAsset.id,
      providerTransferId: providerTransfer.id,
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

  it("uses an exact network hash when a provider transfer omits its wallet address", async () => {
    const walletAddress = "bc1qownedwallethashonly0000000000000000000"
    const timestamp = new Date("2025-04-10T10:30:00.000Z")
    const networkHash = "btc-hash-only-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-hash-only",
        timestamp,
        amount: "0.20000000",
        toAddress: null,
        networkHash,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-hash-only",
        txHash: networkHash,
        timestamp: new Date("2025-04-10T10:35:00.000Z"),
        amount: "0.20000000",
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

    expect(summary.autoApplied).toBe(1)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "auto_applied",
      })
    )
  })

  it("uses an exact network hash despite provider address and timestamp drift", async () => {
    const walletAddress = "bc1qownedwallethashdrift0000000000000000000"
    const providerTimestamp = new Date("2025-04-10T10:30:00.000Z")
    const networkHash = "btc-hash-drift-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-hash-drift",
        timestamp: providerTimestamp,
        amount: "0.22000000",
        toAddress: "bc1qincorrectproviderwallet000000000000000000",
        networkHash,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-hash-drift",
        txHash: networkHash,
        timestamp: new Date("2025-04-12T10:35:00.000Z"),
        amount: "0.22000000",
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

    expect(summary.autoApplied).toBe(1)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "auto_applied",
      })
    )
  })

  it("excludes fee movements from exact-hash reconciliation", async () => {
    const walletAddress = "bc1qownedwalletfeerole000000000000000000000"
    const timestamp = new Date("2025-04-10T10:40:00.000Z")
    const networkHash = "btc-fee-role-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-fee-role",
        txHash: networkHash,
        timestamp,
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    const feeProviderTransferId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            transactionId: receipt.transactionId,
            externalId: "onchain-fee-role-provider-transfer",
            externalGroupId: networkHash,
            providerAssetId: providerAssetRowId,
            timestamp,
            direction: "outbound",
            fromAccountRef: null,
            toAccountRef: null,
            fromAddress: walletAddress,
            toAddress: "bitcoin-validator",
            networkName: "bitcoin",
            networkHash,
            amount: "0.01000000",
            metadata: { provider: "test-onchain-adapter", role: "fee" },
          })
          .returning({ id: schema.providerTransfers.id })

        if (providerTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create fee provider transfer fixture")
        }

        return providerTransfer.id
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: ONCHAIN_SOURCE_ID,
        })
      )
    )
    const reconciliations = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ id: schema.transferReconciliations.id })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, feeProviderTransferId))
      })
    )

    expect(summary.evaluatedProviderTransfers).toBe(0)
    expect(reconciliations).toEqual([])
  })

  it("ignores canonical fee candidates for an exact-hash principal match", async () => {
    const walletAddress = "bc1qownedwalletfeecandidate000000000000000000"
    const timestamp = new Date("2025-04-10T10:42:00.000Z")
    const networkHash = "btc-fee-candidate-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-fee-candidate",
        timestamp,
        amount: "0.01000000",
        toAddress: walletAddress,
        networkHash,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-fee-candidate",
        txHash: networkHash,
        timestamp,
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.transfers).values({
          sourceId: ONCHAIN_SOURCE_ID,
          sourceRawRecordId: null,
          externalId: "onchain-fee-candidate",
          externalGroupId: networkHash,
          addressId: ONCHAIN_ADDRESS_ID,
          blockchainId: fixture.bitcoinBlockchainId,
          txHash: networkHash,
          timestamp,
          type: "fee",
          fromAddress: "bc1qexternalorigin0000000000000000000000000",
          toAddress: walletAddress,
          fromAccountRef: null,
          toAccountRef: null,
          fromPartyType: "address",
          fromPartyResourcePath: null,
          toPartyType: "address",
          toPartyResourcePath: null,
          assetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          amount: "0.01000000",
          tokenId: null,
          notes: null,
          metadata: { provider: "bitcoin", role: "fee" },
          principalId: TEST_PRINCIPAL_ID,
        })
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

    expect(summary.autoApplied).toBe(1)
    expect(summary.needsReview).toBe(0)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "auto_applied",
      })
    )
  })

  it("ignores observed fee candidates for an exact-hash principal match", async () => {
    const walletAddress = "bc1qownedwalletobservedfee00000000000000000000"
    const timestamp = new Date("2025-04-10T10:43:00.000Z")
    const networkHash = "btc-observed-fee-candidate-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "observed-fee-candidate-transaction",
            externalGroupId: networkHash,
            timestamp,
            transactionType: null,
            providerTransactionType: null,
            providerStatus: "confirmed",
            providerResourcePath: null,
            providerDescription: "Observed fee candidate fixture",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "bitcoin" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (transaction === undefined) {
          return yield* Effect.dieMessage("Failed to create observed fee candidate transaction")
        }

        yield* db.insert(schema.providerTransfers).values({
          sourceId: ONCHAIN_SOURCE_ID,
          sourceRawRecordId: null,
          transactionId: transaction.id,
          externalId: "observed-fee-candidate",
          externalGroupId: networkHash,
          providerAssetId: providerAssetRowId,
          timestamp,
          direction: "inbound",
          fromAccountRef: null,
          toAccountRef: null,
          fromAddress: "bc1qexternalobservedfee00000000000000000000",
          toAddress: walletAddress,
          networkName: "bitcoin",
          networkHash,
          observedBlockchainId: fixture.bitcoinBlockchainId,
          observedRepresentationType: "native",
          observedContractAddress: null,
          observedMintAddress: null,
          observedDecimals: 8,
          amount: "0.01000000",
          metadata: { provider: "bitcoin", role: "fee" },
        })
      })
    )

    const candidates = await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.findOnchainTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          direction: "inbound",
          walletAddress,
          timestampStart: new Date("2025-04-10T10:42:00.000Z"),
          timestampEnd: new Date("2025-04-10T10:44:00.000Z"),
          networkName: "bitcoin",
          networkHash,
        })
      )
    )

    expect(candidates).toEqual([])
  })

  it("ignores canonical and observed fee candidates for an address-time match", async () => {
    const walletAddress = "bc1qownedwalletwindowfee000000000000000000000"
    const timestamp = new Date("2025-04-10T10:44:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-window-fee-provider-asset" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-window-fee",
        timestamp,
        amount: "0.01000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-window-fee",
        txHash: "btc-window-fee-principal-hash",
        timestamp: new Date("2025-04-10T10:45:00.000Z"),
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.transfers).values({
          sourceId: ONCHAIN_SOURCE_ID,
          sourceRawRecordId: null,
          externalId: "canonical-window-fee-candidate",
          externalGroupId: "btc-window-fee-canonical-hash",
          addressId: ONCHAIN_ADDRESS_ID,
          blockchainId: fixture.bitcoinBlockchainId,
          txHash: "btc-window-fee-canonical-hash",
          timestamp: new Date("2025-04-10T10:46:00.000Z"),
          type: "fee",
          fromAddress: "bc1qexternalwindowfee0000000000000000000000",
          toAddress: walletAddress,
          fromAccountRef: null,
          toAccountRef: null,
          fromPartyType: "address",
          fromPartyResourcePath: null,
          toPartyType: "address",
          toPartyResourcePath: null,
          assetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          amount: "0.01000000",
          tokenId: null,
          notes: null,
          metadata: { provider: "bitcoin", role: "fee" },
          principalId: TEST_PRINCIPAL_ID,
        })

        const [feeTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "observed-window-fee-transaction",
            externalGroupId: "btc-window-fee-observed-hash",
            timestamp: new Date("2025-04-10T10:47:00.000Z"),
            transactionType: null,
            providerTransactionType: null,
            providerStatus: "confirmed",
            providerResourcePath: null,
            providerDescription: "Observed address-time fee candidate fixture",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "bitcoin" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (feeTransaction === undefined) {
          return yield* Effect.dieMessage("Failed to create observed window fee transaction")
        }

        yield* db.insert(schema.providerTransfers).values({
          sourceId: ONCHAIN_SOURCE_ID,
          sourceRawRecordId: null,
          transactionId: feeTransaction.id,
          externalId: "observed-window-fee-candidate",
          externalGroupId: "btc-window-fee-observed-hash",
          providerAssetId: providerAssetRowId,
          timestamp: new Date("2025-04-10T10:47:00.000Z"),
          direction: "inbound",
          fromAccountRef: null,
          toAccountRef: null,
          fromAddress: "bc1qexternalobservedfee00000000000000000000",
          toAddress: walletAddress,
          networkName: "bitcoin",
          networkHash: "btc-window-fee-observed-hash",
          observedBlockchainId: fixture.bitcoinBlockchainId,
          observedRepresentationType: "native",
          observedContractAddress: null,
          observedMintAddress: null,
          observedDecimals: 8,
          amount: "0.01000000",
          metadata: { provider: "bitcoin", role: "fee" },
        })
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

    expect(summary.autoApplied).toBe(1)
    expect(summary.needsReview).toBe(0)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
      })
    )
  })

  it("does not reconcile a hashless transfer with a canonical rent movement", async () => {
    const walletAddress = "bc1qownedwalletwindowrent00000000000000000000"
    const timestamp = new Date("2025-04-10T10:48:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-window-rent-provider-asset" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-window-rent",
        timestamp,
        amount: "0.01000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "canonical-window-rent-candidate",
        txHash: "btc-window-rent-canonical-hash",
        timestamp: new Date("2025-04-10T10:49:00.000Z"),
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        transferType: "native",
        role: "rent",
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
        pending: 1,
        autoApplied: 0,
        needsReview: 0,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    )
  })

  it("selects the principal receipt when a canonical rent movement has the same hashless facts", async () => {
    const walletAddress = "bc1qownedwalletwindowrentprincipal00000000000000"
    const timestamp = new Date("2025-04-10T10:50:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-window-rent-principal-provider-asset" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-window-rent-principal",
        timestamp,
        amount: "0.01000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "canonical-window-rent-competing-candidate",
        txHash: "btc-window-rent-competing-hash",
        timestamp: new Date("2025-04-10T10:51:00.000Z"),
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        transferType: "native",
        role: "rent",
      })
    )
    const principalReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "canonical-window-principal-candidate",
        txHash: "btc-window-principal-candidate-hash",
        timestamp: new Date("2025-04-10T10:52:00.000Z"),
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        role: "principal",
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
        pending: 0,
        autoApplied: 1,
        needsReview: 0,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: principalReceipt.transferId,
        status: "auto_applied",
      })
    )
  })

  it("does not reconcile an exact-hash transfer with a canonical rent movement", async () => {
    const walletAddress = "bc1qownedwallethashrent0000000000000000000000"
    const timestamp = new Date("2025-04-10T10:54:00.000Z")
    const networkHash = "btc-hash-rent-candidate"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-hash-rent-provider-asset" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-hash-rent",
        timestamp,
        amount: "0.01000000",
        toAddress: walletAddress,
        networkHash,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "canonical-hash-rent-candidate",
        txHash: networkHash,
        timestamp,
        amount: "0.01000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        transferType: "native",
        role: "rent",
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
        pending: 1,
        autoApplied: 0,
        needsReview: 0,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    )
  })

  it("does not match an onchain provider movement to its own canonical transfer", async () => {
    const walletAddress = "bc1qownedwallethashdirection0000000000000000"
    const timestamp = new Date("2025-04-10T10:45:00.000Z")
    const networkHash = "btc-hash-direction-match-1"

    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-hash-direction",
        txHash: networkHash,
        timestamp,
        amount: "0.30000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    const providerTransferId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            transactionId: receipt.transactionId,
            externalId: "onchain-provider-transfer-hash-direction",
            externalGroupId: networkHash,
            providerAssetId: providerAssetRowId,
            timestamp,
            direction: "inbound",
            fromAccountRef: null,
            toAccountRef: walletAddress,
            fromAddress: "bc1qexternalorigin0000000000000000000000000",
            toAddress: walletAddress,
            networkName: "bitcoin",
            networkHash,
            amount: "0.30000000",
            metadata: { provider: "bitcoin" },
          })
          .returning({ id: schema.providerTransfers.id })

        if (providerTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create onchain provider transfer fixture")
        }

        return providerTransfer.id
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: ONCHAIN_SOURCE_ID,
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
        evaluatedProviderTransfers: 0,
        pending: 0,
        autoApplied: 0,
      })
    )
    expect(reconciliation).toBeUndefined()
  })

  it.each(["failed", "pending"] as const)(
    "does not reconcile a $providerStatus provider movement",
    async (providerStatus) => {
      const walletAddress = `bc1qownedwallet${providerStatus}movement00000000000000`
      const providerAssetRowId = await runPg(
        seedApprovedProviderAsset({ providerAssetId: `btc-provider-${providerStatus}-movement` })
      )
      await runPg(seedOwnedOnchainSource({ walletAddress }))
      const providerTransferId = await runPg(
        seedProviderTransfer({
          providerAssetRowId,
          externalId: `provider-transfer-${providerStatus}-movement`,
          timestamp: new Date("2025-04-10T10:30:00.000Z"),
          amount: "0.30000000",
          toAddress: walletAddress,
          networkHash: `btc-${providerStatus}-movement-hash`,
        })
      )
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [providerTransfer] = yield* db
            .select({ transactionId: schema.providerTransfers.transactionId })
            .from(schema.providerTransfers)
            .where(eq(schema.providerTransfers.id, providerTransferId))
          if (providerTransfer === undefined) {
            return yield* Effect.dieMessage("Failed to load non-final provider movement")
          }
          yield* db
            .update(schema.transactions)
            .set({ providerStatus })
            .where(eq(schema.transactions.id, providerTransfer.transactionId))
        })
      )
      await runPg(
        seedOnchainReceipt({
          externalId: `onchain-receipt-${providerStatus}-movement`,
          txHash: `btc-${providerStatus}-movement-hash`,
          timestamp: new Date("2025-04-10T10:32:00.000Z"),
          amount: "0.30000000",
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
      const reconciliation = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [row] = yield* db
            .select()
            .from(schema.transferReconciliations)
            .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          return row
        })
      )

      expect(summary.evaluatedProviderTransfers).toBe(0)
      expect(reconciliation).toBeUndefined()
    }
  )

  it("allows only one provider movement to claim a canonical transfer", async () => {
    const walletAddress = "bc1qownedwalletcanonicalclaim00000000000000000"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-canonical-claim" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferIds = await Promise.all(
      ["first", "second"].map((suffix) =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: `provider-transfer-canonical-claim-${suffix}`,
            timestamp: new Date("2025-04-10T10:45:00.000Z"),
            amount: "0.30000000",
            toAddress: walletAddress,
            networkHash: "btc-canonical-claim-hash",
          })
        )
      )
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-canonical-claim",
        txHash: "btc-canonical-claim-hash",
        timestamp: new Date("2025-04-10T10:47:00.000Z"),
        amount: "0.30000000",
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
    const reconciliations = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            providerTransferId: schema.transferReconciliations.providerTransferId,
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(inArray(schema.transferReconciliations.providerTransferId, providerTransferIds))
      })
    )

    expect(reconciliations).toHaveLength(2)
    expect(reconciliations.filter(({ status }) => status === "auto_applied")).toHaveLength(1)
    expect(reconciliations.filter(({ status }) => status === "needs_review")).toEqual([
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        matchReason: "canonical_transfer_already_reconciled",
      }),
    ])
  })

  it("reconciles a chainless EVM mapping despite transaction hash casing", async () => {
    const walletAddress = "0x0000000000000000000000000000000000000960"
    const timestamp = new Date("2025-04-10T11:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-coinbase-chainless-evm" })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "evm",
        providerKey: "test-evm-adapter",
      })
    )

    const representationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: TEST_BTC_ASSET_ID,
            blockchainId: fixture.baseBlockchainId,
            type: "token",
            contractAddress: "0x0000000000000000000000000000000000000b96",
            decimals: 8,
          })
          .returning({ id: schema.assetRepresentations.id })

        if (representation === undefined) {
          return yield* Effect.dieMessage("Failed to create EVM representation fixture")
        }

        return representation.id
      })
    )

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-chainless-evm",
        timestamp,
        amount: "0.40000000",
        toAddress: walletAddress,
        networkName: "base",
        networkHash: "0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-chainless-evm",
        txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        timestamp: new Date("2025-04-10T11:02:00.000Z"),
        amount: "0.40000000",
        walletAddress,
        blockchainId: fixture.baseBlockchainId,
        assetRepresentationId: representationId,
        transferType: "erc20",
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

    expect(summary.autoApplied).toBe(1)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "auto_applied",
      })
    )
  })

  it("requires an approved provider representation to match before auto-applying", async () => {
    const walletAddress = "0x0000000000000000000000000000000000000964"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-pinned-representation" })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "evm",
        providerKey: "test-evm-adapter",
      })
    )

    const destinationRepresentationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: TEST_BTC_ASSET_ID,
            blockchainId: fixture.baseBlockchainId,
            type: "token",
            contractAddress: "0x0000000000000000000000000000000000000f96",
            decimals: 8,
          })
          .returning({ id: schema.assetRepresentations.id })

        if (representation === undefined) {
          return yield* Effect.dieMessage("Failed to create destination representation fixture")
        }

        yield* db
          .update(schema.providerAssetMappings)
          .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))

        return representation.id
      })
    )

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-pinned-representation",
        timestamp: new Date("2025-04-10T11:30:00.000Z"),
        amount: "0.45000000",
        toAddress: walletAddress,
        networkName: "base",
        networkHash: "0xpinned-representation-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-pinned-representation",
        txHash: "0xpinned-representation-hash",
        timestamp: new Date("2025-04-10T11:32:00.000Z"),
        amount: "0.45000000",
        walletAddress,
        blockchainId: fixture.baseBlockchainId,
        assetRepresentationId: destinationRepresentationId,
        transferType: "erc20",
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

    expect(summary.needsReview).toBe(1)
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: null,
        canonicalTransactionId: receipt.transactionId,
        status: "needs_review",
        matchReason: "provider_asset_representation_conflict",
        deterministic: false,
      })
    )
    expect(reconciliation?.reviewMetadata).toEqual(
      expect.objectContaining({
        providerAssetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        candidateTransferIds: [receipt.transferId],
      })
    )
  })

  it("uses a unique owned-address amount and time-window match when no hash is available", async () => {
    const walletAddress = "bc1qownedwalletwindowmatch00000000000000000000"
    const timestamp = new Date("2025-04-10T12:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-window-match" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-window-match",
        timestamp,
        amount: "0.33000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-window-match",
        txHash: "btc-window-match-hash",
        timestamp: new Date("2025-04-10T18:00:00.000Z"),
        amount: "0.33000000",
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
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
      })
    )
  })

  it.each([
    { caseName: "exactly 12 hours before", offsetMillis: -12 * 60 * 60 * 1000, matches: true },
    { caseName: "exactly 12 hours after", offsetMillis: 12 * 60 * 60 * 1000, matches: true },
    {
      caseName: "one millisecond before the 12-hour window",
      offsetMillis: -12 * 60 * 60 * 1000 - 1,
      matches: false,
    },
    {
      caseName: "one millisecond after the 12-hour window",
      offsetMillis: 12 * 60 * 60 * 1000 + 1,
      matches: false,
    },
  ] as const)("treats a hashless receipt $caseName as matches=$matches", async (testCase) => {
    const walletAddress = `bc1qownedwalletwindowboundary${testCase.offsetMillis}`
    const timestamp = new Date("2025-04-10T12:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: `btc-provider-window-boundary-${testCase.offsetMillis}`,
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: `provider-transfer-window-boundary-${testCase.offsetMillis}`,
        timestamp,
        amount: "0.33000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: `onchain-receipt-window-boundary-${testCase.offsetMillis}`,
        txHash: `btc-window-boundary-hash-${testCase.offsetMillis}`,
        timestamp: new Date(timestamp.getTime() + testCase.offsetMillis),
        amount: "0.33000000",
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
      expect.objectContaining(
        testCase.matches
          ? { pending: 0, autoApplied: 1, needsReview: 0 }
          : { pending: 1, autoApplied: 0, needsReview: 0 }
      )
    )
    expect(reconciliation).toEqual(
      expect.objectContaining(
        testCase.matches
          ? { canonicalTransferId: receipt.transferId, status: "auto_applied" }
          : {
              canonicalTransferId: null,
              status: "pending",
              matchReason: "no_candidate_onchain_receipt",
            }
      )
    )
  })

  it("replays reconciliation after a destination source is synced later", async () => {
    const walletAddress = "bc1qownedwalletlatersync000000000000000000000"
    const timestamp = new Date("2025-04-10T13:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-later-sync" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-later-sync",
        timestamp,
        amount: "0.21000000",
        toAddress: walletAddress,
        networkHash: "btc-later-sync-hash",
      })
    )

    const reconcile = () =>
      runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )

    await reconcile()
    const [pending] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )
    expect(pending).toEqual(
      expect.objectContaining({ status: "pending", matchReason: "no_candidate_onchain_receipt" })
    )

    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-later-sync",
        txHash: "btc-later-sync-hash",
        timestamp: new Date("2025-04-10T13:05:00.000Z"),
        amount: "0.21000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await reconcile()

    const [replayed] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )
    expect(replayed).toEqual(
      expect.objectContaining({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
      })
    )
  })

  it("keeps a first-seen representation pending with evidence and replays after approval", async () => {
    const walletAddress = "0x0000000000000000000000000000000000abcdef"
    const observedWalletAddress = "0x0000000000000000000000000000000000aBcDeF"
    const contractAddress = "0x0000000000000000000000000000000000000c96"
    const txHash = "0xunknown-representation-hash"
    const timestamp = new Date("2025-04-10T14:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-unknown-representation" })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "evm",
        providerKey: "test-evm-adapter",
      })
    )
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-unknown-representation",
        timestamp,
        amount: "0.61000000",
        toAddress: observedWalletAddress,
        networkName: "base",
        networkHash: txHash,
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        providerAssetId: contractAddress,
        externalId: "observed-onchain-unknown-representation",
        txHash,
        timestamp: new Date("2025-04-10T14:01:00.000Z"),
        amount: "0.61000000",
        walletAddress: observedWalletAddress,
        blockchainId: fixture.baseBlockchainId,
        blockchainName: "base",
        representationType: "token",
        contractAddress,
        mintAddress: null,
        decimals: null,
      })
    )

    const reconcile = () =>
      runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )

    await reconcile()
    const pendingState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const [mapping] = yield* db
          .select()
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId))
        return { mapping, reconciliation }
      })
    )

    expect(pendingState.reconciliation).toEqual(
      expect.objectContaining({
        status: "pending",
        matchReason: "asset_representation_review_pending",
        canonicalTransferId: null,
        canonicalTransactionId: observed.transactionId,
      })
    )
    expect(pendingState.reconciliation?.reviewMetadata).toEqual(
      expect.objectContaining({
        proposedCanonicalAssetId: TEST_BTC_ASSET_ID,
        evidenceKind: "network_hash_owned_address_amount",
      })
    )
    expect(pendingState.mapping).toEqual(
      expect.objectContaining({
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
        sourceNotes: expect.stringContaining("transfer_reconciliation_evidence"),
      })
    )

    const canonicalTransfer = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: TEST_BTC_ASSET_ID,
            blockchainId: fixture.baseBlockchainId,
            type: "token",
            contractAddress,
            decimals: 8,
          })
          .returning({ id: schema.assetRepresentations.id })

        if (representation === undefined) {
          return yield* Effect.dieMessage("Failed to approve representation fixture")
        }

        yield* db
          .update(schema.providerAssetMappings)
          .set({
            canonicalAssetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: representation.id,
            mappingStatus: "approved",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId))

        yield* db.insert(schema.transactionOnchainContext).values({
          transactionId: observed.transactionId,
          blockchainId: fixture.baseBlockchainId,
          addressId: ONCHAIN_ADDRESS_ID,
          chainTxId: txHash,
          blockHeight: "1",
          blockHash: "block-unknown-representation",
          positionInBlock: "0",
          fromAddress: "external-observed-origin",
          toAddress: observedWalletAddress,
          gasUsed: null,
          gasPrice: null,
          feeAmount: null,
          feeAssetId: null,
          feeCostBasisAmount: null,
          feeCostBasisCurrency: null,
          isError: false,
          functionName: null,
          metadata: { provider: "test-evm-adapter" },
        })

        const [transfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "canonical-unknown-representation",
            externalGroupId: txHash,
            addressId: ONCHAIN_ADDRESS_ID,
            blockchainId: fixture.baseBlockchainId,
            txHash,
            timestamp: new Date("2025-04-10T14:01:00.000Z"),
            type: "erc20",
            fromAddress: "external-observed-origin",
            toAddress: observedWalletAddress,
            fromAccountRef: null,
            toAccountRef: null,
            fromPartyType: "address",
            fromPartyResourcePath: null,
            toPartyType: "address",
            toPartyResourcePath: null,
            assetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: representation.id,
            amount: "0.61000000",
            tokenId: null,
            notes: null,
            metadata: { provider: "test-evm-adapter" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transfers.id })

        if (transfer === undefined) {
          return yield* Effect.dieMessage("Failed to replay canonical transfer fixture")
        }

        return transfer.id
      })
    )

    await reconcile()
    const [replayed] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )
    expect(replayed).toEqual(
      expect.objectContaining({
        canonicalTransferId: canonicalTransfer,
        status: "auto_applied",
      })
    )
  })

  it("does not create or approve a representation mapping from symbol and name equality", async () => {
    const walletAddress = "0x0000000000000000000000000000000000000962"
    const timestamp = new Date("2025-04-10T15:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-symbol-only" })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "evm",
        providerKey: "test-evm-adapter",
      })
    )
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-symbol-only",
        timestamp,
        amount: "0.71000000",
        toAddress: walletAddress,
        networkName: "base",
        networkHash: "0xsource-physical-hash",
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        providerAssetId: "0x0000000000000000000000000000000000000d96",
        externalId: "observed-symbol-only",
        txHash: "0xdifferent-physical-hash",
        timestamp: new Date("2025-04-10T15:01:00.000Z"),
        amount: "0.71000000",
        walletAddress,
        blockchainId: fixture.baseBlockchainId,
        blockchainName: "base",
        representationType: "token",
        contractAddress: "0x0000000000000000000000000000000000000d96",
        mintAddress: null,
        decimals: 8,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({ currencyCode: "BTC", name: "Sync Engine Bitcoin Fixture" })
          .where(eq(schema.providerAssets.id, observed.providerAssetRowId))
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

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [mapping] = yield* db
          .select()
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId))
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        return { mapping, reconciliation }
      })
    )

    expect(state.mapping).toEqual(
      expect.objectContaining({
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
        sourceNotes: "First observed by test onchain adapter.",
      })
    )
    expect(state.reconciliation).toEqual(
      expect.objectContaining({
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
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
    expect(reconciliation?.reviewMetadata).toEqual(
      expect.objectContaining({
        candidateCount: 2,
        candidates: expect.arrayContaining([
          expect.objectContaining({
            assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            amount: expect.stringContaining("0.25000000"),
          }),
        ]),
      })
    )
  })

  it("reverses an applied match when a later receipt makes it ambiguous", async () => {
    const walletAddress = "bc1qownedwalletlateambiguity0000000000000000"
    const timestamp = new Date("2025-04-11T10:30:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-late-ambiguity",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-late-ambiguity",
        timestamp,
        amount: "0.25000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const firstReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-late-ambiguity-1",
        txHash: "btc-late-ambiguity-hash-1",
        timestamp: new Date("2025-04-11T10:35:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    const openingInventory = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerTransfer] = yield* db
          .select({ transactionId: schema.providerTransfers.transactionId })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, providerTransferId))
          .limit(1)
        const [openingLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "late-ambiguity-opening-leg",
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

        if (providerTransfer === undefined || openingLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create late ambiguity inventory")
        }

        const [openingLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "1.00000000",
            remainingAmount: "1.00000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: openingLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })

        if (openingLot === undefined) {
          return yield* Effect.dieMessage("Failed to create late ambiguity lot")
        }

        const [unrelatedProviderTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            externalId: "late-ambiguity-unrelated-provider-transfer",
            externalGroupId: "late-ambiguity-unrelated-provider-transfer:group",
            providerAssetId: providerAssetRowId,
            timestamp,
            direction: "outbound",
            fromAccountRef: "coinbase-account-1",
            toAccountRef: "unrelated-destination",
            fromAddress: null,
            toAddress: null,
            networkName: "bitcoin",
            networkHash: null,
            amount: "0.01000000",
            metadata: { provider: "coinbase" },
          })
          .returning({ id: schema.providerTransfers.id })

        if (unrelatedProviderTransfer === undefined) {
          return yield* Effect.dieMessage(
            "Failed to create unrelated late ambiguity provider transfer"
          )
        }

        const [matchedMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.25000000",
          })
          .returning({ id: schema.inventoryMovements.id })
        const [unrelatedMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId: unrelatedProviderTransfer.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.25000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (matchedMovement === undefined || unrelatedMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create late ambiguity movements")
        }

        return {
          openingLotId: openingLot.id,
          providerTransactionId: providerTransfer.transactionId,
          matchedMovementId: matchedMovement.id,
          unrelatedMovementId: unrelatedMovement.id,
        }
      })
    )

    const reconcile = () =>
      runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )

    expect((await reconcile()).autoApplied).toBe(1)
    expect(
      await runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.applyDeterministicInternalTransferCanonicalization({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )
    ).toEqual({ canonicalizedPairs: 1 })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transactionReviews)
          .set({
            reviewStatus: "needs_review",
            categorizationReason:
              "provider_asset_mapping: Keep this unresolved provider review.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
            matchedLayer: "provider_asset_mapping,transfer_reconciliation",
            needsReview: true,
          })
          .where(eq(schema.transactionReviews.transactionId, firstReceipt.transactionId))
      })
    )

    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-late-ambiguity-2",
        txHash: "btc-late-ambiguity-hash-2",
        timestamp: new Date("2025-04-11T10:38:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    expect((await reconcile()).needsReview).toBe(1)

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const transactions = yield* db
          .select({
            id: schema.transactions.id,
            transactionType: schema.transactions.transactionType,
          })
          .from(schema.transactions)
          .where(
            inArray(schema.transactions.id, [
              openingInventory.providerTransactionId,
              firstReceipt.transactionId,
            ])
          )
        const internalLegs = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(
            inArray(schema.transactionLegs.derivationRule, [
              "internal_transfer_out",
              "internal_transfer_in",
            ])
          )
        const reviews = yield* db
          .select({
            transactionId: schema.transactionReviews.transactionId,
            reviewStatus: schema.transactionReviews.reviewStatus,
            currentTypeKey: schema.transactionReviews.currentTypeKey,
            categorizationReason: schema.transactionReviews.categorizationReason,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(
            inArray(schema.transactionReviews.transactionId, [
              openingInventory.providerTransactionId,
              firstReceipt.transactionId,
            ])
          )
        const [openingLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, openingInventory.openingLotId))
        const movements = yield* db
          .select({
            id: schema.inventoryMovements.id,
            taxTreatment: schema.inventoryMovements.taxTreatment,
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
          })
          .from(schema.inventoryMovements)
          .where(
            inArray(schema.inventoryMovements.id, [
              openingInventory.matchedMovementId,
              openingInventory.unrelatedMovementId,
            ])
          )
          .orderBy(asc(schema.inventoryMovements.id))

        return { reconciliation, transactions, internalLegs, reviews, openingLot, movements }
      })
    )

    expect(state.reconciliation).toEqual(
      expect.objectContaining({
        status: "needs_review",
        canonicalTransferId: null,
        canonicalTransactionId: null,
        matchReason: "multiple_candidate_onchain_receipts",
      })
    )
    expect(state.transactions.every(({ transactionType }) => transactionType === null)).toBe(true)
    expect(state.internalLegs).toHaveLength(0)
    expect(state.reviews).toEqual([
      {
        transactionId: firstReceipt.transactionId,
        reviewStatus: "needs_review",
        currentTypeKey: null,
        categorizationReason: "provider_asset_mapping: Keep this unresolved provider review.",
        matchedLayer: "provider_asset_mapping",
        needsReview: true,
      },
    ])
    expect(state.openingLot?.remainingAmount).toContain("1.00000000")
    expect(state.movements).toEqual(
      expect.arrayContaining([
        {
          id: openingInventory.matchedMovementId,
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
        },
        {
          id: openingInventory.unrelatedMovementId,
          taxTreatment: "non_taxable",
          reconciliationStatus: "matched",
        },
      ])
    )
  })

  it.each(["disposal match", "inventory allocation"] as const)(
    "blocks rollback when a same-timestamp origin $dependencyKind used the affected FIFO suffix",
    async (dependencyKind) => {
      const walletAddress = "bc1qownedwalletoriginrollback0000000000000000"
      const timestamp = new Date("2025-04-11T11:00:00.000Z")
      const providerAssetRowId = await runPg(
        seedApprovedProviderAsset({ providerAssetId: "btc-provider-origin-rollback" })
      )
      await runPg(seedOwnedOnchainSource({ walletAddress }))
      const providerTransferId = await runPg(
        seedProviderTransfer({
          providerAssetRowId,
          externalId: "provider-transfer-origin-rollback",
          timestamp,
          amount: "0.25000000",
          toAddress: walletAddress,
          networkHash: "btc-origin-rollback-hash",
        })
      )
      const receipt = await runPg(
        seedOnchainReceipt({
          externalId: "onchain-receipt-origin-rollback",
          txHash: "btc-origin-rollback-hash",
          timestamp: new Date("2025-04-11T11:05:00.000Z"),
          amount: "0.25000000",
          walletAddress,
          blockchainId: fixture.bitcoinBlockchainId,
        })
      )

      const seeded = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [providerTransfer] = yield* db
            .select({ transactionId: schema.providerTransfers.transactionId })
            .from(schema.providerTransfers)
            .where(eq(schema.providerTransfers.id, providerTransferId))
          if (providerTransfer === undefined) {
            return yield* Effect.dieMessage("Failed to load origin rollback provider transfer")
          }

          yield* db.insert(schema.transferReconciliations).values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: receipt.transferId,
            canonicalTransactionId: receipt.transactionId,
            status: "auto_applied",
            matchReason: "exact_network_hash",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })

          const acquisitionLegs = yield* db
            .insert(schema.transactionLegs)
            .values([
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "origin-rollback-acquisition-1",
                timestamp: new Date("2025-04-01T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1.00000000",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                fiatAmount: "50000.00",
                fiatCurrency: "EUR",
              },
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "origin-rollback-acquisition-2",
                timestamp: new Date("2025-04-02T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1.00000000",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                fiatAmount: "60000.00",
                fiatCurrency: "EUR",
              },
            ])
            .returning({ id: schema.transactionLegs.id })
          const firstAcquisitionLeg = acquisitionLegs[0]
          const secondAcquisitionLeg = acquisitionLegs[1]
          if (firstAcquisitionLeg === undefined || secondAcquisitionLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create origin rollback acquisitions")
          }

          const lots = yield* db
            .insert(schema.fifoLots)
            .values([
              {
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                assetId: TEST_BTC_ASSET_ID,
                acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
                originalAmount: "1.00000000",
                remainingAmount: "0.00000000",
                costBasisPerToken: "50000.000000000000000000",
                costBasisCurrency: "EUR",
                sourceLegId: firstAcquisitionLeg.id,
                sourceLegSequence: 0,
              },
              {
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                assetId: TEST_BTC_ASSET_ID,
                acquiredAt: new Date("2025-04-02T10:00:00.000Z"),
                originalAmount: "1.00000000",
                remainingAmount: "0.95000000",
                costBasisPerToken: "60000.000000000000000000",
                costBasisCurrency: "EUR",
                sourceLegId: secondAcquisitionLeg.id,
                sourceLegSequence: 0,
              },
            ])
            .returning({ id: schema.fifoLots.id })
          const firstLot = lots[0]
          const secondLot = lots[1]
          if (firstLot === undefined || secondLot === undefined) {
            return yield* Effect.dieMessage("Failed to create origin rollback lots")
          }

          const internalLegs = yield* db
            .insert(schema.transactionLegs)
            .values([
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "origin-rollback-internal-out",
                timestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.25000000",
                kind: "disposal" as const,
                provenance: "deterministic" as const,
                derivationRule: "internal_transfer_out",
                metadata: { reconciliation: { providerTransferId } },
                transactionId: providerTransfer.transactionId,
              },
              {
                sourceId: ONCHAIN_SOURCE_ID,
                externalId: "origin-rollback-internal-in",
                timestamp: new Date("2025-04-11T11:05:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                addressId: ONCHAIN_ADDRESS_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.25000000",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                derivationRule: "internal_transfer_in",
                metadata: { reconciliation: { providerTransferId } },
                transactionId: receipt.transactionId,
              },
            ])
            .returning({
              id: schema.transactionLegs.id,
              derivationRule: schema.transactionLegs.derivationRule,
            })
          const originLeg = internalLegs.find(
            ({ derivationRule }) => derivationRule === "internal_transfer_out"
          )
          const destinationLeg = internalLegs.find(
            ({ derivationRule }) => derivationRule === "internal_transfer_in"
          )
          if (originLeg === undefined || destinationLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create origin rollback internal legs")
          }

          yield* db.insert(schema.disposalMatches).values({
            disposalLegId: originLeg.id,
            fifoLotId: firstLot.id,
            matchedAmount: "0.25000000",
            costBasis: "12500.00",
            proceeds: "0.00",
            gainLoss: "-12500.00",
          })
          yield* db.insert(schema.fifoLots).values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "0.25000000",
            remainingAmount: "0.25000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: destinationLeg.id,
            sourceLegSequence: 0,
          })

          const [laterOriginLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: `origin-rollback-${dependencyKind}`,
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.80000000",
              kind: dependencyKind === "disposal match" ? "disposal" : "fee",
              provenance: "deterministic",
              fiatAmount: "48000.00",
              fiatCurrency: "EUR",
            })
            .returning({ id: schema.transactionLegs.id })
          if (laterOriginLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create same-timestamp origin consumer")
          }
          if (dependencyKind === "disposal match") {
            yield* db.insert(schema.disposalMatches).values([
              {
                disposalLegId: laterOriginLeg.id,
                fifoLotId: firstLot.id,
                matchedAmount: "0.75000000",
                costBasis: "37500.00",
                proceeds: "45000.00",
                gainLoss: "7500.00",
              },
              {
                disposalLegId: laterOriginLeg.id,
                fifoLotId: secondLot.id,
                matchedAmount: "0.05000000",
                costBasis: "3000.00",
                proceeds: "3000.00",
                gainLoss: "0.00",
              },
            ])
          } else {
            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                transactionId: providerTransfer.transactionId,
                transactionLegId: laterOriginLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp,
                direction: "outbound",
                purpose: "fee",
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                amount: "0.80000000",
              })
              .returning({ id: schema.inventoryMovements.id })
            if (movement === undefined) {
              return yield* Effect.dieMessage("Failed to create same-timestamp origin allocation")
            }
            yield* db.insert(schema.inventoryMovementAllocations).values([
              {
                inventoryMovementId: movement.id,
                fifoLotId: firstLot.id,
                matchedAmount: "0.75000000",
              },
              {
                inventoryMovementId: movement.id,
                fifoLotId: secondLot.id,
                matchedAmount: "0.05000000",
              },
            ])
          }

          return { firstLotId: firstLot.id, secondLotId: secondLot.id }
        })
      )

      await runTransferReconciliationRepository(
        Effect.flatMap(TransferReconciliationRepository, (repository) =>
          repository.upsertTransferReconciliation({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: null,
            canonicalTransactionId: null,
            status: "needs_review",
            matchReason: "multiple_candidate_onchain_receipts",
            confidence: "0.5000",
            deterministic: false,
            reviewMetadata: { candidateCount: 2 },
          })
        )
      )

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [reconciliation] = yield* db
            .select()
            .from(schema.transferReconciliations)
            .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          const lots = yield* db
            .select({ id: schema.fifoLots.id, remainingAmount: schema.fifoLots.remainingAmount })
            .from(schema.fifoLots)
            .where(inArray(schema.fifoLots.id, [seeded.firstLotId, seeded.secondLotId]))
            .orderBy(asc(schema.fifoLots.id))
          const remainingInternalLegs = yield* db
            .select({ id: schema.transactionLegs.id })
            .from(schema.transactionLegs)
            .where(
              inArray(schema.transactionLegs.derivationRule, [
                "internal_transfer_out",
                "internal_transfer_in",
              ])
            )
          return { reconciliation, lots, remainingInternalLegs }
        })
      )

      expect(state.reconciliation).toEqual(
        expect.objectContaining({
          status: "needs_review",
          canonicalTransferId: receipt.transferId,
          canonicalTransactionId: receipt.transactionId,
          reviewMetadata: expect.objectContaining({
            rollback: {
              status: "blocked",
              reason: "dependent_origin_fifo_usage",
              appliedEffectsRetained: true,
            },
          }),
        })
      )
      expect(state.lots).toEqual(
        expect.arrayContaining([
          {
            id: seeded.firstLotId,
            remainingAmount: expect.stringContaining("0.00000000"),
          },
          {
            id: seeded.secondLotId,
            remainingAmount: expect.stringContaining("0.95000000"),
          },
        ])
      )
      expect(state.remainingInternalLegs).toHaveLength(2)
    }
  )

  it("records review state when downstream FIFO usage blocks match rollback", async () => {
    const walletAddress = "bc1qownedwalletblockedrollback000000000000000"
    const timestamp = new Date("2025-04-11T11:30:00.000Z")

    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-blocked-rollback",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-blocked-rollback",
        timestamp,
        amount: "0.25000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const firstReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-blocked-rollback-1",
        txHash: "btc-blocked-rollback-hash-1",
        timestamp: new Date("2025-04-11T11:35:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const openingLotId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [openingLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "blocked-rollback-opening-leg",
            timestamp: new Date("2025-04-01T11:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "1.00000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "50000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (openingLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create blocked rollback opening leg")
        }

        const [openingLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T11:00:00.000Z"),
            originalAmount: "1.00000000",
            remainingAmount: "1.00000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: openingLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        if (openingLot === undefined) {
          return yield* Effect.dieMessage("Failed to create blocked rollback opening lot")
        }
        return openingLot.id
      })
    )

    const reconcile = () =>
      runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )

    expect((await reconcile()).autoApplied).toBe(1)
    expect(
      await runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.applyDeterministicInternalTransferCanonicalization({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )
    ).toEqual({ canonicalizedPairs: 1 })

    const dependentUsage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [destinationLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(
            and(
              eq(schema.transactionLegs.transactionId, firstReceipt.transactionId),
              eq(schema.transactionLegs.derivationRule, "internal_transfer_in")
            )
          )
          .limit(1)

        if (destinationLeg === undefined) {
          return yield* Effect.dieMessage("Failed to load blocked rollback destination leg")
        }

        const [destinationLot] = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceLegId, destinationLeg.id))
          .limit(1)
        const [dependentDisposalLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "blocked-rollback-dependent-disposal",
            timestamp: new Date("2025-04-12T11:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "disposal",
            provenance: "deterministic",
            fiatAmount: "3000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (destinationLot === undefined || dependentDisposalLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create blocked rollback dependent usage")
        }

        const [dependentMatch] = yield* db
          .insert(schema.disposalMatches)
          .values({
            disposalLegId: dependentDisposalLeg.id,
            fifoLotId: destinationLot.id,
            matchedAmount: "0.05000000",
            costBasis: "2500.00",
            proceeds: "3000.00",
            gainLoss: "500.00",
          })
          .returning({ id: schema.disposalMatches.id })

        if (dependentMatch === undefined) {
          return yield* Effect.dieMessage("Failed to create blocked rollback disposal match")
        }

        yield* db
          .update(schema.fifoLots)
          .set({ remainingAmount: "0.20000000" })
          .where(eq(schema.fifoLots.id, destinationLot.id))

        return {
          destinationLegId: destinationLeg.id,
          destinationLotId: destinationLot.id,
          dependentMatchId: dependentMatch.id,
        }
      })
    )

    const secondReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-blocked-rollback-2",
        txHash: "btc-blocked-rollback-hash-2",
        timestamp: new Date("2025-04-11T11:38:00.000Z"),
        amount: "0.25000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    expect((await reconcile()).needsReview).toBe(1)
    expect((await reconcile()).needsReview).toBe(1)

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const [destinationLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.id, dependentUsage.destinationLegId))
        const [destinationLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, dependentUsage.destinationLotId))
        const [dependentMatch] = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.id, dependentUsage.dependentMatchId))

        return { reconciliation, destinationLeg, destinationLot, dependentMatch }
      })
    )

    expect(state.reconciliation).toEqual(
      expect.objectContaining({
        status: "needs_review",
        canonicalTransferId: firstReceipt.transferId,
        canonicalTransactionId: firstReceipt.transactionId,
        matchReason: "applied_match_replacement_rollback_blocked",
        confidence: "0.0000",
        deterministic: false,
        reviewMetadata: expect.objectContaining({
          candidateCount: 2,
          rollback: {
            status: "blocked",
            reason: "dependent_destination_lot_usage",
            appliedEffectsRetained: true,
          },
        }),
      })
    )
    expect(state.destinationLeg).toEqual({ id: dependentUsage.destinationLegId })
    expect(state.destinationLot?.remainingAmount).toContain("0.20000000")
    expect(state.dependentMatch).toEqual({ id: dependentUsage.dependentMatchId })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transfers)
          .set({ amount: "0.30000000" })
          .where(inArray(schema.transfers.id, [firstReceipt.transferId, secondReceipt.transferId]))
      })
    )

    expect((await reconcile()).pending).toBe(1)

    const blockedPending = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        return reconciliation
      })
    )

    expect(blockedPending).toEqual(
      expect.objectContaining({
        status: "needs_review",
        canonicalTransferId: firstReceipt.transferId,
        canonicalTransactionId: firstReceipt.transactionId,
        matchReason: "applied_match_replacement_rollback_blocked",
        confidence: "0.0000",
        deterministic: false,
        reviewMetadata: expect.objectContaining({
          rollback: {
            status: "blocked",
            reason: "dependent_destination_lot_usage",
            appliedEffectsRetained: true,
          },
        }),
      })
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transfers)
          .set({ amount: "0.25000000" })
          .where(eq(schema.transfers.id, secondReceipt.transferId))
      })
    )

    expect((await reconcile()).autoApplied).toBe(1)

    const blockedReplacement = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        return reconciliation
      })
    )

    expect(blockedReplacement).toEqual(
      expect.objectContaining({
        status: "needs_review",
        canonicalTransferId: firstReceipt.transferId,
        canonicalTransactionId: firstReceipt.transactionId,
        matchReason: "applied_match_replacement_rollback_blocked",
        confidence: "0.0000",
        deterministic: false,
        reviewMetadata: expect.objectContaining({
          rollback: {
            status: "blocked",
            reason: "dependent_destination_lot_usage",
            appliedEffectsRetained: true,
          },
        }),
      })
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.disposalMatches)
          .where(eq(schema.disposalMatches.id, dependentUsage.dependentMatchId))
      })
    )

    expect((await reconcile()).autoApplied).toBe(1)

    const retriedState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const [destinationLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.id, dependentUsage.destinationLegId))
        const [destinationLot] = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, dependentUsage.destinationLotId))
        const [openingLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, openingLotId))
        return { reconciliation, destinationLeg, destinationLot, openingLot }
      })
    )

    expect(retriedState.reconciliation).toEqual(
      expect.objectContaining({
        status: "auto_applied",
        canonicalTransferId: secondReceipt.transferId,
        canonicalTransactionId: secondReceipt.transactionId,
        matchReason: "deterministic_wallet_receipt_match",
        reviewMetadata: expect.not.objectContaining({ rollback: expect.anything() }),
      })
    )
    expect(retriedState.destinationLeg).toBeUndefined()
    expect(retriedState.destinationLot).toBeUndefined()
    expect(retriedState.openingLot?.remainingAmount).toContain("1.00000000")
  })

  it("keeps distinct observed representations visible beside canonical transfers", async () => {
    const walletAddress = "CaseSensitiveWallet1111111111111111111111111"
    const canonicalMintAddress = "MintCaseABC111111111111111111111111111111111"
    const observedMintAddress = "mintcaseabc111111111111111111111111111111111"
    const txHash = "solana-distinct-observed-representations"
    const solanaBlockchainId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "solana"))
          .limit(1)

        if (blockchain === undefined) {
          return yield* Effect.dieMessage("Missing seeded Solana blockchain fixture")
        }

        return blockchain.id
      })
    )
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-distinct-observed" })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "solana",
        providerKey: "helius-solana",
      })
    )
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-distinct-observed",
        timestamp: new Date("2025-04-11T11:00:00.000Z"),
        amount: "0.18000000",
        toAddress: walletAddress,
        networkName: "solana",
        networkHash: txHash,
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        providerAssetId: observedMintAddress,
        externalId: "observed-distinct-representation",
        txHash,
        timestamp: new Date("2025-04-11T11:02:00.000Z"),
        amount: "0.18000000",
        walletAddress,
        blockchainId: solanaBlockchainId,
        blockchainName: "solana",
        representationType: "token",
        contractAddress: null,
        mintAddress: observedMintAddress,
        decimals: 8,
      })
    )

    const canonicalTransferId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: TEST_BTC_ASSET_ID,
            blockchainId: solanaBlockchainId,
            type: "token",
            mintAddress: canonicalMintAddress,
            decimals: 8,
          })
          .returning({ id: schema.assetRepresentations.id })

        if (representation === undefined) {
          return yield* Effect.dieMessage("Failed to create canonical representation fixture")
        }

        yield* db.insert(schema.transactionOnchainContext).values({
          transactionId: observed.transactionId,
          blockchainId: solanaBlockchainId,
          addressId: ONCHAIN_ADDRESS_ID,
          chainTxId: txHash,
          blockHeight: "1",
          blockHash: "block-distinct-observed-representations",
          positionInBlock: "0",
          fromAddress: "external-observed-origin",
          toAddress: walletAddress,
          gasUsed: null,
          gasPrice: null,
          feeAmount: null,
          feeAssetId: null,
          feeCostBasisAmount: null,
          feeCostBasisCurrency: null,
          isError: false,
          functionName: null,
          metadata: { provider: "helius-solana" },
        })

        const [transfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "canonical-distinct-representation",
            externalGroupId: txHash,
            addressId: ONCHAIN_ADDRESS_ID,
            blockchainId: solanaBlockchainId,
            txHash,
            timestamp: new Date("2025-04-11T11:02:00.000Z"),
            type: "spl",
            fromAddress: "external-observed-origin",
            toAddress: walletAddress,
            fromAccountRef: null,
            toAccountRef: null,
            fromPartyType: "address",
            fromPartyResourcePath: null,
            toPartyType: "address",
            toPartyResourcePath: null,
            assetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: representation.id,
            amount: "0.18000000",
            tokenId: null,
            notes: null,
            metadata: { provider: "helius-solana" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transfers.id })

        if (transfer === undefined) {
          return yield* Effect.dieMessage("Failed to create canonical transfer fixture")
        }

        return transfer.id
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

    const destinationSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: ONCHAIN_SOURCE_ID,
        })
      )
    )

    const { reconciliation, destinationReconciliations } = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const destinationReconciliations = yield* db
          .select()
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, observed.providerTransferId))
        return { reconciliation, destinationReconciliations }
      })
    )

    expect(summary.needsReview).toBe(1)
    expect(destinationSummary.evaluatedProviderTransfers).toBe(0)
    expect(destinationReconciliations).toEqual([])
    expect(reconciliation).toEqual(
      expect.objectContaining({
        status: "needs_review",
        matchReason: "multiple_candidate_onchain_receipts",
      })
    )
    expect(reconciliation?.reviewMetadata).toEqual(
      expect.objectContaining({
        candidateCount: 2,
        candidateTransferIds: expect.arrayContaining([canonicalTransferId, null]),
        candidates: expect.arrayContaining([
          expect.objectContaining({
            observedProviderTransferId: observed.providerTransferId,
            mintAddress: observedMintAddress,
          }),
        ]),
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

  it("reselects reconciliation state after waiting for destination inventory", async () => {
    const walletAddress = "bc1qownedwalletreselect000000000000000000000"
    const timestamp = new Date("2025-04-13T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-reselect",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-reselect",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-reselect-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-reselect",
        txHash: "btc-reselect-hash",
        timestamp: new Date("2025-04-13T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const reconciliationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: receipt.transferId,
            canonicalTransactionId: receipt.transactionId,
            status: "approved",
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })

        if (reconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create reselect reconciliation fixture")
        }
        return reconciliation.id
      })
    )

    const lockAcquired = await Effect.runPromise(Deferred.make<void>())
    const removeCanonicalState = await Effect.runPromise(Deferred.make<void>())
    const lockDestination = runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, ONCHAIN_SOURCE_ID))
              .for("update")
            yield* Deferred.succeed(lockAcquired, undefined)
            yield* Deferred.await(removeCanonicalState)
            yield* tx
              .delete(schema.transactions)
              .where(eq(schema.transactions.id, receipt.transactionId))
          })
        )
      })
    )

    await Effect.runPromise(Deferred.await(lockAcquired))

    const canonicalization = runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId,
        })
      )
    )
    const earlyOutcome = await Promise.race([
      canonicalization.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])

    await Effect.runPromise(Deferred.succeed(removeCanonicalState, undefined))
    const [summary] = await Promise.all([canonicalization, lockDestination])

    expect(earlyOutcome).toBe("blocked")
    expect(summary).toEqual({ canonicalizedPairs: 0 })
  })

  it("serializes reconciliation invalidation on canonicalization source locks", async () => {
    const walletAddress = "bc1qownedwalletserializedinvalidation00000000000"
    const timestamp = new Date("2025-04-13T12:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-serialized-invalidation" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-serialized-invalidation",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-serialized-invalidation-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-serialized-invalidation",
        txHash: "btc-serialized-invalidation-hash",
        timestamp: new Date("2025-04-13T12:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.transferReconciliations).values({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId,
          canonicalTransferId: receipt.transferId,
          canonicalTransactionId: receipt.transactionId,
          status: "auto_applied",
          matchReason: "exact_network_hash",
          confidence: "1.0000",
          deterministic: true,
          reviewMetadata: {},
        })
      })
    )

    const lockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseLock = await Effect.runPromise(Deferred.make<void>())
    const heldCanonicalizationSourceLock = runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, ONCHAIN_SOURCE_ID))
              .for("update")
            yield* Deferred.succeed(lockAcquired, undefined)
            yield* Deferred.await(releaseLock)
          })
        )
      })
    )
    await Effect.runPromise(Deferred.await(lockAcquired))

    const invalidation = runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.upsertTransferReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "pending",
          matchReason: "no_candidate_onchain_receipt",
          confidence: "0.0000",
          deterministic: false,
          reviewMetadata: {},
        })
      )
    )
    const earlyOutcome = await Promise.race([
      invalidation.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])

    await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
    await Promise.all([invalidation, heldCanonicalizationSourceLock])

    expect(earlyOutcome).toBe("blocked")
  })

  it("revalidates candidate uniqueness after concurrent destination persistence", async () => {
    const walletAddress = "bc1qownedwalletconcurrentcandidate00000000000000"
    const timestamp = new Date("2025-04-13T13:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-concurrent-candidate" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-concurrent-candidate",
        timestamp,
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-concurrent-candidate-first",
        txHash: "btc-concurrent-candidate-first",
        timestamp: new Date("2025-04-13T13:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const candidatesRead = await Effect.runPromise(Deferred.make<void>())
    const continueReconciliation = await Effect.runPromise(Deferred.make<void>())
    const PausingTransferReconciliationRepositoryLive = Layer.effect(
      TransferReconciliationRepository,
      Effect.gen(function* () {
        const repository = yield* TransferReconciliationRepository

        return TransferReconciliationRepository.of({
          ...repository,
          findOnchainTransferCandidates: (params) =>
            repository.findOnchainTransferCandidates(params).pipe(
              Effect.tap(() => Deferred.succeed(candidatesRead, undefined)),
              Effect.tap(() => Deferred.await(continueReconciliation))
            ),
        })
      })
    ).pipe(Layer.provide(TransferReconciliationRepositoryLive))
    const PausingTransferReconciliationServiceLive = TransferReconciliationServiceLive.pipe(
      Layer.provide(PausingTransferReconciliationRepositoryLive)
    )
    const reconciliationRun = Effect.runPromise(
      context.runWithLayer({
        effect: Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        ),
        layer: PausingTransferReconciliationServiceLive,
      })
    )

    await Effect.runPromise(Deferred.await(candidatesRead))
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-concurrent-candidate-second",
        txHash: "btc-concurrent-candidate-second",
        timestamp: new Date("2025-04-13T13:06:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await Effect.runPromise(Deferred.succeed(continueReconciliation, undefined))

    const summary = await reconciliationRun
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
        pending: 0,
        needsReview: 1,
        autoApplied: 0,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        canonicalTransferId: null,
        status: "needs_review",
        matchReason: "candidate_set_changed_during_reconciliation",
      })
    )
  })

  it.each([
    {
      label: "an earlier origin disposal",
      consumerSourceId: TEST_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T09:00:00.000Z"),
      consumerDerivationRule: "fixture_historical_disposal",
      consumerEffect: "disposal" as const,
      expectedCanonicalizedPairs: 1,
    },
    {
      label: "a later origin disposal",
      consumerSourceId: TEST_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "fixture_historical_disposal",
      consumerEffect: "disposal" as const,
      expectedCanonicalizedPairs: 0,
    },
    {
      label: "a later origin internal transfer",
      consumerSourceId: TEST_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "internal_transfer_out",
      consumerEffect: "disposal" as const,
      expectedCanonicalizedPairs: 0,
    },
    {
      label: "a later destination disposal",
      consumerSourceId: ONCHAIN_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "fixture_historical_disposal",
      consumerEffect: "disposal" as const,
      expectedCanonicalizedPairs: 0,
    },
    {
      label: "a later destination internal transfer",
      consumerSourceId: ONCHAIN_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "internal_transfer_out",
      consumerEffect: "disposal" as const,
      expectedCanonicalizedPairs: 0,
    },
    {
      label: "a later origin inventory allocation",
      consumerSourceId: TEST_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "fixture_historical_movement",
      consumerEffect: "allocation" as const,
      expectedCanonicalizedPairs: 0,
    },
    {
      label: "a later destination inventory allocation",
      consumerSourceId: ONCHAIN_SOURCE_ID,
      consumerTimestamp: new Date("2025-04-14T11:00:00.000Z"),
      consumerDerivationRule: "fixture_historical_movement",
      consumerEffect: "allocation" as const,
      expectedCanonicalizedPairs: 0,
    },
  ])(
    "does not rewrite successful FIFO allocations behind $label",
    async ({
      label,
      consumerSourceId,
      consumerTimestamp,
      consumerDerivationRule,
      consumerEffect,
      expectedCanonicalizedPairs,
    }) => {
      const walletAddress = "bc1qownedwallethistoricalfifo00000000000000000"
      const transferTimestamp = new Date("2025-04-14T10:00:00.000Z")
      const providerAssetRowId = await runPg(
        seedApprovedProviderAsset({ providerAssetId: `historical-fifo-${label}` })
      )
      await runPg(seedOwnedOnchainSource({ walletAddress }))
      const providerTransferId = await runPg(
        seedProviderTransfer({
          providerAssetRowId,
          externalId: `provider-transfer-historical-fifo-${label}`,
          timestamp: transferTimestamp,
          amount: "0.25000000",
          toAddress: walletAddress,
          networkHash: `btc-historical-fifo-${label}`,
        })
      )
      await runPg(
        seedOnchainReceipt({
          externalId: `onchain-receipt-historical-fifo-${label}`,
          txHash: `btc-historical-fifo-${label}`,
          timestamp: new Date("2025-04-14T10:05:00.000Z"),
          amount: "0.25000000",
          walletAddress,
          blockchainId: fixture.bitcoinBlockchainId,
        })
      )

      const consumerFixture = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const openingLotIds = new Map<string, string>()

          for (const inventorySourceId of [TEST_SOURCE_ID, ONCHAIN_SOURCE_ID]) {
            const [acquisitionLeg] = yield* db
              .insert(schema.transactionLegs)
              .values({
                sourceId: inventorySourceId,
                externalId: `historical-fifo-opening-${label}-${inventorySourceId}`,
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
            if (acquisitionLeg === undefined) {
              return yield* Effect.dieMessage("Failed to seed historical FIFO acquisition")
            }

            const [lot] = yield* db
              .insert(schema.fifoLots)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: inventorySourceId,
                assetId: TEST_BTC_ASSET_ID,
                acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
                originalAmount: "1.00000000",
                remainingAmount:
                  inventorySourceId === consumerSourceId ? "0.90000000" : "1.00000000",
                costBasisPerToken: "50000.000000000000000000",
                costBasisCurrency: "EUR",
                sourceLegId: acquisitionLeg.id,
                sourceLegSequence: 0,
              })
              .returning({ id: schema.fifoLots.id })
            if (lot === undefined) {
              return yield* Effect.dieMessage("Failed to seed historical FIFO lot")
            }
            openingLotIds.set(inventorySourceId, lot.id)
          }

          const [consumerTransaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: consumerSourceId,
              sourceRawRecordId: null,
              externalId: `historical-fifo-consumer-${label}`,
              timestamp: consumerTimestamp,
              transactionType: "sell_fiat",
              providerTransactionType: "sell",
              providerStatus: "completed",
              metadata: { fixture: "historical-fifo-consumer" },
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (consumerTransaction === undefined) {
            return yield* Effect.dieMessage("Failed to seed historical FIFO consumer transaction")
          }

          const consumerLotId = openingLotIds.get(consumerSourceId)
          if (consumerLotId === undefined) {
            return yield* Effect.dieMessage("Failed to seed historical FIFO consumer")
          }

          if (consumerEffect === "allocation") {
            const [movementLeg] = yield* db
              .insert(schema.transactionLegs)
              .values({
                sourceId: consumerSourceId,
                externalId: `historical-fifo-consumer-movement-leg-${label}`,
                timestamp: consumerTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.10000000",
                kind: "disposal",
                provenance: "deterministic",
                derivationRule: consumerDerivationRule,
                transactionId: consumerTransaction.id,
                fiatAmount: null,
                fiatCurrency: "EUR",
              })
              .returning({ id: schema.transactionLegs.id })
            if (movementLeg === undefined) {
              return yield* Effect.dieMessage("Failed to seed historical FIFO movement leg")
            }
            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: consumerSourceId,
                transactionId: consumerTransaction.id,
                providerTransferId: null,
                transactionLegId: movementLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: consumerTimestamp,
                direction: "outbound",
                purpose: "principal",
                taxTreatment: "taxable",
                reconciliationStatus: "unmatched",
                amount: "0.10000000",
              })
              .returning({ id: schema.inventoryMovements.id })
            if (movement === undefined) {
              return yield* Effect.dieMessage("Failed to seed historical FIFO movement")
            }
            const [allocation] = yield* db
              .insert(schema.inventoryMovementAllocations)
              .values({
                inventoryMovementId: movement.id,
                fifoLotId: consumerLotId,
                matchedAmount: "0.10000000",
              })
              .returning({ id: schema.inventoryMovementAllocations.id })
            if (allocation === undefined) {
              return yield* Effect.dieMessage("Failed to seed historical FIFO allocation")
            }

            return {
              consumerEffect,
              consumerEffectId: allocation.id,
              consumerLegId: movementLeg.id,
              consumerLotId,
              consumerMovementId: movement.id,
            }
          }

          const [consumerLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: consumerSourceId,
              externalId: `historical-fifo-consumer-leg-${label}`,
              timestamp: consumerTimestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.10000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: consumerDerivationRule,
              transactionId: consumerTransaction.id,
              fiatAmount: "6000.00",
              fiatCurrency: "EUR",
            })
            .returning({ id: schema.transactionLegs.id })
          if (consumerLeg === undefined) {
            return yield* Effect.dieMessage("Failed to seed historical FIFO disposal")
          }
          const [disposalMatch] = yield* db
            .insert(schema.disposalMatches)
            .values({
              disposalLegId: consumerLeg.id,
              fifoLotId: consumerLotId,
              matchedAmount: "0.10000000",
              costBasis: "5000.00",
              proceeds: "6000.00",
              gainLoss: "1000.00",
            })
            .returning({ id: schema.disposalMatches.id })
          if (disposalMatch === undefined) {
            return yield* Effect.dieMessage("Failed to seed historical FIFO disposal match")
          }

          return {
            consumerEffect,
            consumerEffectId: disposalMatch.id,
            consumerLegId: consumerLeg.id,
            consumerLotId,
            consumerMovementId: null,
          }
        })
      )

      const reconciliation = await runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.reconcileTransferCandidates({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )
      expect(reconciliation.autoApplied).toBe(1)

      const summary = await runTransferReconciliation(
        Effect.flatMap(TransferReconciliationService, (service) =>
          service.applyDeterministicInternalTransferCanonicalization({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )
      const persistedState = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [reconciliationRow] = yield* db
            .select()
            .from(schema.transferReconciliations)
            .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          const [disposalMatch] = yield* db
            .select({
              id: schema.disposalMatches.id,
              disposalLegId: schema.disposalMatches.disposalLegId,
              fifoLotId: schema.disposalMatches.fifoLotId,
              matchedAmount: schema.disposalMatches.matchedAmount,
            })
            .from(schema.disposalMatches)
            .where(eq(schema.disposalMatches.id, consumerFixture.consumerEffectId))
          const [movementAllocation] = yield* db
            .select({
              id: schema.inventoryMovementAllocations.id,
              inventoryMovementId: schema.inventoryMovementAllocations.inventoryMovementId,
              fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
              matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
            })
            .from(schema.inventoryMovementAllocations)
            .where(eq(schema.inventoryMovementAllocations.id, consumerFixture.consumerEffectId))
          const [consumerLot] = yield* db
            .select({ remainingAmount: schema.fifoLots.remainingAmount })
            .from(schema.fifoLots)
            .where(eq(schema.fifoLots.id, consumerFixture.consumerLotId))
          const reconciliationLegs = yield* db
            .select({ id: schema.transactionLegs.id })
            .from(schema.transactionLegs)
            .where(
              sql`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId' = ${providerTransferId}`
            )

          return {
            reconciliationRow,
            disposalMatch,
            movementAllocation,
            consumerLot,
            reconciliationLegs,
          }
        })
      )

      expect(summary).toEqual({ canonicalizedPairs: expectedCanonicalizedPairs })
      if (consumerFixture.consumerEffect === "allocation") {
        expect(persistedState.disposalMatch).toBeUndefined()
        expect(persistedState.movementAllocation).toEqual({
          id: consumerFixture.consumerEffectId,
          inventoryMovementId: consumerFixture.consumerMovementId,
          fifoLotId: consumerFixture.consumerLotId,
          matchedAmount: expect.stringContaining("0.10000000"),
        })
      } else {
        expect(persistedState.movementAllocation).toBeUndefined()
        expect(persistedState.disposalMatch).toEqual({
          id: consumerFixture.consumerEffectId,
          disposalLegId: consumerFixture.consumerLegId,
          fifoLotId: consumerFixture.consumerLotId,
          matchedAmount: expect.stringContaining("0.10000000"),
        })
      }
      if (expectedCanonicalizedPairs === 0) {
        expect(persistedState.reconciliationRow).toEqual(
          expect.objectContaining({
            status: "needs_review",
            matchReason: "historical_fifo_rebuild_required",
            deterministic: false,
            reviewMetadata: expect.objectContaining({
              canonicalization: expect.objectContaining({
                status: "blocked",
                reason: "later_fifo_usage",
                affectedSourceIds: [consumerSourceId],
              }),
            }),
          })
        )
        expect(persistedState.consumerLot?.remainingAmount).toContain("0.90000000")
        expect(persistedState.reconciliationLegs).toHaveLength(0)
      } else {
        expect(persistedState.consumerLot?.remainingAmount).toContain("0.65000000")
        expect(persistedState.reconciliationLegs).toHaveLength(2)
      }
    }
  )

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

    const providerOriginFixture = await runPg(
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

        const [feeLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "scoped-replay-origin-fee:leg",
            timestamp,
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "fee",
            provenance: "deterministic",
            derivationRule: "fixture_fee",
            transactionId: providerTransfer.transactionId,
            fiatAmount: null,
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (feeLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create origin fee leg fixture")
        }

        // Match the transfer amount so the test proves that amount equality does not make this
        // unrelated fee movement part of the canonical transfer.
        const [feeMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId: null,
            transactionLegId: feeLeg.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "fee",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (feeMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create origin fee movement fixture")
        }

        yield* db.insert(schema.transactionReviews).values({
          transactionId: providerTransfer.transactionId,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          originalTypeKey: "send",
          currentTypeKey: "send",
          categorizationReason:
            "fifo_inventory: Review required because origin inventory was incomplete.",
          matchedLayer: "fifo_inventory",
          needsReview: true,
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

        return {
          feeMovementId: feeMovement.id,
          originTransactionId: providerTransfer.transactionId,
          providerOriginLotId: providerOriginLot.id,
        }
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

    const destinationRecoveryFixture = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reviewedTransaction] = yield* db
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(eq(schema.transactions.externalId, "destination-disposal-before-reconciliation"))
          .limit(1)

        if (reviewedTransaction === undefined) {
          return yield* Effect.dieMessage("Failed to load reviewed disposal fixture")
        }

        yield* db
          .update(schema.transactionReviews)
          .set({
            reviewStatus: "changed",
            categorizationReason:
              "provider_asset_mapping: Keep this provider review.\nfifo_inventory: Review required because destination inventory is incomplete.",
            matchedLayer: "provider_asset_mapping,fifo_inventory",
            needsReview: true,
            userNotes: "Keep the manual review state",
            reviewedAt: new Date("2025-04-20T12:00:00.000Z"),
          })
          .where(eq(schema.transactionReviews.transactionId, reviewedTransaction.id))

        const [redundantProviderTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: reviewedTransaction.id,
            externalId: "destination-reviewed-principal-movement",
            externalGroupId: "destination-reviewed-principal-movement:group",
            providerAssetId: providerAssetRowId,
            timestamp: new Date("2025-04-20T10:00:00.000Z"),
            direction: "outbound",
            fromAccountRef: "owned-wallet",
            toAccountRef: null,
            fromAddress: walletAddress,
            toAddress: "bc1qexternaldisposal000000000000000000000000",
            networkName: "bitcoin",
            networkHash: "destination-reviewed-principal-movement-hash",
            amount: "0.15000000",
            metadata: { provider: "bitcoin" },
          })
          .returning({ id: schema.providerTransfers.id })

        if (redundantProviderTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create redundant principal transfer fixture")
        }

        const [redundantPrincipalMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: reviewedTransaction.id,
            providerTransferId: redundantProviderTransfer.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-20T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.15000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (redundantPrincipalMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create redundant principal movement fixture")
        }

        const [localAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-local-acquisition",
            timestamp: new Date("2025-04-05T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "2000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (localAcquisitionLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create destination acquisition fixture")
        }

        const [localLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-05T10:00:00.000Z"),
            originalAmount: "0.05000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "40000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: localAcquisitionLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [laterTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-later-disposal",
            timestamp: new Date("2025-04-21T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "sell",
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (localLot === undefined || laterTransaction === undefined) {
          return yield* Effect.dieMessage("Failed to create later disposal fixtures")
        }

        const [laterDisposalLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-later-disposal:leg",
            timestamp: new Date("2025-04-21T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "fixture_disposal",
            transactionId: laterTransaction.id,
            fiatAmount: "3100.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (laterDisposalLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create later disposal leg fixture")
        }

        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: laterDisposalLeg.id,
          fifoLotId: localLot.id,
          matchedAmount: "0.05000000",
          costBasis: "2000.00000000",
          proceeds: "3100.00000000",
          gainLoss: "1100.00000000",
        })

        const [feeLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-pending-fee:leg",
            timestamp: new Date("2025-04-14T10:05:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.02000000",
            kind: "fee",
            provenance: "deterministic",
            derivationRule: "fixture_fee",
            transactionId: firstReceipt.transactionId,
            fiatAmount: null,
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (feeLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create fee leg fixture")
        }

        const [feeMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: firstReceipt.transactionId,
            providerTransferId: null,
            transactionLegId: feeLeg.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-14T10:05:00.000Z"),
            direction: "outbound",
            purpose: "fee",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.02000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (feeMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create fee movement fixture")
        }

        yield* db.insert(schema.transactionReviews).values({
          transactionId: firstReceipt.transactionId,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          originalTypeKey: "sell_fiat",
          currentTypeKey: "sell_fiat",
          categorizationReason:
            "provider_asset_mapping: Keep this unresolved provider review.\nfifo_inventory: Review required because destination fee inventory is incomplete.",
          matchedLayer: "provider_asset_mapping,fifo_inventory",
          needsReview: true,
        })

        const [canonicalTransferTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-canonical-transfer",
            timestamp: new Date("2025-04-19T10:00:00.000Z"),
            transactionType: "internal_transfer",
            providerTransactionType: "send",
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        const [canonicalAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-canonical-transfer:opening-leg",
            timestamp: new Date("2025-04-05T09:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.03000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "1200.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (canonicalTransferTransaction === undefined || canonicalAcquisitionLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create canonical transfer fixtures")
        }

        const [canonicalTransferLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "destination-canonical-transfer:leg",
            timestamp: new Date("2025-04-19T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.03000000",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "fixture_disposal",
            transactionId: canonicalTransferTransaction.id,
            fiatAmount: "1200.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })
        const [canonicalLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-05T09:00:00.000Z"),
            originalAmount: "0.03000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "40000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: canonicalAcquisitionLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })

        if (canonicalTransferLeg === undefined || canonicalLot === undefined) {
          return yield* Effect.dieMessage("Failed to create canonical transfer FIFO fixtures")
        }

        const [canonicalMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: canonicalTransferTransaction.id,
            providerTransferId: null,
            transactionLegId: canonicalTransferLeg.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-19T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.03000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (canonicalMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create canonical custody movement fixture")
        }

        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: canonicalTransferLeg.id,
          fifoLotId: canonicalLot.id,
          matchedAmount: "0.03000000",
          costBasis: "1200.00000000",
          proceeds: "1200.00000000",
          gainLoss: "0.00000000",
        })

        yield* db.insert(schema.transactionReviews).values({
          transactionId: canonicalTransferTransaction.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          originalTypeKey: "internal_transfer",
          currentTypeKey: "internal_transfer",
          categorizationReason:
            "fifo_inventory: Review required because destination inventory changed.",
          matchedLayer: "fifo_inventory",
          needsReview: true,
        })

        return {
          canonicalLotId: canonicalLot.id,
          canonicalMovementId: canonicalMovement.id,
          canonicalTransferLegId: canonicalTransferLeg.id,
          localLotId: localLot.id,
          laterDisposalLegId: laterDisposalLeg.id,
          feeMovementId: feeMovement.id,
          redundantPrincipalMovementId: redundantPrincipalMovement.id,
          reviewedTransactionId: reviewedTransaction.id,
        }
      })
    )

    const reviewsBeforeReconciliation = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.transactionReviews)
      })
    )
    expect(reviewsBeforeReconciliation).toHaveLength(4)

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

    const underfundedState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const laterMatches = yield* db
          .select({
            fifoLotId: schema.disposalMatches.fifoLotId,
            matchedAmount: schema.disposalMatches.matchedAmount,
          })
          .from(schema.disposalMatches)
          .where(
            eq(schema.disposalMatches.disposalLegId, destinationRecoveryFixture.laterDisposalLegId)
          )
        const [localLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, destinationRecoveryFixture.localLotId))
        const [receiptReview] = yield* db
          .select({
            reviewStatus: schema.transactionReviews.reviewStatus,
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, firstReceipt.transactionId))
        const [laterDisposalReview] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.transactionLegs.transactionId, schema.transactionReviews.transactionId)
          )
          .where(eq(schema.transactionLegs.id, destinationRecoveryFixture.laterDisposalLegId))

        return { laterMatches, localLot, receiptReview, laterDisposalReview }
      })
    )

    expect(underfundedState.laterMatches).toEqual([])
    expect(underfundedState.localLot?.remainingAmount).toContain("0.05000000")
    expect(underfundedState.receiptReview).toEqual({
      reviewStatus: "needs_review",
      matchedLayer: "provider_asset_mapping,fifo_inventory,transfer_reconciliation",
      needsReview: true,
    })
    expect(underfundedState.laterDisposalReview).toEqual({
      matchedLayer: "fifo_inventory",
      needsReview: true,
    })

    const secondSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: secondReconciliationId,
        })
      )
    )

    const [secondReconciliation] = await runPg(
      Effect.flatMap(drizzle, (db) =>
        db
          .select({
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            reviewMetadata: schema.transferReconciliations.reviewMetadata,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.id, secondReconciliationId))
      )
    )

    expect({ secondSummary, secondReconciliation }).toEqual({
      secondSummary: { canonicalizedPairs: 1 },
      secondReconciliation: expect.objectContaining({ status: "approved" }),
    })

    const movedLots = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            id: schema.fifoLots.id,
            assetRepresentationId: schema.fifoLots.assetRepresentationId,
            acquiredAt: schema.fifoLots.acquiredAt,
            originalAmount: schema.fifoLots.originalAmount,
            remainingAmount: schema.fifoLots.remainingAmount,
            costBasisPerToken: schema.fifoLots.costBasisPerToken,
            costBasisCurrency: schema.fifoLots.costBasisCurrency,
          })
          .from(schema.fifoLots)
          .where(
            and(
              eq(schema.fifoLots.sourceId, ONCHAIN_SOURCE_ID),
              ne(schema.fifoLots.id, destinationRecoveryFixture.localLotId),
              ne(schema.fifoLots.id, destinationRecoveryFixture.canonicalLotId)
            )
          )
          .orderBy(asc(schema.fifoLots.createdAt))
      })
    )

    expect(movedLots).toEqual([
      expect.objectContaining({
        acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        originalAmount: expect.stringContaining("0.10000000"),
        remainingAmount: expect.stringContaining("0.00000000"),
        costBasisPerToken: expect.stringContaining("50000.000000000000000000"),
        costBasisCurrency: "EUR",
      }),
      expect.objectContaining({
        acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        originalAmount: expect.stringContaining("0.20000000"),
        remainingAmount: expect.stringContaining("0.05000000"),
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
        const [feeMovement] = yield* db
          .select({
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
            taxTreatment: schema.inventoryMovements.taxTreatment,
          })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.id, providerOriginFixture.feeMovementId))
        const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
        const reviews = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(ne(schema.transactionReviews.matchedLayer, "transfer_reconciliation"))
        const disposalMatches = yield* db
          .select({
            disposalLegId: schema.disposalMatches.disposalLegId,
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
          .where(eq(schema.fifoLots.id, providerOriginFixture.providerOriginLotId))
        const [originReview] = yield* db
          .select()
          .from(schema.transactionReviews)
          .where(
            eq(schema.transactionReviews.transactionId, providerOriginFixture.originTransactionId)
          )
        const [localLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, destinationRecoveryFixture.localLotId))
        const [canonicalLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, destinationRecoveryFixture.canonicalLotId))
        const canonicalMovementAllocations = yield* db
          .select({ id: schema.inventoryMovementAllocations.id })
          .from(schema.inventoryMovementAllocations)
          .where(
            eq(
              schema.inventoryMovementAllocations.inventoryMovementId,
              destinationRecoveryFixture.canonicalMovementId
            )
          )
        const redundantPrincipalMovementAllocations = yield* db
          .select({ id: schema.inventoryMovementAllocations.id })
          .from(schema.inventoryMovementAllocations)
          .where(
            eq(
              schema.inventoryMovementAllocations.inventoryMovementId,
              destinationRecoveryFixture.redundantPrincipalMovementId
            )
          )
        const [redundantPrincipalMovement] = yield* db
          .select({
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
          })
          .from(schema.inventoryMovements)
          .where(
            eq(
              schema.inventoryMovements.id,
              destinationRecoveryFixture.redundantPrincipalMovementId
            )
          )
        const canonicalDisposalMatches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(
            eq(
              schema.disposalMatches.disposalLegId,
              destinationRecoveryFixture.canonicalTransferLegId
            )
          )
        return {
          canonicalDisposalMatches,
          canonicalLot,
          canonicalMovementAllocations,
          lots,
          movement,
          allocations,
          disposalMatches,
          feeMovement,
          providerOriginLot,
          redundantPrincipalMovement,
          redundantPrincipalMovementAllocations,
          originReview,
          localLot,
          reviews,
        }
      })
    )

    expect(state.movement).toEqual(
      expect.objectContaining({
        reconciliationStatus: "matched",
        taxTreatment: "non_taxable",
      })
    )
    expect(state.feeMovement).toEqual({
      reconciliationStatus: "unmatched",
      taxTreatment: "pending_review",
    })
    expect(state.allocations).toEqual([
      expect.objectContaining({
        inventoryMovementId: destinationRecoveryFixture.feeMovementId,
        fifoLotId: movedLots[0]?.id,
        matchedAmount: expect.stringContaining("0.02000000"),
      }),
    ])
    expect(state.canonicalMovementAllocations).toHaveLength(0)
    expect(state.redundantPrincipalMovement).toEqual({ reconciliationStatus: "unmatched" })
    expect(state.redundantPrincipalMovementAllocations).toHaveLength(0)
    expect(state.canonicalDisposalMatches).toHaveLength(1)
    expect(state.canonicalLot?.remainingAmount).toContain("0.03000000")
    expect(state.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transactionId: providerOriginFixture.originTransactionId,
          reviewStatus: "auto_applied",
          categorizationReason:
            "fifo_inventory: Review required because origin inventory was incomplete.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
          matchedLayer: "fifo_inventory,transfer_reconciliation",
          needsReview: true,
        }),
        expect.objectContaining({
          transactionId: destinationRecoveryFixture.reviewedTransactionId,
          reviewStatus: "changed",
          categorizationReason: "provider_asset_mapping: Keep this provider review.",
          matchedLayer: "provider_asset_mapping",
          needsReview: false,
          userNotes: "Keep the manual review state",
          reviewedAt: new Date("2025-04-20T12:00:00.000Z"),
        }),
        expect.objectContaining({
          transactionId: firstReceipt.transactionId,
          reviewStatus: "needs_review",
          categorizationReason:
            "provider_asset_mapping: Keep this unresolved provider review.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
          matchedLayer: "provider_asset_mapping,transfer_reconciliation",
          needsReview: true,
        }),
      ])
    )
    expect(state.reviews).toHaveLength(3)
    expect(state.originReview).toEqual(
      expect.objectContaining({
        transactionId: providerOriginFixture.originTransactionId,
        reviewStatus: "auto_applied",
        categorizationReason:
          "fifo_inventory: Review required because origin inventory was incomplete.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
        matchedLayer: "fifo_inventory,transfer_reconciliation",
        needsReview: true,
      })
    )
    expect(state.disposalMatches).toHaveLength(4)
    expect(state.disposalMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposalLegId: destinationRecoveryFixture.canonicalTransferLegId,
          fifoLotId: movedLots[0]?.id,
          matchedAmount: expect.stringContaining("0.03000000"),
        }),
        expect.objectContaining({
          fifoLotId: movedLots[0]?.id,
          matchedAmount: expect.stringContaining("0.05000000"),
        }),
        expect.objectContaining({
          fifoLotId: movedLots[1]?.id,
          matchedAmount: expect.stringContaining("0.10000000"),
        }),
        expect.objectContaining({
          disposalLegId: destinationRecoveryFixture.laterDisposalLegId,
          fifoLotId: movedLots[1]?.id,
          matchedAmount: expect.stringContaining("0.05000000"),
        }),
      ])
    )
    expect(state.localLot?.remainingAmount).toContain("0.05000000")
    expect(state.providerOriginLot?.remainingAmount).toContain("0.20000000")
    expect(state.lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: TEST_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.70000000"),
        }),
        expect.objectContaining({
          sourceId: ONCHAIN_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.05000000"),
        }),
        expect.objectContaining({
          sourceId: ONCHAIN_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.00000000"),
        }),
        expect.objectContaining({
          sourceId: ONCHAIN_SOURCE_ID,
          remainingAmount: expect.stringContaining("0.05000000"),
        }),
      ])
    )

    const replayRepresentationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [representation] = yield* db
          .insert(schema.assetRepresentations)
          .values({
            assetId: TEST_BTC_ASSET_ID,
            blockchainId: fixture.baseBlockchainId,
            type: "token",
            contractAddress: "0x0000000000000000000000000000000000000b7c",
            decimals: 8,
          })
          .returning({ id: schema.assetRepresentations.id })

        if (representation === undefined) {
          return yield* Effect.dieMessage("Failed to create replay representation fixture")
        }

        yield* db
          .update(schema.transfers)
          .set({ assetRepresentationId: representation.id })
          .where(eq(schema.transfers.id, firstReceipt.transferId))

        return representation.id
      })
    )

    const replaySummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: firstReconciliationId,
        })
      )
    )
    expect(replaySummary).toEqual({ canonicalizedPairs: 1 })

    const replayState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [destinationLeg] = yield* db
          .select({
            id: schema.transactionLegs.id,
            assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          })
          .from(schema.transactionLegs)
          .where(
            and(
              eq(schema.transactionLegs.transactionId, firstReceipt.transactionId),
              eq(schema.transactionLegs.derivationRule, "internal_transfer_in")
            )
          )
          .limit(1)

        if (destinationLeg === undefined) {
          return yield* Effect.dieMessage("Missing replay destination leg")
        }

        const destinationLots = yield* db
          .select({ assetRepresentationId: schema.fifoLots.assetRepresentationId })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceLegId, destinationLeg.id))

        return { destinationLeg, destinationLots }
      })
    )

    expect(replayState.destinationLeg.assetRepresentationId).toBe(replayRepresentationId)
    expect(replayState.destinationLots.length).toBeGreaterThan(0)
    expect(
      replayState.destinationLots.every(
        (lot) => lot.assetRepresentationId === replayRepresentationId
      )
    ).toBe(true)
  })

  it("keeps transferred lots unavailable before the destination receipt", async () => {
    const walletAddress = "bc1qownedwalletreceiptgating000000000000000000"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-receipt-gating",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-receipt-gating",
        timestamp: new Date("2025-04-14T10:00:00.000Z"),
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-receipt-gating-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-receipt-gating",
        txHash: "btc-receipt-gating-hash",
        timestamp: new Date("2025-04-20T10:00:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const reconciliationId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: receipt.transferId,
            canonicalTransactionId: receipt.transactionId,
            status: "approved",
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })

        if (reconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create receipt-gating reconciliation")
        }

        const [originLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "receipt-gating-origin-acquisition",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "5000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })
        const [providerTransfer] = yield* db
          .select({ transactionId: schema.providerTransfers.transactionId })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, providerTransferId))
          .limit(1)

        if (originLeg === undefined || providerTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create receipt-gating origin fixture")
        }

        const [originLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "0.10000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: originLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [movement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-14T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (originLot === undefined || movement === undefined) {
          return yield* Effect.dieMessage("Failed to create receipt-gating custody fixture")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: movement.id,
          fifoLotId: originLot.id,
          matchedAmount: "0.10000000",
        })

        return reconciliation.id
      })
    )

    await runSourceNormalization(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: ONCHAIN_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "destination-disposal-before-receipt",
            externalGroupId: null,
            timestamp: new Date("2025-04-15T10:00:00.000Z"),
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
                externalId: "destination-disposal-before-receipt:leg",
                txHash: null,
                timestamp: new Date("2025-04-15T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                addressId: ONCHAIN_ADDRESS_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.10000000",
                kind: "disposal",
                provenance: "deterministic",
                derivationRule: "fixture_disposal",
                metadata: null,
                transactionId: transaction.id,
                sourceTransferId: null,
                fiatAmount: "6000.00",
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

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId,
        })
      )
    )

    expect(summary).toEqual({ canonicalizedPairs: 1 })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [disposal] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.externalId, "destination-disposal-before-receipt:leg"))
        const [movedLot] = yield* db
          .select({
            acquiredAt: schema.fifoLots.acquiredAt,
            availableAt: schema.transactionLegs.timestamp,
            remainingAmount: schema.fifoLots.remainingAmount,
          })
          .from(schema.fifoLots)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
          )
          .where(eq(schema.fifoLots.sourceId, ONCHAIN_SOURCE_ID))
        const [review] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .innerJoin(
            schema.transactions,
            eq(schema.transactions.id, schema.transactionReviews.transactionId)
          )
          .where(eq(schema.transactions.externalId, "destination-disposal-before-receipt"))

        if (disposal === undefined) {
          return yield* Effect.dieMessage("Failed to load receipt-gating disposal")
        }

        const matches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, disposal.id))

        return { matches, movedLot, review }
      })
    )

    expect(state.movedLot).toEqual({
      acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
      availableAt: new Date("2025-04-20T10:00:00.000Z"),
      remainingAmount: expect.stringContaining("0.10000000"),
    })
    expect(state.matches).toHaveLength(0)
    expect(state.review).toEqual({
      matchedLayer: "fifo_inventory",
      needsReview: true,
    })
  })

  it("does not recover downstream internal-transfer disposals without moving their lots", async () => {
    const walletAddress = "bc1qownedwalletdownstreamtransfer000000000000000"
    const downstreamAddressId = "00000000-0000-0000-0000-000000000703"
    const downstreamSourceId = "00000000-0000-0000-0000-000000000704"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-downstream-transfer",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-downstream-transfer",
        timestamp: new Date("2025-04-14T10:00:00.000Z"),
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-downstream-transfer-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-downstream-transfer",
        txHash: "btc-downstream-transfer-hash",
        timestamp: new Date("2025-04-14T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const downstreamFixture = await runPg(
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
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })
        const [originAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "downstream-transfer-origin-acquisition",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "5000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (
          providerTransfer === undefined ||
          reconciliation === undefined ||
          originAcquisitionLeg === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create downstream transfer fixture")
        }

        const [originLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "0.10000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: originAcquisitionLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [originMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransfer.transactionId,
            providerTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-14T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.10000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (originLot === undefined || originMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create downstream custody fixture")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: originMovement.id,
          fifoLotId: originLot.id,
          matchedAmount: "0.10000000",
        })
        yield* db.insert(schema.addresses).values({
          id: downstreamAddressId,
          address: "bc1qdownstreamdestination0000000000000000000000",
          type: "bitcoin",
          name: "Downstream destination",
          principalId: TEST_PRINCIPAL_ID,
        })
        yield* db.insert(schema.sources).values({
          id: downstreamSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Downstream source",
          providerKey: "bitcoin",
          sourceableType: "onchain",
          addressId: downstreamAddressId,
          cexAccountId: null,
        })

        const [downstreamOriginTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "downstream-internal-transfer-origin",
            timestamp: new Date("2025-04-15T10:00:00.000Z"),
            transactionType: "internal_transfer",
            providerTransactionType: "send",
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        const [downstreamDestinationTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: downstreamSourceId,
            externalId: "downstream-internal-transfer-destination",
            timestamp: new Date("2025-04-15T10:05:00.000Z"),
            transactionType: "internal_transfer",
            providerTransactionType: null,
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (
          downstreamOriginTransaction === undefined ||
          downstreamDestinationTransaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create downstream transactions")
        }

        const [downstreamOriginLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "downstream-internal-transfer-origin:leg",
            timestamp: new Date("2025-04-15T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            transactionId: downstreamOriginTransaction.id,
            fiatAmount: null,
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })
        const [downstreamDestinationLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: downstreamSourceId,
            externalId: "downstream-internal-transfer-destination:leg",
            timestamp: new Date("2025-04-15T10:05:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: downstreamAddressId,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            transactionId: downstreamDestinationTransaction.id,
            fiatAmount: null,
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (downstreamOriginLeg === undefined || downstreamDestinationLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create downstream transfer legs")
        }

        yield* db.insert(schema.transactionReviews).values({
          transactionId: downstreamOriginTransaction.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          originalTypeKey: "internal_transfer",
          currentTypeKey: "internal_transfer",
          categorizationReason:
            "fifo_inventory: Review required because downstream inventory is incomplete.",
          matchedLayer: "fifo_inventory",
          needsReview: true,
        })

        return {
          downstreamDestinationLegId: downstreamDestinationLeg.id,
          downstreamOriginLegId: downstreamOriginLeg.id,
          downstreamOriginTransactionId: downstreamOriginTransaction.id,
          reconciliationId: reconciliation.id,
        }
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: downstreamFixture.reconciliationId,
        })
      )
    )

    expect(summary).toEqual({ canonicalizedPairs: 1 })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const downstreamMatches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, downstreamFixture.downstreamOriginLegId))
        const downstreamLots = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceLegId, downstreamFixture.downstreamDestinationLegId))
        const [downstreamReview] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(
            eq(
              schema.transactionReviews.transactionId,
              downstreamFixture.downstreamOriginTransactionId
            )
          )

        return { downstreamLots, downstreamMatches, downstreamReview }
      })
    )

    expect(state.downstreamMatches).toHaveLength(0)
    expect(state.downstreamLots).toHaveLength(0)
    expect(state.downstreamReview).toEqual({
      matchedLayer: "fifo_inventory",
      needsReview: true,
    })
  })

  it("replays later canonical transfers after recovering earlier FIFO effects", async () => {
    const walletAddress = "bc1qownedwallettransferreplay00000000000000000"
    const downstreamAddressId = "00000000-0000-0000-0000-000000000705"
    const downstreamSourceId = "00000000-0000-0000-0000-000000000706"
    const downstreamWalletAddress = "bc1qdownstreamtransferreplay000000000000000000"
    const finalAddressId = "00000000-0000-0000-0000-000000000707"
    const finalSourceId = "00000000-0000-0000-0000-000000000708"
    const finalWalletAddress = "bc1qfinaltransferreplay0000000000000000000000"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-transfer-replay",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const upstreamProviderTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-upstream-replay",
        timestamp: new Date("2025-04-14T10:00:00.000Z"),
        amount: "0.05000000",
        toAddress: walletAddress,
        networkHash: "btc-upstream-replay-hash",
      })
    )
    const upstreamReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-upstream-replay",
        txHash: "btc-upstream-replay-hash",
        timestamp: new Date("2025-04-14T10:05:00.000Z"),
        amount: "0.05000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const replayFixture = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.addresses).values({
          id: downstreamAddressId,
          address: downstreamWalletAddress,
          type: "bitcoin",
          name: "Downstream replay destination",
          principalId: TEST_PRINCIPAL_ID,
        })
        yield* db.insert(schema.sources).values({
          id: downstreamSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Downstream replay source",
          providerKey: "bitcoin",
          sourceableType: "onchain",
          addressId: downstreamAddressId,
          cexAccountId: null,
        })
        yield* db.insert(schema.addresses).values({
          id: finalAddressId,
          address: finalWalletAddress,
          type: "bitcoin",
          name: "Final replay destination",
          principalId: TEST_PRINCIPAL_ID,
        })
        yield* db.insert(schema.sources).values({
          id: finalSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Final replay source",
          providerKey: "bitcoin",
          sourceableType: "onchain",
          addressId: finalAddressId,
          cexAccountId: null,
        })

        const [upstreamProviderTransfer] = yield* db
          .select({ transactionId: schema.providerTransfers.transactionId })
          .from(schema.providerTransfers)
          .where(eq(schema.providerTransfers.id, upstreamProviderTransferId))
        const [upstreamReconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: upstreamProviderTransferId,
            canonicalTransferId: upstreamReceipt.transferId,
            canonicalTransactionId: upstreamReceipt.transactionId,
            status: "approved",
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })
        const [upstreamAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "upstream-replay-acquisition",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "2500.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (
          upstreamProviderTransfer === undefined ||
          upstreamReconciliation === undefined ||
          upstreamAcquisitionLeg === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create upstream replay fixtures")
        }

        const [upstreamLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "0.05000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: upstreamAcquisitionLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [upstreamMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: upstreamProviderTransfer.transactionId,
            providerTransferId: upstreamProviderTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-14T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.05000000",
          })
          .returning({ id: schema.inventoryMovements.id })

        if (upstreamLot === undefined || upstreamMovement === undefined) {
          return yield* Effect.dieMessage("Failed to create upstream replay inventory")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: upstreamMovement.id,
          fifoLotId: upstreamLot.id,
          matchedAmount: "0.05000000",
        })

        const [localAcquisitionLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "transfer-replay-local-acquisition",
            timestamp: new Date("2025-04-02T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "2600.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })
        const [reviewedTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "transfer-replay-earlier-disposal",
            timestamp: new Date("2025-04-15T10:00:00.000Z"),
            transactionType: "sell_fiat",
            providerTransactionType: "sell",
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (localAcquisitionLeg === undefined || reviewedTransaction === undefined) {
          return yield* Effect.dieMessage("Failed to create reviewed replay fixtures")
        }

        const [localLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-02T10:00:00.000Z"),
            originalAmount: "0.05000000",
            remainingAmount: "0.00000000",
            costBasisPerToken: "52000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: localAcquisitionLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })
        const [reviewedDisposalLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "transfer-replay-earlier-disposal:leg",
            timestamp: new Date("2025-04-15T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            addressId: ONCHAIN_ADDRESS_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.10000000",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "fixture_disposal",
            transactionId: reviewedTransaction.id,
            fiatAmount: "6000.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (localLot === undefined || reviewedDisposalLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create reviewed replay FIFO effects")
        }

        yield* db.insert(schema.transactionReviews).values({
          transactionId: reviewedTransaction.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          originalTypeKey: "sell_fiat",
          currentTypeKey: "sell_fiat",
          categorizationReason:
            "fifo_inventory: Review required because destination inventory is incomplete.",
          matchedLayer: "fifo_inventory",
          needsReview: true,
        })

        const [downstreamProviderTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            externalId: "provider-transfer-downstream-replay:tx",
            timestamp: new Date("2025-04-16T10:00:00.000Z"),
            transactionType: null,
            providerTransactionType: "send",
            providerStatus: "completed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        const [downstreamCanonicalTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: downstreamSourceId,
            externalId: "onchain-receipt-downstream-replay:tx",
            timestamp: new Date("2025-04-16T10:05:00.000Z"),
            transactionType: null,
            providerTransactionType: null,
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (
          downstreamProviderTransaction === undefined ||
          downstreamCanonicalTransaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create downstream replay transactions")
        }

        const [downstreamProviderTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: downstreamProviderTransaction.id,
            externalId: "provider-transfer-downstream-replay",
            externalGroupId: "provider-transfer-downstream-replay:group",
            providerAssetId: providerAssetRowId,
            timestamp: new Date("2025-04-16T10:00:00.000Z"),
            direction: "outbound",
            fromAccountRef: "owned-wallet",
            toAccountRef: null,
            fromAddress: walletAddress,
            toAddress: downstreamWalletAddress,
            networkName: "bitcoin",
            networkHash: "btc-downstream-replay-hash",
            amount: "0.05000000",
            metadata: { provider: "bitcoin" },
          })
          .returning({ id: schema.providerTransfers.id })
        const [downstreamCanonicalTransfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: downstreamSourceId,
            externalId: "onchain-receipt-downstream-replay",
            externalGroupId: "onchain-receipt-downstream-replay",
            addressId: downstreamAddressId,
            blockchainId: fixture.bitcoinBlockchainId,
            txHash: "btc-downstream-replay-hash",
            timestamp: new Date("2025-04-16T10:05:00.000Z"),
            type: "utxo",
            fromAddress: walletAddress,
            toAddress: downstreamWalletAddress,
            fromPartyType: "address",
            toPartyType: "address",
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            metadata: { provider: "bitcoin" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transfers.id })

        if (downstreamProviderTransfer === undefined || downstreamCanonicalTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create downstream replay transfers")
        }

        const [downstreamMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: ONCHAIN_SOURCE_ID,
            transactionId: downstreamProviderTransaction.id,
            providerTransferId: downstreamProviderTransfer.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-16T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.05000000",
          })
          .returning({ id: schema.inventoryMovements.id })
        const [downstreamReconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: downstreamProviderTransfer.id,
            canonicalTransferId: downstreamCanonicalTransfer.id,
            canonicalTransactionId: downstreamCanonicalTransaction.id,
            status: "approved",
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })

        if (downstreamMovement === undefined || downstreamReconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create downstream replay reconciliation")
        }

        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: downstreamMovement.id,
          fifoLotId: localLot.id,
          matchedAmount: "0.05000000",
        })

        return {
          downstreamMovementId: downstreamMovement.id,
          downstreamProviderTransactionId: downstreamProviderTransaction.id,
          downstreamReconciliationId: downstreamReconciliation.id,
          reviewedDisposalLegId: reviewedDisposalLeg.id,
          reviewedTransactionId: reviewedTransaction.id,
          upstreamReconciliationId: upstreamReconciliation.id,
        }
      })
    )

    const downstreamSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: ONCHAIN_SOURCE_ID,
          reconciliationId: replayFixture.downstreamReconciliationId,
        })
      )
    )
    expect(downstreamSummary).toEqual({ canonicalizedPairs: 1 })

    const finalFixture = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [downstreamLot] = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceId, downstreamSourceId))
        const [finalProviderTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: downstreamSourceId,
            externalId: "provider-transfer-final-replay:tx",
            timestamp: new Date("2025-04-17T10:00:00.000Z"),
            transactionType: null,
            providerTransactionType: "send",
            providerStatus: "completed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        const [finalCanonicalTransaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: finalSourceId,
            externalId: "onchain-receipt-final-replay:tx",
            timestamp: new Date("2025-04-17T10:05:00.000Z"),
            transactionType: null,
            providerTransactionType: null,
            providerStatus: "confirmed",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })

        if (
          downstreamLot === undefined ||
          finalProviderTransaction === undefined ||
          finalCanonicalTransaction === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create final replay transactions")
        }

        const [finalProviderTransfer] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: downstreamSourceId,
            transactionId: finalProviderTransaction.id,
            externalId: "provider-transfer-final-replay",
            externalGroupId: "provider-transfer-final-replay:group",
            providerAssetId: providerAssetRowId,
            timestamp: new Date("2025-04-17T10:00:00.000Z"),
            direction: "outbound",
            fromAccountRef: "downstream-wallet",
            toAccountRef: null,
            fromAddress: downstreamWalletAddress,
            toAddress: finalWalletAddress,
            networkName: "bitcoin",
            networkHash: "btc-final-replay-hash",
            amount: "0.05000000",
            metadata: { provider: "bitcoin" },
          })
          .returning({ id: schema.providerTransfers.id })
        const [finalCanonicalTransfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: finalSourceId,
            externalId: "onchain-receipt-final-replay",
            externalGroupId: "onchain-receipt-final-replay",
            addressId: finalAddressId,
            blockchainId: fixture.bitcoinBlockchainId,
            txHash: "btc-final-replay-hash",
            timestamp: new Date("2025-04-17T10:05:00.000Z"),
            type: "utxo",
            fromAddress: downstreamWalletAddress,
            toAddress: finalWalletAddress,
            fromPartyType: "address",
            toPartyType: "address",
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            metadata: { provider: "bitcoin" },
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transfers.id })

        if (finalProviderTransfer === undefined || finalCanonicalTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to create final replay transfers")
        }

        const [finalMovement] = yield* db
          .insert(schema.inventoryMovements)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: downstreamSourceId,
            transactionId: finalProviderTransaction.id,
            providerTransferId: finalProviderTransfer.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-04-17T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: "0.05000000",
          })
          .returning({ id: schema.inventoryMovements.id })
        const [finalReconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: finalProviderTransfer.id,
            canonicalTransferId: finalCanonicalTransfer.id,
            canonicalTransactionId: finalCanonicalTransaction.id,
            status: "approved",
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })

        if (finalMovement === undefined || finalReconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create final replay reconciliation")
        }

        yield* db
          .update(schema.fifoLots)
          .set({ remainingAmount: "0.00000000" })
          .where(eq(schema.fifoLots.id, downstreamLot.id))
        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: finalMovement.id,
          fifoLotId: downstreamLot.id,
          matchedAmount: "0.05000000",
        })

        return {
          movementId: finalMovement.id,
          providerTransactionId: finalProviderTransaction.id,
          reconciliationId: finalReconciliation.id,
        }
      })
    )

    const finalSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: downstreamSourceId,
          reconciliationId: finalFixture.reconciliationId,
        })
      )
    )
    expect(finalSummary).toEqual({ canonicalizedPairs: 1 })

    const upstreamSummary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: replayFixture.upstreamReconciliationId,
        })
      )
    )
    expect(upstreamSummary).toEqual({ canonicalizedPairs: 1 })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const reviewedMatches = yield* db
          .select({ matchedAmount: schema.disposalMatches.matchedAmount })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, replayFixture.reviewedDisposalLegId))
        const [downstreamOriginLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(
            and(
              eq(
                schema.transactionLegs.transactionId,
                replayFixture.downstreamProviderTransactionId
              ),
              eq(schema.transactionLegs.derivationRule, "internal_transfer_out")
            )
          )
        const [reviewedReview] = yield* db
          .select({ id: schema.transactionReviews.id })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, replayFixture.reviewedTransactionId))
        const [downstreamReview] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(
            eq(
              schema.transactionReviews.transactionId,
              replayFixture.downstreamProviderTransactionId
            )
          )
        const [downstreamMovement] = yield* db
          .select({
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
            taxTreatment: schema.inventoryMovements.taxTreatment,
          })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.id, replayFixture.downstreamMovementId))
        const [finalOriginLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(
            and(
              eq(schema.transactionLegs.transactionId, finalFixture.providerTransactionId),
              eq(schema.transactionLegs.derivationRule, "internal_transfer_out")
            )
          )
        const [finalReview] = yield* db
          .select({
            matchedLayer: schema.transactionReviews.matchedLayer,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, finalFixture.providerTransactionId))
        const [finalMovement] = yield* db
          .select({
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
            taxTreatment: schema.inventoryMovements.taxTreatment,
          })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.id, finalFixture.movementId))
        const downstreamLots = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceId, downstreamSourceId))
        const finalLots = yield* db
          .select({ id: schema.fifoLots.id })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceId, finalSourceId))
        const downstreamMatches =
          downstreamOriginLeg === undefined
            ? []
            : yield* db
                .select({ id: schema.disposalMatches.id })
                .from(schema.disposalMatches)
                .where(eq(schema.disposalMatches.disposalLegId, downstreamOriginLeg.id))
        const finalMatches =
          finalOriginLeg === undefined
            ? []
            : yield* db
                .select({ id: schema.disposalMatches.id })
                .from(schema.disposalMatches)
                .where(eq(schema.disposalMatches.disposalLegId, finalOriginLeg.id))

        return {
          downstreamLots,
          downstreamMatches,
          downstreamMovement,
          downstreamOriginLeg,
          downstreamReview,
          finalLots,
          finalMatches,
          finalMovement,
          finalOriginLeg,
          finalReview,
          reviewedMatches,
          reviewedReview,
        }
      })
    )

    expect(state.reviewedMatches).toHaveLength(2)
    expect(state.reviewedMatches).toEqual(
      expect.arrayContaining([
        { matchedAmount: expect.stringContaining("0.05000000") },
        { matchedAmount: expect.stringContaining("0.05000000") },
      ])
    )
    expect(state.reviewedReview).toBeUndefined()
    expect(state.downstreamOriginLeg).toBeDefined()
    expect(state.downstreamMatches).toHaveLength(0)
    expect(state.downstreamLots).toHaveLength(0)
    expect(state.downstreamMovement).toEqual({
      reconciliationStatus: "unmatched",
      taxTreatment: "pending_review",
    })
    expect(state.downstreamReview).toEqual({
      matchedLayer: "transfer_reconciliation,fifo_inventory",
      needsReview: true,
    })
    expect(state.finalOriginLeg).toBeDefined()
    expect(state.finalMatches).toHaveLength(0)
    expect(state.finalLots).toHaveLength(0)
    expect(state.finalMovement).toEqual({
      reconciliationStatus: "unmatched",
      taxTreatment: "pending_review",
    })
    expect(state.finalReview).toEqual({
      matchedLayer: "transfer_reconciliation,fifo_inventory",
      needsReview: true,
    })
  })

  it("does not mutate same-source lots when transfer inventory is insufficient", async () => {
    const walletAddress = "bc1qownedwalletpartialinventory0000000000000000"
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-asset-partial-inventory",
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))

    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-partial-inventory",
        timestamp: new Date("2025-04-14T10:00:00.000Z"),
        amount: "0.10000000",
        toAddress: walletAddress,
        networkHash: "btc-partial-inventory-hash",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-partial-inventory",
        txHash: "btc-partial-inventory-hash",
        timestamp: new Date("2025-04-14T10:05:00.000Z"),
        amount: "0.10000000",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const partialInventoryFixture = await runPg(
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
            matchReason: "admin_approved_fixture",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
          })
          .returning({ id: schema.transferReconciliations.id })
        const [sourceLeg] = yield* db
          .insert(schema.transactionLegs)
          .values({
            sourceId: TEST_SOURCE_ID,
            externalId: "partial-inventory-acquisition",
            timestamp: new Date("2025-04-01T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.05000000",
            kind: "acquisition",
            provenance: "deterministic",
            fiatAmount: "2500.00",
            fiatCurrency: "EUR",
          })
          .returning({ id: schema.transactionLegs.id })

        if (
          providerTransfer === undefined ||
          reconciliation === undefined ||
          sourceLeg === undefined
        ) {
          return yield* Effect.dieMessage("Failed to create partial inventory fixture")
        }

        const [sourceLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
            originalAmount: "0.05000000",
            remainingAmount: "0.05000000",
            costBasisPerToken: "50000.000000000000000000",
            costBasisCurrency: "EUR",
            sourceLegId: sourceLeg.id,
            sourceLegSequence: 0,
          })
          .returning({ id: schema.fifoLots.id })

        if (sourceLot === undefined) {
          return yield* Effect.dieMessage("Failed to create partial source lot")
        }

        return {
          originTransactionId: providerTransfer.transactionId,
          reconciliationId: reconciliation.id,
          sourceLotId: sourceLot.id,
        }
      })
    )

    const summary = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId: partialInventoryFixture.reconciliationId,
        })
      )
    )

    expect(summary).toEqual({ canonicalizedPairs: 0 })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [sourceLot] = yield* db
          .select({ remainingAmount: schema.fifoLots.remainingAmount })
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.id, partialInventoryFixture.sourceLotId))
        const [originLeg] = yield* db
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(
            and(
              eq(schema.transactionLegs.transactionId, partialInventoryFixture.originTransactionId),
              eq(schema.transactionLegs.derivationRule, "internal_transfer_out")
            )
          )

        if (originLeg === undefined) {
          return yield* Effect.dieMessage("Failed to load partial inventory origin leg")
        }

        const matches = yield* db
          .select({ id: schema.disposalMatches.id })
          .from(schema.disposalMatches)
          .where(eq(schema.disposalMatches.disposalLegId, originLeg.id))

        return { matches, sourceLot }
      })
    )

    expect(state.sourceLot?.remainingAmount).toContain("0.05000000")
    expect(state.matches).toHaveLength(0)
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
