import { createServerFn } from "@tanstack/react-start"
import { deleteCookie, getCookie } from "@tanstack/react-start/server"
import { TaxMaxi, isTaxMaxiUnauthorizedError } from "taxmaxi"

const REST_SESSION_COOKIE_NAME = "taxmaxi_session"
const DEFAULT_REST_SERVER_URL = "http://localhost:4000"

const getRestServerUrl = (): string => {
  const value = process.env.TAXMAXI_API_BASE_URL?.trim()
  return value === undefined || value.length === 0 ? DEFAULT_REST_SERVER_URL : value
}

const getCookieDomain = (): string | undefined => {
  // Empty means "no cookie domain" (local dev, see .dev.vars). The delete must
  // match the Domain attribute the API used when setting the cookie.
  const value = process.env.COOKIE_DOMAIN?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

const deleteAuthSessionCookie = (): void => {
  const domain = getCookieDomain()

  deleteCookie(REST_SESSION_COOKIE_NAME, {
    path: "/",
    ...(domain === undefined ? {} : { domain }),
  })
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
  deleteAuthSessionCookie()
})

export const logoutAuthSession = createServerFn({ method: "POST" }).handler(async () => {
  const sessionCookie = getCookie(REST_SESSION_COOKIE_NAME)

  if (sessionCookie !== undefined) {
    const taxmaxi = TaxMaxi.fromRequest({
      baseUrl: getRestServerUrl(),
      cookieHeader: `${REST_SESSION_COOKIE_NAME}=${sessionCookie}`,
    })

    try {
      await taxmaxi.auth.logout()
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) throw error
    }
  }

  deleteAuthSessionCookie()

  return { success: true }
})

export const prepareCoinbaseSignIn = createServerFn({ method: "POST" }).handler(async () => {
  const url = new URL(getRestServerUrl())
  url.pathname = "/auth/authorize/coinbase"
  url.searchParams.set("redirectTo", "/app")

  return {
    redirectUrl: url.toString(),
  }
})
