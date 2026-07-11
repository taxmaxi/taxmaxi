import { createServerFn } from "@tanstack/react-start"
import { deleteCookie, getCookie } from "@tanstack/react-start/server"

const REST_SESSION_COOKIE_NAME = "taxmaxi_session"
const DEFAULT_REST_SERVER_URL = "http://localhost:4000"

const getRestServerUrl = (): string => {
  const value = process.env.TAXMAXI_API_BASE_URL?.trim()
  return value === undefined || value.length === 0 ? DEFAULT_REST_SERVER_URL : value
}

export const getAuthStatus = createServerFn({ method: "GET" }).handler(async () => {
  const sessionCookie = getCookie(REST_SESSION_COOKIE_NAME)
  if (sessionCookie) {
    return { isAuthenticated: true }
  }
  return { isAuthenticated: false }
})

export const getGuestSession = createServerFn({ method: "GET" }).handler(async () => {
  const guestSession = getCookie("guest_session")
  return guestSession
})

export const clearAuthSessionCookie = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(REST_SESSION_COOKIE_NAME, {
    path: "/",
  })
})

export const prepareCoinbaseSignIn = createServerFn({ method: "POST" }).handler(async () => {
  const url = new URL(getRestServerUrl())
  url.pathname = "/auth/authorize/coinbase"
  url.searchParams.set("redirectTo", "/app")

  return {
    redirectUrl: url.toString(),
  }
})
