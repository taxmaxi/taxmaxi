import { CMS_ROUTE_STALE_TIME_MS } from "./content"

const CMS_BROWSER_TTL_SECONDS = 60
const CMS_EDGE_STALE_SECONDS = 24 * 60 * 60

export const CLOUDFLARE_CACHE_CONTROL_HEADER = "Cloudflare-CDN-Cache-Control"
export const CMS_BROWSER_CACHE_CONTROL = `public, max-age=${CMS_BROWSER_TTL_SECONDS}`
export const CMS_EDGE_CACHE_CONTROL = `public, max-age=${CMS_ROUTE_STALE_TIME_MS / 1_000}, stale-while-revalidate=${CMS_EDGE_STALE_SECONDS}, stale-if-error=${CMS_EDGE_STALE_SECONDS}`
export const CMS_CACHE_TAG = "cms"

export function isCmsCacheableResponse(response: Response): boolean {
  return (
    response.status === 200 &&
    response.headers.get(CLOUDFLARE_CACHE_CONTROL_HEADER) === CMS_EDGE_CACHE_CONTROL
  )
}

export function applyPrivateCachePolicy(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "private, no-store")
  headers.delete(CLOUDFLARE_CACHE_CONTROL_HEADER)
  headers.delete("CDN-Cache-Control")
  headers.delete("Cache-Tag")

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
