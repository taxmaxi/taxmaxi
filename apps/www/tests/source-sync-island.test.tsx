// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("motion/react", async () => {
  const { createElement } = await import("react")
  const motionProps = new Set([
    "animate",
    "custom",
    "exit",
    "initial",
    "layout",
    "transition",
    "variants",
    "whileTap",
  ])
  const makeMotionElement = (tag: "button" | "circle" | "div" | "span") =>
    function MotionElement(props: Record<string, unknown>) {
      const domProps = Object.fromEntries(
        Object.entries(props).filter(([property]) => !motionProps.has(property))
      )

      return createElement(tag, domProps)
    }

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: {
      button: makeMotionElement("button"),
      circle: makeMotionElement("circle"),
      div: makeMotionElement("div"),
      span: makeMotionElement("span"),
    },
    useReducedMotion: () => true,
  }
})

vi.mock("#/components/ui/button", () => ({ Button: "button" }))

import {
  SourceSyncIsland,
  type SourceSyncIslandItem,
} from "../src/components/dashboard/source-sync-island"
import { SourceCards } from "../src/components/source-cards"

const queuedSync: SourceSyncIslandItem = {
  id: "coinbase",
  progress: 0,
  sourceName: "Coinbase",
  status: "queued",
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  })
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  })
})

afterEach(cleanup)

describe("SourceSyncIsland", () => {
  it("shows queued work without invented progress", async () => {
    render(<SourceSyncIsland items={[queuedSync]} />)

    expect(await screen.findByText("Waiting for Coinbase")).toBeTruthy()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("expands to reveal metrics and concurrent syncs", async () => {
    const runningSync: SourceSyncIslandItem = {
      ...queuedSync,
      importedRecords: 284,
      normalizedRecords: 271,
      progress: 0,
      status: "running",
    }
    const secondSync: SourceSyncIslandItem = {
      id: "kraken",
      progress: 0,
      sourceName: "Kraken",
      status: "queued",
    }

    render(<SourceSyncIsland items={[runningSync, secondSync]} />)

    const detailsButton = await screen.findByRole("button", {
      name: "Show sync details: Syncing Coinbase and Kraken",
    })
    const headline = screen.getByText("Syncing Coinbase and Kraken")
    expect(screen.queryByText("284 records imported")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
    fireEvent.click(detailsButton)

    expect(screen.getByText("Syncing Coinbase and Kraken")).toBe(headline)
    expect(await screen.findByText("284")).toBeTruthy()
    expect(screen.getByText("271")).toBeTruthy()
    expect(screen.getByText("Kraken")).toBeTruthy()
    expect(screen.queryByRole("progressbar")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Hide sync details for Coinbase" }))

    expect(screen.getByText("Syncing Coinbase and Kraken")).toBe(headline)
    expect(screen.queryByText("284")).toBeNull()
  })

  it("keeps failed work actionable", async () => {
    const onDismiss = vi.fn()
    const onRetry = vi.fn()
    const failedSync: SourceSyncIslandItem = {
      ...queuedSync,
      message: "Coinbase stopped responding.",
      progress: 100,
      status: "failed",
    }

    render(<SourceSyncIsland items={[failedSync]} onDismiss={onDismiss} onRetry={onRetry} />)

    const retryButton = await screen.findByRole("button", { name: "Retry" })
    fireEvent.click(retryButton)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Coinbase sync status" }))

    expect(onRetry).toHaveBeenCalledWith(failedSync)
    expect(onDismiss).toHaveBeenCalledWith(failedSync)
  })

  it("keeps active work tracked while details are open", async () => {
    const onDismiss = vi.fn()
    const runningSync: SourceSyncIslandItem = {
      ...queuedSync,
      status: "running",
    }

    render(<SourceSyncIsland items={[runningSync]} onDismiss={onDismiss} />)

    fireEvent.click(
      await screen.findByRole("button", { name: "Show sync details: Syncing Coinbase" })
    )

    expect(screen.queryByRole("button", { name: "Dismiss Coinbase sync status" })).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe("SourceCards", () => {
  it("does not select a source when its sync control receives a keyboard event", () => {
    const onSelectedSourceIdChange = vi.fn()
    const onSourceSync = vi.fn()
    const source = {
      id: "coinbase",
      importedTransactions: 0,
      kind: "exchange" as const,
      lastSync: "Never",
      name: "Coinbase",
      unresolvedItems: 0,
    }

    render(
      <SourceCards
        onSelectedSourceIdChange={onSelectedSourceIdChange}
        onSourceSync={onSourceSync}
        sources={[source]}
      />
    )

    const syncButton = screen.getByRole("button", { name: "Sync Coinbase" })
    fireEvent.keyDown(syncButton, { key: "Enter" })
    fireEvent.click(syncButton)

    expect(onSelectedSourceIdChange).not.toHaveBeenCalled()
    expect(onSourceSync).toHaveBeenCalledWith(source)
  })
})
