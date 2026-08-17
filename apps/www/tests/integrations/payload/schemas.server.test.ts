import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { LandingPageSchema } from "#/integrations/payload/schemas.server"

describe("LandingPageSchema", () => {
  it("decodes expanded relationship nodes and internal document links", () => {
    const page = Effect.runSync(
      Schema.decodeUnknown(LandingPageSchema)({
        id: 1,
        slug: "crypto-tax",
        pageType: "general",
        title: "Crypto tax",
        excerpt: "A guide",
        content: {
          root: {
            type: "root",
            children: [
              {
                type: "relationship",
                relationTo: "news-articles",
                value: { id: 2, slug: "new-rules", title: "New rules" },
              },
              {
                type: "link",
                fields: {
                  linkType: "internal",
                  doc: {
                    relationTo: "tax-law-articles",
                    value: { id: 3, slug: "staking-income", title: "Staking income" },
                  },
                },
                children: [{ type: "text", text: "Read more" }],
              },
            ],
          },
        },
        updatedAt: "2026-08-17T10:00:00.000Z",
      })
    )

    expect(page.content.root.children).toEqual([
      {
        type: "relationship",
        relationTo: "news-articles",
        value: { id: 2, slug: "new-rules" },
      },
      {
        type: "link",
        fields: {
          linkType: "internal",
          doc: {
            relationTo: "tax-law-articles",
            value: { id: 3, slug: "staking-income" },
          },
        },
        children: [{ type: "text", text: "Read more" }],
      },
    ])
  })
})
