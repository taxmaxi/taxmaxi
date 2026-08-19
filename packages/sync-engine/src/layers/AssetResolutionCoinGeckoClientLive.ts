/**
 * AssetResolutionCoinGeckoClientLive - Live CoinGecko coin lookup for attach-only resolution.
 *
 * Dependencies: HttpClient (provided via FetchHttpClient).
 *
 * @module AssetResolutionCoinGeckoClientLive
 */

import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssetResolutionUpstreamFailure } from "@my/core/assets"
import {
  AssetResolutionCoinGeckoClient,
  type AssetResolutionCoinGeckoClientShape,
} from "../services/AssetResolutionCoinGeckoClient.ts"

const COINGECKO_PRO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3"
const COINGECKO_PUBLIC_API_BASE_URL = "https://api.coingecko.com/api/v3"

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const configuredBaseUrl = yield* Config.option(Config.string("COINGECKO_API_BASE_URL"))
  const demoApiKey = yield* Config.option(Config.string("COINGECKO_API_KEY"))
  const proApiKey = yield* Config.option(Config.string("COINGECKO_PRO_API_KEY"))
  const baseUrl = Option.getOrElse(configuredBaseUrl, () =>
    Option.isSome(proApiKey) ? COINGECKO_PRO_API_BASE_URL : COINGECKO_PUBLIC_API_BASE_URL
  )

  const upstreamFailure = new AssetResolutionUpstreamFailure({ source: "coingecko" })

  const fetchCoin: AssetResolutionCoinGeckoClientShape["fetchCoin"] = ({ coinGeckoCoinId }) => {
    const baseRequest = HttpClientRequest.get(`${baseUrl}/coins/${coinGeckoCoinId}`)
    const request = Option.match(proApiKey, {
      onNone: () =>
        Option.match(demoApiKey, {
          onNone: () => baseRequest,
          onSome: (apiKey) =>
            baseRequest.pipe(HttpClientRequest.setHeader("x-cg-demo-api-key", apiKey)),
        }),
      onSome: (apiKey) => baseRequest.pipe(HttpClientRequest.setHeader("x-cg-pro-api-key", apiKey)),
    })

    return httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.succeed(upstreamFailure)
          : response.json.pipe(
              Effect.map((payload) => ({ _tag: "payload", payload }) as const),
              Effect.orElseSucceed(() => upstreamFailure)
            )
      ),
      Effect.orElseSucceed(() => upstreamFailure)
    )
  }

  return AssetResolutionCoinGeckoClient.of({ fetchCoin })
})

/**
 * AssetResolutionCoinGeckoClientLive - Live layer backed by the public CoinGecko API.
 */
export const AssetResolutionCoinGeckoClientLive = Layer.effect(
  AssetResolutionCoinGeckoClient,
  make
).pipe(Layer.provide(FetchHttpClient.layer))
