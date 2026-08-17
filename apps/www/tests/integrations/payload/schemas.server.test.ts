import { afterEach, describe, expect, it, vi } from "vitest"

import { findNewsArticle } from "#/integrations/payload/client.server"
import { LandingPageSchema, NewsArticleSchema } from "#/integrations/payload/schemas.server"

const lexicalDocument = {
  root: {
    type: "root",
    children: [
      {
        type: "upload",
        value: {
          id: 7,
          alt: "Tax report preview",
          url: "/media/tax-report.png",
        },
      },
    ],
  },
}

describe("Payload response schemas", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("decodes recursive Lexical content and media references", () => {
    const result = LandingPageSchema.safeParse({
      id: 1,
      slug: "crypto-tax",
      pageType: "general",
      title: "Crypto tax",
      excerpt: "Calculate crypto taxes.",
      content: lexicalDocument,
      updatedAt: "2026-08-17T00:00:00.000Z",
    })

    expect(result.success).toBe(true)
  })

  it("rejects values outside the Payload content contract", () => {
    const result = NewsArticleSchema.safeParse({
      id: 2,
      slug: "tax-update",
      title: "Tax update",
      content: lexicalDocument,
      publishedAt: "2026-08-17T00:00:00.000Z",
      category: "unsupported-category",
      updatedAt: "2026-08-17T00:00:00.000Z",
    })

    expect(result.success).toBe(false)
  })

  it("rejects a malformed collection response at the HTTP boundary", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ docs: [{ id: "not-a-number" }] }), {
            headers: { "Content-Type": "application/json" },
          })
      )
    )

    await expect(findNewsArticle({ locale: "en", slug: "tax-update" })).rejects.toThrow(
      "Payload response did not match the content contract"
    )
  })

  it("maps a failed Payload request to a client error", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")))

    await expect(findNewsArticle({ locale: "en", slug: "tax-update" })).rejects.toThrow(
      "Payload request failed: Error: network unavailable"
    )
  })

  it("rejects unsuccessful Payload responses", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )

    await expect(findNewsArticle({ locale: "en", slug: "tax-update" })).rejects.toThrow(
      "Payload returned HTTP 503"
    )
  })

  it("rejects invalid JSON returned by Payload", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{"))
    )

    await expect(findNewsArticle({ locale: "en", slug: "tax-update" })).rejects.toThrow(
      "Payload returned invalid JSON"
    )
  })

  it("maps a valid response and its alternate locale to a CMS page", async () => {
    stubPayloadApiUrl()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          docs: [
            {
              ...newsArticle,
              featuredImage: {
                id: 7,
                alt: "Tax report preview",
                url: "/media/tax-report.png",
              },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ...newsArticle,
          slug: "steuer-update",
          title: "Steuer-Update",
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const page = await findNewsArticle({ locale: "en", slug: "tax-update" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(page).toMatchObject({
      kind: "news-article",
      locale: "en",
      slug: "tax-update",
      title: "Tax update",
      image: {
        url: "https://cms.taxmaxi.com/media/tax-report.png",
      },
      translations: [
        { locale: "en", slug: "tax-update" },
        { locale: "de", slug: "steuer-update" },
      ],
    })
  })

  it("keeps the primary page when the alternate locale request fails", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ docs: [newsArticle] }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
    )

    const page = await findNewsArticle({ locale: "en", slug: "tax-update" })

    expect(page?.translations).toEqual([{ locale: "en", slug: "tax-update" }])
  })

  it("returns null when Payload has no matching article", async () => {
    stubPayloadApiUrl()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ docs: [] }))
    )

    await expect(findNewsArticle({ locale: "en", slug: "missing" })).resolves.toBeNull()
  })
})

function stubPayloadApiUrl() {
  vi.stubEnv("PAYLOAD_API_URL", "https://cms.taxmaxi.com")
}

const newsArticle = {
  id: 2,
  slug: "tax-update",
  title: "Tax update",
  content: lexicalDocument,
  publishedAt: "2026-08-17T00:00:00.000Z",
  category: "regulatory-update",
  updatedAt: "2026-08-17T00:00:00.000Z",
} as const
