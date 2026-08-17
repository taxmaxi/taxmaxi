import { describe, expect, it } from "vitest"

import { localeStrategy } from "#/lib/i18n"

describe("localeStrategy", () => {
  it("persists URL locale choices for routes that use the locale cookie", () => {
    expect(localeStrategy).toEqual(["url", "cookie", "baseLocale"])
  })
})
