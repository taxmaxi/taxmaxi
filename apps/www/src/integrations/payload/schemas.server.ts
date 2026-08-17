import { Schema } from "effect"

import type {
  LexicalNode,
  PayloadDocumentReference,
  PayloadLandingPage,
  PayloadMedia,
  PayloadNewsArticle,
  PayloadTaxLawArticle,
} from "./content"

const NullableString = Schema.optional(Schema.NullOr(Schema.String))
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number))
const NullableBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))

const PayloadMediaSchema: Schema.Schema<PayloadMedia> = Schema.Struct({
  id: Schema.Number,
  alt: Schema.String,
  url: NullableString,
  mimeType: NullableString,
  width: NullableNumber,
  height: NullableNumber,
})

const PayloadDocumentReferenceSchema: Schema.Schema<PayloadDocumentReference> = Schema.Struct({
  id: Schema.Number,
  slug: NullableString,
  url: NullableString,
})

const PayloadRelationshipReferenceSchema = Schema.Struct({
  relationTo: Schema.String,
  value: Schema.Union(Schema.Number, PayloadDocumentReferenceSchema),
})

const LexicalNodeSchema: Schema.Schema<LexicalNode> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.String,
    children: Schema.optional(Schema.Array(LexicalNodeSchema)),
    text: Schema.optional(Schema.String),
    format: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
    tag: Schema.optional(Schema.String),
    listType: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    fields: Schema.optional(
      Schema.Struct({
        url: NullableString,
        newTab: NullableBoolean,
        linkType: Schema.optional(Schema.NullOr(Schema.Literal("custom", "internal"))),
        doc: Schema.optional(Schema.NullOr(PayloadRelationshipReferenceSchema)),
      })
    ),
    relationTo: Schema.optional(Schema.String),
    value: Schema.optional(
      Schema.Union(Schema.Number, PayloadMediaSchema, PayloadDocumentReferenceSchema)
    ),
  })
)

const LexicalDocumentSchema = Schema.Struct({
  root: LexicalNodeSchema,
})

const MediaReferenceSchema = Schema.optional(
  Schema.NullOr(Schema.Union(Schema.Number, PayloadMediaSchema))
)

const CtaSchema = Schema.optional(
  Schema.Struct({
    label: NullableString,
    href: NullableString,
  })
)

export const LandingPageSchema: Schema.Schema<PayloadLandingPage> = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  pageType: Schema.Literal("exchange-tax-report", "jurisdiction", "general"),
  title: Schema.String,
  eyebrow: NullableString,
  excerpt: Schema.String,
  content: LexicalDocumentSchema,
  primaryCta: CtaSchema,
  secondaryCta: CtaSchema,
  faqs: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          question: Schema.String,
          answer: LexicalDocumentSchema,
        })
      )
    )
  ),
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
  sources: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          label: Schema.String,
          url: Schema.String,
          accessedAt: NullableString,
        })
      )
    )
  ),
  updatedAt: Schema.String,
})

export const NewsArticleSchema: Schema.Schema<PayloadNewsArticle> = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  title: Schema.String,
  excerpt: NullableString,
  content: LexicalDocumentSchema,
  publishedAt: Schema.String,
  category: Schema.Literal(
    "general-news",
    "regulatory-update",
    "exchange-update",
    "blockchain-update",
    "company-news",
    "product-launch"
  ),
  featuredImage: MediaReferenceSchema,
  socialImage: MediaReferenceSchema,
  authorName: NullableString,
  seoTitle: NullableString,
  seoDescription: NullableString,
  canonicalUrl: NullableString,
  cta: CtaSchema,
  updatedAt: Schema.String,
})

export const TaxLawArticleSchema: Schema.Schema<PayloadTaxLawArticle> = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  title: Schema.String,
  excerpt: NullableString,
  content: LexicalDocumentSchema,
  publishedAt: NullableString,
  effectiveFrom: NullableString,
  featuredImage: MediaReferenceSchema,
  seoTitle: NullableString,
  seoDescription: NullableString,
  updatedAt: Schema.String,
})

export const LandingPagesResponseSchema = Schema.Struct({
  docs: Schema.Array(LandingPageSchema),
})

export const NewsArticlesResponseSchema = Schema.Struct({
  docs: Schema.Array(NewsArticleSchema),
})

export const TaxLawArticlesResponseSchema = Schema.Struct({
  docs: Schema.Array(TaxLawArticleSchema),
})
