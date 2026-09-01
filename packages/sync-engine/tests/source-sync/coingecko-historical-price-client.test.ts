import { ConfigProvider, DateTime, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
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
  COINGECKO_HISTORICAL_MIN_INTERVAL_MS: "1000",
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
  configProvider = testConfigProvider,
}: {
  readonly handler: (
    url: URL
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
  readonly configProvider?: ConfigProvider.ConfigProvider
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
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
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
      expect(urls[0]).toContain("date=04-03-2025")
      expect(urls[0]).toContain("localization=false")
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(Option.getOrNull(result.success)).toBe("128.375")
      }
    })
  )

  it.effect("stores the smallest positive value at the canonical 18-decimal scale", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (url) =>
            Effect.succeed(
              jsonResponse(url, {
                market_data: { current_price: { eur: 0.0000000000000000005 } },
              })
            ),
        })
      )

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(Option.getOrNull(result.success)).toBe("1e-18")
      }
    })
  )

  it.effect("paces requests shared by one client layer", () =>
    Effect.gen(function* () {
      const requestTimes: Array<number> = []
      const program = Effect.gen(function* () {
        const client = yield* CoinGeckoHistoricalPriceClient
        const first = yield* client.fetchDailyEurPrice({ coinId: "solana", snapshotAt })
        const second = yield* client
          .fetchDailyEurPrice({ coinId: "bitcoin", snapshotAt })
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* Effect.yieldNow
        expect(Option.isSome(first)).toBe(true)
        expect(requestTimes).toEqual([0])

        yield* TestClock.adjust("999 millis")
        expect(requestTimes).toEqual([0])

        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(second)
        expect(requestTimes).toEqual([0, 1000])
      })

      yield* program.pipe(
        Effect.provide(
          CoinGeckoHistoricalPriceClientLayer.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((_request, url) =>
                  Effect.clockWith((clock) =>
                    Effect.map(clock.currentTimeMillis, (now) => {
                      requestTimes.push(now)
                      return jsonResponse(url, {
                        market_data: { current_price: { eur: 1 } },
                      })
                    })
                  )
                )
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, testConfigProvider)
      )
    })
  )

  it.effect("honors Retry-After before retrying a rate-limited request", () =>
    Effect.gen(function* () {
      let requests = 0
      const program = Effect.gen(function* () {
        const client = yield* CoinGeckoHistoricalPriceClient
        const resultFiber = yield* client
          .fetchDailyEurPrice({ coinId: "solana", snapshotAt })
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* Effect.yieldNow
        expect(requests).toBe(1)

        yield* TestClock.adjust("4999 millis")
        expect(requests).toBe(1)

        yield* TestClock.adjust("1 millis")
        const result = yield* Fiber.join(resultFiber)
        expect(requests).toBe(2)
        expect(Option.getOrNull(result)).toBe("1")
      })

      yield* program.pipe(
        Effect.provide(
          CoinGeckoHistoricalPriceClientLayer.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((_request, url) =>
                  Effect.sync(() => {
                    requests += 1
                    return requests === 1
                      ? HttpClientResponse.fromWeb(
                          HttpClientRequest.get(url.toString()),
                          new Response(null, {
                            status: 429,
                            headers: { "retry-after": "5" },
                          })
                        )
                      : jsonResponse(url, {
                          market_data: { current_price: { eur: 1 } },
                        })
                  })
                )
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, testConfigProvider)
      )
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

  it.effect("reports an invalid configured base URL through the typed client error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runFetch({
          configProvider: ConfigProvider.fromEnvRecord({
            COINGECKO_API_BASE_URL: "not a URL",
            COINGECKO_REQUEST_TIMEOUT_MS: "50",
            COINGECKO_RETRY_ATTEMPTS: "2",
            COINGECKO_RETRY_BASE_DELAY_MS: "1",
            COINGECKO_HISTORICAL_MIN_INTERVAL_MS: "1",
          }),
          handler: (url) => Effect.succeed(jsonResponse(url, {})),
        })
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(CoinGeckoHistoricalPriceError)
        expect(result.failure.status).toBeNull()
      }
    })
  )
})
