import { describe, expect, it } from "vitest"
import { nextProviderAssetSelection } from "./provider-asset-review"

describe("provider asset review progression", () => {
  it("selects the row that moves into the reviewed row's position", () => {
    expect(
      nextProviderAssetSelection({
        reviewedId: "asset-b",
        rowIds: ["asset-a", "asset-b", "asset-c"],
      })
    ).toEqual({ remainingIds: ["asset-a", "asset-c"], selectedId: "asset-c" })
  })

  it("falls back to the previous row at the end of the queue", () => {
    expect(
      nextProviderAssetSelection({
        reviewedId: "asset-c",
        rowIds: ["asset-a", "asset-b", "asset-c"],
      })
    ).toEqual({ remainingIds: ["asset-a", "asset-b"], selectedId: "asset-b" })
  })
})
