// @vitest-environment jsdom

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AccountMenu } from "#/components/account-menu"
import { logoutFromApp } from "#/lib/auth-session"

beforeEach(() => {
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

const renderAccountMenu = async (onLogout = vi.fn().mockResolvedValue(undefined)) => {
  const rootRoute = createRootRoute({ component: Outlet })
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    component: () => <AccountMenu onLogout={onLogout} />,
  })
  const billingRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "billing",
    component: () => <p>Billing page</p>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "settings",
    component: () => <p>Settings page</p>,
  })
  const assetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/assets",
    component: () => <p>Assets page</p>,
  })
  const routeTree = rootRoute.addChildren([
    appRoute.addChildren([billingRoute, settingsRoute]),
    assetsRoute,
  ])
  const history = createMemoryHistory({ initialEntries: ["/app"] })
  const router = createRouter({ history, routeTree })

  await router.load()
  render(<RouterProvider router={router} />)

  return { history, onLogout }
}

const openAccountMenu = () => {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu" }), {
    button: 0,
    ctrlKey: false,
  })
}

describe("AccountMenu", () => {
  it.each([
    { label: "Assets", path: "/assets" },
    { label: "Billing", path: "/app/billing" },
    { label: "Settings", path: "/app/settings" },
  ])("navigates to $label", async ({ label, path }) => {
    const { history } = await renderAccountMenu()

    openAccountMenu()
    fireEvent.click(await screen.findByRole("menuitem", { name: label }))

    await waitFor(() => expect(history.location.pathname).toBe(path))
  })

  it("runs the logout action from the account menu", async () => {
    const { onLogout } = await renderAccountMenu()

    openAccountMenu()
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }))

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
  })
})

describe("logoutFromApp", () => {
  it("invalidates the backend session before clearing client state and returning to login", async () => {
    const calls: Array<string> = []

    await logoutFromApp({
      logout: async () => {
        calls.push("backend")
      },
      clearClientState: () => {
        calls.push("client")
      },
      navigateToLogin: async () => {
        calls.push("login")
      },
    })

    expect(calls).toEqual(["backend", "client", "login"])
  })

  it("keeps client state when backend logout fails", async () => {
    const clearClientState = vi.fn()
    const navigateToLogin = vi.fn()

    await expect(
      logoutFromApp({
        logout: () => Promise.reject(new Error("API unavailable")),
        clearClientState,
        navigateToLogin,
      })
    ).rejects.toThrow("API unavailable")

    expect(clearClientState).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
  })
})
