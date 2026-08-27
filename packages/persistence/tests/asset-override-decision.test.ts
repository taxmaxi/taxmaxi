import { describe, expect, it } from "vitest"
import {
  providerTransferOwnsLeg,
  resolveEffectiveAssetOverrideDecision,
} from "../src/layers/AssetOverrideDecision.ts"
import { resolveAssetOverrideApplicationReadiness } from "../src/layers/AssetOverrideApplicationReadiness.ts"

describe("AssetOverrideDecision", () => {
  it.each([
    {
      name: "keeps a resolved included asset included",
      input: {
        systemAssetId: "asset-1",
        systemInclusionState: "included" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: null,
      },
      expected: { assetId: "asset-1", inclusionState: "included" },
    },
    {
      name: "keeps a final exclusion omitted",
      input: {
        systemAssetId: "asset-1",
        systemInclusionState: "excluded" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: null,
      },
      expected: { assetId: null, inclusionState: "excluded" },
    },
    {
      name: "keeps an unresolved identity blocked",
      input: {
        systemAssetId: null,
        systemInclusionState: "blocked" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: null,
      },
      expected: { assetId: null, inclusionState: "blocked" },
    },
    {
      name: "lets an identity override resolve an identity-only blocker",
      input: {
        systemAssetId: null,
        systemInclusionState: "blocked" as const,
        technicalBlocker: false,
        identityOverrideAssetId: "asset-1",
        inclusionOverrideState: null,
      },
      expected: { assetId: "asset-1", inclusionState: "included" },
    },
    {
      name: "lets an inclusion override restore a retained identity",
      input: {
        systemAssetId: "asset-1",
        systemInclusionState: "excluded" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: "included" as const,
      },
      expected: { assetId: "asset-1", inclusionState: "included" },
    },
    {
      name: "lets an inclusion override omit an included asset",
      input: {
        systemAssetId: "asset-1",
        systemInclusionState: "included" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: "excluded" as const,
      },
      expected: { assetId: null, inclusionState: "excluded" },
    },
    {
      name: "keeps technical blockers active",
      input: {
        systemAssetId: "asset-1",
        systemInclusionState: "blocked" as const,
        technicalBlocker: true,
        identityOverrideAssetId: "asset-2",
        inclusionOverrideState: "included" as const,
      },
      expected: { assetId: null, inclusionState: "blocked" },
    },
    {
      name: "blocks an included choice without an identity",
      input: {
        systemAssetId: null,
        systemInclusionState: "excluded" as const,
        technicalBlocker: false,
        identityOverrideAssetId: null,
        inclusionOverrideState: "included" as const,
      },
      expected: { assetId: null, inclusionState: "blocked" },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveEffectiveAssetOverrideDecision(input)).toEqual(expected)
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

  it("keeps an owner pending through its transitive replay closure", () => {
    expect(
      resolveAssetOverrideApplicationReadiness({
        rootSourceIds: ["source-a"],
        rows: [
          {
            overrideId: "override-1",
            sourceId: "source-a",
            replayJobId: "job-a",
            dependsOnSourceIds: [],
            jobStatus: "completed",
            failedRecords: 0,
          },
          {
            overrideId: "override-1",
            sourceId: "source-b",
            replayJobId: "job-b",
            dependsOnSourceIds: ["source-a"],
            jobStatus: "completed",
            failedRecords: 0,
          },
          {
            overrideId: "override-1",
            sourceId: "source-c",
            replayJobId: "job-c",
            dependsOnSourceIds: ["source-b"],
            jobStatus: "processing",
            failedRecords: 0,
          },
        ],
      })
    ).toBe("updating")
  })

  it("reports a failed or partially failed dependent replay", () => {
    for (const dependent of [
      { jobStatus: "failed" as const, failedRecords: 0 },
      { jobStatus: "completed" as const, failedRecords: 1 },
    ]) {
      expect(
        resolveAssetOverrideApplicationReadiness({
          rootSourceIds: ["source-a"],
          rows: [
            {
              overrideId: "override-1",
              sourceId: "source-a",
              replayJobId: "job-a",
              dependsOnSourceIds: [],
              jobStatus: "completed",
              failedRecords: 0,
            },
            {
              overrideId: "override-1",
              sourceId: "source-b",
              replayJobId: "job-b-repointed",
              dependsOnSourceIds: ["source-a"],
              ...dependent,
            },
          ],
        })
      ).toBe("failed")
    }
  })

  it("does not block an owner on an unrelated sibling application", () => {
    expect(
      resolveAssetOverrideApplicationReadiness({
        rootSourceIds: ["source-a"],
        rows: [
          {
            overrideId: "override-1",
            sourceId: "source-a",
            replayJobId: "job-a",
            dependsOnSourceIds: [],
            jobStatus: "completed",
            failedRecords: 0,
          },
          {
            overrideId: "override-1",
            sourceId: "source-sibling",
            replayJobId: "job-sibling",
            dependsOnSourceIds: [],
            jobStatus: "pending",
            failedRecords: 0,
          },
        ],
      })
    ).toBe("complete")
  })
})
