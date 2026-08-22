import { describe, expect, it } from "vitest"
import {
  providerTransferOwnsLeg,
  resolveEffectiveAssetOverrideDecision,
} from "../src/layers/AssetOverrideDecision.ts"

describe("AssetOverrideDecision", () => {
  it("applies inclusion after an identity override resolves a policy blocker", () => {
    expect(
      resolveEffectiveAssetOverrideDecision({
        systemAssetId: null,
        systemInclusionState: "blocked",
        technicalBlocker: false,
        identityOverrideAssetId: "asset-1",
        inclusionOverrideState: "included",
      })
    ).toEqual({ assetId: "asset-1", inclusionState: "included" })
  })

  it("keeps technical blockers active", () => {
    expect(
      resolveEffectiveAssetOverrideDecision({
        systemAssetId: null,
        systemInclusionState: "blocked",
        technicalBlocker: true,
        identityOverrideAssetId: "asset-1",
        inclusionOverrideState: "included",
      })
    ).toEqual({ assetId: null, inclusionState: "blocked" })
  })

  it("pairs a Helius provider movement through its canonical transfer", () => {
    expect(
      providerTransferOwnsLeg({
        canonicalTransferExternalId: "signature:principal:0",
        legSourceTransferId: "canonical-transfer-id",
        canonicalTransfers: [{ id: "canonical-transfer-id", externalId: "signature:principal:0" }],
      })
    ).toBe(true)
    expect(
      providerTransferOwnsLeg({
        canonicalTransferExternalId: "signature:fee:1",
        legSourceTransferId: "canonical-transfer-id",
        canonicalTransfers: [{ id: "canonical-transfer-id", externalId: "signature:principal:0" }],
      })
    ).toBe(false)
  })
})
