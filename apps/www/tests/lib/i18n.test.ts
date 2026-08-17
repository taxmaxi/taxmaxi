import { describe, expect, it } from "vitest"

import { localeStrategy, translatedPathnames } from "./i18n"

describe("localeStrategy", () => {
  it("persists URL locale choices for routes that use the locale cookie", () => {
    expect(localeStrategy).toEqual(["url", "cookie", "baseLocale"])
  })
})

describe("translatedPathnames", () => {
  it("checks the dynamic landing-page pattern after all specific public routes", () => {
    const dynamicLandingPageIndex = translatedPathnames.findIndex(
      ({ pattern }) => pattern === "/:slug"
    )

    expect(dynamicLandingPageIndex).toBe(translatedPathnames.length - 1)
  })
})
