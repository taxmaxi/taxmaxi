import { describe, expect, it } from "vitest"

import {
  createPayloadCollectionUrl,
  formatCmsDate,
  getCmsPagePath,
  getCmsPageUrl,
  lexicalToPlainText,
  toPayloadLocale,
  type LexicalDocument,
} from "./content"

describe("Payload content integration", () => {
  it("maps Paraglide locales to Payload locales", () => {
    expect(toPayloadLocale("en")).toBe("en")
    expect(toPayloadLocale("de")).toBe("de")
  })

  it("queries localized slugs without falling back to another locale", () => {
    const url = createPayloadCollectionUrl({
      baseUrl: new URL("https://cms.taxmaxi.com"),
      collection: "landing-pages",
      locale: "de",
      slug: "krypto-steuer-deutschland",
    })

    expect(url.pathname).toBe("/api/landing-pages")
    expect(url.searchParams.get("where[slug][equals]")).toBe("krypto-steuer-deutschland")
    expect(url.searchParams.get("locale")).toBe("de")
    expect(url.searchParams.get("fallback-locale")).toBe("none")
  })

  it("builds localized public paths and canonical URLs", () => {
    expect(getCmsPagePath({ kind: "landing", locale: "en", slug: "coinbase-tax" })).toBe(
      "/coinbase-tax"
    )
    expect(getCmsPagePath({ kind: "news-article", locale: "de", slug: "neue-regeln" })).toBe(
      "/de/artikel/neue-regeln"
    )
    expect(getCmsPageUrl({ kind: "tax-law-article", locale: "de", slug: "haltefrist" })).toBe(
      "https://www.taxmaxi.com/de/steuerrecht/haltefrist"
    )
  })

  it("extracts plain FAQ answers from nested Lexical content", () => {
    const document: LexicalDocument = {
      root: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", text: "Hold assets for " },
              { type: "text", text: "one year", format: 1 },
              { type: "text", text: "." },
            ],
          },
        ],
      },
    }

    expect(lexicalToPlainText(document)).toBe("Hold assets for one year.")
  })

  it("formats CMS dates in UTC for stable server and client output", () => {
    expect(formatCmsDate("2026-08-14T00:30:00.000Z", "en")).toBe("Aug 14, 2026")
    expect(formatCmsDate("2026-08-14T00:30:00.000Z", "de")).toBe("14.08.2026")
  })
})
