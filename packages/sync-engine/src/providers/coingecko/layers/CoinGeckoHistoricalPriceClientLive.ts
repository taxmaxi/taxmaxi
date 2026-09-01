/**
 * CoinGeckoHistoricalPriceClientLive - CoinGecko daily EUR history client.
 *
 * @module CoinGeckoHistoricalPriceClientLive
 */

import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
  CoinGeckoHistoricalPriceClient,
  CoinGeckoHistoricalPriceError,
  type CoinGeckoHistoricalPriceClientShape,
} from "../../../services/CoinGeckoHistoricalPriceClient.ts"
import { makeCoinGeckoRequest } from "../../../shared/CoinGeckoRequest.ts"
import { positiveIntConfig } from "../../../shared/PositiveIntConfig.ts"

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
const STORED_PRICE_SCALE = 18
const STORED_PRICE_UPPER_BOUND = BigDecimal.fromStringUnsafe("1000000000000000000")

const CoinGeckoHistoricalPriceResponse = Schema.Struct({
  market_data: Schema.optional(
    Schema.Struct({
      current_price: Schema.optional(
        Schema.Struct({
          eur: Schema.optional(Schema.Finite),
        })
      ),
    })
  ),
})

const decodeHistoricalPriceResponse = Schema.decodeUnknownEffect(CoinGeckoHistoricalPriceResponse)

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

const toUtcDate = (snapshotAt: Date): string => snapshotAt.toISOString().slice(0, 10)

const toStoredPrice = (eur: number): Option.Option<string> => {
  const decoded = BigDecimal.fromNumber(eur)
  if (Option.isNone(decoded)) return Option.none()

  const rounded = BigDecimal.round(decoded.value, {
    scale: STORED_PRICE_SCALE,
    mode: "half-from-zero",
  })

  return BigDecimal.isPositive(rounded) && BigDecimal.isLessThan(rounded, STORED_PRICE_UPPER_BOUND)
    ? Option.some(BigDecimal.format(rounded))
    : Option.none()
}

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

  const fetchDailyEurPrice: CoinGeckoHistoricalPriceClientShape["fetchDailyEurPrice"] = ({
    coinId,
    snapshotAt,
  }) => {
    const date = toUtcDate(snapshotAt)
    const request = coinGeckoRequest.getRequest(
      `/coins/${encodeURIComponent(coinId)}/history?date=${encodeURIComponent(date)}&localization=false`
    )
    const requestAttempt = httpClient.execute(request).pipe(
      Effect.timeout(requestTimeoutMs),
      Effect.mapError(
        (cause) => new CoinGeckoHistoricalPriceError({ coinId, date, status: null, cause })
      ),
      Effect.flatMap((response) =>
        isRetryableStatus(response.status)
          ? Effect.fail(
              new CoinGeckoHistoricalPriceError({
                coinId,
                date,
                status: response.status,
                cause: `CoinGecko responded ${response.status}`,
              })
            )
          : Effect.succeed(response)
      )
    )

    return requestAttempt.pipe(
      Effect.retry({
        times: retryAttempts,
        schedule: Schedule.exponential(retryBaseDelayMs),
      }),
      Effect.flatMap((response) => {
        if (response.status === 404) {
          return Effect.succeed(Option.none<string>())
        }

        if (response.status < 200 || response.status >= 300) {
          return Effect.fail(
            new CoinGeckoHistoricalPriceError({
              coinId,
              date,
              status: response.status,
              cause: `CoinGecko responded ${response.status}`,
            })
          )
        }

        return response.json.pipe(
          Effect.mapError(
            (cause) =>
              new CoinGeckoHistoricalPriceError({
                coinId,
                date,
                status: response.status,
                cause,
              })
          ),
          Effect.flatMap((payload) =>
            decodeHistoricalPriceResponse(payload).pipe(
              Effect.mapError(
                (cause) =>
                  new CoinGeckoHistoricalPriceError({
                    coinId,
                    date,
                    status: response.status,
                    cause,
                  })
              )
            )
          ),
          Effect.map(({ market_data }) => {
            const eur = market_data?.current_price?.eur
            return eur === undefined ? Option.none<string>() : toStoredPrice(eur)
          })
        )
      })
    )
  }

  return CoinGeckoHistoricalPriceClient.of({ fetchDailyEurPrice })
})

/** CoinGecko historical client layer that still requires an HttpClient for focused tests. */
export const CoinGeckoHistoricalPriceClientLayer = Layer.effect(
  CoinGeckoHistoricalPriceClient,
  make
)

/** Live CoinGecko historical client backed by the configured HTTP endpoint. */
export const CoinGeckoHistoricalPriceClientLive = CoinGeckoHistoricalPriceClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer)
)
