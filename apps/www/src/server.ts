import { paraglideMiddleware } from "./paraglide/server.js"
import handler from "@tanstack/react-start/server-entry"
import { WorkerEntrypoint } from "cloudflare:workers"
import type { Locale } from "./paraglide/runtime"

import {
  applyPrivateCachePolicy,
  isCmsCacheableResponse,
} from "./integrations/payload/cache-policy.server"

const PRIVATE_SESSION_COOKIES = new Set(["guest_session", "taxmaxi_session"])
const CMS_COLLECTION_ROUTES = new Set(["articles", "tax-law"])
const NON_CMS_SINGLE_SEGMENT_ROUTES = new Set([
  "_serverFn",
  "about",
  "api",
  "app",
  "assets",
  "coinbase-sign-in",
  "dashboard",
  "demo",
  "imprint",
  "login",
  "privacy",
  "sign-up",
  "terms",
])
const CMS_TRACKING_QUERY_PARAMETERS = new Set([
  "_gl",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "li_fat_id",
  "msclkid",
  "ttclid",
  "twclid",
  "wbraid",
])

interface CmsPageCacheProps {
  readonly hostname: string
  readonly locale: Locale
}

export class CmsPages extends WorkerEntrypoint<Env, CmsPageCacheProps> {
  override async fetch(request: Request): Promise<Response> {
    const response = await paraglideMiddleware(request, () => handler.fetch(request))
    return isCmsCacheableResponse(response) ? response : applyPrivateCachePolicy(response)
  }
}

export default {
  async fetch(req: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    return paraglideMiddleware(req, ({ locale, request }) => {
      if (shouldBypassPageCache(req, request)) {
        return handler.fetch(req)
      }

      const cachedPages = ctx.exports.CmsPages({
        props: { hostname: new URL(req.url).hostname, locale },
      })
      return cachedPages.fetch(req, { cf: { cacheKey: toCmsCacheKey(req) } })
    })
  },
} satisfies ExportedHandler<Env>

function shouldBypassPageCache(request: Request, routeRequest: Request): boolean {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    request.headers.has("Authorization") ||
    hasPrivateSessionCookie(request)
  ) {
    return true
  }

  return !isPotentialCmsPage(new URL(routeRequest.url).pathname)
}

function hasPrivateSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("Cookie")

  if (!cookieHeader) {
    return false
  }

  return cookieHeader.split(";").some((cookie) => {
    const separator = cookie.indexOf("=")
    const name = (separator === -1 ? cookie : cookie.slice(0, separator)).trim()
    return PRIVATE_SESSION_COOKIES.has(name)
  })
}

function isPotentialCmsPage(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean)

  if (segments.length === 1) {
    return !NON_CMS_SINGLE_SEGMENT_ROUTES.has(segments[0])
  }

  return segments.length === 2 && CMS_COLLECTION_ROUTES.has(segments[0])
}

function toCmsCacheKey(request: Request): string {
  const url = new URL(request.url)

  for (const parameter of Array.from(url.searchParams.keys())) {
    const lowercaseParameter = parameter.toLowerCase()

    if (
      lowercaseParameter.startsWith("utm_") ||
      CMS_TRACKING_QUERY_PARAMETERS.has(lowercaseParameter)
    ) {
      url.searchParams.delete(parameter)
    }
  }

  return url.pathname + url.search
}
