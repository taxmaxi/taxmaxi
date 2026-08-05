import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  deriveChainType,
  deriveNativeAssetDecimals,
  representationIdForProviderObservation,
  selectNativePlatform,
  validateNativeProviderIdentity,
} from "../src/layers/AssetCanonicalizationServiceLive.ts"
import type { ProviderAssetRecord } from "@my/sync-engine/services"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("AssetCanonicalizationService", () => {
  const makeProviderAsset = (
    overrides: Partial<ProviderAssetRecord> = {}
  ): ProviderAssetRecord => ({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "coinbase",
    providerAssetId: "coinbase-usdc",
    naturalKey: null,
    currencyCode: "USDC",
    name: "USD Coin",
    exponent: 6,
    providerType: "crypto",
    rawProviderPayload: {},
    discoveredAt: new Date("2025-01-01T00:00:00.000Z"),
    retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  })

  it("keeps chainless provider mappings at the economic asset level", () => {
    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset(),
        representationId: "00000000-0000-4000-8000-000000000002",
      })
    ).toBeNull()
  })

  it("keeps an exact representation for an observed Solana mint", () => {
    const representationId = "00000000-0000-4000-8000-000000000002"

    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: "Mint111111111111111111111111111111111111111",
          naturalKey: "solana:mint:Mint111111111111111111111111111111111111111",
          providerType: "spl-token",
        }),
        representationId,
      })
    ).toBe(representationId)
  })

  it("keeps the native representation for an observed Solana native asset", () => {
    const representationId = "00000000-0000-4000-8000-000000000002"

    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: null,
          naturalKey: "solana:native:SOL",
          providerType: "native",
        }),
        representationId,
      })
    ).toBe(representationId)
  })

  it("rejects a native asset resolution for an observed Solana token", () => {
    const result = Effect.runSync(
      validateNativeProviderIdentity(
        makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: "Mint111111111111111111111111111111111111111",
          naturalKey: "solana:mint:Mint111111111111111111111111111111111111111",
          currencyCode: "SOL",
          name: "Solana",
          providerType: "spl-token",
        })
      ).pipe(Effect.either)
    )

    expect(result._tag).toBe("Left")
  })

  it("includes Cardano native platform metadata from CoinGecko", () => {
    const cardanoPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "cardano"
    )

    expect(cardanoPlatform).toMatchObject({
      id: "cardano",
      name: "Cardano",
      native_coin_id: "cardano",
      chain_identifier: null,
    })
  })

  it("derives native chain decimals without using provider display precision", () => {
    const ethereumPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "ethereum"
    )
    const cardanoPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "cardano"
    )

    expect(ethereumPlatform).toBeDefined()
    expect(cardanoPlatform).toBeDefined()

    if (ethereumPlatform !== undefined && cardanoPlatform !== undefined) {
      expect(
        deriveNativeAssetDecimals({
          coinId: "ethereum",
          platform: ethereumPlatform,
        })
      ).toBe(18)
      expect(
        deriveNativeAssetDecimals({
          coinId: "cardano",
          platform: cardanoPlatform,
        })
      ).toBe(6)
    }
  })

  it("selects native Bitcoin without treating related platforms as ambiguity", () => {
    const bitcoinPlatform = selectNativePlatform({
      coinId: "bitcoin",
      assetPlatforms: coinGeckoAssetPlatformSnapshot,
    })

    expect(bitcoinPlatform).toMatchObject({
      id: "bitcoin",
      name: "Bitcoin",
      native_coin_id: "bitcoin",
      chain_identifier: null,
    })
  })

  it("does not select a single related native platform for token coins", () => {
    expect(
      selectNativePlatform({
        coinId: "usd-coin",
        assetPlatforms: [
          {
            id: "hyperliquid",
            name: "Hyperliquid",
            chain_identifier: null,
            shortname: "HYPE",
            native_coin_id: "usd-coin",
          },
        ],
      })
    ).toBeNull()
  })

  it("uses explicit chain identifiers before platform name heuristics", () => {
    expect(
      deriveChainType({
        id: "bitlayer",
        name: "Bitlayer",
        chain_identifier: 200901,
        shortname: null,
        native_coin_id: "bitcoin",
      })
    ).toBe("evm")
  })
})
