import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { SOLANA_USDC_MINT } from "../../src/assets/AssetReferenceCatalog.ts"
import {
  ASSET_RESOLUTION_POLICY_REVISION,
  AssetLegitimacyClaim,
  AssetResolutionConflictingEvidence,
  AssetResolutionMalformedPayload,
  AssetResolutionUpstreamFailure,
  canonicalizeAddress,
  canonicalizeDisplayText,
  ChainClaim,
  CoinGeckoClaim,
  RegistryLookupNotFound,
  RegistryLookupSkipped,
  CoinGeckoPlatformMapping,
  decideAssetResolution,
  decodeChainClaim,
  decodeCoinGeckoClaim,
  decodeJupiterLegitimacyClaim,
  evaluateAssetResolution,
  exactRepresentationKey,
  JUPITER_AUTHORITY,
  type AssetResolutionIdentitySnapshot,
  type ChainResolutionInput,
  type LegitimacyResolutionInput,
  type ProviderDisplayMetadata,
  type RegistryResolutionInput,
} from "../../src/assets/AssetResolutionPolicy.ts"

const ETHEREUM_USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const ETHEREUM_USDC_CONTRACT_CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const LONG_TAIL_MINT = "orbMint1111111111111111111111111111111111111"

const emptyIdentity = (): AssetResolutionIdentitySnapshot => ({
  registryOwner: null,
  displayCandidates: [],
  representations: [],
})

const usdcIdentity = (): AssetResolutionIdentitySnapshot => ({
  registryOwner: {
    assetKey: "usdc",
    coingeckoCoinId: "usd-coin",
    type: "fungible",
  },
  displayCandidates: [],
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

const longTailChainFact = {
  blockchain: "solana",
  type: "token",
  contractAddress: null,
  mintAddress: LONG_TAIL_MINT,
  decimals: 9,
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

const longTailChainClaim = (
  overrides: Partial<{ readonly type: "token" | "nft"; readonly decimals: number }> = {}
) => ChainClaim.make({ ...longTailChainFact, ...overrides })

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

const longTailCoinGeckoClaim = (overrides: { readonly decimals?: number | null } = {}) =>
  CoinGeckoClaim.make({
    coinId: "orb-token",
    name: "Orb Token",
    symbol: "orb",
    platforms: [
      CoinGeckoPlatformMapping.make({
        platformId: "solana",
        contractAddress: LONG_TAIL_MINT,
        decimals: overrides.decimals === undefined ? 9 : overrides.decimals,
      }),
    ],
  })

const providerDisplay: ProviderDisplayMetadata = { name: "Orb Token", symbol: "ORB" }

const decodeFailureTag = (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const result = Effect.runSync(Effect.result(effect))
  expect(result._tag).toBe("Failure")
  return result._tag === "Failure" ? result.failure._tag : "Success"
}

const decide = ({
  chain,
  registry = new RegistryLookupNotFound(),
  identity = emptyIdentity(),
  legitimacy = [],
  display = providerDisplay,
}: {
  readonly chain: ChainResolutionInput
  readonly registry?: RegistryResolutionInput
  readonly identity?: AssetResolutionIdentitySnapshot
  readonly legitimacy?: ReadonlyArray<LegitimacyResolutionInput>
  readonly display?: ProviderDisplayMetadata
}) =>
  decideAssetResolution({
    chain,
    registry,
    identity,
    legitimacy,
    providerDisplay: display,
  })

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

  describe("decodeJupiterLegitimacyClaim", () => {
    const jupiterToken = (overrides: Record<string, unknown> = {}) => ({
      id: LONG_TAIL_MINT,
      name: "Orb Token",
      symbol: "ORB",
      decimals: 9,
      holderCount: 42,
      ...overrides,
    })

    const decodeVerdict = (payload: unknown) =>
      Effect.runSync(decodeJupiterLegitimacyClaim({ payload, mintAddress: LONG_TAIL_MINT }))

    it("maps a banned tag to a banned verdict even alongside other tags", () => {
      const claim = decodeVerdict([jupiterToken({ tags: ["unknown", "banned"], isVerified: true })])

      expect(claim).toMatchObject({
        _tag: "legitimacy_claim",
        authority: JUPITER_AUTHORITY,
        verdict: "banned",
      })
    })

    it("maps verification, suspicion, low activity, and their absence to typed verdicts", () => {
      const verified = decodeVerdict([jupiterToken({ isVerified: true, tags: ["verified"] })])
      const suspicious = decodeVerdict([jupiterToken({ audit: { isSus: true } })])
      const lowActivity = decodeVerdict([
        jupiterToken({ isVerified: true, organicScoreLabel: "low" }),
      ])
      const unverified = decodeVerdict([jupiterToken({})])

      expect(verified).toMatchObject({ _tag: "legitimacy_claim", verdict: "verified" })
      expect(suspicious).toMatchObject({ _tag: "legitimacy_claim", verdict: "suspicious" })
      expect(lowActivity).toMatchObject({ _tag: "legitimacy_claim", verdict: "low_activity" })
      expect(unverified).toMatchObject({ _tag: "legitimacy_claim", verdict: "unverified" })
    })

    it("gives a suspicious audit flag priority over verification", () => {
      const claim = decodeVerdict([
        jupiterToken({ isVerified: true, audit: { isSus: true }, tags: ["verified"] }),
      ])

      expect(claim).toMatchObject({
        _tag: "legitimacy_claim",
        authority: JUPITER_AUTHORITY,
        verdict: "suspicious",
      })
    })

    it("treats a response without the exact mint as a definitive not-indexed answer", () => {
      const empty = decodeVerdict([])
      const otherMint = decodeVerdict([jupiterToken({ id: SOLANA_USDC_MINT })])

      expect(empty).toMatchObject({ _tag: "registry_not_found" })
      expect(otherMint).toMatchObject({ _tag: "registry_not_found" })
    })

    it("fails closed for malformed or changed Jupiter payloads", () => {
      expect(
        decodeFailureTag(
          decodeJupiterLegitimacyClaim({
            payload: { tokens: [] },
            mintAddress: LONG_TAIL_MINT,
          })
        )
      ).toBe("malformed_payload")
      expect(
        decodeFailureTag(
          decodeJupiterLegitimacyClaim({
            payload: [jupiterToken({ id: 5 })],
            mintAddress: LONG_TAIL_MINT,
          })
        )
      ).toBe("malformed_payload")
      expect(
        decodeFailureTag(
          decodeJupiterLegitimacyClaim({
            payload: [jupiterToken({ tags: [7] })],
            mintAddress: LONG_TAIL_MINT,
          })
        )
      ).toBe("malformed_payload")
    })
  })

  describe("decideAssetResolution attach", () => {
    it("attaches a new exact representation when the registry coin id belongs to an existing asset", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "attach",
        policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
        assetKey: "usdc",
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: SOLANA_USDC_MINT,
        decimals: 6,
      })
    })

    it("attaches to the local owner of the exact representation without registry evidence", () => {
      const decision = decide({
        chain: ChainClaim.make({
          ...ethereumUsdcChainFact,
          contractAddress: ETHEREUM_USDC_CONTRACT,
        }),
        registry: new RegistryLookupNotFound(),
        identity: usdcIdentity(),
      })

      expect(decision).toMatchObject({
        _tag: "attach",
        assetKey: "usdc",
        blockchain: "ethereum",
        contractAddress: ETHEREUM_USDC_CONTRACT,
      })
    })

    it("attaches through deterministic registry linkage even when display candidates collide", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: usdcCoinGeckoClaim(),
        identity: {
          ...usdcIdentity(),
          displayCandidates: [
            { assetKey: "usdc", coingeckoCoinId: "usd-coin", type: "fungible" },
            { assetKey: "usdc-lookalike", coingeckoCoinId: null, type: "fungible" },
          ],
        },
      })

      expect(decision).toMatchObject({ _tag: "attach", assetKey: "usdc" })
    })

    it("stays pending without a ban when the matching registry platform has no decimals", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: CoinGeckoClaim.make({
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
        identity: { ...usdcIdentity(), representations: [] },
      })

      expect(decision).toMatchObject({
        _tag: "pending",
        reason: "non_exact_platform_match",
      })
    })

    it("excludes a banned observation when matching registry evidence has no decimals", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: CoinGeckoClaim.make({
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
        identity: { ...usdcIdentity(), representations: [] },
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })],
      })

      expect(decision).toMatchObject({
        _tag: "excluded",
        reason: "authority_banned",
      })
    })

    it("lets a ban win when registry evidence cannot produce an exact attach", () => {
      const bannedClaim = AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })
      const missingPlatform = decide({
        chain: longTailChainClaim(),
        registry: CoinGeckoClaim.make({
          coinId: "orb-token",
          name: "Orb Token",
          symbol: "orb",
          platforms: [
            CoinGeckoPlatformMapping.make({
              platformId: "ethereum",
              contractAddress: ETHEREUM_USDC_CONTRACT,
              decimals: 9,
            }),
          ],
        }),
        legitimacy: [bannedClaim],
      })
      const unownedDecimalConflict = decide({
        chain: longTailChainClaim(),
        registry: longTailCoinGeckoClaim({ decimals: 6 }),
        legitimacy: [bannedClaim],
      })
      const ownedDecimalConflict = decide({
        chain: ChainClaim.make({ ...solanaUsdcChainFact, decimals: 8 }),
        registry: usdcCoinGeckoClaim(),
        identity: { ...usdcIdentity(), representations: [] },
        legitimacy: [bannedClaim],
      })
      const ownedTypeConflict = decide({
        chain: ChainClaim.make({ ...solanaUsdcChainFact, type: "nft" }),
        registry: usdcCoinGeckoClaim(),
        identity: { ...usdcIdentity(), representations: [] },
        legitimacy: [bannedClaim],
      })

      for (const decision of [
        missingPlatform,
        unownedDecimalConflict,
        ownedDecimalConflict,
        ownedTypeConflict,
      ]) {
        expect(decision).toMatchObject({
          _tag: "excluded",
          reason: "authority_banned",
        })
      }
    })

    it("fails closed for incompatible decimals or type against the registry owner", () => {
      const incompatibleDecimals = decide({
        chain: ChainClaim.make({ ...solanaUsdcChainFact, decimals: 8 }),
        registry: usdcCoinGeckoClaim(),
        identity: { ...usdcIdentity(), representations: [] },
      })
      const incompatibleType = decide({
        chain: ChainClaim.make({ ...solanaUsdcChainFact, type: "nft" }),
        registry: usdcCoinGeckoClaim(),
        identity: { ...usdcIdentity(), representations: [] },
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

    it("fails closed when the owned representation disagrees with the chain claim", () => {
      const incompatibleDecimals = decide({
        chain: ChainClaim.make({
          ...ethereumUsdcChainFact,
          contractAddress: ETHEREUM_USDC_CONTRACT,
          decimals: 8,
        }),
        identity: usdcIdentity(),
      })

      expect(incompatibleDecimals).toMatchObject({
        _tag: "fail_closed",
        reason: "incompatible_decimals",
      })
    })

    it("fails closed when the registry names a different owner than the representation", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: usdcCoinGeckoClaim(),
        identity: {
          registryOwner: usdcIdentity().registryOwner,
          displayCandidates: [],
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

    it("fails closed when the looked-up coin does not list the exact representation", () => {
      const decision = decide({
        chain: solanaUsdcChainClaim(),
        registry: CoinGeckoClaim.make({
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
        identity: { ...usdcIdentity(), representations: [] },
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "conflicting_evidence",
      })
    })
  })

  describe("decideAssetResolution create_standalone", () => {
    it("creates a standalone asset for an exact unknown representation with no candidates", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        registry: new RegistryLookupNotFound(),
      })

      expect(decision).toMatchObject({
        _tag: "create_standalone",
        policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: LONG_TAIL_MINT,
        decimals: 9,
        coingeckoCoinId: null,
        name: "Orb Token",
        symbol: "ORB",
      })
    })

    it("creates without a coin id when the registry lookup was skipped", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        registry: new RegistryLookupSkipped(),
      })

      expect(decision).toMatchObject({
        _tag: "create_standalone",
        coingeckoCoinId: null,
        name: "Orb Token",
        symbol: "ORB",
      })
    })

    it("stamps the registry coin id when the registry knows the mint but no local asset owns it", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        registry: longTailCoinGeckoClaim(),
      })

      expect(decision).toMatchObject({
        _tag: "create_standalone",
        coingeckoCoinId: "orb-token",
        name: "Orb Token",
        symbol: "orb",
      })
    })

    it("creates when the registry platform lacks decimals but fails closed when they conflict", () => {
      const missingDecimals = decide({
        chain: longTailChainClaim(),
        registry: longTailCoinGeckoClaim({ decimals: null }),
      })
      const conflictingDecimals = decide({
        chain: longTailChainClaim(),
        registry: longTailCoinGeckoClaim({ decimals: 6 }),
      })

      expect(missingDecimals).toMatchObject({
        _tag: "create_standalone",
        coingeckoCoinId: "orb-token",
        decimals: 9,
      })
      expect(conflictingDecimals).toMatchObject({
        _tag: "fail_closed",
        reason: "incompatible_decimals",
      })
    })

    it("falls back to the provider symbol when no display name exists anywhere", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        display: { name: null, symbol: "ORB" },
      })

      expect(decision).toMatchObject({
        _tag: "create_standalone",
        name: "ORB",
        symbol: "ORB",
      })
    })

    it("stays pending when a display name or symbol collides with an existing asset", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        identity: {
          registryOwner: null,
          displayCandidates: [{ assetKey: "orb", coingeckoCoinId: null, type: "fungible" }],
          representations: [],
        },
      })

      expect(decision).toMatchObject({
        _tag: "pending",
        reason: "display_collision",
      })
    })

    it("stays pending for unsupported representation types", () => {
      const nft = decide({
        chain: longTailChainClaim({ type: "nft", decimals: 0 }),
      })
      const native = decide({
        chain: ChainClaim.make(ethNativeChainFact),
      })

      expect(nft).toMatchObject({
        _tag: "pending",
        reason: "unsupported_representation_type",
      })
      expect(native).toMatchObject({
        _tag: "pending",
        reason: "unsupported_representation_type",
      })
    })

    it("excludes on an explicit banned verdict with a final typed reason", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })],
      })

      expect(decision).toMatchObject({
        _tag: "excluded",
        reason: "authority_banned",
      })
    })

    it("banned wins over weaker creation blockers such as display collisions", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        identity: {
          registryOwner: null,
          displayCandidates: [{ assetKey: "orb", coingeckoCoinId: null, type: "fungible" }],
          representations: [],
        },
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })],
      })

      expect(decision).toMatchObject({
        _tag: "excluded",
        reason: "authority_banned",
      })
    })

    it("banned wins over unrelated registry failures when no exact attach evidence exists", () => {
      const bannedClaim = AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })
      const malformedRegistry = decide({
        chain: longTailChainClaim(),
        registry: new AssetResolutionMalformedPayload({ source: "coingecko" }),
        legitimacy: [bannedClaim],
      })
      const upstreamRegistry = decide({
        chain: longTailChainClaim(),
        registry: new AssetResolutionUpstreamFailure({ source: "coingecko" }),
        legitimacy: [bannedClaim],
      })

      expect(malformedRegistry).toMatchObject({
        _tag: "excluded",
        reason: "authority_banned",
      })
      expect(upstreamRegistry).toMatchObject({
        _tag: "excluded",
        reason: "authority_banned",
      })
    })

    it("pauses on suspicious signals but creates for non-decisive legitimacy signals", () => {
      const suspicious = decide({
        chain: longTailChainClaim(),
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "suspicious" })],
      })
      const unverified = decide({
        chain: longTailChainClaim(),
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "unverified" })],
      })
      const lowActivity = decide({
        chain: longTailChainClaim(),
        legitimacy: [AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "low_activity" })],
      })

      expect(suspicious).toMatchObject({
        _tag: "pending",
        reason: "spam_evidence",
      })
      expect(unverified).toMatchObject({ _tag: "create_standalone" })
      expect(lowActivity).toMatchObject({ _tag: "create_standalone" })
    })

    it("fails closed when banned evidence conflicts with exact attach evidence", () => {
      const bannedClaim = AssetLegitimacyClaim.make({ authority: "jupiter", verdict: "banned" })
      const registryAttach = decide({
        chain: solanaUsdcChainClaim(),
        registry: usdcCoinGeckoClaim(),
        identity: usdcIdentity(),
        legitimacy: [bannedClaim],
      })
      const ownedAttach = decide({
        chain: ChainClaim.make(ethereumUsdcChainFact),
        identity: usdcIdentity(),
        legitimacy: [bannedClaim],
      })

      expect(registryAttach).toMatchObject({
        _tag: "fail_closed",
        reason: "conflicting_evidence",
      })
      expect(ownedAttach).toMatchObject({
        _tag: "fail_closed",
        reason: "conflicting_evidence",
      })
    })

    it("fails closed when legitimacy evidence itself failed", () => {
      const malformed = decide({
        chain: longTailChainClaim(),
        legitimacy: [new AssetResolutionMalformedPayload({ source: "jupiter" })],
      })
      const upstream = decide({
        chain: longTailChainClaim(),
        legitimacy: [new AssetResolutionUpstreamFailure({ source: "jupiter" })],
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

    it("fails closed when no usable display metadata exists", () => {
      const decision = decide({
        chain: longTailChainClaim(),
        display: { name: null, symbol: "   " },
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "malformed_payload",
      })
    })
  })

  describe("decideAssetResolution evidence failures", () => {
    it("fails closed for malformed payloads and upstream failures", () => {
      const malformedRegistry = decide({
        chain: solanaUsdcChainClaim(),
        registry: new AssetResolutionMalformedPayload({ source: "coingecko" }),
      })
      const upstreamChain = decide({
        chain: new AssetResolutionUpstreamFailure({ source: "chain" }),
        registry: usdcCoinGeckoClaim(),
      })

      expect(malformedRegistry).toMatchObject({
        _tag: "fail_closed",
        reason: "malformed_payload",
      })
      expect(upstreamChain).toMatchObject({
        _tag: "fail_closed",
        reason: "upstream_failure",
      })
    })

    it("fails closed for conflicting evidence and names the conflict", () => {
      const decision = decide({
        chain: new AssetResolutionConflictingEvidence({ source: "chain" }),
        registry: usdcCoinGeckoClaim(),
      })

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "conflicting_evidence",
      })
    })
  })

  describe("evaluateAssetResolution", () => {
    it("attaches from decoded chain and registry payloads", () => {
      const decision = Effect.runSync(
        evaluateAssetResolution({
          chain: { _tag: "payload", payload: solanaUsdcChainFact },
          registry: { _tag: "payload", payload: usdcCoinPayload },
          identity: { ...usdcIdentity(), representations: [] },
          legitimacy: [],
          providerDisplay: { name: "USDC", symbol: "USDC" },
        })
      )

      expect(decision).toMatchObject({
        _tag: "attach",
        assetKey: "usdc",
        blockchain: "solana",
        mintAddress: SOLANA_USDC_MINT,
        decimals: 6,
      })
    })

    it("creates from a decoded chain payload and a definitive registry miss", () => {
      const decision = Effect.runSync(
        evaluateAssetResolution({
          chain: { _tag: "payload", payload: longTailChainFact },
          registry: new RegistryLookupNotFound(),
          identity: emptyIdentity(),
          legitimacy: [],
          providerDisplay: providerDisplay,
        })
      )

      expect(decision).toMatchObject({
        _tag: "create_standalone",
        mintAddress: LONG_TAIL_MINT,
        coingeckoCoinId: null,
      })
    })

    it("fails closed for malformed payloads and does not attach or create", () => {
      const decision = Effect.runSync(
        evaluateAssetResolution({
          chain: { _tag: "payload", payload: solanaUsdcChainFact },
          registry: { _tag: "payload", payload: { id: "usd-coin" } },
          identity: emptyIdentity(),
          legitimacy: [],
          providerDisplay: providerDisplay,
        })
      )

      expect(decision).toMatchObject({
        _tag: "fail_closed",
        reason: "malformed_payload",
      })
    })

    it("fails closed for upstream failures and does not attach or create", () => {
      const decision = Effect.runSync(
        evaluateAssetResolution({
          chain: { _tag: "payload", payload: solanaUsdcChainFact },
          registry: new AssetResolutionUpstreamFailure({ source: "coingecko" }),
          identity: emptyIdentity(),
          legitimacy: [],
          providerDisplay: providerDisplay,
        })
      )

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

  describe("canonicalizeDisplayText", () => {
    it("case-folds and trims display values", () => {
      expect(canonicalizeDisplayText("  USD Coin ")).toBe("usd coin")
    })

    it("collapses unicode lookalike forms through NFKC", () => {
      // Fullwidth "USDC" normalizes to plain "usdc".
      expect(canonicalizeDisplayText("ＵＳＤＣ")).toBe("usdc")
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
