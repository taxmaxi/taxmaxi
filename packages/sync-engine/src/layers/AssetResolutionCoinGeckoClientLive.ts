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

import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { AssetResolutionUpstreamFailure } from "@my/core/assets"
import {
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoRetryableError,
  type AssetResolutionCoinGeckoClientShape,
} from "../services/AssetResolutionCoinGeckoClient.ts"
import { makeCoinGeckoRequest } from "../shared/CoinGeckoRequest.ts"
import { positiveIntConfig } from "../shared/PositiveIntConfig.ts"

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

// The public CoinGecko API allows roughly 10-30 requests per minute, so 429
// is expected traffic. 408 and 5xx are transient by definition.
const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const coinGeckoRequest = yield* makeCoinGeckoRequest
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

  const upstreamFailure = new AssetResolutionUpstreamFailure({ source: "coingecko" })

  const fetchCoin: AssetResolutionCoinGeckoClientShape["fetchCoin"] = ({ coinGeckoCoinId }) => {
    const request = coinGeckoRequest.getRequest(`/coins/${encodeURIComponent(coinGeckoCoinId)}`)

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
