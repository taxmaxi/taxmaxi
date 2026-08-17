import { describe, expect, it } from "vitest"

import {
  CLOUDFLARE_CACHE_CONTROL_HEADER,
  CMS_BROWSER_CACHE_CONTROL,
  CMS_CACHE_TAG,
  CMS_EDGE_CACHE_CONTROL,
  applyPrivateCachePolicy,
  isCmsCacheableResponse,
} from "#/integrations/payload/cache-policy.server"

describe("CMS cache policy", () => {
  it("uses separate browser and Cloudflare cache policies", () => {
    expect(CMS_BROWSER_CACHE_CONTROL).toBe("public, max-age=60")
    expect(CMS_EDGE_CACHE_CONTROL).toBe(
      "public, max-age=300, stale-while-revalidate=86400, stale-if-error=86400"
    )
  })

  it("recognizes only successful responses with the CMS edge policy", () => {
    const response = new Response("page", {
      headers: {
        [CLOUDFLARE_CACHE_CONTROL_HEADER]: CMS_EDGE_CACHE_CONTROL,
        "Cache-Tag": CMS_CACHE_TAG,
      },
    })

    expect(isCmsCacheableResponse(response)).toBe(true)
    expect(
      isCmsCacheableResponse(
        new Response("missing", {
          status: 404,
          headers: { [CLOUDFLARE_CACHE_CONTROL_HEADER]: CMS_EDGE_CACHE_CONTROL },
        })
      )
    ).toBe(false)
    expect(isCmsCacheableResponse(new Response("public"))).toBe(false)
  })

  it("prevents Cloudflare's heuristic caching for non-CMS responses", async () => {
    const response = applyPrivateCachePolicy(
      new Response("private", {
        headers: {
          "Cache-Control": "public, max-age=60",
          [CLOUDFLARE_CACHE_CONTROL_HEADER]: CMS_EDGE_CACHE_CONTROL,
          "CDN-Cache-Control": "public, max-age=300",
          "Cache-Tag": CMS_CACHE_TAG,
        },
      })
    )

    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.has(CLOUDFLARE_CACHE_CONTROL_HEADER)).toBe(false)
    expect(response.headers.has("CDN-Cache-Control")).toBe(false)
    expect(response.headers.has("Cache-Tag")).toBe(false)
    expect(await response.text()).toBe("private")
  })
})
