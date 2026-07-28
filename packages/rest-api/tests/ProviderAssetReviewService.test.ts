import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  deriveChainType,
  deriveNativeAssetDecimals,
  hasStrongProviderIdentityEvidence,
  isObservedProviderChainMatch,
  optionalCandidateResolution,
  providerAssetCanonicalType,
  providerAssetReplayResults,
  providerTokenIdentifiersMatch,
  resolveNativeAssetDecimals,
  resolveTokenAssetDecimals,
  selectCoinCandidate,
  selectExactTokenPlatform,
  selectNativeCoinPlatform,
  selectNativePlatform,
} from "../src/layers/ProviderAssetReviewServiceLive.ts"
import {
  ProviderAssetReviewBadRequestError,
  ProviderAssetReviewProviderError,
} from "../src/services/ProviderAssetReviewService.ts"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("ProviderAssetReviewService", () => {
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

  it("does not accept a token or bridge without an observed token identifier", () => {
    expect(
      hasStrongProviderIdentityEvidence({
        candidateContractAddress: "zec.omft.near",
        coinName: "Zcash",
        observedTokenId: null,
        providerName: "Zcash",
      })
    ).toBe(false)
  })

  it("preserves NFT provider observations in canonical asset drafts", () => {
    expect(providerAssetCanonicalType("nft")).toBe("nft")
    expect(providerAssetCanonicalType(" NFT ")).toBe("nft")
    expect(providerAssetCanonicalType("spl-token")).toBe("token")
    expect(providerAssetCanonicalType(null)).toBe("token")
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

  it("keeps Zcash native when CoinGecko also reports a bridged NEAR contract", () => {
    const platform = selectNativeCoinPlatform({
      coin: {
        id: "zcash",
        name: "Zcash",
        symbol: "zec",
        asset_platform_id: null,
        platforms: { "": "", "near-protocol": "zec.omft.near" },
        detail_platforms: {
          "": { decimal_place: null, contract_address: "" },
          "near-protocol": { decimal_place: 8, contract_address: "zec.omft.near" },
        },
      },
      assetPlatforms: coinGeckoAssetPlatformSnapshot,
    })

    expect(platform).toEqual({
      id: "zcash",
      name: "Zcash",
      chain_identifier: null,
      shortname: "ZEC",
      native_coin_id: "zcash",
    })
  })

  it("uses provider precision for native chains CoinGecko does not catalog", () => {
    expect(
      resolveNativeAssetDecimals({
        coinId: "zcash",
        platform: {
          id: "zcash",
          name: "Zcash",
          chain_identifier: null,
          shortname: "ZEC",
          native_coin_id: "zcash",
        },
        providerExponent: 8,
      })
    ).toBe(8)
  })

  it("does not guess token precision when CoinGecko and the provider omit it", () => {
    expect(
      resolveTokenAssetDecimals({
        coinGeckoDecimals: null,
        providerExponent: null,
      })
    ).toBeNull()
    expect(
      resolveTokenAssetDecimals({
        coinGeckoDecimals: 6,
        providerExponent: null,
      })
    ).toBe(6)
  })

  it("reports the durable replay job created by the review decision", () => {
    expect(
      providerAssetReplayResults([
        { sourceId: "source-1", principalId: "principal-1", jobId: "job-1" },
      ])
    ).toEqual([
      {
        sourceId: "source-1",
        jobId: "job-1",
        status: "queued",
        message: null,
      },
    ])
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

  it("requires an observed Solana token to map to the Solana chain", () => {
    expect(
      isObservedProviderChainMatch({
        blockchainChainType: "solana",
        provider: "helius-solana",
        providerType: "spl-token",
      })
    ).toBe(true)
    expect(
      isObservedProviderChainMatch({
        blockchainChainType: "other",
        provider: "helius-solana",
        providerType: "spl-token",
      })
    ).toBe(false)
  })

  it("selects the exact observed token from a multi-platform CoinGecko coin", () => {
    const solanaMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

    expect(
      selectExactTokenPlatform({
        assetPlatforms: coinGeckoAssetPlatformSnapshot,
        observedTokenId: solanaMint,
        provider: "helius-solana",
        providerType: "spl-token",
        tokenPlatforms: [
          ["ethereum", "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
          ["solana", solanaMint],
          ["base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
        ],
      })
    ).toEqual(["solana", solanaMint])
  })

  it("rejects exact token identifiers observed on a different provider chain", () => {
    const solanaMint = "CaseSensitiveMint"

    expect(
      selectExactTokenPlatform({
        assetPlatforms: coinGeckoAssetPlatformSnapshot,
        observedTokenId: solanaMint,
        provider: "helius-solana",
        providerType: "spl-token",
        tokenPlatforms: [["aptos", solanaMint]],
      })
    ).toBeNull()
  })

  it("suppresses candidate validation failures but preserves provider outages", async () => {
    await expect(
      Effect.runPromise(
        optionalCandidateResolution(
          Effect.fail(
            new ProviderAssetReviewBadRequestError({ message: "Candidate is ambiguous." })
          )
        )
      )
    ).resolves.toEqual({
      _tag: "UnavailableCandidate",
      reason: "Candidate is ambiguous.",
    })

    await expect(
      Effect.runPromise(
        optionalCandidateResolution(
          Effect.fail(
            new ProviderAssetReviewProviderError({ message: "CoinGecko is unavailable." })
          )
        )
      )
    ).rejects.toMatchObject({
      message: "CoinGecko is unavailable.",
      name: "(FiberFailure) ProviderAssetReviewProviderError",
    })
  })
})
