// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { act, render, renderHook } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DefaultCatchBoundary } from "#/components/catch-boundary"
import {
  ASSET_CATALOG_SEARCH_DEBOUNCE_MS,
  closeAssetCatalog,
  loadAssetCatalogFeeds,
  retryAssetCatalogFeed,
  useDebouncedCatalogQuery,
} from "./index"
import { ASSET_CATALOG_OPENER_ID, restoreAssetCatalogReturnFocus } from "#/lib/asset-catalog-focus"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
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
  const makeLoaderControls = () => ({
    cancelApproved: vi.fn().mockResolvedValue(undefined),
    cancelPending: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  })

  it.each(["approved", "pending"] as const)(
    "keeps the catalog loader successful when the %s feed fails",
    (failedFeed) => {
      const loadApproved =
        failedFeed === "approved"
          ? vi.fn().mockRejectedValue(new Error("approved unavailable"))
          : vi.fn().mockResolvedValue(undefined)
      const loadPending =
        failedFeed === "pending"
          ? vi.fn().mockRejectedValue(new Error("pending unavailable"))
          : vi.fn().mockResolvedValue(undefined)

      expect(
        loadAssetCatalogFeeds({ ...makeLoaderControls(), loadApproved, loadPending })
      ).toBeUndefined()
      expect(loadApproved).toHaveBeenCalledOnce()
      expect(loadPending).toHaveBeenCalledOnce()
    }
  )

  it("keeps the catalog loader successful when both feeds fail", () => {
    const loadApproved = vi.fn().mockRejectedValue(new Error("approved unavailable"))
    const loadPending = vi.fn().mockRejectedValue(new Error("pending unavailable"))

    expect(
      loadAssetCatalogFeeds({ ...makeLoaderControls(), loadApproved, loadPending })
    ).toBeUndefined()
    expect(loadApproved).toHaveBeenCalledOnce()
    expect(loadPending).toHaveBeenCalledOnce()
  })

  it("does not wait for a slow feed before completing the route loader", () => {
    const loadApproved = vi.fn().mockResolvedValue(undefined)
    const loadPending = vi.fn().mockReturnValue(new Promise(() => undefined))

    expect(
      loadAssetCatalogFeeds({ ...makeLoaderControls(), loadApproved, loadPending })
    ).toBeUndefined()
    expect(loadApproved).toHaveBeenCalledOnce()
    expect(loadPending).toHaveBeenCalledOnce()
  })

  it("cancels both detached feed loads when route preloading is abandoned", () => {
    const abortController = new AbortController()
    const cancelApproved = vi.fn().mockResolvedValue(undefined)
    const cancelPending = vi.fn().mockResolvedValue(undefined)
    const loadApproved = vi.fn().mockReturnValue(new Promise(() => undefined))
    const loadPending = vi.fn().mockReturnValue(new Promise(() => undefined))

    loadAssetCatalogFeeds({
      cancelApproved,
      cancelPending,
      loadApproved,
      loadPending,
      signal: abortController.signal,
    })
    abortController.abort()

    expect(cancelApproved).toHaveBeenCalledOnce()
    expect(cancelPending).toHaveBeenCalledOnce()
  })
})

describe("closeAssetCatalog", () => {
  it("consumes the catalog entry when browser history has a previous route", () => {
    const history = createMemoryHistory({ initialEntries: ["/app", "/assets"] })
    const navigateToFallback = vi.fn()
    const restoreFocus = vi.fn()

    closeAssetCatalog({ history, navigateToFallback, restoreFocus })

    expect(history.location.pathname).toBe("/app")
    expect(navigateToFallback).not.toHaveBeenCalled()
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it("replaces a direct catalog entry with the public fallback", () => {
    const history = createMemoryHistory({ initialEntries: ["/assets"] })
    const navigateToFallback = vi.fn()
    const restoreFocus = vi.fn()

    closeAssetCatalog({ history, navigateToFallback, restoreFocus })

    expect(history.location.pathname).toBe("/assets")
    expect(navigateToFallback).toHaveBeenCalledWith({ replace: true, to: "/" })
    expect(restoreFocus).toHaveBeenCalledOnce()
  })
})

describe("restoreAssetCatalogReturnFocus", () => {
  it("waits through a delayed route transition before focusing the app opener", async () => {
    const frames: Array<FrameRequestCallback> = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    document.body.innerHTML = '<main data-asset-catalog-surface=""></main>'

    restoreAssetCatalogReturnFocus()
    for (let frame = 0; frame <= 30; frame += 1) {
      frames.shift()?.(frame)
    }

    expect(document.activeElement).toBe(document.body)

    document.body.innerHTML = `<main><button id="${ASSET_CATALOG_OPENER_ID}">Open</button></main>`
    await Promise.resolve()
    frames.shift()?.(1)

    expect(document.activeElement).toBe(document.getElementById(ASSET_CATALOG_OPENER_ID))
  })

  it("allows pending focus restoration to be cancelled", () => {
    const frames: Array<FrameRequestCallback> = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame")
    document.body.innerHTML = '<main data-asset-catalog-surface=""></main>'

    const cancel = restoreAssetCatalogReturnFocus()
    cancel()
    frames.shift()?.(0)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(document.activeElement).toBe(document.body)
  })

  it("focuses the main landmark after a direct-entry fallback", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    document.body.innerHTML = "<main></main>"

    restoreAssetCatalogReturnFocus()

    const main = document.querySelector("main")
    expect(document.activeElement).toBe(main)
    expect(main?.getAttribute("tabindex")).toBe("-1")
  })

  it("focuses and stops observing when the return route renders an error boundary", async () => {
    const frames: Array<FrameRequestCallback> = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    document.body.innerHTML = '<main data-asset-catalog-surface=""></main>'

    restoreAssetCatalogReturnFocus()
    frames.shift()?.(0)
    document.body.replaceChildren()

    const rootRoute = createRootRoute({
      component: () =>
        createElement(DefaultCatchBoundary, {
          error: new Error("route failed"),
          reset: vi.fn(),
        }),
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute,
    })
    await router.load()
    render(createElement(RouterProvider, { router }))
    await Promise.resolve()
    frames.shift()?.(1)

    const errorBoundary = document.querySelector("[data-asset-catalog-return-focus]")
    expect(document.activeElement).toBe(errorBoundary)
    expect(errorBoundary?.getAttribute("tabindex")).toBe("-1")

    document.body.insertAdjacentHTML(
      "beforeend",
      `<button id="${ASSET_CATALOG_OPENER_ID}">Open</button>`
    )
    await Promise.resolve()
    expect(frames).toHaveLength(0)
    expect(document.activeElement).toBe(errorBoundary)
  })
})

describe("retryAssetCatalogFeed", () => {
  it.each([
    { isFetchNextPageError: true, expected: "fetchNextPage" },
    { isFetchNextPageError: false, expected: "refetch" },
  ] as const)(
    "uses $expected for the current failure",
    async ({ expected, isFetchNextPageError }) => {
      const fetchNextPage = vi.fn().mockResolvedValue("next-page")
      const refetch = vi.fn().mockResolvedValue("first-page")

      await retryAssetCatalogFeed({ fetchNextPage, isFetchNextPageError, refetch })

      if (expected === "fetchNextPage") {
        expect(fetchNextPage).toHaveBeenCalledOnce()
        expect(refetch).not.toHaveBeenCalled()
      } else {
        expect(refetch).toHaveBeenCalledOnce()
        expect(fetchNextPage).not.toHaveBeenCalled()
      }
    }
  )
})
