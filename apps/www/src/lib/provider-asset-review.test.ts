import { describe, expect, it } from "vitest"
import {
  appendUniqueProviderAssetReviews,
  formatProviderAssetReviewDate,
  isCurrentExistingAssetSearchRequest,
  loadSettledProviderAssetReplayUpdates,
  mergeProviderAssetReplayUpdates,
  nextProviderAssetSelection,
  providerAssetReviewFilterKey,
  providerAssetReviewLoaderDeps,
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
          { sourceId: "active", status: "queued", jobId: "active-sync" },
        ],
        updates: [{ sourceId: "active", status: "queued", jobId: "deferred-replay" }],
      })
    ).toEqual([
      { sourceId: "failed", status: "failed_to_queue" },
      { sourceId: "active", status: "queued", jobId: "deferred-replay" },
    ])
  })

  it("preserves successful replay updates when another replay poll fails", async () => {
    const updates = await loadSettledProviderAssetReplayUpdates({
      replays: [{ sourceId: "healthy" }, { sourceId: "unavailable" }],
      load: ({ sourceId }) =>
        sourceId === "healthy"
          ? Promise.resolve({ sourceId, status: "completed" })
          : Promise.reject(new Error("Replay status unavailable")),
    })

    expect(updates).toEqual([{ sourceId: "healthy", status: "completed" }])
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

  it("does not reload review rows when only the selected asset changes", () => {
    const filters = {
      cursor: "00000000-0000-0000-0000-000000000001",
      provider: "coinbase",
      q: "ZEC",
      status: "pending_review" as const,
    }

    expect(providerAssetReviewLoaderDeps({ ...filters, asset: "asset-a" })).toEqual(
      providerAssetReviewLoaderDeps({ ...filters, asset: "asset-b" })
    )
  })

  it("discards existing-asset results from an old query", () => {
    expect(
      isCurrentExistingAssetSearchRequest({ currentQuery: "ether", requestQuery: "bitcoin" })
    ).toBe(false)
    expect(
      isCurrentExistingAssetSearchRequest({ currentQuery: "bitcoin", requestQuery: "bitcoin" })
    ).toBe(true)
  })

  it("formats review timestamps in UTC for stable server hydration", () => {
    expect(formatProviderAssetReviewDate({ epochMillis: Date.UTC(2026, 6, 20, 12, 30) })).toBe(
      "Jul 20, 2026, 12:30 PM"
    )
  })
})
