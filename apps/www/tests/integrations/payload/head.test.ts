import { describe, expect, it } from "vitest"

import type { CmsContentPage, LexicalDocument } from "#/integrations/payload/content"
import { createCmsPageHead } from "#/integrations/payload/head"

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

  it("escapes hostile CMS text in FAQ JSON-LD without changing its parsed value", () => {
    const hostileText = '</script><script>alert("faq")</script>'
    const page = {
      id: 1,
      kind: "landing",
      locale: "en",
      slug: "crypto-tax",
      title: "Crypto tax",
      content: emptyDocument,
      updatedAt: "2026-08-16T00:00:00.000Z",
      faqs: [
        {
          question: hostileText,
          answer: {
            root: {
              type: "root",
              children: [{ type: "paragraph", children: [{ type: "text", text: hostileText }] }],
            },
          },
        },
      ],
      sources: [],
      translations: [],
      seo: {
        title: "Crypto tax",
        noIndex: false,
      },
    } satisfies CmsContentPage

    const [faqScript] = createCmsPageHead(page).scripts

    expect(faqScript?.children).not.toContain("<")
    expect(faqScript?.children).toContain("\\u003c/script>")
    expect(JSON.parse(faqScript?.children ?? "{}")).toMatchObject({
      "@type": "FAQPage",
      mainEntity: [
        {
          name: hostileText,
          acceptedAnswer: { text: hostileText },
        },
      ],
    })
  })

  it("escapes hostile CMS text in Article JSON-LD without changing its parsed value", () => {
    const hostileText = '</script><script>alert("article")</script>'
    const page = {
      id: 1,
      kind: "news-article",
      locale: "en",
      slug: "security-update",
      title: hostileText,
      content: emptyDocument,
      publishedAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      author: hostileText,
      faqs: [],
      sources: [],
      translations: [],
      seo: {
        title: "Security update",
        description: hostileText,
        noIndex: false,
      },
    } satisfies CmsContentPage

    const [articleScript] = createCmsPageHead(page).scripts

    expect(articleScript?.children).not.toContain("<")
    expect(articleScript?.children).toContain("\\u003c/script>")
    expect(JSON.parse(articleScript?.children ?? "{}")).toMatchObject({
      "@type": "Article",
      headline: hostileText,
      description: hostileText,
      author: { name: hostileText },
    })
  })
})
