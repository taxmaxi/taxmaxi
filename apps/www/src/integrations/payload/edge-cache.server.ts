import { CMS_ROUTE_STALE_TIME_MS } from "./content"

const CMS_BROWSER_TTL_SECONDS = 60
const CMS_EDGE_STALE_TIME_MS = 24 * 60 * 60 * 1_000
const CMS_EDGE_RETENTION_SECONDS = (CMS_ROUTE_STALE_TIME_MS + CMS_EDGE_STALE_TIME_MS) / 1_000
const CMS_STORED_AT_HEADER = "X-TaxMaxi-CMS-Stored-At"

export const CMS_CACHE_CONTROL = `public, max-age=${CMS_BROWSER_TTL_SECONDS}, s-maxage=${CMS_ROUTE_STALE_TIME_MS / 1_000}, stale-while-revalidate=${CMS_EDGE_STALE_TIME_MS / 1_000}`

interface CmsEdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

interface CmsEdgeCacheContext {
  waitUntil(promise: Promise<unknown>): void
}

export async function withCmsEdgeCache({
  request,
  cache,
  context,
  resolve,
  now = Date.now,
}: {
  readonly request: Request
  readonly cache: CmsEdgeCache
  readonly context: CmsEdgeCacheContext
  readonly resolve: () => Promise<Response>
  readonly now?: () => number
}): Promise<Response> {
  if (request.method !== "GET" || request.headers.has("Authorization")) {
    return resolve()
  }

  const cached = await cache.match(request)
  const storedAtHeader = cached?.headers.get(CMS_STORED_AT_HEADER)
  const storedAt = storedAtHeader ? Number(storedAtHeader) : Number.NaN
  const age = now() - storedAt

  if (cached && Number.isFinite(storedAt) && age >= 0) {
    if (age <= CMS_ROUTE_STALE_TIME_MS) {
      return toClientResponse(cached)
    }

    if (age <= CMS_ROUTE_STALE_TIME_MS + CMS_EDGE_STALE_TIME_MS) {
      context.waitUntil(resolveAndStore({ request, cache, resolve, now }))
      return toClientResponse(cached)
    }
  }

  const response = await resolve()
  scheduleStore({ request, response, cache, context, now })
  return response
}

async function resolveAndStore({
  request,
  cache,
  resolve,
  now,
}: {
  readonly request: Request
  readonly cache: CmsEdgeCache
  readonly resolve: () => Promise<Response>
  readonly now: () => number
}): Promise<void> {
  const response = await resolve()

  if (isCmsResponse(response)) {
    await cache.put(request, toStoredResponse(response, now()))
  }
}

function scheduleStore({
  request,
  response,
  cache,
  context,
  now,
}: {
  readonly request: Request
  readonly response: Response
  readonly cache: CmsEdgeCache
  readonly context: CmsEdgeCacheContext
  readonly now: () => number
}) {
  if (isCmsResponse(response)) {
    context.waitUntil(cache.put(request, toStoredResponse(response, now())))
  }
}

function isCmsResponse(response: Response): boolean {
  return response.ok && response.headers.get("Cache-Control") === CMS_CACHE_CONTROL
}

function toStoredResponse(response: Response, storedAt: number): Response {
  const headers = new Headers(response.headers)
  headers.delete("Set-Cookie")
  headers.set("Cache-Control", `public, max-age=${CMS_EDGE_RETENTION_SECONDS}`)
  headers.set(CMS_STORED_AT_HEADER, String(storedAt))

  return new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function toClientResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete(CMS_STORED_AT_HEADER)
  headers.set("Cache-Control", CMS_CACHE_CONTROL)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
