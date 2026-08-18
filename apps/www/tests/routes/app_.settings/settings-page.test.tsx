// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Account } from "taxmaxi"

import { SettingsPageContent } from "#/routes/app_.settings"

const account: Account = {
  account: {
    id: "00000000-0000-4000-8000-000000000101",
    email: "account@taxmaxi.test",
    displayName: "Account Owner",
    role: "member",
    emailVerified: true,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:30:00.000Z",
  },
  loginMethods: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      provider: "coinbase",
      providerEmail: "provider@coinbase.test",
      linkedAt: "2026-08-18T12:00:00.000Z",
      isCurrentSession: true,
      canRemove: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      provider: "google",
      providerEmail: "person@gmail.test",
      linkedAt: "2026-08-18T12:15:00.000Z",
      isCurrentSession: false,
      canRemove: true,
    },
  ],
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } satisfies Storage,
  })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })
    ),
  })
})

afterEach(cleanup)

describe("SettingsPageContent", () => {
  it("shows the read-only account email and every linked login method", async () => {
    const rootRoute = createRootRoute({
      component: () => <SettingsPageContent account={account} onLogout={vi.fn()} />,
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute,
    })

    await router.load()
    render(<RouterProvider router={router} />)

    const accountEmail = screen.getByRole("textbox", { name: "Account email" })
    expect(accountEmail.getAttribute("value")).toBe("account@taxmaxi.test")
    expect(accountEmail.hasAttribute("readonly")).toBe(true)
    expect(screen.getByRole("heading", { name: "Coinbase" })).toBeTruthy()
    expect(screen.getByText("provider@coinbase.test")).toBeTruthy()
    expect(screen.getByText("Current session")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Google" })).toBeTruthy()
    expect(screen.getByText("person@gmail.test")).toBeTruthy()
  })
})
