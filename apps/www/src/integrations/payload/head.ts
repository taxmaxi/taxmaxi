import { seo } from "#/lib/seo"

import { getCmsPageUrl, lexicalToPlainText, type CmsContentPage } from "./content"

export function createCmsPageHead(page: CmsContentPage) {
  const canonicalUrl = page.seo.canonicalUrl ?? getCmsPageUrl(page)
  const socialImage = page.socialImage ?? page.image
  const englishTranslation = page.translations.find(({ locale }) => locale === "en")
  const scripts: Array<{ type: string; children: string }> = []

  if (page.faqs.length > 0) {
    scripts.push({
      type: "application/ld+json",
      children: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: page.faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: lexicalToPlainText(faq.answer),
          },
        })),
      }),
    })
  }

  if (page.kind !== "landing") {
    scripts.push({
      type: "application/ld+json",
      children: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: page.title,
        description: page.seo.description,
        datePublished: page.publishedAt,
        dateModified: page.updatedAt,
        inLanguage: page.locale,
        mainEntityOfPage: canonicalUrl,
        ...(page.reviewedBy ? { author: { "@type": "Person", name: page.reviewedBy } } : {}),
        ...(socialImage ? { image: socialImage.url } : {}),
      }),
    })
  }

  return {
    meta: seo({
      title: page.seo.title,
      description: page.seo.description,
      type: page.kind === "landing" ? "website" : "article",
      url: canonicalUrl,
      robots: page.seo.noIndex ? "noindex, nofollow" : "index, follow",
      ...(socialImage
        ? {
            image: {
              url: socialImage.url,
              ...(socialImage.mimeType ? { type: socialImage.mimeType } : {}),
              ...(socialImage.width ? { width: String(socialImage.width) } : {}),
              ...(socialImage.height ? { height: String(socialImage.height) } : {}),
              alt: socialImage.alt,
            },
          }
        : {}),
    }),
    links: [
      { rel: "canonical", href: canonicalUrl },
      ...page.translations.map((translation) => ({
        rel: "alternate",
        hrefLang: translation.locale,
        href: getCmsPageUrl({ kind: page.kind, ...translation }),
      })),
      ...(englishTranslation
        ? [
            {
              rel: "alternate",
              hrefLang: "x-default",
              href: getCmsPageUrl({ kind: page.kind, ...englishTranslation }),
            },
          ]
        : []),
    ],
    scripts,
  }
}
