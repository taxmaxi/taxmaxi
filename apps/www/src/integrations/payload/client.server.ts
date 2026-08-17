import { z } from "zod"

import {
  createPayloadCollectionUrl,
  createPayloadDocumentUrl,
  type CmsContentPage,
  type CmsCta,
  type CmsImage,
  type CmsSource,
  type CmsTranslation,
  type LexicalDocument,
  type LexicalNode,
  type PayloadLandingPage,
  type PayloadLocale,
  type PayloadMedia,
  type PayloadNewsArticle,
  type PayloadTaxLawArticle,
} from "./content"
import {
  LandingPagesResponseSchema,
  LandingPageSchema,
  NewsArticlesResponseSchema,
  NewsArticleSchema,
  TaxLawArticlesResponseSchema,
  TaxLawArticleSchema,
} from "./schemas.server"

const PAYLOAD_REQUEST_TIMEOUT_MS = 5_000
const TAXMAXI_ORIGIN = "https://www.taxmaxi.com"

class PayloadClientError extends Error {}

function payloadApiBaseUrl(): URL {
  const configuredUrl = process.env.PAYLOAD_API_URL

  if (!configuredUrl) {
    throw new PayloadClientError("PAYLOAD_API_URL is required")
  }

  try {
    return new URL(configuredUrl)
  } catch {
    throw new PayloadClientError("PAYLOAD_API_URL must be an absolute URL")
  }
}

async function requestPayload<A>(url: URL, schema: z.ZodType<A>): Promise<A> {
  let response: Response

  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PAYLOAD_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new PayloadClientError(`Payload request failed: ${String(error)}`)
  }

  if (!response.ok) {
    throw new PayloadClientError(`Payload returned HTTP ${response.status}`)
  }

  let body: unknown

  try {
    body = await response.json()
  } catch (error) {
    throw new PayloadClientError(`Payload returned invalid JSON: ${String(error)}`)
  }

  const result = schema.safeParse(body)

  if (!result.success) {
    throw new PayloadClientError(
      `Payload response did not match the content contract: ${result.error.message}`
    )
  }

  return result.data
}

function otherLocale(locale: PayloadLocale): PayloadLocale {
  return locale === "en" ? "de" : "en"
}

function toCmsCta(
  cta: { readonly label?: string | null; readonly href?: string | null } | undefined
) {
  if (!cta?.label || !cta.href || !isSafePublicHref(cta.href)) {
    return undefined
  }

  return { label: cta.label, href: cta.href } satisfies CmsCta
}

function isSafePublicHref(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("#")) {
    return true
  }

  try {
    return ["http:", "https:", "mailto:", "tel:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function toAbsoluteHttpUrl(value: string, baseUrl: string | URL): string | undefined {
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function toCanonicalUrl(value: string | null | undefined): string | undefined {
  return value ? toAbsoluteHttpUrl(value, TAXMAXI_ORIGIN) : undefined
}

function toCmsImage(
  media: number | PayloadMedia | null | undefined,
  baseUrl: URL
): CmsImage | undefined {
  if (media === null || media === undefined || typeof media === "number" || !media.url) {
    return undefined
  }

  const url = toAbsoluteHttpUrl(media.url, baseUrl)

  if (!url) {
    return undefined
  }

  return {
    alt: media.alt,
    url,
    ...(media.mimeType ? { mimeType: media.mimeType } : {}),
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
  }
}

function resolveRichTextMedia(document: LexicalDocument, baseUrl: URL): LexicalDocument {
  return { root: resolveRichTextNode(document.root, baseUrl) }
}

function resolveRichTextNode(node: LexicalNode, baseUrl: URL): LexicalNode {
  const resolvedMediaUrl =
    typeof node.value === "object" && node.value.url
      ? toAbsoluteHttpUrl(node.value.url, baseUrl)
      : undefined
  const value =
    typeof node.value === "object" && node.value.url
      ? { ...node.value, url: resolvedMediaUrl ?? null }
      : node.value

  return {
    ...node,
    ...(node.children
      ? { children: node.children.map((child) => resolveRichTextNode(child, baseUrl)) }
      : {}),
    ...(value !== undefined ? { value } : {}),
  }
}

function translationList({
  locale,
  doc,
  alternate,
}: {
  readonly locale: PayloadLocale
  readonly doc: { readonly slug: string; readonly canonicalUrl?: string | null }
  readonly alternate?: { readonly slug: string; readonly canonicalUrl?: string | null }
}): ReadonlyArray<CmsTranslation> {
  const canonicalUrl = toCanonicalUrl(doc.canonicalUrl)
  const alternateCanonicalUrl = toCanonicalUrl(alternate?.canonicalUrl)

  return [
    { locale, slug: doc.slug, ...(canonicalUrl ? { canonicalUrl } : {}) },
    ...(alternate
      ? [
          {
            locale: otherLocale(locale),
            slug: alternate.slug,
            ...(alternateCanonicalUrl ? { canonicalUrl: alternateCanonicalUrl } : {}),
          },
        ]
      : []),
  ]
}

function toLandingPage({
  alternate,
  baseUrl,
  doc,
  locale,
}: {
  readonly alternate?: PayloadLandingPage
  readonly baseUrl: URL
  readonly doc: PayloadLandingPage
  readonly locale: PayloadLocale
}): CmsContentPage {
  const sources: ReadonlyArray<CmsSource> = (doc.sources ?? []).flatMap((source) => {
    const url = toAbsoluteHttpUrl(source.url, TAXMAXI_ORIGIN)

    return url
      ? [
          {
            label: source.label,
            url,
            ...(source.accessedAt ? { accessedAt: source.accessedAt } : {}),
          },
        ]
      : []
  })
  const image = toCmsImage(doc.featuredImage, baseUrl)
  const socialImage = toCmsImage(doc.socialImage, baseUrl)
  const primaryCta = toCmsCta(doc.primaryCta)
  const secondaryCta = toCmsCta(doc.secondaryCta)
  const canonicalUrl = toCanonicalUrl(doc.canonicalUrl)

  return {
    id: doc.id,
    kind: "landing",
    locale,
    slug: doc.slug,
    title: doc.title,
    ...(doc.eyebrow ? { eyebrow: doc.eyebrow } : {}),
    excerpt: doc.excerpt,
    content: resolveRichTextMedia(doc.content, baseUrl),
    ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
    ...(doc.effectiveFrom ? { effectiveFrom: doc.effectiveFrom } : {}),
    ...(doc.lastReviewedAt ? { lastReviewedAt: doc.lastReviewedAt } : {}),
    updatedAt: doc.updatedAt,
    ...(doc.reviewedBy ? { reviewedBy: doc.reviewedBy } : {}),
    ...(image ? { image } : {}),
    ...(socialImage ? { socialImage } : {}),
    ...(primaryCta ? { primaryCta } : {}),
    ...(secondaryCta ? { secondaryCta } : {}),
    faqs: (doc.faqs ?? []).map((faq) => ({
      question: faq.question,
      answer: resolveRichTextMedia(faq.answer, baseUrl),
    })),
    sources,
    translations: translationList({ locale, doc, alternate }),
    seo: {
      title: doc.seoTitle ?? doc.title,
      description: doc.seoDescription ?? doc.excerpt,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      noIndex: doc.noIndex ?? false,
    },
  }
}

function toNewsArticle({
  alternate,
  baseUrl,
  doc,
  locale,
}: {
  readonly alternate?: PayloadNewsArticle
  readonly baseUrl: URL
  readonly doc: PayloadNewsArticle
  readonly locale: PayloadLocale
}): CmsContentPage {
  const image = toCmsImage(doc.featuredImage, baseUrl)
  const socialImage = toCmsImage(doc.socialImage, baseUrl)
  const primaryCta = toCmsCta(doc.cta)
  const canonicalUrl = toCanonicalUrl(doc.canonicalUrl)

  return {
    id: doc.id,
    kind: "news-article",
    locale,
    slug: doc.slug,
    title: doc.title,
    ...(doc.excerpt ? { excerpt: doc.excerpt } : {}),
    content: resolveRichTextMedia(doc.content, baseUrl),
    publishedAt: doc.publishedAt,
    updatedAt: doc.updatedAt,
    ...(doc.authorName ? { author: doc.authorName } : {}),
    category: doc.category,
    ...(image ? { image } : {}),
    ...(socialImage ? { socialImage } : {}),
    ...(primaryCta ? { primaryCta } : {}),
    faqs: [],
    sources: [],
    translations: translationList({ locale, doc, alternate }),
    seo: {
      title: doc.seoTitle ?? doc.title,
      ...((doc.seoDescription ?? doc.excerpt)
        ? { description: doc.seoDescription ?? doc.excerpt ?? undefined }
        : {}),
      ...(canonicalUrl ? { canonicalUrl } : {}),
      noIndex: false,
    },
  }
}

function toTaxLawArticle({
  alternate,
  baseUrl,
  doc,
  locale,
}: {
  readonly alternate?: PayloadTaxLawArticle
  readonly baseUrl: URL
  readonly doc: PayloadTaxLawArticle
  readonly locale: PayloadLocale
}): CmsContentPage {
  const image = toCmsImage(doc.featuredImage, baseUrl)

  return {
    id: doc.id,
    kind: "tax-law-article",
    locale,
    slug: doc.slug,
    title: doc.title,
    ...(doc.excerpt ? { excerpt: doc.excerpt } : {}),
    content: resolveRichTextMedia(doc.content, baseUrl),
    ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
    ...(doc.effectiveFrom ? { effectiveFrom: doc.effectiveFrom } : {}),
    updatedAt: doc.updatedAt,
    ...(image ? { image } : {}),
    faqs: [],
    sources: [],
    translations: translationList({ locale, doc, alternate }),
    seo: {
      title: doc.seoTitle ?? doc.title,
      ...((doc.seoDescription ?? doc.excerpt)
        ? { description: doc.seoDescription ?? doc.excerpt ?? undefined }
        : {}),
      noIndex: false,
    },
  }
}

export async function findLandingPage({
  locale,
  slug,
}: {
  readonly locale: PayloadLocale
  readonly slug: string
}): Promise<CmsContentPage | null> {
  const baseUrl = payloadApiBaseUrl()
  const response = await requestPayload(
    createPayloadCollectionUrl({ baseUrl, collection: "landing-pages", locale, slug }),
    LandingPagesResponseSchema
  )
  const doc = response.docs[0]

  if (!doc) {
    return null
  }

  const alternate = await requestPayload(
    createPayloadDocumentUrl({
      baseUrl,
      collection: "landing-pages",
      id: doc.id,
      locale: otherLocale(locale),
    }),
    LandingPageSchema
  ).catch(() => undefined)

  return toLandingPage({ alternate, baseUrl, doc, locale })
}

export async function findNewsArticle({
  locale,
  slug,
}: {
  readonly locale: PayloadLocale
  readonly slug: string
}): Promise<CmsContentPage | null> {
  const baseUrl = payloadApiBaseUrl()
  const response = await requestPayload(
    createPayloadCollectionUrl({ baseUrl, collection: "news-articles", locale, slug }),
    NewsArticlesResponseSchema
  )
  const doc = response.docs[0]

  if (!doc) {
    return null
  }

  const alternate = await requestPayload(
    createPayloadDocumentUrl({
      baseUrl,
      collection: "news-articles",
      id: doc.id,
      locale: otherLocale(locale),
    }),
    NewsArticleSchema
  ).catch(() => undefined)

  return toNewsArticle({ alternate, baseUrl, doc, locale })
}

export async function findTaxLawArticle({
  locale,
  slug,
}: {
  readonly locale: PayloadLocale
  readonly slug: string
}): Promise<CmsContentPage | null> {
  const baseUrl = payloadApiBaseUrl()
  const response = await requestPayload(
    createPayloadCollectionUrl({ baseUrl, collection: "tax-law-articles", locale, slug }),
    TaxLawArticlesResponseSchema
  )
  const doc = response.docs[0]

  if (!doc) {
    return null
  }

  const alternate = await requestPayload(
    createPayloadDocumentUrl({
      baseUrl,
      collection: "tax-law-articles",
      id: doc.id,
      locale: otherLocale(locale),
    }),
    TaxLawArticleSchema
  ).catch(() => undefined)

  return toTaxLawArticle({ alternate, baseUrl, doc, locale })
}
