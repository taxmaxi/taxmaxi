// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { TaxMaxiAsset } from "#/lib/assets"
import { AssetCatalog } from "./asset-catalog"

const makeAsset = ({
  id,
  name,
  symbol,
}: {
  id: string
  name: string
  symbol: string
}): TaxMaxiAsset => ({
  id,
  name,
  symbol,
  logoUrl: null,
  type: "fungible",
  representations: [],
})

describe("AssetCatalog", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
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

  afterEach(() => cleanup())

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
})
