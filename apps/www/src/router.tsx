import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { QueryClient } from "@tanstack/react-query"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeader } from "@tanstack/react-start/server"
import { TaxMaxi } from "taxmaxi"
import { TaxMaxiInternal } from "taxmaxi/internal"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

import { routeTree } from "./routeTree.gen"
import { deLocalizeUrl, localizeUrl } from "./paraglide/runtime"
import { DefaultCatchBoundary } from "./components/catch-boundary"
import { NotFound } from "./components/not-found"

const getServerCookieHeader = createIsomorphicFn()
  .server(() => getRequestHeader("Cookie") ?? "")
  .client(() => undefined)

const nonEmptyBaseUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

const getServerApiBaseUrl = (): string | undefined =>
  Effect.runSync(Config.option(Config.string("TAXMAXI_API_BASE_URL"))).pipe(
    Option.getOrUndefined,
    nonEmptyBaseUrl
  )

export function getRouter() {
  const queryClient = new QueryClient()
  let browserTaxMaxi: TaxMaxi | undefined
  let browserInternalTaxMaxi: TaxMaxiInternal | undefined

  const taxmaxi = () => {
    const cookieHeader = getServerCookieHeader()

    if (cookieHeader !== undefined) {
      return TaxMaxi.fromRequest({
        baseUrl: getServerApiBaseUrl(),
        cookieHeader,
      })
    }

    browserTaxMaxi ??= TaxMaxi.fromBrowserSession({
      baseUrl: nonEmptyBaseUrl(import.meta.env.VITE_TAXMAXI_API_BASE_URL),
    })
    return browserTaxMaxi
  }

  const internalTaxmaxi = () => {
    const cookieHeader = getServerCookieHeader()
    const baseUrl =
      cookieHeader === undefined
        ? nonEmptyBaseUrl(import.meta.env.VITE_TAXMAXI_API_BASE_URL)
        : getServerApiBaseUrl()

    if (cookieHeader !== undefined) {
      return new TaxMaxiInternal({ baseUrl, headers: { cookie: cookieHeader } })
    }

    browserInternalTaxMaxi ??= new TaxMaxiInternal({ baseUrl, credentials: "include" })
    return browserInternalTaxMaxi
  }

  const router = createTanStackRouter({
    routeTree,
    context: {
      queryClient,
      taxmaxi,
      internalTaxmaxi,
    },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url),
      output: ({ url }) => localizeUrl(url),
    },
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
