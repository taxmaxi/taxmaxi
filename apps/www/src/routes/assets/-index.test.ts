import { createMemoryHistory } from "@tanstack/react-router"
import { describe, expect, it, vi } from "vitest"

import { closeAssetCatalog } from "./index"

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
