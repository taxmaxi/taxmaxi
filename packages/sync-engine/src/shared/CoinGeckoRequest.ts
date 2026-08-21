/**
 * CoinGeckoRequest - Shared CoinGecko HTTP request building.
 *
 * One place for the base-url selection and API-key header rules used by every
 * CoinGecko caller (the rest-api pricing client and the sync-engine evidence
 * client). Response handling stays with each caller: pricing decodes typed
 * payloads, evidence gathering keeps raw payloads and its own retry taxonomy.
 *
 * @module CoinGeckoRequest
 */

import { HttpClientRequest } from "effect/unstable/http"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

export const COINGECKO_PRO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3"
export const COINGECKO_PUBLIC_API_BASE_URL = "https://api.coingecko.com/api/v3"

/**
 * Build a request factory for CoinGecko endpoints from environment config.
 *
 * Reads COINGECKO_API_BASE_URL, COINGECKO_API_KEY (demo), and
 * COINGECKO_PRO_API_KEY. A pro key switches the default base url to the pro
 * host and wins over the demo key for the auth header.
 */
export const makeCoinGeckoRequest = Effect.gen(function* () {
  const configuredBaseUrl = yield* Config.option(Config.string("COINGECKO_API_BASE_URL"))
  const demoApiKey = yield* Config.option(Config.string("COINGECKO_API_KEY"))
  const proApiKey = yield* Config.option(Config.string("COINGECKO_PRO_API_KEY"))
  const baseUrl = Option.getOrElse(configuredBaseUrl, () =>
    Option.isSome(proApiKey) ? COINGECKO_PRO_API_BASE_URL : COINGECKO_PUBLIC_API_BASE_URL
  )

  /** Build a GET request for one CoinGecko endpoint path such as `/coins/bitcoin`. */
  const getRequest = (endpoint: string): HttpClientRequest.HttpClientRequest => {
    const baseRequest = HttpClientRequest.get(`${baseUrl}${endpoint}`)

    return Option.match(proApiKey, {
      onNone: () =>
        Option.match(demoApiKey, {
          onNone: () => baseRequest,
          onSome: (apiKey) =>
            baseRequest.pipe(HttpClientRequest.setHeader("x-cg-demo-api-key", apiKey)),
        }),
      onSome: (apiKey) => baseRequest.pipe(HttpClientRequest.setHeader("x-cg-pro-api-key", apiKey)),
    })
  }

  return { getRequest }
})
