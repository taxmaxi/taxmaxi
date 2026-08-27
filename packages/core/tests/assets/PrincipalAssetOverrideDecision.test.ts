import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  decidePrincipalAssetOverride,
  PrincipalAssetEffectiveDecision,
  PrincipalAssetOverrideTarget,
} from "../../src/assets/PrincipalAssetOverrideDecision.ts"

const BTC_ASSET_ID = "11111111-1111-4111-8111-111111111111"

describe("decidePrincipalAssetOverride", () => {
  it("accepts exact representation and provider-asset fallback targets", () => {
    const isTarget = Schema.is(PrincipalAssetOverrideTarget)

    expect(
      isTarget({
        _tag: "representation",
        blockchain: "base",
        type: "token",
        contractAddress: "0x1111111111111111111111111111111111111111",
        mintAddress: null,
      })
    ).toBe(true)
    expect(
      isTarget({
        _tag: "representation",
        blockchain: "bitcoin",
        type: "native",
        contractAddress: null,
        mintAddress: null,
      })
    ).toBe(true)
    expect(
      isTarget({
        _tag: "provider_asset",
        providerAssetRowId: "22222222-2222-4222-8222-222222222222",
      })
    ).toBe(true)
  })

  it("rejects representation targets whose address shape conflicts with their type", () => {
    const isTarget = Schema.is(PrincipalAssetOverrideTarget)

    expect(
      isTarget({
        _tag: "representation",
        blockchain: "base",
        type: "native",
        contractAddress: "0x1111111111111111111111111111111111111111",
        mintAddress: null,
      })
    ).toBe(false)
    expect(
      isTarget({
        _tag: "representation",
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: null,
      })
    ).toBe(false)
  })

  it("rejects blocked decisions whose reason conflicts with their blockers", () => {
    const isDecision = Schema.is(PrincipalAssetEffectiveDecision)

    expect(
      isDecision({
        _tag: "blocked",
        identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
        reason: "technical_blocker",
        technicalBlockers: [],
      })
    ).toBe(false)
    expect(
      isDecision({
        _tag: "blocked",
        identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
        reason: "unresolved_identity",
        technicalBlockers: ["missing_decimals"],
      })
    ).toBe(false)
  })

  it("includes a resolved asset that TaxMaxi includes", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "included",
      identityReplacement: null,
      inclusionReplacement: null,
      technicalBlockers: [],
    })

    expect(decision).toEqual({ _tag: "included", assetId: BTC_ASSET_ID })
  })

  it("keeps a TaxMaxi-excluded asset out of accounting", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "excluded",
      identityReplacement: null,
      inclusionReplacement: null,
      technicalBlockers: [],
    })

    expect(decision).toEqual({
      _tag: "excluded",
      identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
    })
  })

  it("blocks an included asset whose economic identity is unresolved", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "unresolved" },
      systemInclusion: "included",
      identityReplacement: null,
      inclusionReplacement: null,
      technicalBlockers: [],
    })

    expect(decision).toEqual({
      _tag: "blocked",
      identity: { _tag: "unresolved" },
      reason: "unresolved_identity",
      technicalBlockers: [],
    })
  })

  it("keeps technical blockers even when identity and inclusion are settled", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "included",
      identityReplacement: null,
      inclusionReplacement: null,
      technicalBlockers: ["missing_decimals", "malformed_movement"],
    })

    expect(decision).toEqual({
      _tag: "blocked",
      identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      reason: "technical_blocker",
      technicalBlockers: ["missing_decimals", "malformed_movement"],
    })
  })

  it("uses an identity replacement for an unresolved included asset", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "unresolved" },
      systemInclusion: "included",
      identityReplacement: { _tag: "resolved", assetId: BTC_ASSET_ID },
      inclusionReplacement: null,
      technicalBlockers: [],
    })

    expect(decision).toEqual({ _tag: "included", assetId: BTC_ASSET_ID })
  })

  it("uses an inclusion replacement to include a policy-excluded asset", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "excluded",
      identityReplacement: null,
      inclusionReplacement: "included",
      technicalBlockers: [],
    })

    expect(decision).toEqual({ _tag: "included", assetId: BTC_ASSET_ID })
  })

  it("uses an exclusion replacement before checking technical blockers", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "included",
      identityReplacement: null,
      inclusionReplacement: "excluded",
      technicalBlockers: ["unsupported_asset_type"],
    })

    expect(decision).toEqual({
      _tag: "excluded",
      identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
    })
  })

  it("does not let an inclusion replacement bypass a technical blocker", () => {
    const decision = decidePrincipalAssetOverride({
      systemIdentity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      systemInclusion: "excluded",
      identityReplacement: null,
      inclusionReplacement: "included",
      technicalBlockers: ["missing_decimals"],
    })

    expect(decision).toEqual({
      _tag: "blocked",
      identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
      reason: "technical_blocker",
      technicalBlockers: ["missing_decimals"],
    })
  })

  it("combines identity and inclusion replacements independently", () => {
    const input = {
      systemIdentity: { _tag: "unresolved" },
      systemInclusion: "excluded",
      technicalBlockers: [],
    } as const

    expect(
      decidePrincipalAssetOverride({
        ...input,
        identityReplacement: { _tag: "resolved", assetId: BTC_ASSET_ID },
        inclusionReplacement: null,
      })
    ).toEqual({
      _tag: "excluded",
      identity: { _tag: "resolved", assetId: BTC_ASSET_ID },
    })
    expect(
      decidePrincipalAssetOverride({
        ...input,
        identityReplacement: null,
        inclusionReplacement: "included",
      })
    ).toEqual({
      _tag: "blocked",
      identity: { _tag: "unresolved" },
      reason: "unresolved_identity",
      technicalBlockers: [],
    })
    expect(
      decidePrincipalAssetOverride({
        ...input,
        identityReplacement: { _tag: "resolved", assetId: BTC_ASSET_ID },
        inclusionReplacement: "included",
      })
    ).toEqual({ _tag: "included", assetId: BTC_ASSET_ID })
  })
})
