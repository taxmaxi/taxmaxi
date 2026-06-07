import { describe, expect, it } from "vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  AssetCanonicalizationEvidenceResponse,
  AssetCanonicalizationResponse,
  CanonicalAssetResponse,
  ProviderAssetReviewRow,
} from "../src/definitions/AssetsApi.ts"
import {
  deriveNativeAssetDecimals,
  selectNativePlatform,
} from "../src/layers/AssetCanonicalizationServiceLive.ts"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("AssetsApi schemas", () => {
  it("encodes CoinGecko-backed canonicalization responses", () => {
    const response = AssetCanonicalizationResponse.make({
      providerAsset: ProviderAssetReviewRow.make({
        id: "11111111-1111-4111-8111-111111111111",
        provider: "coinbase",
        providerAssetId: "63062039-7afb-56ff-8e19-5e3215dc404a",
        naturalKey: null,
        currencyCode: "ADA",
        name: "Cardano",
        exponent: 6,
        providerType: "crypto",
        mappingKind: "asset",
        canonicalAssetId: null,
        canonicalAssetSymbol: "ADA",
        canonicalFiatCurrency: null,
        mappingStatus: "pending_review",
        reviewerNotes: null,
        sourceNotes: "Review required.",
      }),
      canonicalAsset: CanonicalAssetResponse.make({
        id: "22222222-2222-4222-8222-222222222222",
        blockchainId: "33333333-3333-4333-8333-333333333333",
        blockchainName: "cardano",
        name: "Cardano",
        symbol: "ADA",
        decimals: 6,
        contractAddress: null,
        type: "native",
      }),
      evidence: AssetCanonicalizationEvidenceResponse.make({
        source: "coingecko",
        coinId: "cardano",
        coinName: "Cardano",
        coinSymbol: "ADA",
        platformId: "cardano",
        platformName: "Cardano",
        contractAddress: null,
      }),
    })

    const encoded = Schema.encodeEither(AssetCanonicalizationResponse)(response)

    expect(Either.isRight(encoded)).toBe(true)
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
})
