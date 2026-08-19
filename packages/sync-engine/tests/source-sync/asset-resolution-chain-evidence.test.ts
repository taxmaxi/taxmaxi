import { describe, expect, it } from "vitest"
import { buildChainEvidence } from "../../src/layers/AssetResolutionJobExecutorLive.ts"
import type { ProviderAssetObservedRepresentationRecord } from "@my/sync-engine/services"

const SOLANA_MINT = "OrbTestMint1111111111111111111111111111111"
const EVM_CONTRACT_LOWER = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const EVM_CONTRACT_CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const solanaObservation = (mintAddress: string): ProviderAssetObservedRepresentationRecord => ({
  blockchainName: "solana",
  representationType: "token",
  contractAddress: null,
  mintAddress,
  decimals: 8,
})

const evmObservation = (contractAddress: string): ProviderAssetObservedRepresentationRecord => ({
  blockchainName: "ethereum",
  representationType: "token",
  contractAddress,
  mintAddress: null,
  decimals: 6,
})

describe("buildChainEvidence", () => {
  it("reduces identical observations to one exact fact", () => {
    const result = buildChainEvidence([
      solanaObservation(SOLANA_MINT),
      solanaObservation(SOLANA_MINT),
    ])

    expect(result.fact).toMatchObject({ mintAddress: SOLANA_MINT, decimals: 8 })
    expect(result.evidence._tag).toBe("payload")
  })

  it("fails closed when two mint addresses differ only in case on a case-sensitive chain", () => {
    const result = buildChainEvidence([
      solanaObservation(SOLANA_MINT),
      solanaObservation(SOLANA_MINT.toLowerCase()),
    ])

    // Solana mint case is significant: these are two different identities,
    // so the evidence must conflict instead of silently keeping one of them.
    expect(result.fact).toBeNull()
    expect(result.evidence._tag).toBe("conflicting_evidence")
  })

  it("merges EVM contract case variants into one fact", () => {
    const result = buildChainEvidence([
      evmObservation(EVM_CONTRACT_CHECKSUM),
      evmObservation(EVM_CONTRACT_LOWER),
    ])

    expect(result.fact).toMatchObject({ decimals: 6 })
    expect(result.evidence._tag).toBe("payload")
  })

  it("fails closed when there is no usable observation", () => {
    const result = buildChainEvidence([])

    expect(result.fact).toBeNull()
    expect(result.evidence._tag).toBe("malformed_payload")
  })
})
