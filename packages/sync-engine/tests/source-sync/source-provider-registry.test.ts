import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseSourceSyncProvider } from "../../src/providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import { SourceProviderRegistry } from "../../src/services/SourceProviderRegistry.ts"
import { FetchProviderRawBatchParams } from "../../src/shared/SourceProviderRawBatch.ts"

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

const RegistryLive = SourceProviderRegistryLive.pipe(
  Layer.provide(CoinbaseSourceSyncProviderTestLive),
  Layer.provide(HeliusSolanaSourceSyncProviderLive)
)

describe("SourceProviderRegistryLive", () => {
  it("resolves the production Solana provider key to the Helius stub", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* SourceProviderRegistry
        const provider = yield* registry.resolveProviderModule({ providerKey: "helius-solana" })
        yield* provider.refreshReferenceData()
        return yield* provider
          .fetchRawBatch(
            FetchProviderRawBatchParams.make({
              providerKey: "helius-solana",
              sourceId: "source-solana-1",
              cursorPayload: null,
              resumeHighWatermark: null,
              resumeCheckpointExternalId: null,
              pageSize: 100,
            })
          )
          .pipe(Effect.either)
      }).pipe(Effect.provide(RegistryLive))
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        providerKey: "helius-solana",
        retryable: false,
      })
      expect(result.left.message).toContain("not implemented")
    }
  })
})
