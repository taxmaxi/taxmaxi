/**
 * CoinGeckoHistoricalPriceClientLive - CoinGecko daily EUR history client.
 *
 * @module CoinGeckoHistoricalPriceClientLive
 */

import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { RateLimiter } from "effect/unstable/persistence"
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
import {
  COINGECKO_PRO_API_BASE_URL,
  makeCoinGeckoRequest,
} from "../../../shared/CoinGeckoRequest.ts"
import { positiveIntConfig } from "../../../shared/PositiveIntConfig.ts"

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
// CoinGecko documents 5-15 requests/minute for the keyless public host and
// 500-1,000 requests/minute for the paid host. Use each documented floor;
// unknown/custom hosts use the safer public floor. A deployment may override
// the interval only when its configured plan limit is known.
const PUBLIC_MIN_REQUEST_INTERVAL_MS = 12_000
const PRO_MIN_REQUEST_INTERVAL_MS = 120
const STORED_PRICE_SCALE = 18
const STORED_PRICE_UPPER_BOUND = BigDecimal.fromStringUnsafe("1000000000000000000")

class JsonNumberLiteral {
  constructor(readonly source: string) {}
}

interface JsonParseContext {
  readonly source: string
}

// Node 26 exposes the original primitive text to JSON revivers. TypeScript's
// current JSON declaration does not yet include that third callback argument.
declare global {
  interface JSON {
    parse(
      text: string,
      reviver: (this: unknown, key: string, value: unknown, context: JsonParseContext) => unknown
    ): unknown
  }
}

const CoinGeckoHistoricalPriceResponse = Schema.Struct({
  market_data: Schema.optional(
    Schema.Struct({
      current_price: Schema.optional(
        Schema.Struct({
          eur: Schema.optional(Schema.instanceOf(JsonNumberLiteral)),
        })
      ),
    })
  ),
})

const decodeHistoricalPriceResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CoinGeckoHistoricalPriceResponse, {
    reviver: (_key, value, context) =>
      typeof value === "number" ? new JsonNumberLiteral(context.source) : value,
  })
)

const isRetryableStatus = (status: number): boolean => status === 408 || status >= 500

const toCoinGeckoDate = (snapshotAt: Date): string => {
  const [year, month, day] = snapshotAt.toISOString().slice(0, 10).split("-")
  return `${day}-${month}-${year}`
}

const toStoredPrice = (eur: JsonNumberLiteral): Option.Option<string> => {
  const decoded = BigDecimal.fromString(eur.source)
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
  const limiter = yield* RateLimiter.RateLimiter
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
  const rateLimitKey = coinGeckoRequest.getRequest("/ping").url
  const usesProHost = rateLimitKey.startsWith(`${COINGECKO_PRO_API_BASE_URL}/`)
  const minRequestIntervalMs = yield* positiveIntConfig({
    name: "COINGECKO_HISTORICAL_MIN_INTERVAL_MS",
    defaultValue: usesProHost ? PRO_MIN_REQUEST_INTERVAL_MS : PUBLIC_MIN_REQUEST_INTERVAL_MS,
  })
  const timedHttpClient = httpClient.pipe(
    HttpClient.transformResponse(Effect.timeout(requestTimeoutMs))
  )
  const rateLimitedHttpClient = timedHttpClient.pipe(
    HttpClient.withRateLimiter({
      limiter,
      key: `coingecko-history:${rateLimitKey}`,
      limit: 1,
      window: minRequestIntervalMs,
      algorithm: "token-bucket",
      times: retryAttempts,
    })
  )

  const fetchDailyEurPrice: CoinGeckoHistoricalPriceClientShape["fetchDailyEurPrice"] = ({
    coinId,
    snapshotAt,
  }) => {
    const date = toCoinGeckoDate(snapshotAt)
    const request = coinGeckoRequest.getRequest(
      `/coins/${encodeURIComponent(coinId)}/history?date=${encodeURIComponent(date)}&localization=false`
    )
    const requestAttempt = rateLimitedHttpClient.execute(request).pipe(
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

        return response.text.pipe(
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
).pipe(Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))))

/** Live CoinGecko historical client backed by the configured HTTP endpoint. */
export const CoinGeckoHistoricalPriceClientLive = CoinGeckoHistoricalPriceClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer)
)
