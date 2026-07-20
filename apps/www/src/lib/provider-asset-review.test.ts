import { describe, expect, it } from "vitest"
import {
  appendUniqueProviderAssetReviews,
  mergeProviderAssetReplayUpdates,
  nextProviderAssetSelection,
  providerAssetReviewFilterKey,
} from "./provider-asset-review"

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

  it("preserves failed replay entries while active jobs are refreshed", () => {
    expect(
      mergeProviderAssetReplayUpdates({
        current: [
          { sourceId: "failed", status: "failed_to_queue" },
          { sourceId: "active", status: "queued" },
        ],
        updates: [{ sourceId: "active", status: "completed" }],
      })
    ).toEqual([
      { sourceId: "failed", status: "failed_to_queue" },
      { sourceId: "active", status: "completed" },
    ])
  })

  it("does not append duplicate review rows from a repeated cursor request", () => {
    expect(
      appendUniqueProviderAssetReviews({
        current: [{ id: "asset-a" }, { id: "asset-b" }],
        incoming: [{ id: "asset-b" }, { id: "asset-c" }],
      })
    ).toEqual([{ id: "asset-a" }, { id: "asset-b" }, { id: "asset-c" }])
  })

  it("changes the page request key when any review filter changes", () => {
    const current = providerAssetReviewFilterKey({
      provider: "coinbase",
      query: "BTC",
      status: "pending_review",
    })

    expect(
      providerAssetReviewFilterKey({
        provider: "helius-solana",
        query: "BTC",
        status: "pending_review",
      })
    ).not.toBe(current)
    expect(
      providerAssetReviewFilterKey({
        provider: "coinbase",
        query: "ETH",
        status: "pending_review",
      })
    ).not.toBe(current)
    expect(
      providerAssetReviewFilterKey({ provider: "coinbase", query: "BTC", status: "approved" })
    ).not.toBe(current)
  })
})
