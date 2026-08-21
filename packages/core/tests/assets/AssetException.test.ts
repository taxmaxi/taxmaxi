import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AssetExceptionClaim,
  assetExceptionSeverityForReason,
} from "../../src/assets/AssetException.ts"

describe("AssetException", () => {
  it.each([
    ["ownership_conflict", "critical"],
    ["conflicting_evidence", "critical"],
    ["incompatible_decimals", "high"],
    ["incompatible_type", "high"],
    ["display_collision", "medium"],
    ["non_exact_platform_match", "medium"],
    ["spam_evidence", "low"],
    ["unsupported_representation_type", "low"],
  ] as const)("maps %s to %s", (reason, severity) => {
    expect(assetExceptionSeverityForReason(reason)).toBe(severity)
  })

  it("decodes a declarative claim for an existing economic identity", () => {
    const claim = Schema.decodeUnknownSync(AssetExceptionClaim)({
      _tag: "identity",
      assetId: "00000000-0000-4000-8000-000000000001",
      newAsset: null,
      representation: {
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: "Mint111111111111111111111111111111111111111",
        decimals: 6,
      },
    })

    expect(claim._tag).toBe("identity")
  })

  it("rejects free-form exclusion reasons", () => {
    expect(() =>
      Schema.decodeUnknownSync(AssetExceptionClaim)({
        _tag: "exclusion",
        reason: "other",
      })
    ).toThrow()
  })

  it("requires either an existing identity or complete new identity facts", () => {
    expect(() =>
      Schema.decodeUnknownSync(AssetExceptionClaim)({
        _tag: "identity",
        assetId: null,
        newAsset: null,
        representation: null,
      })
    ).toThrow()
  })

  it("rejects token representations without exactly one address", () => {
    expect(() =>
      Schema.decodeUnknownSync(AssetExceptionClaim)({
        _tag: "identity",
        assetId: "00000000-0000-4000-8000-000000000001",
        newAsset: null,
        representation: {
          blockchain: "solana",
          type: "token",
          contractAddress: null,
          mintAddress: null,
          decimals: 6,
        },
      })
    ).toThrow()
  })
})
