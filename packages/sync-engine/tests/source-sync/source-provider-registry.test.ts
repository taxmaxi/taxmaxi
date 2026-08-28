import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "@effect/vitest"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { CoinbaseSourceSyncProvider } from "../../src/providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HeliusSolanaSourceSyncProvider,
} from "../../src/providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
import { SourceProviderRegistry } from "../../src/services/SourceProviderRegistry.ts"
import {
  FetchProviderRawBatchParams,
  FetchProviderRawBatchResult,
  ProviderRawRecord,
} from "../../src/shared/SourceProviderRawBatch.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"

const SOLANA_WALLET_ADDRESS = "So11111111111111111111111111111111111111112"

const source: SourceSyncSource = {
  id: "source-solana-1",
  principalId: "principal-solana-1",
  providerKey: HELIUS_SOLANA_PROVIDER_KEY,
  cexAccountId: null,
  addressId: "address-solana-1",
  walletAddress: SOLANA_WALLET_ADDRESS,
}

const sourceRecord: SourceRawRecord = {
  id: "raw-solana-1",
  sourceId: source.id,
  provider: HELIUS_SOLANA_PROVIDER_KEY,
  recordType: "solana_transaction_full",
  externalAccountId: source.walletAddress,
  externalRecordId: "solana-signature-1",
  externalParentId: null,
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
  payload: { transaction: { signatures: ["solana-signature-1"] } },
  importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
  normalizedAt: null,
  normalizationError: null,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
}

const CoinbaseSourceSyncProviderTestLive = Layer.succeed(
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProvider.of({
    fetchRawBatch: () => Effect.die("Coinbase fetchRawBatch should not be called"),
    refreshReferenceData: Effect.die("Coinbase refreshReferenceData should not be called"),
    refreshDefaultMappings: Effect.die("Coinbase refreshDefaultMappings should not be called"),
    loadNormalizationLookups: Effect.die("Coinbase loadNormalizationLookups should not be called"),
    prepareNormalization: () => Effect.die("Coinbase prepareNormalization should not be called"),
    deriveLegs: () => Effect.die("Coinbase deriveLegs should not be called"),
  })
)

const HeliusSolanaSourceSyncProviderTestLive = Layer.succeed(
  HeliusSolanaSourceSyncProvider,
  HeliusSolanaSourceSyncProvider.of({
    fetchRawBatch: () =>
      Effect.succeed(
        FetchProviderRawBatchResult.make({
          records: [
            ProviderRawRecord.make({
              providerKey: HELIUS_SOLANA_PROVIDER_KEY,
              recordType: "solana_transaction_full",
              externalRecordId: "solana-signature-1",
              externalAccountId: "So11111111111111111111111111111111111111112",
              externalParentId: null,
              occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
              payload: { transaction: { signatures: ["solana-signature-1"] } },
            }),
          ],
          cursorPayload: { paginationToken: null },
          highWatermark: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          done: true,
        })
      ),
    refreshReferenceData: Effect.succeed({
      transactionTypeCatalogCount: 0,
      providerAssetCatalogCount: 0,
      defaultTransactionMappingCount: 0,
      defaultProviderAssetMappingCount: 0,
    }),
    loadNormalizationLookups: Effect.succeed({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      solanaBlockchainId: "solana-blockchain-id",
    }),
    prepareNormalization: () =>
      Effect.succeed({
        providerAssetRowIds: [],
        transaction: {
          sourceId: source.id,
          sourceRawRecordId: sourceRecord.id,
          externalId: "solana-signature-1",
          externalGroupId: "solana-signature-1",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          transactionType: null,
          providerTransactionType: "unknown",
          providerStatus: "succeeded",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          providerUpdatedAt: null,
          metadata: { provider: HELIUS_SOLANA_PROVIDER_KEY },
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: source.principalId,
        },
        venueContext: {
          venueType: "dex",
          cexAccountId: null,
          externalAccountId: SOLANA_WALLET_ADDRESS,
          externalOrderId: null,
          externalFillId: null,
          side: null,
          instrument: null,
          fillPrice: null,
          commissionAmount: null,
          commissionCurrency: null,
          metadata: { provider: HELIUS_SOLANA_PROVIDER_KEY },
        },
        onchainContext: {
          blockchainId: "solana-blockchain-id",
          addressId: "address-solana-1",
          chainTxId: "solana-signature-1",
          blockHeight: "123",
          blockHash: null,
          positionInBlock: "4",
          fromAddress: SOLANA_WALLET_ADDRESS,
          toAddress: SOLANA_WALLET_ADDRESS,
          gasUsed: null,
          gasPrice: null,
          feeAmount: "5000",
          feeAssetId: "asset-sol",
          feeCostBasisAmount: null,
          feeCostBasisCurrency: null,
          isError: false,
          functionName: "unknown",
          metadata: { provider: HELIUS_SOLANA_PROVIDER_KEY },
        },
        providerTransfers: [],
        canonicalTransfers: [],
        transactionReview: null,
        resolvedTransactionType: {
          providerTransactionType: "unknown",
          transactionType: null,
          inventoryEffect: "unknown",
          taxTreatment: "requires_additional_rule_logic",
          resolutionStrategy: "no_leg",
          pairedRecordRequired: false,
          mappingStatus: "pending_review",
        },
        legDerivationStrategy: "skip",
        legPlans: [],
      }),
    deriveLegs: () => Effect.die("Helius deriveLegs should not be called"),
  })
)

const RegistryLive = SourceProviderRegistryLive.pipe(
  Layer.provide(CoinbaseSourceSyncProviderTestLive),
  Layer.provide(HeliusSolanaSourceSyncProviderTestLive)
)

describe("SourceProviderRegistryLive", () => {
  it.effect("resolves the production Solana provider key to the Helius provider module", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registry = yield* SourceProviderRegistry
        const provider = yield* registry.resolveProviderModule({
          providerKey: "helius-solana",
        })
        yield* provider.refreshReferenceData
        return yield* provider.fetchRawBatch(
          FetchProviderRawBatchParams.make({
            providerKey: "helius-solana",
            sourceId: "source-solana-1",
            walletAddress: "So11111111111111111111111111111111111111112",
            cursorPayload: null,
            resumeHighWatermark: null,
            resumeCheckpointExternalId: null,
            pageSize: 100,
          })
        )
      }).pipe(Effect.provide(RegistryLive))

      expect(result.records.map((record) => record.externalRecordId)).toEqual([
        "solana-signature-1",
      ])
      expect(result.done).toBe(true)
    })
  )

  it.effect("forwards Helius onchain context through prepared normalization", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registry = yield* SourceProviderRegistry
        const provider = yield* registry.resolveProviderModule({
          providerKey: "helius-solana",
        })
        const normalize = yield* provider.makeRawRecordNormalizer
        return yield* normalize({ source, sourceRecord })
      }).pipe(Effect.provide(RegistryLive))

      expect(result.kind).toBe("prepared")
      if (result.kind === "prepared") {
        expect(result.onchainContext).toMatchObject({
          chainTxId: "solana-signature-1",
          blockHeight: "123",
          positionInBlock: "4",
        })
      }
    })
  )
})
