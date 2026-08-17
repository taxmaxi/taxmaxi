import { describe, expect, it } from "vitest"

import { CMS_CACHE_CONTROL, withCmsEdgeCache } from "#/integrations/payload/edge-cache.server"

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

  it("evicts stale content when the background refresh returns 404", async () => {
    const request = new Request("https://www.taxmaxi.com/de/geloeschte-seite")
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
      resolve: async () => new Response("not found", { status: 404 }),
      now: () => 302_000,
    })

    expect(await staleResponse.text()).toBe("stale")
    await Promise.all(refreshContext.pending)

    let resolveCount = 0
    const response = await withCmsEdgeCache({
      request,
      cache,
      context: createContext(),
      resolve: async () => {
        resolveCount += 1
        return new Response("still not found", { status: 404 })
      },
      now: () => 303_000,
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe("still not found")
    expect(resolveCount).toBe(1)
  })

  it("shares cache entries across tracking query variants", async () => {
    const cache = new MemoryCache()
    const initialContext = createContext()

    await withCmsEdgeCache({
      request: new Request(
        "https://www.taxmaxi.com/de/krypto-steuer?utm_source=newsletter&utm_campaign=launch&fbclid=first"
      ),
      cache,
      context: initialContext,
      resolve: async () => cmsResponse("shared"),
      now: () => 1_000,
    })
    await Promise.all(initialContext.pending)

    let resolveCount = 0
    const response = await withCmsEdgeCache({
      request: new Request(
        "https://www.taxmaxi.com/de/krypto-steuer?utm_medium=social&gclid=second"
      ),
      cache,
      context: createContext(),
      resolve: async () => {
        resolveCount += 1
        return cmsResponse("unexpected")
      },
      now: () => 2_000,
    })

    expect(await response.text()).toBe("shared")
    expect(resolveCount).toBe(0)
  })

  it("keeps meaningful query parameters distinct", async () => {
    const cache = new MemoryCache()
    const initialContext = createContext()

    await withCmsEdgeCache({
      request: new Request("https://www.taxmaxi.com/api/cms?page=1&utm_source=newsletter"),
      cache,
      context: initialContext,
      resolve: async () => cmsResponse("page one"),
      now: () => 1_000,
    })
    await Promise.all(initialContext.pending)

    let resolveCount = 0
    const secondContext = createContext()
    const response = await withCmsEdgeCache({
      request: new Request("https://www.taxmaxi.com/api/cms?page=2&utm_source=social"),
      cache,
      context: secondContext,
      resolve: async () => {
        resolveCount += 1
        return cmsResponse("page two")
      },
      now: () => 2_000,
    })

    expect(await response.text()).toBe("page two")
    expect(resolveCount).toBe(1)
    await Promise.all(secondContext.pending)
  })
})

class MemoryCache {
  private readonly responses = new Map<string, Response>()

  async match(request: Request): Promise<Response | undefined> {
    return this.responses.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.responses.set(request.url, response.clone())
  }

  async delete(request: Request): Promise<boolean> {
    return this.responses.delete(request.url)
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
