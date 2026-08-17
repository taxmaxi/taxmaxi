import { beforeEach, describe, expect, it, vi } from "vitest"

const { paraglideMiddleware, withCmsEdgeCache } = vi.hoisted(() => ({
  paraglideMiddleware: vi.fn(),
  withCmsEdgeCache: vi.fn(),
}))

vi.mock("../src/paraglide/server.js", () => ({ paraglideMiddleware }))
vi.mock("../src/integrations/payload/edge-cache.server", () => ({ withCmsEdgeCache }))
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: vi.fn() },
}))

import server from "../src/server"

describe("server middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("caches", { default: {} })
  })

  it("runs locale middleware for cached responses", async () => {
    const cachedResponse = new Response("cached")
    const localizedResponse = new Response("cached", {
      headers: { "Set-Cookie": "PARAGLIDE_LOCALE=de" },
    })

    withCmsEdgeCache.mockResolvedValue(cachedResponse)
    paraglideMiddleware.mockImplementation(
      async (_request: Request, resolve: () => Promise<Response>) => {
        expect(await resolve()).toBe(cachedResponse)
        return localizedResponse
      }
    )

    const response = await server.fetch(
      new Request("https://www.taxmaxi.com/de/krypto-steuer"),
      {} as Env,
      {} as ExecutionContext
    )

    expect(response).toBe(localizedResponse)
    expect(response.headers.get("Set-Cookie")).toBe("PARAGLIDE_LOCALE=de")
    expect(paraglideMiddleware).toHaveBeenCalledOnce()
    expect(withCmsEdgeCache).toHaveBeenCalledOnce()
  })
})
