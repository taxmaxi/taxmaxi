import { beforeEach, describe, expect, it, vi } from "vitest"

const { cmsPages, cmsPagesFetch, handlerFetch, paraglideMiddleware } = vi.hoisted(() => ({
  cmsPages: vi.fn(),
  cmsPagesFetch: vi.fn(),
  handlerFetch: vi.fn(),
  paraglideMiddleware: vi.fn(),
}))

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}))
vi.mock("../src/paraglide/server.js", () => ({ paraglideMiddleware }))
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: handlerFetch },
}))

import {
  CLOUDFLARE_CACHE_CONTROL_HEADER,
  CMS_EDGE_CACHE_CONTROL,
} from "../src/integrations/payload/cache-policy.server"
import server, { CmsPages } from "../src/server"

beforeEach(() => {
  vi.clearAllMocks()
  paraglideMiddleware.mockImplementation(
    async (request: Request, resolve: (input: { locale: "de"; request: Request }) => unknown) => {
      const url = new URL(request.url)
      url.pathname = url.pathname.replace(/^\/de(?=\/|$)/, "") || "/"
      return resolve({ locale: "de", request: new Request(url, request) })
    }
  )
})

describe("server cache gateway", () => {
  beforeEach(() => {
    cmsPages.mockReturnValue({ fetch: cmsPagesFetch })
  })

  it("routes anonymous pages through a locale- and host-partitioned cached entrypoint", async () => {
    const request = new Request("https://www.taxmaxi.com/de/krypto-steuer?utm_source=newsletter")
    const cachedResponse = new Response("cached")
    cmsPagesFetch.mockResolvedValue(cachedResponse)

    const response = await server.fetch(request, {} as Env, createContext())

    expect(response).toBe(cachedResponse)
    expect(cmsPages).toHaveBeenCalledWith({
      props: { hostname: "www.taxmaxi.com", locale: "de" },
    })
    expect(cmsPagesFetch).toHaveBeenCalledWith(request, {
      cf: { cacheKey: "/de/krypto-steuer" },
    })
    expect(handlerFetch).not.toHaveBeenCalled()
  })

  it("removes tracking parameters from the cache key but keeps meaningful query parameters", async () => {
    const request = new Request(
      "https://www.taxmaxi.com/de/krypto-steuer?preview=1&utm_campaign=launch&GCLID=click"
    )
    cmsPagesFetch.mockResolvedValue(new Response("cached"))

    await server.fetch(request, {} as Env, createContext())

    expect(cmsPagesFetch).toHaveBeenCalledWith(request, {
      cf: { cacheKey: "/de/krypto-steuer?preview=1" },
    })
  })

  it.each([
    ["authorization", { Authorization: "Bearer token" }],
    ["authenticated session", { Cookie: "taxmaxi_session=session" }],
    ["guest session", { Cookie: "guest_session=guest" }],
  ])("bypasses page caching for %s requests", async (_name, headers) => {
    const request = new Request("https://www.taxmaxi.com/de/krypto-steuer", { headers })
    const directResponse = new Response("direct")
    handlerFetch.mockResolvedValue(directResponse)

    const response = await server.fetch(request, {} as Env, createContext())

    expect(response).toBe(directResponse)
    expect(cmsPages).not.toHaveBeenCalled()
    expect(handlerFetch).toHaveBeenCalledWith(request)
  })

  it("bypasses page caching for server functions", async () => {
    const request = new Request("https://www.taxmaxi.com/_serverFn/function-id")
    const directResponse = new Response("server function")
    handlerFetch.mockResolvedValue(directResponse)

    const response = await server.fetch(request, {} as Env, createContext())

    expect(response).toBe(directResponse)
    expect(cmsPages).not.toHaveBeenCalled()
  })

  it("routes localized non-CMS pages directly", async () => {
    const request = new Request("https://www.taxmaxi.com/de/about")
    const directResponse = new Response("about")
    handlerFetch.mockResolvedValue(directResponse)

    const response = await server.fetch(request, {} as Env, createContext())

    expect(response).toBe(directResponse)
    expect(cmsPages).not.toHaveBeenCalled()
    expect(handlerFetch).toHaveBeenCalledWith(request)
  })

  it("bypasses page caching for mutations", async () => {
    const request = new Request("https://www.taxmaxi.com/coinbase-sign-in", { method: "POST" })
    const directResponse = new Response("mutation")
    handlerFetch.mockResolvedValue(directResponse)

    const response = await server.fetch(request, {} as Env, createContext())

    expect(response).toBe(directResponse)
    expect(cmsPages).not.toHaveBeenCalled()
  })
})

describe("cached CMS page entrypoint", () => {
  it("keeps the explicit CMS cache policy", async () => {
    const cmsResponse = new Response("cms", {
      headers: { [CLOUDFLARE_CACHE_CONTROL_HEADER]: CMS_EDGE_CACHE_CONTROL },
    })
    handlerFetch.mockResolvedValue(cmsResponse)

    const response = await createCmsPages().fetch(new Request("https://taxmaxi.com/de/news/post"))

    expect(response).toBe(cmsResponse)
    expect(response.headers.get(CLOUDFLARE_CACHE_CONTROL_HEADER)).toBe(CMS_EDGE_CACHE_CONTROL)
  })

  it("marks every response without the explicit CMS policy as private", async () => {
    handlerFetch.mockResolvedValue(
      new Response("app", {
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Cache-Tag": "other",
          [CLOUDFLARE_CACHE_CONTROL_HEADER]: "public, max-age=3600",
        },
      })
    )

    const response = await createCmsPages().fetch(new Request("https://taxmaxi.com/de/unknown"))

    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.has(CLOUDFLARE_CACHE_CONTROL_HEADER)).toBe(false)
    expect(response.headers.has("Cache-Tag")).toBe(false)
  })
})

function createContext(): ExecutionContext {
  return { exports: { CmsPages: cmsPages } } as unknown as ExecutionContext
}

function createCmsPages(): CmsPages {
  return new CmsPages(createContext(), {} as Env)
}
