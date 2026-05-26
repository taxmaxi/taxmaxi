import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
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

const CoinbaseSourceSyncProviderTestLive = Layer.succeed(
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProvider.of({
    fetchRawBatch: () => Effect.dieMessage("Coinbase fetchRawBatch should not be called"),
    refreshReferenceData: () =>
      Effect.dieMessage("Coinbase refreshReferenceData should not be called"),
    loadNormalizationLookups: () =>
      Effect.dieMessage("Coinbase loadNormalizationLookups should not be called"),
    prepareNormalization: () =>
      Effect.dieMessage("Coinbase prepareNormalization should not be called"),
    deriveLegs: () => Effect.dieMessage("Coinbase deriveLegs should not be called"),
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
              occurredAt: new Date("2026-01-01T00:00:00.000Z"),
              payload: { transaction: { signatures: ["solana-signature-1"] } },
            }),
          ],
          cursorPayload: { paginationToken: null },
          highWatermark: new Date("2026-01-01T00:00:00.000Z"),
          done: true,
        })
      ),
    refreshReferenceData: () =>
      Effect.succeed({
        transactionTypeCatalogCount: 0,
        providerAssetCatalogCount: 0,
        defaultTransactionMappingCount: 0,
        defaultProviderAssetMappingCount: 0,
      }),
    loadNormalizationLookups: () => Effect.succeed({ providerKey: HELIUS_SOLANA_PROVIDER_KEY }),
    prepareNormalization: () =>
      Effect.dieMessage("Helius prepareNormalization should not be called"),
    deriveLegs: () => Effect.dieMessage("Helius deriveLegs should not be called"),
  })
)

const RegistryLive = SourceProviderRegistryLive.pipe(
  Layer.provide(CoinbaseSourceSyncProviderTestLive),
  Layer.provide(HeliusSolanaSourceSyncProviderTestLive)
)

describe("SourceProviderRegistryLive", () => {
  it("resolves the production Solana provider key to the Helius provider module", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* SourceProviderRegistry
        const provider = yield* registry.resolveProviderModule({ providerKey: "helius-solana" })
        yield* provider.refreshReferenceData()
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
    )

    expect(result.records.map((record) => record.externalRecordId)).toEqual(["solana-signature-1"])
    expect(result.done).toBe(true)
  })
})
