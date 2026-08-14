import type { Locale } from "#/paraglide/runtime"

export const payloadLocales = ["en", "de"] as const

export type PayloadLocale = (typeof payloadLocales)[number]
export type CmsCollection = "landing-pages" | "news-articles" | "tax-law-articles"
export type CmsPageKind = "landing" | "news-article" | "tax-law-article"

export const TAXMAXI_SITE_ORIGIN = "https://www.taxmaxi.com"
export const CMS_ROUTE_STALE_TIME_MS = 5 * 60 * 1_000

export const PAYLOAD_LOCALE_BY_PARAGLIDE_LOCALE = {
  en: "en",
  de: "de",
} as const satisfies Record<Locale, PayloadLocale>

export function toPayloadLocale(locale: Locale): PayloadLocale {
  return PAYLOAD_LOCALE_BY_PARAGLIDE_LOCALE[locale]
}

export interface PayloadMedia {
  readonly id: number
  readonly alt: string
  readonly url?: string | null
  readonly mimeType?: string | null
  readonly width?: number | null
  readonly height?: number | null
}

export interface LexicalNode {
  readonly type: string
  readonly children?: ReadonlyArray<LexicalNode>
  readonly text?: string
  readonly format?: number | string
  readonly tag?: string
  readonly listType?: string
  readonly url?: string
  readonly fields?: {
    readonly url?: string | null
    readonly newTab?: boolean | null
  }
  readonly value?: number | PayloadMedia
}

export interface LexicalDocument {
  readonly root: LexicalNode
}

interface PayloadCta {
  readonly label?: string | null
  readonly href?: string | null
}

type PayloadMediaReference = number | PayloadMedia | null | undefined

interface PayloadSeoFields {
  readonly seoTitle?: string | null
  readonly seoDescription?: string | null
}

export interface PayloadLandingPage extends PayloadSeoFields {
  readonly id: number
  readonly slug: string
  readonly pageType: "exchange-tax-report" | "jurisdiction" | "general"
  readonly title: string
  readonly eyebrow?: string | null
  readonly excerpt: string
  readonly content: LexicalDocument
  readonly primaryCta?: PayloadCta
  readonly secondaryCta?: PayloadCta
  readonly faqs?: ReadonlyArray<{
    readonly question: string
    readonly answer: LexicalDocument
  }> | null
  readonly publishedAt?: string | null
  readonly effectiveFrom?: string | null
  readonly lastReviewedAt?: string | null
  readonly reviewedBy?: string | null
  readonly featuredImage?: PayloadMediaReference
  readonly socialImage?: PayloadMediaReference
  readonly canonicalUrl?: string | null
  readonly noIndex?: boolean | null
  readonly sources?: ReadonlyArray<{
    readonly label: string
    readonly url: string
    readonly accessedAt?: string | null
  }> | null
  readonly updatedAt: string
}

export interface PayloadNewsArticle extends PayloadSeoFields {
  readonly id: number
  readonly slug: string
  readonly title: string
  readonly excerpt?: string | null
  readonly content: LexicalDocument
  readonly publishedAt: string
  readonly category:
    | "general-news"
    | "regulatory-update"
    | "exchange-update"
    | "blockchain-update"
    | "company-news"
    | "product-launch"
  readonly featuredImage?: PayloadMediaReference
  readonly socialImage?: PayloadMediaReference
  readonly authorName?: string | null
  readonly canonicalUrl?: string | null
  readonly cta?: PayloadCta
  readonly updatedAt: string
}

export interface PayloadTaxLawArticle extends PayloadSeoFields {
  readonly id: number
  readonly slug: string
  readonly title: string
  readonly excerpt?: string | null
  readonly content: LexicalDocument
  readonly publishedAt?: string | null
  readonly effectiveFrom?: string | null
  readonly featuredImage?: PayloadMediaReference
  readonly updatedAt: string
}

export interface CmsImage {
  readonly alt: string
  readonly url: string
  readonly mimeType?: string
  readonly width?: number
  readonly height?: number
}

export interface CmsTranslation {
  readonly locale: PayloadLocale
  readonly slug: string
}

export interface CmsCta {
  readonly label: string
  readonly href: string
}

export interface CmsFaq {
  readonly question: string
  readonly answer: LexicalDocument
}

export interface CmsSource {
  readonly label: string
  readonly url: string
  readonly accessedAt?: string
}

export interface CmsContentPage {
  readonly id: number
  readonly kind: CmsPageKind
  readonly locale: PayloadLocale
  readonly slug: string
  readonly title: string
  readonly eyebrow?: string
  readonly excerpt?: string
  readonly content: LexicalDocument
  readonly publishedAt?: string
  readonly effectiveFrom?: string
  readonly updatedAt: string
  readonly reviewedBy?: string
  readonly category?: string
  readonly image?: CmsImage
  readonly socialImage?: CmsImage
  readonly primaryCta?: CmsCta
  readonly secondaryCta?: CmsCta
  readonly faqs: ReadonlyArray<CmsFaq>
  readonly sources: ReadonlyArray<CmsSource>
  readonly translations: ReadonlyArray<CmsTranslation>
  readonly seo: {
    readonly title: string
    readonly description?: string
    readonly canonicalUrl?: string
    readonly noIndex: boolean
  }
}

export function createPayloadCollectionUrl({
  baseUrl,
  collection,
  locale,
  slug,
}: {
  readonly baseUrl: URL
  readonly collection: CmsCollection
  readonly locale: PayloadLocale
  readonly slug: string
}): URL {
  const url = new URL(`/api/${collection}`, baseUrl)
  url.searchParams.set("where[slug][equals]", slug)
  url.searchParams.set("locale", locale)
  url.searchParams.set("fallback-locale", "none")
  url.searchParams.set("depth", "1")
  url.searchParams.set("limit", "1")
  url.searchParams.set("pagination", "false")
  return url
}

export function createPayloadDocumentUrl({
  baseUrl,
  collection,
  id,
  locale,
}: {
  readonly baseUrl: URL
  readonly collection: CmsCollection
  readonly id: number
  readonly locale: PayloadLocale
}): URL {
  const url = new URL(`/api/${collection}/${id}`, baseUrl)
  url.searchParams.set("locale", locale)
  url.searchParams.set("fallback-locale", "none")
  url.searchParams.set("depth", "1")
  return url
}

export function getCmsPagePath({
  kind,
  locale,
  slug,
}: {
  readonly kind: CmsPageKind
  readonly locale: PayloadLocale
  readonly slug: string
}): string {
  const localePrefix = locale === "en" ? "" : "/de"
  const encodedSlug = encodeURIComponent(slug)

  if (kind === "landing") {
    return `${localePrefix}/${encodedSlug}`
  }

  if (kind === "news-article") {
    const segment = locale === "de" ? "artikel" : "articles"
    return `${localePrefix}/${segment}/${encodedSlug}`
  }

  const segment = locale === "de" ? "steuerrecht" : "tax-law"
  return `${localePrefix}/${segment}/${encodedSlug}`
}

export function getCmsPageUrl({
  kind,
  locale,
  slug,
}: {
  readonly kind: CmsPageKind
  readonly locale: PayloadLocale
  readonly slug: string
}): string {
  return new URL(getCmsPagePath({ kind, locale, slug }), TAXMAXI_SITE_ORIGIN).toString()
}

export function lexicalToPlainText(document: LexicalDocument): string {
  return nodeToPlainText(document.root).replace(/\s+/g, " ").trim()
}

function nodeToPlainText(node: LexicalNode): string {
  if (node.text !== undefined) {
    return node.text
  }

  if (node.children === undefined) {
    return ""
  }

  const separator = node.type === "root" || node.type === "list" ? " " : ""
  return node.children.map(nodeToPlainText).join(separator)
}
