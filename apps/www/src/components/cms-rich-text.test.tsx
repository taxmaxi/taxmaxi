// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { LexicalDocument } from "#/integrations/payload/content"
import { CmsRichText } from "./cms-rich-text"

afterEach(cleanup)

describe("CmsRichText", () => {
  it("localizes root-relative links while preserving fragments and external URLs", () => {
    const document: LexicalDocument = {
      root: {
        type: "root",
        children: [
          link("Privacy", "/privacy"),
          link("FAQ", "#faq"),
          link("Phone", "tel:+49123456789"),
          link("Payload", "https://payloadcms.com"),
        ],
      },
    }

    const { getByRole } = render(<CmsRichText document={document} locale="de" />)

    expect(getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/de/datenschutz")
    expect(getByRole("link", { name: "FAQ" }).getAttribute("href")).toBe("#faq")
    expect(getByRole("link", { name: "Phone" }).getAttribute("href")).toBe("tel:+49123456789")
    expect(getByRole("link", { name: "Payload" }).getAttribute("href")).toBe(
      "https://payloadcms.com/"
    )
  })

  it.each([
    ["landing-pages", "steuer-rechner", "/de/steuer-rechner"],
    ["news-articles", "neue-regeln", "/de/artikel/neue-regeln"],
    ["tax-law-articles", "staking-erträge", "/de/steuerrecht/staking-ertr%C3%A4ge"],
  ] as const)(
    "renders an internal %s link from its expanded localized slug",
    (relationTo, slug, expectedHref) => {
      const document: LexicalDocument = {
        root: {
          type: "root",
          children: [internalLink("Read more", relationTo, { id: 42, slug })],
        },
      }

      render(<CmsRichText document={document} locale="de" />)

      expect(screen.getByRole("link", { name: "Read more" }).getAttribute("href")).toBe(
        expectedHref
      )
    }
  )

  it("renders children without a link for unsupported or unresolved internal targets", () => {
    const document: LexicalDocument = {
      root: {
        type: "root",
        children: [
          internalLink("Unsupported", "authors", { id: 42, slug: "max" }),
          internalLink("Unresolved", "news-articles", 42),
        ],
      },
    }

    const { container } = render(<CmsRichText document={document} locale="en" />)

    expect(screen.queryByRole("link")).toBeNull()
    expect(container.textContent).toBe("UnsupportedUnresolved")
  })
})

function link(text: string, url: string) {
  return {
    type: "link",
    fields: { url },
    children: [{ type: "text", text }],
  } as const
}

function internalLink(
  text: string,
  relationTo: string,
  value: number | { readonly id: number; readonly slug: string }
) {
  return {
    type: "link",
    fields: {
      linkType: "internal",
      doc: { relationTo, value },
    },
    children: [{ type: "text", text }],
  } as const
}
