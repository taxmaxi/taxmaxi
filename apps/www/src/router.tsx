import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { QueryClient } from "@tanstack/react-query"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeader } from "@tanstack/react-start/server"
import { TaxMaxi } from "taxmaxi"
import { TaxMaxiInternal } from "taxmaxi/internal"

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

export function getRouter() {
  const queryClient = new QueryClient()
  let browserTaxMaxi: TaxMaxi | undefined
  let browserInternalTaxMaxi: TaxMaxiInternal | undefined

  const taxmaxi = () => {
    const cookieHeader = getServerCookieHeader()

    if (cookieHeader !== undefined) {
      return TaxMaxi.fromRequest({
        baseUrl: nonEmptyBaseUrl(process.env.TAXMAXI_API_BASE_URL),
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

    if (cookieHeader !== undefined) {
      return new TaxMaxiInternal({
        baseUrl: nonEmptyBaseUrl(process.env.TAXMAXI_API_BASE_URL),
        headers: { cookie: cookieHeader },
      })
    }

    browserInternalTaxMaxi ??= new TaxMaxiInternal({
      baseUrl: nonEmptyBaseUrl(import.meta.env.VITE_TAXMAXI_API_BASE_URL),
      credentials: "include",
    })
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
