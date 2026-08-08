// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { TaxMaxiAsset, TaxMaxiPendingAsset } from "#/lib/assets"
import { AssetCatalog } from "./asset-catalog"

let desktopViewport = false
const desktopChangeListeners = new Set<EventListenerOrEventListenerObject>()

const setDesktopViewport = (matches: boolean) => {
  desktopViewport = matches
  const event = new Event("change")
  Object.defineProperty(event, "matches", { value: matches })

  for (const listener of desktopChangeListeners) {
    if (typeof listener === "function") {
      listener(event)
    } else {
      listener.handleEvent(event)
    }
  }
}

const makeAsset = ({
  id,
  name,
  symbol,
  coingeckoCoinId = null,
}: {
  id: string
  name: string
  symbol: string
  coingeckoCoinId?: string | null
}): TaxMaxiAsset => ({
  id,
  name,
  symbol,
  coingeckoCoinId,
  logoUrl: null,
  type: "fungible",
  representations: [],
})

const makePendingAsset = ({
  id,
  name,
  provider,
  symbol,
}: {
  id: string
  name: string
  provider: string
  symbol: string
}): TaxMaxiPendingAsset => ({
  id,
  name,
  provider,
  providerAssetId: id,
  providerType: "crypto",
  symbol,
})

describe("AssetCatalog", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        get matches() {
          return query === "(min-width: 1024px)" ? desktopViewport : !desktopViewport
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (query === "(min-width: 1024px)") {
            desktopChangeListeners.add(listener)
          }
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          desktopChangeListeners.delete(listener)
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }),
    })
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    })
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    desktopViewport = false
    desktopChangeListeners.clear()
  })

  it("selects the next and previous visible asset with the arrow keys", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" }),
          makeAsset({ id: "ethereum", name: "Ether", symbol: "ETH" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    const search = screen.getByRole("combobox", { name: "Search assets" })
    expect(screen.getByRole("heading", { level: 2, name: "BTC" })).toBeTruthy()

    fireEvent.keyDown(search, { key: "ArrowDown" })

    expect(screen.getByRole("heading", { level: 2, name: "ETH" })).toBeTruthy()
    expect(search.getAttribute("aria-activedescendant")).toBe(
      "asset-catalog-option-approved-ethereum"
    )

    fireEvent.keyDown(search, { key: "ArrowUp" })

    expect(screen.getByRole("heading", { level: 2, name: "BTC" })).toBeTruthy()
  })

  it("opens a mobile detail view and returns focus to the selected asset", async () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" }),
          makeAsset({ id: "ethereum", name: "Ether", symbol: "ETH" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    const ethereum = screen.getByRole("option", { name: /ETH/ })
    fireEvent.click(ethereum)

    const backButton = screen.getByRole("button", { name: "Back to asset list" })
    expect(screen.getByRole("heading", { level: 2, name: "ETH" })).toBeTruthy()
    expect(document.activeElement).toBe(backButton)

    fireEvent.click(backButton)

    await waitFor(() => expect(document.activeElement).toBe(ethereum))
    expect(screen.queryByRole("button", { name: "Back to asset list" })).toBeNull()
  })

  it("closes mobile detail when the selected asset leaves the feed", async () => {
    const pendingAsset = makePendingAsset({
      id: "pending",
      name: "Pending",
      provider: "provider",
      symbol: "PND",
    })
    const { rerender } = render(
      <AssetCatalog assets={[]} onClose={vi.fn()} pendingAssets={[pendingAsset]} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Pending" }))
    fireEvent.click(screen.getByRole("option", { name: /PND/ }))
    expect(screen.getByRole("button", { name: "Back to asset list" })).toBeTruthy()

    rerender(<AssetCatalog assets={[]} onClose={vi.fn()} pendingAssets={[]} />)

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Back to asset list" })).toBeNull()
    )
    expect(screen.queryByRole("heading", { level: 2, name: "PND" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search assets" }))
  })

  it("loads matches beyond the initial 80-row window", () => {
    const assets = Array.from({ length: 81 }, (_, index) =>
      makeAsset({
        id: `asset-${index + 1}`,
        name: `Asset ${index + 1}`,
        symbol: `A${index + 1}`,
      })
    )

    render(<AssetCatalog assets={assets} onClose={vi.fn()} pendingAssets={[]} />)

    expect(screen.getAllByRole("option")).toHaveLength(80)
    expect(screen.queryByRole("option", { name: /A81/ })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Load more assets" }))

    expect(screen.getAllByRole("option")).toHaveLength(81)
    expect(screen.getByRole("option", { name: /A81/ })).toBeTruthy()
  })

  it("requests the next approved and pending pages from the All scope", () => {
    const onLoadMoreApproved = vi.fn()
    const onLoadMorePending = vi.fn()

    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        canLoadMoreApproved={true}
        canLoadMorePending={true}
        onClose={vi.fn()}
        onLoadMoreApproved={onLoadMoreApproved}
        onLoadMorePending={onLoadMorePending}
        pendingAssets={[
          makePendingAsset({
            id: "pending",
            name: "Pending",
            provider: "provider",
            symbol: "PND",
          }),
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Load more assets" }))

    expect(onLoadMoreApproved).toHaveBeenCalledOnce()
    expect(onLoadMorePending).toHaveBeenCalledOnce()
  })

  it.each([
    { scope: "Approved", expectedFeed: "approved" },
    { scope: "Pending", expectedFeed: "pending" },
  ] as const)("requests only the next $expectedFeed page in the $scope scope", ({ scope }) => {
    const onLoadMoreApproved = vi.fn()
    const onLoadMorePending = vi.fn()

    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        canLoadMoreApproved={true}
        canLoadMorePending={true}
        onClose={vi.fn()}
        onLoadMoreApproved={onLoadMoreApproved}
        onLoadMorePending={onLoadMorePending}
        pendingAssets={[
          makePendingAsset({
            id: "pending",
            name: "Pending",
            provider: "provider",
            symbol: "PND",
          }),
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: scope }))
    fireEvent.click(screen.getByRole("button", { name: "Load more assets" }))

    if (scope === "Approved") {
      expect(onLoadMoreApproved).toHaveBeenCalledOnce()
      expect(onLoadMorePending).not.toHaveBeenCalled()
    } else {
      expect(onLoadMoreApproved).not.toHaveBeenCalled()
      expect(onLoadMorePending).toHaveBeenCalledOnce()
    }
  })

  it("keeps approved assets usable when the pending feed is unavailable", () => {
    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        pendingAssets={[]}
        pendingAssetsUnavailable={true}
      />
    )

    expect(screen.getByRole("heading", { level: 2, name: "BTC" })).toBeTruthy()

    const pendingScope = screen.getByRole("button", { name: "Pending" })

    expect(pendingScope.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(pendingScope)

    expect(pendingScope.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getAllByText("Pending assets unavailable")).toHaveLength(2)
    expect(screen.queryByRole("tab")).toBeNull()
  })

  it("reports search changes so unloaded server pages can be queried", () => {
    const onQueryChange = vi.fn()

    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        onQueryChange={onQueryChange}
        pendingAssets={[]}
      />
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Search assets" }), {
      target: { value: "later-page" },
    })

    expect(onQueryChange).toHaveBeenCalledWith("later-page")
  })

  it("announces changing result and feed status", () => {
    const { rerender } = render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )
    const status = screen.getByRole("status")

    expect(status.textContent).toBe("Showing 1 loaded match")
    expect(status.getAttribute("aria-live")).toBe("polite")

    rerender(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        isLoadingApproved={true}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )
    expect(status.textContent).toBe("Loading assets. Showing 1 loaded match")

    rerender(
      <AssetCatalog
        approvedAssetsUnavailable={true}
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        isLoadingPending={true}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )
    expect(status.textContent).toBe(
      "Loading assets. Some assets could not be loaded. Showing 1 loaded match"
    )
  })

  it.each([
    {
      assets: [makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })],
      expectedName: /BTC/,
      pendingAssets: [],
      query: "  bItCoIn   btc ",
    },
    {
      assets: [],
      expectedName: /cbETH/,
      pendingAssets: [
        makePendingAsset({
          id: "coinbase-cbeth",
          name: "Wrapped Ether",
          provider: "Coinbase",
          symbol: "cbETH",
        }),
      ],
      query: "coinBASE cbeth",
    },
    {
      assets: [makeAsset({ id: "percent", name: "100%_literal asset", symbol: "PCT" })],
      expectedName: /PCT/,
      pendingAssets: [],
      query: "%_literal",
    },
    {
      assets: [
        makeAsset({
          id: "usdc",
          name: "USD Coin",
          symbol: "USDC",
          coingeckoCoinId: "usd-coin",
        }),
      ],
      expectedName: /USDC/,
      pendingAssets: [],
      query: "usd-coin",
    },
    {
      assets: [
        makeAsset({
          id: "00000000-0000-4000-8000-000000000010",
          name: "USD Coin",
          symbol: "USDC",
        }),
      ],
      expectedName: /USDC/,
      pendingAssets: [],
      query: "00000000-0000-4000-8000-000000000010",
    },
  ])("keeps multi-field and literal query matches visible for $query", (testCase) => {
    render(
      <AssetCatalog
        assets={testCase.assets}
        onClose={vi.fn()}
        pendingAssets={testCase.pendingAssets}
      />
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Search assets" }), {
      target: { value: testCase.query },
    })

    expect(screen.getByRole("option", { name: testCase.expectedName })).toBeTruthy()
  })

  it("does not treat SQL wildcard characters as client-side wildcards", () => {
    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Search assets" }), {
      target: { value: "%_" },
    })

    expect(screen.queryByRole("option")).toBeNull()
  })

  it("shows a retry action when a loaded page fails", () => {
    const onRetryApproved = vi.fn()

    render(
      <AssetCatalog
        approvedAssetsUnavailable={true}
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        onRetryApproved={onRetryApproved}
        pendingAssets={[]}
      />
    )

    expect(screen.getByRole("status").textContent).toContain("Some assets could not be loaded.")
    fireEvent.click(screen.getByRole("button", { name: "Retry loading assets" }))
    expect(onRetryApproved).toHaveBeenCalledOnce()
  })

  it.each(["approved", "pending"] as const)(
    "keeps the healthy %s feed pageable while the other feed is unavailable",
    (healthyFeed) => {
      const approvedUnavailable = healthyFeed === "pending"
      const pendingUnavailable = healthyFeed === "approved"
      const onLoadMoreApproved = vi.fn()
      const onLoadMorePending = vi.fn()
      const onRetryApproved = vi.fn()
      const onRetryPending = vi.fn()

      render(
        <AssetCatalog
          approvedAssetsUnavailable={approvedUnavailable}
          assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
          canLoadMoreApproved={!approvedUnavailable}
          canLoadMorePending={!pendingUnavailable}
          onClose={vi.fn()}
          onLoadMoreApproved={onLoadMoreApproved}
          onLoadMorePending={onLoadMorePending}
          onRetryApproved={onRetryApproved}
          onRetryPending={onRetryPending}
          pendingAssets={[
            makePendingAsset({
              id: "pending",
              name: "Pending",
              provider: "provider",
              symbol: "PND",
            }),
          ]}
          pendingAssetsUnavailable={pendingUnavailable}
        />
      )

      fireEvent.click(screen.getByRole("button", { name: "Load more assets" }))
      fireEvent.click(screen.getByRole("button", { name: "Retry loading assets" }))

      if (healthyFeed === "approved") {
        expect(onLoadMoreApproved).toHaveBeenCalledOnce()
        expect(onLoadMorePending).not.toHaveBeenCalled()
        expect(onRetryApproved).not.toHaveBeenCalled()
        expect(onRetryPending).toHaveBeenCalledOnce()
      } else {
        expect(onLoadMoreApproved).not.toHaveBeenCalled()
        expect(onLoadMorePending).toHaveBeenCalledOnce()
        expect(onRetryApproved).toHaveBeenCalledOnce()
        expect(onRetryPending).not.toHaveBeenCalled()
      }
    }
  )

  it("loads the ready feed while the other feed is still fetching", () => {
    const onLoadMoreApproved = vi.fn()
    const onLoadMorePending = vi.fn()

    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        canLoadMoreApproved={true}
        canLoadMorePending={true}
        isLoadingPending={true}
        onClose={vi.fn()}
        onLoadMoreApproved={onLoadMoreApproved}
        onLoadMorePending={onLoadMorePending}
        pendingAssets={[
          makePendingAsset({
            id: "pending",
            name: "Pending",
            provider: "provider",
            symbol: "PND",
          }),
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Load more assets" }))

    expect(onLoadMoreApproved).toHaveBeenCalledOnce()
    expect(onLoadMorePending).not.toHaveBeenCalled()
  })

  it("opens the selected mobile asset with Enter from the search combobox", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" }),
          makeAsset({ id: "ethereum", name: "Ether", symbol: "ETH" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    const search = screen.getByRole("combobox", { name: "Search assets" })
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(screen.getByRole("button", { name: "Back to asset list" })).toBeTruthy()
    expect(screen.getByRole("heading", { level: 2, name: "ETH" })).toBeTruthy()
  })

  it("does not hijack arrow keys from unrelated controls", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" }),
          makeAsset({ id: "ethereum", name: "Ether", symbol: "ETH" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    fireEvent.keyDown(screen.getByRole("button", { name: "Close asset catalog" }), {
      key: "ArrowDown",
    })

    expect(screen.getByRole("heading", { level: 2, name: "BTC" })).toBeTruthy()
  })

  it("moves focus to the selected row when the mobile detail crosses the desktop breakpoint", async () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" }),
          makeAsset({ id: "ethereum", name: "Ether", symbol: "ETH" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    const ethereum = screen.getByRole("option", { name: /ETH/ })
    fireEvent.click(ethereum)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to asset list" }))

    setDesktopViewport(true)

    await waitFor(() => expect(document.activeElement).toBe(ethereum))
    expect(screen.queryByRole("button", { name: "Back to asset list" })).toBeNull()
  })

  it("keeps duplicate symbols separate by catalog identity", () => {
    render(
      <AssetCatalog
        assets={[makeAsset({ id: "approved-dup", name: "Approved Duplicate", symbol: "DUP" })]}
        onClose={vi.fn()}
        pendingAssets={[
          makePendingAsset({
            id: "pending-dup",
            name: "Pending Duplicate",
            provider: "duplicate-provider",
            symbol: "DUP",
          }),
        ]}
      />
    )

    const duplicateRows = screen.getAllByRole("option", { name: /DUP/ })
    expect(duplicateRows).toHaveLength(2)

    fireEvent.click(duplicateRows[1])
    expect(screen.getByText("This asset currently has no network representation.")).toBeTruthy()

    fireEvent.click(duplicateRows[0])
    expect(screen.getByText("duplicate-provider")).toBeTruthy()
  })

  it("links approved details to their public asset page", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({
            id: "00000000-0000-4000-8000-000000000010",
            name: "Bitcoin",
            symbol: "BTC",
          }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    expect(screen.getByRole("link", { name: "Open public asset page" }).getAttribute("href")).toBe(
      "/assets/00000000-0000-4000-8000-000000000010"
    )
  })
})
