// @vitest-environment jsdom

import { createMemoryHistory } from "@tanstack/react-router"
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ASSET_CATALOG_SEARCH_DEBOUNCE_MS,
  closeAssetCatalog,
  loadAssetCatalogFeeds,
  useDebouncedCatalogQuery,
} from "./index"

afterEach(() => {
  vi.useRealTimers()
})

describe("useDebouncedCatalogQuery", () => {
  it("publishes only the last query after the idle window", async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ query }: { readonly query: string }) => useDebouncedCatalogQuery(query),
      { initialProps: { query: "" } }
    )

    rerender({ query: "bit" })
    rerender({ query: "bitcoin" })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ASSET_CATALOG_SEARCH_DEBOUNCE_MS - 1)
    })
    expect(result.current).toBe("")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current).toBe("bitcoin")
  })
})

describe("loadAssetCatalogFeeds", () => {
  it.each(["approved", "pending"] as const)(
    "keeps the catalog loader successful when the %s feed fails",
    async (failedFeed) => {
      const loadApproved =
        failedFeed === "approved"
          ? vi.fn().mockRejectedValue(new Error("approved unavailable"))
          : vi.fn().mockResolvedValue(undefined)
      const loadPending =
        failedFeed === "pending"
          ? vi.fn().mockRejectedValue(new Error("pending unavailable"))
          : vi.fn().mockResolvedValue(undefined)

      await expect(loadAssetCatalogFeeds({ loadApproved, loadPending })).resolves.toBeUndefined()
      expect(loadApproved).toHaveBeenCalledOnce()
      expect(loadPending).toHaveBeenCalledOnce()
    }
  )
})

describe("closeAssetCatalog", () => {
  it("consumes the catalog entry when browser history has a previous route", () => {
    const history = createMemoryHistory({ initialEntries: ["/app", "/assets"] })
    const navigateToFallback = vi.fn()

    closeAssetCatalog({ history, navigateToFallback })

    expect(history.location.pathname).toBe("/app")
    expect(navigateToFallback).not.toHaveBeenCalled()
  })

  it("replaces a direct catalog entry with the public fallback", () => {
    const history = createMemoryHistory({ initialEntries: ["/assets"] })
    const navigateToFallback = vi.fn()

    closeAssetCatalog({ history, navigateToFallback })

    expect(history.location.pathname).toBe("/assets")
    expect(navigateToFallback).toHaveBeenCalledWith({ replace: true, to: "/" })
  })
})
