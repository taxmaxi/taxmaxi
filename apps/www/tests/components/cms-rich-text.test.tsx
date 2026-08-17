// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CmsRichText } from "#/components/cms-rich-text"
import type { LexicalDocument } from "#/integrations/payload/content"

afterEach(cleanup)

describe("CmsRichText", () => {
  it.each([
    ["left", "text-left"],
    ["center", "text-center"],
    ["right", "text-right"],
    ["justify", "text-justify"],
    ["start", "text-start"],
    ["end", "text-end"],
  ] as const)("renders %s paragraph alignment with a safe class", (format, className) => {
    const document: LexicalDocument = {
      root: {
        type: "root",
        children: [
          {
            type: "paragraph",
            format,
            children: [{ type: "text", text: "Aligned paragraph" }],
          },
        ],
      },
    }

    render(<CmsRichText document={document} locale="en" />)

    expect(screen.getByText("Aligned paragraph").getAttribute("class")).toBe(className)
  })

  it("preserves heading tags and their block alignment", () => {
    const document: LexicalDocument = {
      root: {
        type: "root",
        children: [
          {
            type: "heading",
            tag: "h4",
            format: "right",
            children: [{ type: "text", text: "Aligned heading" }],
          },
        ],
      },
    }

    render(<CmsRichText document={document} locale="en" />)

    expect(
      screen.getByRole("heading", { level: 4, name: "Aligned heading" }).getAttribute("class")
    ).toBe("text-right")
  })

  it.each(["unsafe-class", 2] as const)(
    "ignores unsupported block alignment format %s",
    (format) => {
      const document: LexicalDocument = {
        root: {
          type: "root",
          children: [
            {
              type: "paragraph",
              format,
              children: [{ type: "text", text: "Unaligned paragraph" }],
            },
          ],
        },
      }

      render(<CmsRichText document={document} locale="en" />)

      expect(screen.getByText("Unaligned paragraph").getAttribute("class")).toBeNull()
    }
  )

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
