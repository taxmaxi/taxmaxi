import { describe, expect, it } from "vitest"

import type { CmsContentPage, LexicalDocument } from "./content"
import { createCmsPageHead } from "./head"

const emptyDocument: LexicalDocument = { root: { type: "root", children: [] } }

describe("CMS page head", () => {
  it("uses each translation's canonical override for hreflang links", () => {
    const page = {
      id: 1,
      kind: "landing",
      locale: "de",
      slug: "krypto-steuer",
      title: "Krypto-Steuer",
      content: emptyDocument,
      updatedAt: "2026-08-16T00:00:00.000Z",
      faqs: [],
      sources: [],
      translations: [
        {
          locale: "de",
          slug: "krypto-steuer",
          canonicalUrl: "https://steuer.example/de/krypto",
        },
        {
          locale: "en",
          slug: "crypto-tax",
          canonicalUrl: "https://tax.example/en/crypto",
        },
      ],
      seo: {
        title: "Krypto-Steuer",
        canonicalUrl: "https://steuer.example/de/krypto",
        noIndex: false,
      },
    } satisfies CmsContentPage

    const alternates = createCmsPageHead(page).links.filter((link) => "hrefLang" in link)

    expect(alternates).toEqual([
      {
        rel: "alternate",
        hrefLang: "de",
        href: "https://steuer.example/de/krypto",
      },
      {
        rel: "alternate",
        hrefLang: "en",
        href: "https://tax.example/en/crypto",
      },
      {
        rel: "alternate",
        hrefLang: "x-default",
        href: "https://tax.example/en/crypto",
      },
    ])
  })
})
