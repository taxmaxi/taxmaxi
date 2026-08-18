import { describe, expect, it } from "vitest"

import { localeStrategy, routeStrategies, translatedPathnames } from "#/lib/i18n"
import { getStrategyForUrl } from "#/paraglide/runtime"

const cookieLocaleStrategy = ["cookie", "baseLocale"] as const
const publicLocaleStrategy = ["url", "cookie", "baseLocale"] as const

const localizedPaths = (pattern: string) => {
  const entry = translatedPathnames.find((item) => item.pattern === pattern)
  return entry === undefined ? undefined : Object.fromEntries(entry.localized)
}

describe("localeStrategy", () => {
  it("persists URL locale choices for routes that use the locale cookie", () => {
    expect(localeStrategy).toEqual(publicLocaleStrategy)
  })
})

describe("routeStrategies", () => {
  it("keeps signed-in app pages on the locale cookie", () => {
    expect(routeStrategies).toEqual(
      expect.arrayContaining([
        { match: "/app", strategy: cookieLocaleStrategy },
        { match: "/app/:path(.*)?", strategy: cookieLocaleStrategy },
      ])
    )
  })

  it("resolves cookie strategy for the dashboard, settings, and billing", () => {
    expect(getStrategyForUrl("https://taxmaxi.test/app")).toEqual(cookieLocaleStrategy)
    expect(getStrategyForUrl("https://taxmaxi.test/app/settings")).toEqual(cookieLocaleStrategy)
    expect(getStrategyForUrl("https://taxmaxi.test/app/billing")).toEqual(cookieLocaleStrategy)
  })

  it("keeps the public asset catalog on the URL strategy", () => {
    expect(getStrategyForUrl("https://taxmaxi.test/assets")).toEqual(publicLocaleStrategy)
    expect(getStrategyForUrl("https://taxmaxi.test/de/assets")).toEqual(publicLocaleStrategy)
  })
})

describe("translatedPathnames", () => {
  it("checks the dynamic landing-page pattern after all specific public routes", () => {
    const dynamicLandingPageIndex = translatedPathnames.findIndex(
      ({ pattern }) => pattern === "/:slug"
    )

    expect(dynamicLandingPageIndex).toBe(translatedPathnames.length - 1)
  })

  it("does not put a locale prefix on signed-in app pages", () => {
    expect(localizedPaths("/app")).toEqual({ en: "/app", de: "/app" })
    expect(localizedPaths("/app/:path(.*)?")).toEqual({
      en: "/app/:path(.*)?",
      de: "/app/:path(.*)?",
    })
  })

  it("keeps public asset pages on locale-prefixed URLs", () => {
    expect(localizedPaths("/assets")).toEqual({ en: "/assets", de: "/de/assets" })
    expect(localizedPaths("/assets/:assetId")).toEqual({
      en: "/assets/:assetId",
      de: "/de/assets/:assetId",
    })
  })
})
