import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { SOLANA_USDC_MINT } from "../../src/assets/AssetReferenceCatalog.ts"
import {
  AssetResolutionConflictingEvidence,
  AssetResolutionMalformedPayload,
  AssetResolutionUpstreamFailure,
  ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
  canonicalizeAddress,
  ChainClaim,
  exactRepresentationKey,
  CoinGeckoClaim,
  CoinGeckoPlatformMapping,
  decodeChainClaim,
  decodeCoinGeckoClaim,
  decideAttachOnlyResolution,
  evaluateAttachOnlyResolution,
  type AssetResolutionIdentitySnapshot,
} from "../../src/assets/AssetResolutionPolicy.ts"

const ETHEREUM_USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const ETHEREUM_USDC_CONTRACT_CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const usdcIdentity = (): AssetResolutionIdentitySnapshot => ({
  economicAssets: [
    {
      assetKey: "usdc",
      coingeckoCoinId: "usd-coin",
      type: "fungible",
    },
  ],
  representations: [
    {
      assetKey: "usdc",
      blockchain: "ethereum",
      type: "token",
      contractAddress: ETHEREUM_USDC_CONTRACT,
      mintAddress: null,
      decimals: 6,
    },
  ],
})

const ethIdentity = (): AssetResolutionIdentitySnapshot => ({
  economicAssets: [
    {
      assetKey: "eth",
      coingeckoCoinId: "ethereum",
      type: "fungible",
    },
  ],
  representations: [],
})

const solanaUsdcChainFact = {
  blockchain: "solana",
  type: "token",
  contractAddress: null,
  mintAddress: SOLANA_USDC_MINT,
  decimals: 6,
} as const

const ethereumUsdcChainFact = {
  blockchain: "ethereum",
  type: "token",
  contractAddress: ETHEREUM_USDC_CONTRACT_CHECKSUM,
  mintAddress: null,
  decimals: 6,
} as const

const ethNativeChainFact = {
  blockchain: "ethereum",
  type: "native",
  contractAddress: null,
  mintAddress: null,
  decimals: 18,
} as const

const usdcCoinPayload = {
  id: "usd-coin",
  symbol: "usdc",
  name: "USDC",
  asset_platform_id: null,
  platforms: {
    ethereum: ETHEREUM_USDC_CONTRACT,
    solana: SOLANA_USDC_MINT,
  },
  detail_platforms: {
    ethereum: {
      decimal_place: 6,
      contract_address: ETHEREUM_USDC_CONTRACT,
    },
    solana: {
      decimal_place: 6,
      contract_address: SOLANA_USDC_MINT,
    },
  },
  image: {
    thumb: "https://example.test/usdc-thumb.png",
    small: "https://example.test/usdc-small.png",
    large: "https://example.test/usdc-large.png",
  },
}

const ethCoinPayload = {
  id: "ethereum",
  symbol: "eth",
  name: "Ethereum",
  asset_platform_id: null,
  platforms: {
    ethereum: "",
  },
  detail_platforms: {
    ethereum: {
      decimal_place: 18,
      contract_address: "",
    },
  },
}

const solanaUsdcChainClaim = () =>
  ChainClaim.make({
    blockchain: "solana",
    type: "token",
    contractAddress: null,
    mintAddress: SOLANA_USDC_MINT,
    decimals: 6,
  })

const usdcCoinGeckoClaim = () =>
  CoinGeckoClaim.make({
    coinId: "usd-coin",
    name: "USDC",
    symbol: "usdc",
    platforms: [
      CoinGeckoPlatformMapping.make({
        platformId: "ethereum",
        contractAddress: ETHEREUM_USDC_CONTRACT,
        decimals: 6,
      }),
      CoinGeckoPlatformMapping.make({
        platformId: "solana",
        contractAddress: SOLANA_USDC_MINT,
        decimals: 6,
      }),
    ],
  })

const decodeFailureTag = (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const result = Effect.runSync(Effect.result(effect))
  expect(result._tag).toBe("Failure")
  return result._tag === "Failure" ? result.failure._tag : "Success"
}

const evaluate = ({
  chain,
  coinGecko,
  identity = usdcIdentity(),
}: {
  readonly chain:
    | { readonly _tag: "payload"; readonly payload: unknown }
    | AssetResolutionUpstreamFailure
  readonly coinGecko:
    | { readonly _tag: "payload"; readonly payload: unknown }
    | AssetResolutionUpstreamFailure
  readonly identity?: AssetResolutionIdentitySnapshot
}) => Effect.runSync(evaluateAttachOnlyResolution({ chain, coinGecko, identity }))

describe("AssetResolutionPolicy", () => {
  describe("decodeChainClaim", () => {
    it("decodes exact native, contract, and mint chain facts into typed claims", () => {
      const native = Effect.runSync(decodeChainClaim(ethNativeChainFact))
      const contract = Effect.runSync(decodeChainClaim(ethereumUsdcChainFact))
      const mint = Effect.runSync(decodeChainClaim(solanaUsdcChainFact))

      expect(native).toMatchObject({
        _tag: "chain_claim",
        blockchain: "ethereum",
        type: "native",
        contractAddress: null,
        mintAddress: null,
        decimals: 18,
      })
      expect(contract).toMatchObject({
        _tag: "chain_claim",
        type: "token",
        contractAddress: ETHEREUM_USDC_CONTRACT,
        mintAddress: null,
        decimals: 6,
      })
      expect(mint).toMatchObject({
        _tag: "chain_claim",
        type: "token",
        contractAddress: null,
        mintAddress: SOLANA_USDC_MINT,
        decimals: 6,
      })
    })

    it("fails closed for malformed chain facts", () => {
      expect(
        decodeFailureTag(
          decodeChainClaim({
            ...solanaUsdcChainFact,
            type: "native",
          })
        )
      ).toBe("malformed_payload")
      expect(decodeFailureTag(decodeChainClaim({ ...solanaUsdcChainFact, decimals: "6" }))).toBe(
        "malformed_payload"
      )
      expect(decodeFailureTag(decodeChainClaim({ blockchain: "solana" }))).toBe("malformed_payload")
    })
  })

  describe("decodeCoinGeckoClaim", () => {
    it("decodes a CoinGecko coin payload into typed platform claims", () => {
      const claim = Effect.runSync(decodeCoinGeckoClaim(usdcCoinPayload))

      expect(claim._tag).toBe("coingecko_claim")
      expect(claim.coinId).toBe("usd-coin")
      expect(claim.platforms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            platformId: "solana",
            contractAddress: SOLANA_USDC_MINT,
            decimals: 6,
          }),
          expect.objectContaining({
            platformId: "ethereum",
            contractAddress: ETHEREUM_USDC_CONTRACT,
            decimals: 6,
          }),
        ])
      )
    })

    it("treats empty CoinGecko native addresses as null", () => {
      const claim = Effect.runSync(decodeCoinGeckoClaim(ethCoinPayload))

      expect(claim.platforms).toEqual([
        expect.objectContaining({
          platformId: "ethereum",
          contractAddress: null,
          decimals: 18,
        }),
      ])
    })

    it("fails closed for malformed or changed CoinGecko payloads", () => {
      expect(decodeFailureTag(decodeCoinGeckoClaim({ id: 1 }))).toBe("malformed_payload")
      expect(
        decodeFailureTag(
          decodeCoinGeckoClaim({
            ...usdcCoinPayload,
            detail_platforms: {
              solana: {
                decimal_place: "6",
                contract_address: SOLANA_USDC_MINT,
              },
            },
          })
        )
      ).toBe("malformed_payload")
      expect(
        decodeFailureTag(
          decodeCoinGeckoClaim({
            ...usdcCoinPayload,
            platforms: {
              ...usdcCoinPayload.platforms,
              solana: "So11111111111111111111111111111111111111112",
            },
          })
        )
      ).toBe("malformed_payload")
    })
  })

  describe("decideAttachOnlyResolution", () => {
    it("attaches a new exact representation to the existing economic asset", () => {
      const decision = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "attach",
        policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
        assetKey: "usdc",
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: SOLANA_USDC_MINT,
        decimals: 6,
      })
    })

    it("attaches a native representation when the CoinGecko platform address is empty", () => {
      const decision = decideAttachOnlyResolution({
        chain: ChainClaim.make(ethNativeChainFact),
        coinGecko: Effect.runSync(decodeCoinGeckoClaim(ethCoinPayload)),
        identity: ethIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "attach",
        assetKey: "eth",
        blockchain: "ethereum",
        type: "native",
        contractAddress: null,
        mintAddress: null,
        decimals: 18,
      })
    })

    it("does not attach when names and symbols match a known asset but the CoinGecko id does not", () => {
      const decision = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: CoinGeckoClaim.make({
          coinId: "usd-coin-impersonator",
          name: "USD Coin",
          symbol: "usdc",
          platforms: usdcCoinGeckoClaim().platforms,
        }),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "pending",
        reason: "missing_existing_economic_asset",
      })
    })

    it("stays pending when no existing economic asset owns the CoinGecko id", () => {
      const decision = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: usdcCoinGeckoClaim(),
        identity: ethIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "pending",
        reason: "missing_existing_economic_asset",
      })
    })

    it("stays pending when the CoinGecko platform chain or address is not an exact match", () => {
      const wrongChain = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: CoinGeckoClaim.make({
          coinId: "usd-coin",
          name: "USDC",
          symbol: "usdc",
          platforms: [
            CoinGeckoPlatformMapping.make({
              platformId: "ethereum",
              contractAddress: ETHEREUM_USDC_CONTRACT,
              decimals: 6,
            }),
          ],
        }),
        identity: usdcIdentity(),
      })
      const wrongAddress = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: CoinGeckoClaim.make({
          coinId: "usd-coin",
          name: "USDC",
          symbol: "usdc",
          platforms: [
            CoinGeckoPlatformMapping.make({
              platformId: "solana",
              contractAddress: "So11111111111111111111111111111111111111112",
              decimals: 6,
            }),
          ],
        }),
        identity: usdcIdentity(),
      })

      expect(wrongChain).toMatchObject({
        _tag: "pending",
        reason: "non_exact_platform_match",
      })
      expect(wrongAddress).toMatchObject({
        _tag: "pending",
        reason: "non_exact_platform_match",
      })
    })

    it("stays pending when the matching CoinGecko platform has no decimals", () => {
      const decision = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: CoinGeckoClaim.make({
          coinId: "usd-coin",
          name: "USDC",
          symbol: "usdc",
          platforms: [
            CoinGeckoPlatformMapping.make({
              platformId: "solana",
              contractAddress: SOLANA_USDC_MINT,
              decimals: null,
            }),
          ],
        }),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "pending",
        reason: "non_exact_platform_match",
      })
    })

    it("fails closed for incompatible decimals or type", () => {
      const incompatibleDecimals = decideAttachOnlyResolution({
        chain: ChainClaim.make({
          ...solanaUsdcChainFact,
          decimals: 8,
        }),
        coinGecko: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })
      const incompatibleType = decideAttachOnlyResolution({
        chain: ChainClaim.make({
          ...solanaUsdcChainFact,
          type: "nft",
        }),
        coinGecko: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })

      expect(incompatibleDecimals).toMatchObject({
        _tag: "fail_closed",
        reason: "incompatible_decimals",
      })
      expect(incompatibleType).toMatchObject({
        _tag: "fail_closed",
        reason: "incompatible_type",
      })
    })

    it("fails closed when another asset already owns the representation", () => {
      const decision = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: usdcCoinGeckoClaim(),
        identity: {
          economicAssets: usdcIdentity().economicAssets,
          representations: [
            {
              assetKey: "usdt",
              blockchain: "solana",
              type: "token",
              contractAddress: null,
              mintAddress: SOLANA_USDC_MINT,
              decimals: 6,
            },
          ],
        },
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "ownership_conflict",
      })
    })

    it("fails closed for malformed payloads and upstream failures", () => {
      const malformed = decideAttachOnlyResolution({
        chain: solanaUsdcChainClaim(),
        coinGecko: new AssetResolutionMalformedPayload({ source: "coingecko" }),
        identity: usdcIdentity(),
      })
      const upstream = decideAttachOnlyResolution({
        chain: new AssetResolutionUpstreamFailure({ source: "chain" }),
        coinGecko: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })

      expect(malformed).toMatchObject({
        _tag: "fail_closed",
        reason: "malformed_payload",
      })
      expect(upstream).toMatchObject({
        _tag: "fail_closed",
        reason: "upstream_failure",
      })
    })

    it("fails closed for conflicting evidence and names the conflict", () => {
      const decision = decideAttachOnlyResolution({
        chain: new AssetResolutionConflictingEvidence({ source: "chain" }),
        coinGecko: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "conflicting_evidence",
      })
    })
  })

  describe("evaluateAttachOnlyResolution", () => {
    it("attaches from decoded chain and CoinGecko payloads", () => {
      const decision = evaluate({
        chain: { _tag: "payload", payload: solanaUsdcChainFact },
        coinGecko: { _tag: "payload", payload: usdcCoinPayload },
      })

      expect(decision).toMatchObject({
        _tag: "attach",
        assetKey: "usdc",
        blockchain: "solana",
        mintAddress: SOLANA_USDC_MINT,
        decimals: 6,
      })
    })

    it("fails closed for malformed payloads and does not attach", () => {
      const decision = evaluate({
        chain: { _tag: "payload", payload: solanaUsdcChainFact },
        coinGecko: { _tag: "payload", payload: { id: "usd-coin" } },
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "malformed_payload",
      })
    })

    it("fails closed for upstream failures and does not attach", () => {
      const decision = evaluate({
        chain: { _tag: "payload", payload: solanaUsdcChainFact },
        coinGecko: new AssetResolutionUpstreamFailure({ source: "coingecko" }),
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "upstream_failure",
      })
    })
  })

  describe("canonicalizeAddress", () => {
    it("lowercases EVM-shaped addresses because their case is not significant", () => {
      expect(canonicalizeAddress(ETHEREUM_USDC_CONTRACT_CHECKSUM)).toBe(ETHEREUM_USDC_CONTRACT)
    })

    it("preserves the case of every other address", () => {
      expect(canonicalizeAddress(SOLANA_USDC_MINT)).toBe(SOLANA_USDC_MINT)
      expect(canonicalizeAddress(SOLANA_USDC_MINT.toLowerCase())).toBe(
        SOLANA_USDC_MINT.toLowerCase()
      )
    })

    it("passes null through", () => {
      expect(canonicalizeAddress(null)).toBeNull()
    })
  })

  describe("exactRepresentationKey", () => {
    it("keys native, contract, and mint representations distinctly", () => {
      const native = exactRepresentationKey({
        blockchain: "ethereum",
        type: "native",
        contractAddress: null,
        mintAddress: null,
      })
      const contract = exactRepresentationKey({
        blockchain: "ethereum",
        type: "token",
        contractAddress: ETHEREUM_USDC_CONTRACT,
        mintAddress: null,
      })
      const mint = exactRepresentationKey({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: SOLANA_USDC_MINT,
      })

      expect(new Set([native, contract, mint]).size).toBe(3)
    })

    it("treats EVM contract case variants as one identity", () => {
      const checksum = exactRepresentationKey({
        blockchain: "ethereum",
        type: "token",
        contractAddress: ETHEREUM_USDC_CONTRACT_CHECKSUM,
        mintAddress: null,
      })
      const lower = exactRepresentationKey({
        blockchain: "ethereum",
        type: "token",
        contractAddress: ETHEREUM_USDC_CONTRACT,
        mintAddress: null,
      })

      expect(checksum).toBe(lower)
    })

    it("gives a non-native representation without an address no identity at all", () => {
      const first = exactRepresentationKey({
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: null,
      })
      const second = exactRepresentationKey({
        blockchain: "solana",
        type: "nft",
        contractAddress: null,
        mintAddress: null,
      })

      // Null means "no identity": two malformed rows must not collide into
      // one shared key the way an empty-string key would.
      expect(first).toBeNull()
      expect(second).toBeNull()
    })
  })
})
