/**
 * AssetResolutionCoinGeckoClientLive - Live CoinGecko coin lookup for attach-only resolution.
 *
 * Classifies fetch failures before they become durable decisions: rate
 * limits, server errors, timeouts, and transport failures are retried with
 * backoff and then raised as retryable so the job runs again later, while a
 * missing coin or an unreadable body stays a terminal upstream failure the
 * policy fails closed on.
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
import * as Schedule from "effect/Schedule"
import { AssetResolutionUpstreamFailure } from "@my/core/assets"
import {
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoRetryableError,
  type AssetResolutionCoinGeckoClientShape,
} from "../services/AssetResolutionCoinGeckoClient.ts"
import { positiveIntConfig } from "../shared/PositiveIntConfig.ts"

const COINGECKO_PRO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3"
const COINGECKO_PUBLIC_API_BASE_URL = "https://api.coingecko.com/api/v3"

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

// The public CoinGecko API allows roughly 10-30 requests per minute, so 429
// is expected traffic. 408 and 5xx are transient by definition.
const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const configuredBaseUrl = yield* Config.option(Config.string("COINGECKO_API_BASE_URL"))
  const demoApiKey = yield* Config.option(Config.string("COINGECKO_API_KEY"))
  const proApiKey = yield* Config.option(Config.string("COINGECKO_PRO_API_KEY"))
  const requestTimeoutMs = yield* positiveIntConfig({
    name: "COINGECKO_REQUEST_TIMEOUT_MS",
    defaultValue: DEFAULT_REQUEST_TIMEOUT_MS,
  })
  const retryAttempts = yield* positiveIntConfig({
    name: "COINGECKO_RETRY_ATTEMPTS",
    defaultValue: DEFAULT_RETRY_ATTEMPTS,
  })
  const retryBaseDelayMs = yield* positiveIntConfig({
    name: "COINGECKO_RETRY_BASE_DELAY_MS",
    defaultValue: DEFAULT_RETRY_BASE_DELAY_MS,
  })
  const baseUrl = Option.getOrElse(configuredBaseUrl, () =>
    Option.isSome(proApiKey) ? COINGECKO_PRO_API_BASE_URL : COINGECKO_PUBLIC_API_BASE_URL
  )

  const upstreamFailure = new AssetResolutionUpstreamFailure({ source: "coingecko" })

  const fetchCoin: AssetResolutionCoinGeckoClientShape["fetchCoin"] = ({ coinGeckoCoinId }) => {
    const baseRequest = HttpClientRequest.get(
      `${baseUrl}/coins/${encodeURIComponent(coinGeckoCoinId)}`
    )
    const request = Option.match(proApiKey, {
      onNone: () =>
        Option.match(demoApiKey, {
          onNone: () => baseRequest,
          onSome: (apiKey) =>
            baseRequest.pipe(HttpClientRequest.setHeader("x-cg-demo-api-key", apiKey)),
        }),
      onSome: (apiKey) => baseRequest.pipe(HttpClientRequest.setHeader("x-cg-pro-api-key", apiKey)),
    })

    const attempt = httpClient.execute(request).pipe(
      Effect.timeout(requestTimeoutMs),
      Effect.mapError(
        (cause) => new AssetResolutionCoinGeckoRetryableError({ status: null, cause })
      ),
      Effect.flatMap((response) => {
        if (isRetryableStatus(response.status)) {
          return Effect.fail(
            new AssetResolutionCoinGeckoRetryableError({
              status: response.status,
              cause: `CoinGecko responded ${response.status}`,
            })
          )
        }

        if (response.status < 200 || response.status >= 300) {
          return Effect.succeed(upstreamFailure)
        }

        return response.json.pipe(
          Effect.map((payload) => ({ _tag: "payload", payload }) as const),
          Effect.orElseSucceed(() => upstreamFailure)
        )
      })
    )

    return attempt.pipe(
      Effect.retry({
        times: retryAttempts,
        schedule: Schedule.exponential(retryBaseDelayMs),
      })
    )
  }

  return AssetResolutionCoinGeckoClient.of({ fetchCoin })
})

/**
 * AssetResolutionCoinGeckoClientLayer - Client layer that still requires an
 * HttpClient, so tests can stub the transport.
 */
export const AssetResolutionCoinGeckoClientLayer = Layer.effect(
  AssetResolutionCoinGeckoClient,
  make
)

/**
 * AssetResolutionCoinGeckoClientLive - Live layer backed by the public CoinGecko API.
 */
export const AssetResolutionCoinGeckoClientLive = AssetResolutionCoinGeckoClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer)
)
