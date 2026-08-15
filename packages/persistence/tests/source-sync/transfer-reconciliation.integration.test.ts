import { and, asc, eq, inArray, ne } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
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
  TEST_EUR_ASSET_ID,
  TEST_EUR_REPRESENTATION_ID,
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
  canonicalAssetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  currencyCode = "BTC",
}: {
  readonly providerAssetId?: string
  readonly canonicalAssetId?: string
  readonly assetRepresentationId?: string | null
  readonly currencyCode?: string
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
        currencyCode,
        name: currencyCode,
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
      canonicalAssetId,
      assetRepresentationId,
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
      name: "Owned bitcoin wallet",
      principalId: TEST_PRINCIPAL_ID,
      createdAt: now,
      updatedAt: now,
    })

    yield* db.insert(schema.sources).values({
      id: ONCHAIN_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      name: "Owned bitcoin source",
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
  networkHash,
  networkName = "bitcoin",
}: {
  readonly providerAssetRowId: string
  readonly externalId: string
  readonly timestamp: Date
  readonly amount: string
  readonly toAddress: string
  readonly networkHash: string | null
  readonly networkName?: string
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
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAccountRef: null,
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
}: {
  readonly externalId: string
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly assetId?: string
  readonly assetRepresentationId?: string | null
  readonly transferType?: "utxo" | "erc20"
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

const seedObservedOnchainReceipt = ({
  externalId,
  transactionExternalId = `${externalId}:transaction`,
  canonicalTransferExternalId = null,
  txHash,
  timestamp,
  amount,
  walletAddress,
  blockchainId,
  role = "principal",
  observedAsset = {
    provider: "bitcoin",
    providerAssetId: "bitcoin:native",
    naturalKey: "bitcoin:native",
    currencyCode: "BTC",
    name: "Bitcoin",
    exponent: 8,
    providerType: "native",
    networkName: "bitcoin",
    fromAddress: "bc1qexternalorigin0000000000000000000000000",
    representationType: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 8,
  },
}: {
  readonly externalId: string
  readonly transactionExternalId?: string
  readonly canonicalTransferExternalId?: string | null
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly role?: "principal" | "fee" | "rent"
  readonly observedAsset?: {
    readonly provider: string
    readonly providerAssetId: string
    readonly naturalKey: string
    readonly currencyCode: string
    readonly name: string
    readonly exponent: number
    readonly providerType: string
    readonly networkName: string
    readonly fromAddress: string
    readonly representationType: "native" | "token" | "nft"
    readonly contractAddress: string | null
    readonly mintAddress: string | null
    readonly decimals: number
  }
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: observedAsset.provider,
        providerAssetId: observedAsset.providerAssetId,
        naturalKey: observedAsset.naturalKey,
        currencyCode: observedAsset.currencyCode,
        name: observedAsset.name,
        exponent: observedAsset.exponent,
        providerType: observedAsset.providerType,
        rawProviderPayload: { source: "test" },
        retrievedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.dieMessage("Failed to create observed provider asset fixture")
    }

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: transactionExternalId,
        externalGroupId: externalId,
        timestamp,
        transactionType: null,
        providerTransactionType: "transfer",
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Observed onchain receipt fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: observedAsset.provider },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.dieMessage("Failed to create observed transaction fixture")
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
        processingMode: "evidence_only",
        fromAccountRef: null,
        toAccountRef: null,
        fromAddress: observedAsset.fromAddress,
        toAddress: walletAddress,
        networkName: observedAsset.networkName,
        networkHash: txHash,
        observedBlockchainId: blockchainId,
        observedRepresentationType: observedAsset.representationType,
        observedContractAddress: observedAsset.contractAddress,
        observedMintAddress: observedAsset.mintAddress,
        observedDecimals: observedAsset.decimals,
        amount,
        metadata: { provider: observedAsset.provider, role, canonicalTransferExternalId },
      })
      .returning({ id: schema.providerTransfers.id })

    if (providerTransfer === undefined) {
      return yield* Effect.dieMessage("Failed to create observed provider transfer fixture")
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

  it("keeps split evidence-only transfers out of inventory and reconciliation", async () => {
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(seedApprovedProviderAsset({}))

    const persisted = await runSourceNormalization(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: null,
            externalId: "split-native-evidence",
            externalGroupId: "split-native-evidence",
            timestamp,
            transactionType: "internal_transfer",
            providerTransactionType: "transfer",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: "Split native transfer evidence",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "helius-solana" },
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
            metadata: { provider: "helius-solana" },
          },
          providerTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: null,
              externalId: "split-native-evidence:accounting",
              externalGroupId: "split-native-evidence",
              providerAssetId: providerAssetRowId,
              timestamp,
              direction: "outbound",
              processingMode: "accounting_only",
              fromAccountRef: null,
              toAccountRef: null,
              fromAddress: "owned-address",
              toAddress: "counterparty",
              networkName: "bitcoin",
              networkHash: "split-native-evidence-hash",
              observedBlockchainId: null,
              observedRepresentationType: null,
              observedContractAddress: null,
              observedMintAddress: null,
              observedDecimals: null,
              amount: "0.75",
              metadata: {},
            },
            ...[
              { suffix: "a", amount: "0.5" },
              { suffix: "b", amount: "0.25" },
            ].map(({ suffix, amount }) => ({
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: null,
              externalId: `split-native-evidence:${suffix}`,
              externalGroupId: "split-native-evidence",
              providerAssetId: providerAssetRowId,
              timestamp,
              direction: "outbound" as const,
              processingMode: "evidence_only" as const,
              fromAccountRef: null,
              toAccountRef: null,
              fromAddress: "owned-address",
              toAddress: `counterparty-${suffix}`,
              networkName: "bitcoin",
              networkHash: "split-native-evidence-hash",
              observedBlockchainId: fixture.bitcoinBlockchainId,
              observedRepresentationType: "native" as const,
              observedContractAddress: null,
              observedMintAddress: null,
              observedDecimals: 8,
              amount,
              metadata: {},
            })),
          ],
          feeTransfers: [],
          legs: [],
          transactionReview: null,
          resolvedTransactionType: {
            providerTransactionType: "transfer",
            transactionType: "internal_transfer",
            inventoryEffect: "internal_transfer",
            taxTreatment: "non_taxable_by_default",
            resolutionStrategy: "amount_sign",
            pairedRecordRequired: true,
            mappingStatus: "approved",
          },
        })
      )
    )

    const reconciliationCandidates = await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.listProviderTransfersForReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    const inventoryMovements = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            providerTransferId: schema.inventoryMovements.providerTransferId,
            amount: schema.inventoryMovements.amount,
          })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.transactionId, persisted.transaction.id))
      })
    )
    const accountingTransfer = persisted.providerTransfers.find(
      (transfer) => transfer.externalId === "split-native-evidence:accounting"
    )

    expect(persisted.providerTransfers).toHaveLength(3)
    expect(accountingTransfer).toBeDefined()
    expect(inventoryMovements).toEqual([
      {
        providerTransferId: accountingTransfer?.id,
        amount: expect.stringMatching(/^0\.75(?:0+)?$/),
      },
    ])
    expect(reconciliationCandidates.map((candidate) => candidate.providerTransferId)).toEqual([
      accountingTransfer?.id,
    ])

    const evidenceTransfer = persisted.providerTransfers.find(
      (transfer) => transfer.externalId === "split-native-evidence:a"
    )
    expect(evidenceTransfer).toBeDefined()
    if (evidenceTransfer === undefined) {
      return
    }

    const walletAddress = "bc1qownedevidenceonly0000000000000000000000"
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "evidence-only-receipt",
        txHash: "split-native-evidence-hash",
        timestamp,
        amount: "0.5",
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
            providerTransferId: evidenceTransfer.id,
            canonicalTransferId: receipt.transferId,
            canonicalTransactionId: receipt.transactionId,
            status: "auto_applied",
            matchReason: "test_evidence_only_filter",
            confidence: "1",
            deterministic: true,
            reviewMetadata: null,
          })
          .returning({ id: schema.transferReconciliations.id })

        if (reconciliation === undefined) {
          return yield* Effect.dieMessage("Failed to create evidence-only reconciliation")
        }

        return reconciliation.id
      })
    )

    const canonicalization = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          reconciliationId,
        })
      )
    )

    expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
  })

  it("defers FIFO application for a deterministic owned onchain receipt", async () => {
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
          .select({
            providerTransferId: schema.transferReconciliations.providerTransferId,
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(summary).toEqual(
      expect.objectContaining({
        evaluatedProviderTransfers: 1,
        pending: 1,
      })
    )
    expect(reconciliation).toEqual(
      expect.objectContaining({
        providerTransferId,
        canonicalTransferId: receipt.transferId,
        canonicalTransactionId: receipt.transactionId,
        status: "pending",
        matchReason: "fifo_application_deferred",
        deterministic: true,
      })
    )
  })

  it("uses an exact hash despite provider address and timestamp drift", async () => {
    const walletAddress = "bc1qownedwalletbyhash00000000000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-hash-drift",
        assetRepresentationId: null,
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-hash-drift",
        timestamp,
        amount: "0.125",
        toAddress: "provider-reported-address",
        networkHash: "btc-hash-drift",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-hash-drift",
        txHash: "btc-hash-drift",
        timestamp: new Date("2025-04-12T10:00:00.000Z"),
        amount: "0.125",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const [originCandidate] = await runTransferReconciliationRepository(
      Effect.flatMap(TransferReconciliationRepository, (repository) =>
        repository.listProviderTransfersForReconciliation({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    expect(originCandidate?.assetRepresentationId).toBeNull()

    await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.reconcileTransferCandidates({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const canonicalization = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const [reconciliation] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: receipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
      deterministic: true,
    })
    expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
  })

  it("compares EVM transaction hashes without case sensitivity", async () => {
    const walletAddress = "0xAbCd00000000000000000000000000000000Ef01"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "eur-provider-evm-hash",
        canonicalAssetId: TEST_EUR_ASSET_ID,
        assetRepresentationId: null,
        currencyCode: "EUR",
      })
    )
    await runPg(
      seedOwnedOnchainSource({
        walletAddress,
        addressType: "evm",
        providerKey: "base",
      })
    )
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-evm-hash",
        timestamp,
        amount: "12.5",
        toAddress: walletAddress.toLowerCase(),
        networkHash: "0xABCDEF1234",
        networkName: "base",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-evm-hash",
        txHash: "0xabcdef1234",
        timestamp: new Date("2025-04-12T10:00:00.000Z"),
        amount: "12.5",
        walletAddress,
        blockchainId: fixture.baseBlockchainId,
        assetId: TEST_EUR_ASSET_ID,
        assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
        transferType: "erc20",
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: receipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
    })
  })

  it("compares Bitcoin transaction ids without case sensitivity without applying FIFO", async () => {
    const walletAddress = "bc1qownedwalletbtchash000000000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-hash-case" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-btc-hash-case",
        timestamp,
        amount: "0.125",
        toAddress: walletAddress,
        networkHash: "ABCDEF1234567890",
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-btc-hash-case",
        txHash: "abcdef1234567890",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.125",
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: receipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
      deterministic: true,
    })
  })

  it("keeps Solana signatures case-sensitive", async () => {
    const walletAddress = "SoOwnedWalletSignature111111111111111111111111"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const solanaBlockchainId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "solana"))
          .limit(1)

        if (blockchain === undefined) {
          return yield* Effect.dieMessage("Missing seeded Solana blockchain")
        }

        return blockchain.id
      })
    )
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "sol-provider-signature-case" })
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
        externalId: "provider-transfer-sol-signature-case",
        timestamp,
        amount: "1.25",
        toAddress: walletAddress,
        networkHash: "SolanaSignatureABC",
        networkName: "solana",
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-sol-signature-case",
        txHash: "solanasignatureabc",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "1.25",
        walletAddress,
        blockchainId: solanaBlockchainId,
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: null,
      status: "pending",
      matchReason: "no_candidate_onchain_receipt",
    })
  })

  it("filters known incompatible assets before deciding candidate ambiguity", async () => {
    const walletAddress = "bc1qownedwalletknownasset000000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-known-asset" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-known-asset",
        timestamp,
        amount: "0.5",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const matchingReceipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-known-asset",
        txHash: "btc-known-asset",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.5",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-other-asset",
        txHash: "btc-other-asset",
        timestamp: new Date("2025-04-10T10:06:00.000Z"),
        amount: "0.5",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        assetId: TEST_EUR_ASSET_ID,
        assetRepresentationId: null,
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: matchingReceipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
    })
  })

  it("keeps a sole known-asset conflict unresolved without moving inventory", async () => {
    const walletAddress = "bc1qownedwalletassetconflict00000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-asset-conflict" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-asset-conflict",
        timestamp,
        amount: "0.5",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-asset-conflict",
        txHash: "btc-asset-conflict",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.5",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        assetId: TEST_EUR_ASSET_ID,
        assetRepresentationId: null,
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
        const [reconciliation] = yield* db
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const inventoryMovements = yield* db
          .select({ id: schema.inventoryMovements.id })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

        return { reconciliation, inventoryMovements }
      })
    )

    expect(state.reconciliation).toMatchObject({
      canonicalTransferId: null,
      status: "needs_review",
      matchReason: "known_asset_candidate_conflict",
      deterministic: false,
    })
    expect(state.inventoryMovements).toEqual([])
  })

  it("prefers a canonical transfer over its observed evidence row", async () => {
    const walletAddress = "bc1qownedwalletdedup0000000000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-dedup",
        assetRepresentationId: null,
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-dedup",
        timestamp,
        amount: "0.75",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-shared-dedup",
        txHash: "btc-shared-dedup",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.75",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        assetRepresentationId: null,
      })
    )
    await runPg(
      seedObservedOnchainReceipt({
        externalId: "onchain-shared-dedup:provider:principal:0",
        transactionExternalId: "onchain-shared-dedup:observed-transaction",
        canonicalTransferExternalId: "onchain-shared-dedup",
        txHash: "btc-shared-dedup",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.75",
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: receipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
    })
  })

  it("compares uniformly cased Bitcoin Bech32 addresses without case sensitivity", async () => {
    const walletAddress = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-bech32-case" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-bech32-case",
        timestamp,
        amount: "0.25",
        toAddress: walletAddress.toUpperCase(),
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-bech32-case",
        txHash: "btc-bech32-case",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.25",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transfers)
          .set({ toAddress: walletAddress.toUpperCase() })
          .where(eq(schema.transfers.id, receipt.transferId))
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: receipt.transferId,
      status: "pending",
      matchReason: "fifo_application_deferred",
    })
  })

  it("keeps Bitcoin Base58 address comparisons case-sensitive", async () => {
    const walletAddress = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-base58-case" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-base58-case",
        timestamp,
        amount: "0.25",
        toAddress: walletAddress,
        networkHash: null,
      })
    )
    const receipt = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-base58-case",
        txHash: "btc-base58-case",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.25",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transfers)
          .set({ toAddress: walletAddress.toLowerCase() })
          .where(eq(schema.transfers.id, receipt.transferId))
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: null,
      status: "pending",
      matchReason: "no_candidate_onchain_receipt",
    })
  })

  it("keeps mixed-case Bitcoin Bech32 addresses case-sensitive", async () => {
    const walletAddress = "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-bech32-mixed-case" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-bech32-mixed-case",
        timestamp,
        amount: "0.25",
        toAddress: walletAddress.toLowerCase(),
        networkHash: null,
      })
    )
    await runPg(
      seedOnchainReceipt({
        externalId: "onchain-receipt-bech32-mixed-case",
        txHash: "btc-bech32-mixed-case",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.25",
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: null,
      status: "pending",
      matchReason: "no_candidate_onchain_receipt",
    })
  })

  it("excludes canonical and observed fee movements from exact-hash candidates", async () => {
    const walletAddress = "bc1qownedwalletfee0000000000000000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-fee" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-fee",
        timestamp,
        amount: "0.0001",
        toAddress: walletAddress,
        networkHash: "btc-fee-hash",
      })
    )
    const fee = await runPg(
      seedOnchainReceipt({
        externalId: "onchain-fee",
        txHash: "btc-fee-hash",
        timestamp,
        amount: "0.0001",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transfers)
          .set({ type: "fee", metadata: { provider: "bitcoin", role: "fee" } })
          .where(eq(schema.transfers.id, fee.transferId))
      })
    )
    await runPg(
      seedObservedOnchainReceipt({
        externalId: "observed-onchain-fee",
        txHash: "btc-fee-hash",
        timestamp,
        amount: "0.0001",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
        role: "fee",
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
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
      })
    )

    expect(reconciliation).toMatchObject({
      canonicalTransferId: null,
      status: "pending",
      matchReason: "no_candidate_onchain_receipt",
    })
  })

  it("defers an approved observed representation until its canonical transfer exists", async () => {
    const walletAddress = "bc1qownedwalletapprovedobservation000000000000"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({ providerAssetId: "btc-provider-approved-observation" })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-approved-observation",
        timestamp,
        amount: "0.25",
        toAddress: walletAddress,
        networkHash: "btc-approved-observation-hash",
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        externalId: "observed-approved-representation",
        txHash: "btc-approved-observation-hash",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.25",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: observed.providerAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes: null,
          createdAt: timestamp,
          updatedAt: timestamp,
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
    const canonicalization = await runTransferReconciliation(
      Effect.flatMap(TransferReconciliationService, (service) =>
        service.applyDeterministicInternalTransferCanonicalization({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [reconciliation] = yield* db
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const inventoryMovements = yield* db
          .select({ id: schema.inventoryMovements.id })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

        return { reconciliation, inventoryMovements }
      })
    )

    expect(summary).toEqual(
      expect.objectContaining({
        evaluatedProviderTransfers: 1,
        pending: 1,
      })
    )
    expect(state.reconciliation).toMatchObject({
      canonicalTransferId: null,
      canonicalTransactionId: observed.transactionId,
      status: "pending",
      matchReason: "destination_source_replay_pending",
      deterministic: false,
    })
    expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
    expect(state.inventoryMovements).toEqual([])
  })

  it("records first-seen representation evidence without moving inventory", async () => {
    const walletAddress = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-pending-representation",
        assetRepresentationId: null,
      })
    )
    await runPg(seedOwnedOnchainSource({ walletAddress }))
    const providerTransferId = await runPg(
      seedProviderTransfer({
        providerAssetRowId,
        externalId: "provider-transfer-pending-representation",
        timestamp,
        amount: "0.33",
        toAddress: walletAddress.toUpperCase(),
        networkHash: null,
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        externalId: "observed-pending-representation",
        txHash: "btc-pending-representation",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.33",
        walletAddress,
        blockchainId: fixture.bitcoinBlockchainId,
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerTransfers)
          .set({ toAddress: walletAddress.toUpperCase() })
          .where(eq(schema.providerTransfers.id, observed.providerTransferId))
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
        const [reconciliation] = yield* db
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const [mapping] = yield* db
          .select({
            mappingStatus: schema.providerAssetMappings.mappingStatus,
            canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
            sourceNotes: schema.providerAssetMappings.sourceNotes,
          })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId))
        const inventoryMovements = yield* db
          .select({ id: schema.inventoryMovements.id })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

        return { reconciliation, mapping, inventoryMovements }
      })
    )

    expect(state.reconciliation).toMatchObject({
      canonicalTransferId: null,
      canonicalTransactionId: observed.transactionId,
      status: "pending",
      matchReason: "asset_representation_review_pending",
      deterministic: false,
    })
    expect(state.mapping).toMatchObject({
      mappingStatus: "pending_review",
      canonicalAssetId: null,
      assetRepresentationId: null,
    })
    expect(state.mapping?.sourceNotes).toContain("transfer_reconciliation_evidence:")
    expect(state.mapping?.sourceNotes).toContain(TEST_BTC_ASSET_ID)
    expect(state.inventoryMovements).toEqual([])
  })

  it("records a first-seen Solana mint from a Coinbase transfer as pending evidence", async () => {
    const walletAddress = "SoOwnedWalletPendingMint1111111111111111111111"
    const mintAddress = "PendingMint1111111111111111111111111111111111"
    const timestamp = new Date("2025-04-10T10:00:00.000Z")
    const solanaBlockchainId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "solana"))
          .limit(1)

        if (blockchain === undefined) {
          return yield* Effect.dieMessage("Missing seeded Solana blockchain")
        }

        return blockchain.id
      })
    )
    const providerAssetRowId = await runPg(
      seedApprovedProviderAsset({
        providerAssetId: "btc-provider-pending-solana-mint",
        assetRepresentationId: null,
      })
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
        externalId: "provider-transfer-pending-solana-mint",
        timestamp,
        amount: "0.33",
        toAddress: walletAddress,
        networkHash: "SolanaPendingMintSignature",
        networkName: "solana",
      })
    )
    const observed = await runPg(
      seedObservedOnchainReceipt({
        externalId: "observed-pending-solana-mint",
        txHash: "SolanaPendingMintSignature",
        timestamp: new Date("2025-04-10T10:05:00.000Z"),
        amount: "0.33",
        walletAddress,
        blockchainId: solanaBlockchainId,
        observedAsset: {
          provider: "helius-solana",
          providerAssetId: mintAddress,
          naturalKey: `solana:mint:${mintAddress}`,
          currencyCode: "UNKNOWN",
          name: "Unknown Solana token",
          exponent: 6,
          providerType: "spl-token",
          networkName: "solana",
          fromAddress: "SoExternalOrigin1111111111111111111111111111",
          representationType: "token",
          contractAddress: null,
          mintAddress,
          decimals: 6,
        },
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
        const [reconciliation] = yield* db
          .select({
            canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
            canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            deterministic: schema.transferReconciliations.deterministic,
          })
          .from(schema.transferReconciliations)
          .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
        const [mapping] = yield* db
          .select({
            mappingStatus: schema.providerAssetMappings.mappingStatus,
            canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
            sourceNotes: schema.providerAssetMappings.sourceNotes,
          })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId))
        const inventoryMovements = yield* db
          .select({ id: schema.inventoryMovements.id })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

        return { reconciliation, mapping, inventoryMovements }
      })
    )

    expect(state.reconciliation).toMatchObject({
      canonicalTransferId: null,
      canonicalTransactionId: observed.transactionId,
      status: "pending",
      matchReason: "asset_representation_review_pending",
      deterministic: false,
    })
    expect(state.mapping).toMatchObject({
      mappingStatus: "pending_review",
      canonicalAssetId: null,
      assetRepresentationId: null,
    })
    expect(state.mapping?.sourceNotes).toContain("transfer_reconciliation_evidence:")
    expect(state.mapping?.sourceNotes).toContain(TEST_BTC_ASSET_ID)
    expect(state.inventoryMovements).toEqual([])
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
        status: "pending",
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
            processingMode: "accounting_and_evidence",
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
            derivationRule: "internal_transfer_out",
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
    expect(reviewsBeforeReconciliation).toHaveLength(3)

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

        return { laterMatches, localLot, receiptReview }
      })
    )

    expect(underfundedState.laterMatches).toEqual([
      {
        fifoLotId: destinationRecoveryFixture.localLotId,
        matchedAmount: expect.stringContaining("0.05000000"),
      },
    ])
    expect(underfundedState.localLot?.remainingAmount).toContain("0.00000000")
    expect(underfundedState.receiptReview).toEqual({
      reviewStatus: "needs_review",
      matchedLayer: "provider_asset_mapping,fifo_inventory,transfer_reconciliation",
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

    expect(secondSummary).toEqual({ canonicalizedPairs: 1 })

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
        remainingAmount: expect.stringContaining("0.08000000"),
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
    expect(state.canonicalLot?.remainingAmount).toContain("0.00000000")
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
    expect(state.disposalMatches).toHaveLength(3)
    expect(state.disposalMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fifoLotId: movedLots[0]?.id,
          matchedAmount: expect.stringContaining("0.08000000"),
        }),
        expect.objectContaining({
          fifoLotId: movedLots[1]?.id,
          matchedAmount: expect.stringContaining("0.07000000"),
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
          remainingAmount: expect.stringContaining("0.08000000"),
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
            processingMode: "accounting_and_evidence",
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
            processingMode: "accounting_and_evidence",
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
            processingMode: "accounting_and_evidence",
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
              processingMode: "accounting_and_evidence" as const,
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
