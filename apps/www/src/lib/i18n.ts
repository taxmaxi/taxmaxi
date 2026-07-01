import type { Locale } from "#/paraglide/runtime"
import type { CompilerOptions } from "@inlang/paraglide-js"
import type { FileRoutesByTo } from "../routeTree.gen"

type RoutePath = keyof FileRoutesByTo

const baseLocale = "en" satisfies Locale

const excludedPaths = ["admin", "docs", "api", "dashboard", "app"] as const

type PublicRoutePath = Exclude<RoutePath, `${string}${(typeof excludedPaths)[number]}${string}`>

type UrlPatterns = NonNullable<CompilerOptions["urlPatterns"]>
type RouteStrategies = NonNullable<CompilerOptions["routeStrategies"]>

type TranslatedPathname = {
  pattern: string
  localized: Array<[Locale, string]>
}

function toUrlPattern(path: string) {
  const pattern = path
    // catch-all
    .replace(/\/\$$/, "/:path(.*)?")
    // optional parameters: {-$param}
    .replace(/\{-\$([a-zA-Z0-9_]+)\}/g, ":$1?")
    // named parameters: $param
    .replace(/\$([a-zA-Z0-9_]+)/g, ":$1")
    // remove trailing slash
    .replace(/\/+$/, "")

  return pattern === "" ? "/" : pattern
}

function toLocalizedPattern(locale: Locale, path: string) {
  const pattern = toUrlPattern(path)

  if (locale === baseLocale) {
    return pattern
  }

  if (pattern === "/") {
    return `/${locale}`
  }

  return `/${locale}${pattern}`
}

function createTranslatedPathnames(
  input: Record<PublicRoutePath, Record<Locale, string>>
): TranslatedPathname[] {
  return Object.entries(input).map(([pattern, locales]) => ({
    pattern: toUrlPattern(pattern),
    localized: Object.entries(locales).map(
      ([locale, path]) =>
        [locale as Locale, toLocalizedPattern(locale as Locale, path)] satisfies [Locale, string]
    ),
  }))
}

const preferenceLocalePathnames = [
  {
    pattern: "/dashboard/:path(.*)?",
    localized: [
      ["en", "/dashboard/:path(.*)?"],
      ["de", "/dashboard/:path(.*)?"],
    ],
  },
  {
    pattern: "/app/:path(.*)?",
    localized: [
      ["en", "/app/:path(.*)?"],
      ["de", "/app/:path(.*)?"],
    ],
  },
] satisfies UrlPatterns

export const translatedPathnames = [
  ...preferenceLocalePathnames,
  ...createTranslatedPathnames({
    "/": {
      en: "/",
      de: "/",
    },
    "/about": {
      en: "/about",
      de: "/ueber",
    },
    "/demo/ai-chat": {
      en: "/demo/ai-chat",
      de: "/demo/ai-chat",
    },
    "/demo/ai-image": {
      en: "/demo/ai-image",
      de: "/demo/ai-image",
    },
    "/demo/ai-structured": {
      en: "/demo/ai-structured",
      de: "/demo/ai-structured",
    },
    "/demo/posthog": {
      en: "/demo/posthog",
      de: "/demo/posthog",
    },
    "/demo/tanstack-query": {
      en: "/demo/tanstack-query",
      de: "/demo/tanstack-query",
    },
    "/demo/store": {
      en: "/demo/store",
      de: "/demo/speicher",
    },
    "/demo/form/address": {
      en: "/demo/form/address",
      de: "/demo/formular/adresse",
    },
    "/demo/form/simple": {
      en: "/demo/f/simple",
      de: "/demo/formular/simpel",
    },
    "/demo/guitars/$guitarId": {
      en: "/demo/guitars/$guitarId",
      de: "/demo/gitarren/$guitarId",
    },
    "/demo/guitars": {
      en: "/demo/guitars",
      de: "/demo/gitarren",
    },
  }),
] satisfies UrlPatterns

export const routeStrategies = [
  { match: "/dashboard/:path(.*)?", strategy: ["cookie", "baseLocale"] },
  { match: "/app/:path(.*)?", strategy: ["cookie", "baseLocale"] },
  { match: "/api/:path(.*)?", exclude: true },
  { match: "/demo/api/:path(.*)?", exclude: true },
] satisfies RouteStrategies
