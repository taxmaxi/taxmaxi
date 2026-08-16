// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
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
          link("Payload", "https://payloadcms.com"),
        ],
      },
    }

    const { getByRole } = render(<CmsRichText document={document} locale="de" />)

    expect(getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/de/datenschutz")
    expect(getByRole("link", { name: "FAQ" }).getAttribute("href")).toBe("#faq")
    expect(getByRole("link", { name: "Payload" }).getAttribute("href")).toBe(
      "https://payloadcms.com/"
    )
  })
})

function link(text: string, url: string) {
  return {
    type: "link",
    fields: { url },
    children: [{ type: "text", text }],
  } as const
}
