import { describe, expect, it } from "vitest"
import {
  deriveChainType,
  deriveNativeAssetDecimals,
  selectNativePlatform,
} from "../src/layers/AssetCanonicalizationServiceLive.ts"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("AssetCanonicalizationService", () => {
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
