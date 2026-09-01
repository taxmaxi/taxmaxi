import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientError } from "effect/unstable/http/HttpClientError"
import { describe, expect, it } from "@effect/vitest"
import { CoinGeckoHistoricalPriceClientLayer } from "../../src/providers/coingecko/layers/CoinGeckoHistoricalPriceClientLive.ts"
import {
  CoinGeckoHistoricalPriceClient,
  CoinGeckoHistoricalPriceError,
} from "../../src/services/CoinGeckoHistoricalPriceClient.ts"

const testConfigProvider = ConfigProvider.fromEnvRecord({
  COINGECKO_REQUEST_TIMEOUT_MS: "50",
  COINGECKO_RETRY_ATTEMPTS: "2",
  COINGECKO_RETRY_BASE_DELAY_MS: "1",
})

const snapshotAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T00:00:00.000Z"))

const jsonResponse = (url: URL, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get(url.toString()),
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  )

const runFetch = ({
  handler,
}: {
  readonly handler: (
    url: URL
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
}) =>
  Effect.runPromise(
    Effect.flatMap(CoinGeckoHistoricalPriceClient, (client) =>
      client.fetchDailyEurPrice({ coinId: "solana", snapshotAt }).pipe(Effect.result)
    ).pipe(
      Effect.provide(
        CoinGeckoHistoricalPriceClientLayer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((_request, url) => handler(url))
            )
          )
        )
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, testConfigProvider)
    )
  )

describe("CoinGeckoHistoricalPriceClientLive", () => {
  it.effect("reads the EUR value from the exact UTC daily history request", () =>
    Effect.gen(function* () {
      const urls: Array<string> = []
      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (url) =>
            Effect.sync(() => {
              urls.push(url.toString())
              return jsonResponse(url, {
                market_data: { current_price: { eur: 128.375 } },
              })
            }),
        })
      )

      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain("/coins/solana/history")
      expect(urls[0]).toContain("date=2025-03-04")
      expect(urls[0]).toContain("localization=false")
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(Option.getOrNull(result.success)).toBe("128.375")
      }
    })
  )

  it.effect.each([
    { market_data: { current_price: {} } },
    { market_data: { current_price: { eur: 0 } } },
    { market_data: { current_price: { eur: -1 } } },
    { market_data: { current_price: { eur: 0.00000000000000000049 } } },
    { market_data: { current_price: { eur: 1000000000000000000 } } },
  ] as const)("returns no stored value for an unusable EUR quote", (payload) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runFetch({ handler: (url) => Effect.succeed(jsonResponse(url, payload)) })
      )

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(Option.isNone(result.success)).toBe(true)
      }
    })
  )

  it.effect("retries transient responses and reports failure after the retry budget", () =>
    Effect.gen(function* () {
      let requests = 0
      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (url) =>
            Effect.sync(() => {
              requests += 1
              return jsonResponse(url, {}, 429)
            }),
        })
      )

      expect(requests).toBe(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(CoinGeckoHistoricalPriceError)
        expect(result.failure.status).toBe(429)
      }
    })
  )

  it.effect("returns no value when CoinGecko has no coin history for the date", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runFetch({ handler: (url) => Effect.succeed(jsonResponse(url, {}, 404)) })
      )

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(Option.isNone(result.success)).toBe(true)
      }
    })
  )

  it.effect("reports an authentication response without retrying or inventing a value", () =>
    Effect.gen(function* () {
      let requests = 0
      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (url) =>
            Effect.sync(() => {
              requests += 1
              return jsonResponse(url, {}, 401)
            }),
        })
      )

      expect(requests).toBe(1)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.status).toBe(401)
      }
    })
  )
})
