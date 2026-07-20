import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  deriveChainType,
  deriveNativeAssetDecimals,
  hasStrongProviderIdentityEvidence,
  optionalCandidateResolution,
  providerTokenIdentifiersMatch,
  selectCoinCandidate,
  selectNativePlatform,
} from "../src/layers/AssetCanonicalizationServiceLive.ts"
import {
  AssetCanonicalizationBadRequestError,
  AssetCanonicalizationProviderError,
} from "../src/services/AssetCanonicalizationService.ts"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("AssetCanonicalizationService", () => {
  it("uses the explicitly reviewed CoinGecko candidate", async () => {
    const selected = await Effect.runPromise(
      selectCoinCandidate({
        coinId: "usd-coin",
        providerAssetSymbol: "USDC",
        searchCoins: [
          { id: "bridged-usdc", name: "Bridged USDC", symbol: "USDC" },
          { id: "usd-coin", name: "USD Coin", symbol: "USDC" },
        ],
      })
    )

    expect(selected.id).toBe("usd-coin")
  })

  it("does not treat a symbol-only candidate as strong identity evidence", () => {
    expect(
      hasStrongProviderIdentityEvidence({
        candidateContractAddress: null,
        coinName: "Unrelated Dollar Coin",
        observedTokenId: null,
        providerName: "USD Coin",
      })
    ).toBe(false)
    expect(
      hasStrongProviderIdentityEvidence({
        candidateContractAddress: null,
        coinName: "USD Coin",
        observedTokenId: null,
        providerName: "USD Coin",
      })
    ).toBe(true)
  })

  it("does not accept a native candidate for an observed token identifier", () => {
    expect(
      hasStrongProviderIdentityEvidence({
        candidateContractAddress: null,
        coinName: "Solana",
        observedTokenId: "ImpersonatingMint",
        providerName: "Solana",
      })
    ).toBe(false)
    expect(
      hasStrongProviderIdentityEvidence({
        candidateContractAddress: "MatchingMint",
        coinName: "Token",
        observedTokenId: "MatchingMint",
        providerName: "Token",
      })
    ).toBe(true)
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

  it("preserves case for non-EVM token identifiers", () => {
    expect(
      providerTokenIdentifiersMatch({
        chainType: "solana",
        observedTokenId: "CaseSensitiveMint",
        canonicalTokenId: "casesensitivemint",
      })
    ).toBe(false)
    expect(
      providerTokenIdentifiersMatch({
        chainType: "evm",
        observedTokenId: "0xAbCd",
        canonicalTokenId: "0xabcd",
      })
    ).toBe(true)
  })

  it("suppresses candidate validation failures but preserves provider outages", async () => {
    await expect(
      Effect.runPromise(
        optionalCandidateResolution(
          Effect.fail(
            new AssetCanonicalizationBadRequestError({ message: "Candidate is ambiguous." })
          )
        )
      )
    ).resolves.toEqual({ _tag: "InvalidCandidate" })

    await expect(
      Effect.runPromise(
        optionalCandidateResolution(
          Effect.fail(
            new AssetCanonicalizationProviderError({ message: "CoinGecko is unavailable." })
          )
        )
      )
    ).rejects.toMatchObject({
      message: "CoinGecko is unavailable.",
      name: "(FiberFailure) AssetCanonicalizationProviderError",
    })
  })
})
