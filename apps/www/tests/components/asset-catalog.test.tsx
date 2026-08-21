// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH,
  type TaxMaxiAsset,
  type TaxMaxiPendingAsset,
} from "#/lib/assets"
import { m } from "#/paraglide/messages"
import { AssetCatalog as AssetCatalogView } from "#/components/asset-catalog"

function AssetCatalog({
  approvedAssetsUnavailable = false,
  assets,
  canLoadMoreApproved = false,
  canLoadMorePending = false,
  isLoadingApproved = false,
  isLoadingPending = false,
  onClose,
  onLoadMoreApproved,
  onLoadMorePending,
  onQueryChange,
  onRetryApproved,
  onRetryPending,
  pendingAssets,
  pendingAssetsUnavailable = false,
}: {
  readonly approvedAssetsUnavailable?: boolean
  readonly assets: ReadonlyArray<TaxMaxiAsset>
  readonly canLoadMoreApproved?: boolean
  readonly canLoadMorePending?: boolean
  readonly isLoadingApproved?: boolean
  readonly isLoadingPending?: boolean
  readonly onClose: () => void
  readonly onLoadMoreApproved?: () => Promise<unknown> | void
  readonly onLoadMorePending?: () => Promise<unknown> | void
  readonly onQueryChange?: (query: string) => void
  readonly onRetryApproved?: () => Promise<unknown> | void
  readonly onRetryPending?: () => Promise<unknown> | void
  readonly pendingAssets: ReadonlyArray<TaxMaxiPendingAsset>
  readonly pendingAssetsUnavailable?: boolean
}) {
  return (
    <AssetCatalogView
      feeds={{
        approved: {
          canLoadMore: canLoadMoreApproved,
          isLoading: isLoadingApproved,
          items: assets,
          loadMore: onLoadMoreApproved,
          retry: onRetryApproved,
          unavailable: approvedAssetsUnavailable,
        },
        pending: {
          canLoadMore: canLoadMorePending,
          isLoading: isLoadingPending,
          items: pendingAssets,
          loadMore: onLoadMorePending,
          retry: onRetryPending,
          unavailable: pendingAssetsUnavailable,
        },
      }}
      onClose={onClose}
      onQueryChange={onQueryChange}
    />
  )
}

let desktopViewport = false
let pixelDesktopViewport: boolean | undefined
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
  logoUrl = null,
  name,
  representations = [],
  symbol,
  coingeckoCoinId = null,
}: {
  id: string
  logoUrl?: string | null
  name: string
  representations?: TaxMaxiAsset["representations"]
  symbol: string
  coingeckoCoinId?: string | null
}): TaxMaxiAsset => ({
  id,
  name,
  symbol,
  coingeckoCoinId,
  logoUrl,
  type: "fungible",
  representations,
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
      value: (query: string): MediaQueryList => {
        return {
          get matches() {
            if (query === "(min-width: 64rem)") {
              return desktopViewport
            }
            if (query === "(min-width: 1024px)") {
              return pixelDesktopViewport ?? desktopViewport
            }
            return !(pixelDesktopViewport ?? desktopViewport)
          },
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            if (query === "(min-width: 1024px)" || query === "(min-width: 64rem)") {
              desktopChangeListeners.add(listener)
            }
          },
          removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            desktopChangeListeners.delete(listener)
          },
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
        }
      },
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
    pixelDesktopViewport = undefined
    desktopChangeListeners.clear()
  })

  it("moves focus to search when the catalog opens", () => {
    document.body.innerHTML = '<button id="catalog-entry-opener"></button>'
    document.getElementById("catalog-entry-opener")?.focus()
    document.getElementById("catalog-entry-opener")?.remove()

    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search assets" }))
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

  it("keeps the first loaded asset selected when another feed is prepended", async () => {
    const approvedAsset = makeAsset({ id: "approved", name: "Approved", symbol: "APP" })
    const pendingAsset = makePendingAsset({
      id: "pending",
      name: "Pending",
      provider: "provider",
      symbol: "PND",
    })
    const { rerender } = render(<AssetCatalog assets={[]} onClose={vi.fn()} pendingAssets={[]} />)

    rerender(<AssetCatalog assets={[approvedAsset]} onClose={vi.fn()} pendingAssets={[]} />)
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "APP" })).toBeTruthy())

    rerender(
      <AssetCatalog assets={[approvedAsset]} onClose={vi.fn()} pendingAssets={[pendingAsset]} />
    )

    expect(screen.getByRole("heading", { level: 2, name: "APP" })).toBeTruthy()
    expect(screen.queryByRole("heading", { level: 2, name: "PND" })).toBeNull()
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
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search assets" }))
    )
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

  it("orders loaded pending and approved assets by symbol and name", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({ id: "approved-z", name: "Zulu", symbol: "ZZZ" }),
          makeAsset({ id: "approved-b", name: "Beta", symbol: "AAA" }),
          makeAsset({ id: "approved-a", name: "Alpha", symbol: "AAA" }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[
          makePendingAsset({
            id: "pending-z",
            name: "Zulu pending",
            provider: "provider",
            symbol: "ZZZ",
          }),
          makePendingAsset({
            id: "pending-a",
            name: "Alpha pending",
            provider: "provider",
            symbol: "AAA",
          }),
        ]}
      />
    )

    expect(screen.getAllByRole("option").map((option) => option.id)).toEqual([
      "asset-catalog-option-pending-pending-a",
      "asset-catalog-option-pending-pending-z",
      "asset-catalog-option-approved-approved-a",
      "asset-catalog-option-approved-approved-b",
      "asset-catalog-option-approved-approved-z",
    ])
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
    expect(screen.getByRole("combobox", { name: "Search assets" }).getAttribute("maxlength")).toBe(
      String(ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH)
    )
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

  it("shows loading state instead of an empty registry before the first feeds settle", () => {
    render(
      <AssetCatalog
        assets={[]}
        isLoadingApproved={true}
        isLoadingPending={true}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    expect(screen.getAllByText("Loading assets")).toHaveLength(2)
    expect(screen.queryByText("No assets found")).toBeNull()
    expect(screen.queryByText("The registry has no assets to show yet.")).toBeNull()
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

  it.each(["ethereum", "evm", "0xassetcontract", "solana-mint-address"])(
    "keeps approved representation matches visible for %s",
    (query) => {
      const representedAsset = makeAsset({
        id: "represented-asset",
        name: "Represented Asset",
        representations: [
          {
            id: "ethereum-representation",
            blockchainId: "ethereum",
            blockchainName: "Ethereum",
            blockchainChainType: "evm",
            blockchainChainId: 1,
            blockchainExplorerUrl: "https://etherscan.io",
            blockchainLogoUrl: null,
            type: "token",
            contractAddress: "0xassetcontract",
            mintAddress: null,
            decimals: 18,
            logoUrl: null,
            metadata: null,
          },
          {
            id: "solana-representation",
            blockchainId: "solana",
            blockchainName: "Solana",
            blockchainChainType: "solana",
            blockchainChainId: null,
            blockchainExplorerUrl: "https://explorer.solana.com",
            blockchainLogoUrl: null,
            type: "token",
            contractAddress: null,
            mintAddress: "solana-mint-address",
            decimals: 6,
            logoUrl: null,
            metadata: null,
          },
        ],
        symbol: "RPA",
      })

      render(<AssetCatalog assets={[representedAsset]} onClose={vi.fn()} pendingAssets={[]} />)

      fireEvent.change(screen.getByRole("combobox", { name: "Search assets" }), {
        target: { value: query },
      })

      expect(screen.getByRole("option", { name: /RPA/ })).toBeTruthy()
    }
  )

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

  it("retries both feeds when approved and pending assets are unavailable", () => {
    const onRetryApproved = vi.fn()
    const onRetryPending = vi.fn()

    render(
      <AssetCatalog
        approvedAssetsUnavailable={true}
        assets={[]}
        onClose={vi.fn()}
        onRetryApproved={onRetryApproved}
        onRetryPending={onRetryPending}
        pendingAssets={[]}
        pendingAssetsUnavailable={true}
      />
    )

    expect(screen.getByRole("status").textContent).toContain("Some assets could not be loaded.")
    expect(
      screen.getAllByText("The asset feeds are unavailable. Try again in a moment.")
    ).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Retry loading assets" }))

    expect(onRetryApproved).toHaveBeenCalledOnce()
    expect(onRetryPending).toHaveBeenCalledOnce()
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

  it.each(["ArrowDown", "ArrowUp", "Enter"])(
    "does not handle %s while the search input is composing text",
    (key) => {
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
      const wasNotCancelled = fireEvent.keyDown(search, { isComposing: true, key })

      expect(wasNotCancelled).toBe(true)
      expect(search.getAttribute("aria-activedescendant")).toBe(
        "asset-catalog-option-approved-bitcoin"
      )
      expect(screen.queryByRole("button", { name: "Back to asset list" })).toBeNull()
      expect(document.activeElement).toBe(search)
    }
  )

  it("does not close the catalog when Escape cancels text composition", () => {
    const onClose = vi.fn()
    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={onClose}
        pendingAssets={[]}
      />
    )

    const search = screen.getByRole("combobox", { name: "Search assets" })
    const wasNotCancelled = fireEvent.keyDown(search, { isComposing: true, key: "Escape" })

    expect(wasNotCancelled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(search)
  })

  it("closes the catalog on an ordinary Escape press", () => {
    const onClose = vi.fn()
    render(
      <AssetCatalog
        assets={[makeAsset({ id: "bitcoin", name: "Bitcoin", symbol: "BTC" })]}
        onClose={onClose}
        pendingAssets={[]}
      />
    )

    const wasNotCancelled = fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search assets" }),
      { key: "Escape" }
    )

    expect(wasNotCancelled).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
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

  it("keeps selection and resize behavior aligned with Tailwind's rem breakpoint", async () => {
    pixelDesktopViewport = true
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

  it("falls back to the asset symbol when a remote logo fails", () => {
    render(
      <AssetCatalog
        assets={[
          makeAsset({
            id: "bitcoin",
            logoUrl: "https://assets.example.test/bitcoin.png",
            name: "Bitcoin",
            symbol: "BTC",
          }),
        ]}
        onClose={vi.fn()}
        pendingAssets={[]}
      />
    )

    const listLogo = screen.getAllByRole("img", { name: "Bitcoin logo" })[0]
    const mark = listLogo?.parentElement

    expect(listLogo).toBeDefined()
    if (listLogo === undefined) {
      return
    }
    fireEvent.error(listLogo)

    expect(mark?.querySelector("img")).toBeNull()
    expect(mark?.textContent).toBe("BT")
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

  it("keeps the active locale in approved asset links", () => {
    window.history.replaceState(null, "", "/de/assets")
    try {
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

      expect(
        screen
          .getByRole("link", { name: m["assetCatalog.actions.openPublicPage"]() })
          .getAttribute("href")
      ).toBe("/de/assets/00000000-0000-4000-8000-000000000010")
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })
})
