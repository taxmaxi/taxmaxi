import { describe, expect, it } from "vitest"

import { CMS_CACHE_CONTROL, withCmsEdgeCache } from "./edge-cache.server"

describe("CMS edge cache", () => {
  it("stores CMS responses and serves a fresh response without resolving again", async () => {
    const request = new Request("https://www.taxmaxi.com/coinbase-tax")
    const cache = new MemoryCache()
    const firstContext = createContext()

    const firstResponse = await withCmsEdgeCache({
      request,
      cache,
      context: firstContext,
      resolve: async () => cmsResponse("first"),
      now: () => 1_000,
    })

    expect(await firstResponse.text()).toBe("first")
    await Promise.all(firstContext.pending)

    let resolveCount = 0
    const cachedResponse = await withCmsEdgeCache({
      request,
      cache,
      context: createContext(),
      resolve: async () => {
        resolveCount += 1
        return cmsResponse("second")
      },
      now: () => 2_000,
    })

    expect(await cachedResponse.text()).toBe("first")
    expect(cachedResponse.headers.get("Cache-Control")).toBe(CMS_CACHE_CONTROL)
    expect(resolveCount).toBe(0)
  })

  it("serves stale content while refreshing it in the background", async () => {
    const request = new Request("https://www.taxmaxi.com/de/krypto-steuer")
    const cache = new MemoryCache()
    const initialContext = createContext()

    await withCmsEdgeCache({
      request,
      cache,
      context: initialContext,
      resolve: async () => cmsResponse("stale"),
      now: () => 1_000,
    })
    await Promise.all(initialContext.pending)

    const refreshContext = createContext()
    const staleResponse = await withCmsEdgeCache({
      request,
      cache,
      context: refreshContext,
      resolve: async () => cmsResponse("fresh"),
      now: () => 302_000,
    })

    expect(await staleResponse.text()).toBe("stale")
    await Promise.all(refreshContext.pending)

    const refreshedResponse = await withCmsEdgeCache({
      request,
      cache,
      context: createContext(),
      resolve: async () => cmsResponse("unexpected"),
      now: () => 303_000,
    })

    expect(await refreshedResponse.text()).toBe("fresh")
  })
})

class MemoryCache {
  private response: Response | undefined

  async match(_request: Request): Promise<Response | undefined> {
    return this.response?.clone()
  }

  async put(_request: Request, response: Response): Promise<void> {
    this.response = response.clone()
  }
}

function createContext() {
  const pending: Array<Promise<unknown>> = []

  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
  }
}

function cmsResponse(body: string): Response {
  return new Response(body, { headers: { "Cache-Control": CMS_CACHE_CONTROL } })
}
