import { z } from "zod"

import type {
  LexicalNode,
  PayloadLandingPage,
  PayloadMedia,
  PayloadNewsArticle,
  PayloadTaxLawArticle,
} from "./content"

const NullableString = z.string().nullable().optional()
const NullableNumber = z.number().nullable().optional()
const NullableBoolean = z.boolean().nullable().optional()

const PayloadMediaSchema: z.ZodType<PayloadMedia> = z.object({
  id: z.number(),
  alt: z.string(),
  url: NullableString,
  mimeType: NullableString,
  width: NullableNumber,
  height: NullableNumber,
})

const LexicalNodeSchema: z.ZodType<LexicalNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    children: z.array(LexicalNodeSchema).optional(),
    text: z.string().optional(),
    format: z.union([z.number(), z.string()]).optional(),
    tag: z.string().optional(),
    listType: z.string().optional(),
    url: z.string().optional(),
    fields: z
      .object({
        url: NullableString,
        newTab: NullableBoolean,
      })
      .optional(),
    value: z.union([z.number(), PayloadMediaSchema]).optional(),
  })
)

const LexicalDocumentSchema = z.object({
  root: LexicalNodeSchema,
})

const MediaReferenceSchema = z.union([z.number(), PayloadMediaSchema]).nullable().optional()

const CtaSchema = z
  .object({
    label: NullableString,
    href: NullableString,
  })
  .optional()

export const LandingPageSchema: z.ZodType<PayloadLandingPage> = z.object({
  id: z.number(),
  slug: z.string(),
  pageType: z.enum(["exchange-tax-report", "jurisdiction", "general"]),
  title: z.string(),
  eyebrow: NullableString,
  excerpt: z.string(),
  content: LexicalDocumentSchema,
  primaryCta: CtaSchema,
  secondaryCta: CtaSchema,
  faqs: z
    .array(
      z.object({
        question: z.string(),
        answer: LexicalDocumentSchema,
      })
    )
    .nullable()
    .optional(),
  publishedAt: NullableString,
  effectiveFrom: NullableString,
  lastReviewedAt: NullableString,
  reviewedBy: NullableString,
  featuredImage: MediaReferenceSchema,
  socialImage: MediaReferenceSchema,
  seoTitle: NullableString,
  seoDescription: NullableString,
  canonicalUrl: NullableString,
  noIndex: NullableBoolean,
  sources: z
    .array(
      z.object({
        label: z.string(),
        url: z.string(),
        accessedAt: NullableString,
      })
    )
    .nullable()
    .optional(),
  updatedAt: z.string(),
})

export const NewsArticleSchema: z.ZodType<PayloadNewsArticle> = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  excerpt: NullableString,
  content: LexicalDocumentSchema,
  publishedAt: z.string(),
  category: z.enum([
    "general-news",
    "regulatory-update",
    "exchange-update",
    "blockchain-update",
    "company-news",
    "product-launch",
  ]),
  featuredImage: MediaReferenceSchema,
  socialImage: MediaReferenceSchema,
  authorName: NullableString,
  seoTitle: NullableString,
  seoDescription: NullableString,
  canonicalUrl: NullableString,
  cta: CtaSchema,
  updatedAt: z.string(),
})

export const TaxLawArticleSchema: z.ZodType<PayloadTaxLawArticle> = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  excerpt: NullableString,
  content: LexicalDocumentSchema,
  publishedAt: NullableString,
  effectiveFrom: NullableString,
  featuredImage: MediaReferenceSchema,
  seoTitle: NullableString,
  seoDescription: NullableString,
  updatedAt: z.string(),
})

export const LandingPagesResponseSchema = z.object({
  docs: z.array(LandingPageSchema),
})

export const NewsArticlesResponseSchema = z.object({
  docs: z.array(NewsArticleSchema),
})

export const TaxLawArticlesResponseSchema = z.object({
  docs: z.array(TaxLawArticleSchema),
})
