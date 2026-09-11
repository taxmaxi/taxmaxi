// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TransactionFilterControls } from "#/components/transaction-filters"
import type { TransactionFilters } from "#/lib/transaction-filters"

const A = "00000000-0000-4000-8000-000000000001"
const X = "00000000-0000-4000-8000-000000000011"
const Y = "00000000-0000-4000-8000-000000000012"
const assets = [X, Y].map((assetId) => ({
  assetId,
  symbol: "SAME",
  name: "Same token",
  type: "fungible" as const,
  coingeckoCoinId: null,
  logoUrl: null,
}))
const source = {
  id: A,
  name: "Wallet A",
  kind: "wallet" as const,
  network: "Solana",
  importedTransactions: 1,
  unresolvedItems: 0,
  lastSync: "Today",
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(initial: TransactionFilters = {}, failed = false) {
  const onChange = vi.fn()
  function Controlled() {
    const [filters, setFilters] = useState(initial)
    return (
      <TransactionFilterControls
        filters={filters}
        sources={[source]}
        assets={assets}
        failed={failed}
        onRetry={vi.fn()}
        onChange={(next) => {
          onChange(next)
          setFilters(next)
        }}
      />
    )
  }
  render(<Controlled />)
  return onChange
}

async function open(label: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Filter ${label}`) }))
  return screen.findByRole("combobox", { name: label })
}

async function close(input: HTMLElement) {
  fireEvent.keyDown(input, { key: "Escape" })
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: /^(Sources|Assets|Categories)$/ })).toBeNull()
  )
}

describe("structured filter controls", () => {
  it("applies source, distinct equal-symbol assets and category once, removes only Y", async () => {
    const change = mount({
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    let input = await open("Sources")
    fireEvent.click(screen.getByRole("option", { name: /Wallet A/ }))
    await close(input)
    input = await open("Assets")
    fireEvent.change(input, { target: { value: "Same token" } })
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2))
    fireEvent.click(screen.getByRole("option", { name: new RegExp(X) }))
    fireEvent.click(screen.getByRole("option", { name: new RegExp(Y) }))
    await close(input)
    fireEvent.click(screen.getByRole("button", { name: "Staking" }))
    expect(change).toHaveBeenCalledTimes(4)
    expect(change).toHaveBeenLastCalledWith({
      sourceIds: [A],
      assetIds: [X, Y],
      categories: ["staking"],
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Remove.*${Y}`) }))
    expect(change).toHaveBeenLastCalledWith({
      sourceIds: [A],
      assetIds: [X],
      categories: ["staking"],
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }))
    expect(change).toHaveBeenLastCalledWith({})
  })

  it("searches by name, Arrow/Enter selects once and Escape returns focus", async () => {
    const change = mount()
    const input = await open("Categories")
    fireEvent.change(input, { target: { value: "Purchase" } })
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1))
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(change).toHaveBeenCalledExactlyOnceWith({ categories: ["purchase"] })
    await close(input)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Filter Categories/ })
      )
    )
  })

  it("uses recognizable metadata before exact IDs when equal names can be distinguished", async () => {
    render(
      <TransactionFilterControls
        filters={{ sourceIds: [A], assetIds: [X, Y] }}
        sources={[source, { ...source, id: "00000000-0000-4000-8000-000000000002" }]}
        assets={[
          {
            assetId: X,
            symbol: "SAME",
            name: "Same token",
            type: "fungible",
            coingeckoCoinId: "same-token",
            logoUrl: null,
          },
          {
            assetId: Y,
            symbol: "SAME",
            name: "Same token",
            type: "nft",
            coingeckoCoinId: null,
            logoUrl: null,
          },
        ]}
        onRetry={vi.fn()}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: `Remove Wallet A · ${A}` })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Remove SAME · Same token · Token · same-token" })
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove SAME · Same token · NFT" })).toBeTruthy()
    await open("Assets")
    for (const choice of screen.getAllByRole("option")) {
      expect(choice.textContent).not.toContain(X)
      expect(choice.textContent).not.toContain(Y)
    }
  })

  it("retry keyboard events do not select cmdk options or change filters", async () => {
    const change = vi.fn()
    const retry = vi.fn()
    render(
      <TransactionFilterControls
        filters={{ sourceIds: [A], assetIds: [Y], categories: ["staking"] }}
        sources={[source]}
        assets={assets}
        failed
        onRetry={retry}
        onChange={change}
      />
    )
    const input = await open("Assets")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const button = screen.getByRole("button", { name: "Try again" })
    button.focus()
    for (const key of ["Enter", " "]) {
      fireEvent.keyDown(button, { key })
      fireEvent.keyUp(button, { key })
      fireEvent.click(button, { detail: 0 })
    }
    expect(retry).toHaveBeenCalledTimes(2)
    expect(change).not.toHaveBeenCalled()
    await close(button)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Assets" }))
    )
  })

  it("retains readable selected assets on failure and keeps manual categories usable", async () => {
    const change = mount({ assetIds: [X] }, true)
    const input = await open("Assets")
    expect(
      screen.getByRole("button", { name: new RegExp(`Remove.*Same token.*${X}`) })
    ).toBeTruthy()
    expect(screen.getByText(/Assets could not be loaded/)).toBeTruthy()
    await close(input)
    fireEvent.click(screen.getByRole("button", { name: "Staking" }))
    expect(change).toHaveBeenLastCalledWith({ assetIds: [X], categories: ["staking"] })
  })

  it("keeps keyboard focus on surviving controls after chip removal, suggestions and reset", () => {
    mount({ assetIds: [X] })
    const chip = screen.getByRole("button", { name: new RegExp(`Remove.*${X}`) })
    chip.focus()
    fireEvent.click(chip, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Assets" }))
    const suggestion = screen.getByRole("button", { name: "Staking" })
    suggestion.focus()
    fireEvent.click(suggestion, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Categories" }))
    const reset = screen.getByRole("button", { name: "Clear all filters" })
    reset.focus()
    fireEvent.click(reset, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Sources" }))
  })

  it("shows removable identity fallback on a saved URL without loaded options", () => {
    const change = vi.fn()
    render(
      <TransactionFilterControls
        filters={{ assetIds: [X] }}
        sources={[]}
        failed
        onRetry={vi.fn()}
        onChange={change}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: `Remove Assets · ${X}` }))
    expect(change).toHaveBeenCalledWith({ assetIds: [] })
  })
})

describe("date, order and attention controls", () => {
  it("selects complete current/previous years while preserving attention and other filters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"))
    try {
      const change = mount({ sourceIds: [A], attention: true, order: "oldest" })
      fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
      fireEvent.click(await screen.findByRole("button", { name: "This year" }))
      expect(change).toHaveBeenLastCalledWith({
        sourceIds: [A],
        attention: true,
        order: "oldest",
        from: "2026-01-01",
        to: "2026-12-31",
        timezone: "Europe/Berlin",
      })
      await waitFor(() => expect(screen.queryByRole("button", { name: "This year" })).toBeNull())
      fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
      fireEvent.click(await screen.findByRole("button", { name: "Last year" }))
      expect(change).toHaveBeenLastCalledWith({
        sourceIds: [A],
        attention: true,
        order: "oldest",
        from: "2025-01-01",
        to: "2025-12-31",
        timezone: "Europe/Berlin",
      })
      expect(change).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps invalid drafts local and lets each form apply only its own dates", async () => {
    const change = mount({ assetIds: [X], attention: true, timezone: "Europe/Berlin" })
    fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
    const year = await screen.findByLabelText("Specific year")
    fireEvent.change(year, { target: { value: "1e3" } })
    fireEvent.submit(year.closest("form") ?? year)
    expect(screen.getByRole("alert").textContent).toBe("Enter a year using up to four digits.")
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(year, { target: { value: "2024" } })
    fireEvent.submit(year.closest("form") ?? year)
    expect(change).toHaveBeenCalledExactlyOnceWith({
      assetIds: [X],
      attention: true,
      timezone: "Europe/Berlin",
      from: "2024-01-01",
      to: "2024-12-31",
    })
    await waitFor(() => expect(screen.queryByLabelText("Specific year")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
    const from = await screen.findByLabelText("From date (inclusive)")
    const to = screen.getByLabelText("Through date (inclusive)")
    fireEvent.change(from, { target: { value: "2026-03-29" } })
    fireEvent.change(to, { target: { value: "2026-03-28" } })
    fireEvent.submit(from.closest("form") ?? from)
    expect(screen.getByRole("alert").textContent).toMatch(/start date/i)
    expect(change).toHaveBeenCalledTimes(1)
    fireEvent.change(to, { target: { value: "2026-03-29" } })
    fireEvent.submit(from.closest("form") ?? from)
    expect(change).toHaveBeenLastCalledWith({
      assetIds: [X],
      attention: true,
      timezone: "Europe/Berlin",
      from: "2026-03-29",
      to: "2026-03-29",
    })
  })

  it("shows saved range, order, attention and timezone and clears only dates with focus return", async () => {
    const change = mount({
      from: "2026-03-29",
      to: "2026-03-29",
      timezone: "Europe/Berlin",
      order: "oldest",
      attention: true,
    })
    expect(screen.getByRole("button", { name: "Filter dates" }).textContent).toContain(
      "2026-03-29 – 2026-03-29"
    )
    expect(screen.getByRole("combobox", { name: "Transaction order" }).textContent).toContain(
      "Oldest first"
    )
    expect(
      screen.getByRole("checkbox", { name: "Needs attention" }).getAttribute("aria-checked")
    ).toBe("true")
    expect(screen.getByText("Timezone: Europe/Berlin")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
    const clear = await screen.findByRole("button", { name: "Clear dates" })
    clear.focus()
    fireEvent.click(clear, { detail: 0 })
    expect(change).toHaveBeenLastCalledWith({
      from: undefined,
      to: undefined,
      timezone: "Europe/Berlin",
      order: "oldest",
      attention: true,
    })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter dates" }))
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Needs attention" }))
    expect(change).toHaveBeenLastCalledWith({
      from: undefined,
      to: undefined,
      timezone: "Europe/Berlin",
      order: "oldest",
      attention: undefined,
    })
  })

  it("uses one keyboard order selection without changing the attention filter", async () => {
    const change = mount({ attention: true })
    const order = screen.getByRole("combobox", { name: "Transaction order" })
    fireEvent.keyDown(order, { key: "ArrowDown" })
    const oldest = await screen.findByRole("option", { name: "Oldest first" })
    fireEvent.keyDown(oldest, { key: "Enter" })
    expect(change).toHaveBeenCalledExactlyOnceWith({ attention: true, order: "oldest" })
  })
})

it("does not clear saved dates when a native date field reports an incomplete draft", async () => {
  const change = mount({ from: "2026-03-29", to: "2026-03-29", timezone: "Europe/Berlin" })
  fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
  const from = await screen.findByLabelText("From date (inclusive)")
  fireEvent.change(from, { target: { value: "" } })
  // jsdom has no segmented native date editor; real Chromium supplies badInput here.
  const validity = vi.spyOn(HTMLFormElement.prototype, "checkValidity").mockReturnValue(false)
  try {
    fireEvent.submit(from.closest("form") ?? from)
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toBe("Check the dates and enter a valid range.")
  } finally {
    validity.mockRestore()
  }
})

it("shows saved year0000 dates and keeps its text editor stable while editing", async () => {
  const change = mount({ from: "0000-01-01", to: "0000-12-31", timezone: "UTC" })
  fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
  const from = await screen.findByLabelText("From date (inclusive)")
  expect(from).toHaveProperty("value", "0000-01-01")
  expect(from).toHaveProperty("type", "text")
  fireEvent.change(from, { target: { value: "0000-02-29" } })
  expect(from).toHaveProperty("type", "text")
  fireEvent.submit(from.closest("form") ?? from)
  expect(change).toHaveBeenCalledExactlyOnceWith({
    from: "0000-02-29",
    to: "0000-12-31",
    timezone: "UTC",
  })
})

it("refreshes an open draft on saved date changes but preserves it for other filter changes", async () => {
  const props = { sources: [source], assets, onRetry: vi.fn(), onChange: vi.fn() }
  const view = render(
    <TransactionFilterControls {...props} filters={{ from: "2026-01-01", to: "2026-12-31" }} />
  )
  fireEvent.click(screen.getByRole("button", { name: "Filter dates" }))
  const year = await screen.findByLabelText("Specific year")
  fireEvent.change(year, { target: { value: "2024" } })
  view.rerender(
    <TransactionFilterControls
      {...props}
      filters={{ from: "2026-01-01", to: "2026-12-31", attention: true }}
    />
  )
  expect(screen.getByLabelText("Specific year")).toHaveProperty("value", "2024")
  view.rerender(
    <TransactionFilterControls
      {...props}
      filters={{ from: "2025-01-01", to: "2025-12-31", timezone: "Europe/Berlin", attention: true }}
    />
  )
  expect(screen.getByLabelText("Specific year")).toHaveProperty("value", "2025")
  expect(screen.getByLabelText("From date (inclusive)")).toHaveProperty("value", "2025-01-01")
})
