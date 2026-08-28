import { FetchHttpClient } from "effect/unstable/http"
import { ConfigProvider, Effect } from "effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "@effect/vitest"
import { CoinGeckoClientLive } from "../src/layers/CoinGeckoClientLive.ts"
import { CoinGeckoClient } from "../src/services/coingecko/CoinGeckoClient.ts"

const configProvider = ConfigProvider.fromEnvRecord({
  COINGECKO_API_BASE_URL: "https://coingecko.example.test/v3",
  COINGECKO_API_KEY: "demo-key",
})

const ClientTestLive = CoinGeckoClientLive.pipe(Layer.provide(FetchHttpClient.layer))

const runClient = <A>(
  effect: Effect.Effect<A, unknown, CoinGeckoClient>,
  fetch: typeof globalThis.fetch,
  provider = configProvider
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ClientTestLive),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(ConfigProvider.ConfigProvider, provider)
    )
  )

const runFetchHandler = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]): URL =>
  new URL(input instanceof Request ? input.url : input.toString())

describe("CoinGeckoClientLive", () => {
  it.effect("uses the public API without authentication by default", () =>
    Effect.gen(function* () {
      let requestUrlValue: URL | undefined
      let apiKey: string | null = null

      yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            return yield* client.searchCoins({ query: "BTC" })
          }),
          (input, init) =>
            runFetchHandler(
              Effect.sync(() => {
                requestUrlValue = requestUrl(input)
                const headers = new Headers(
                  init?.headers ?? (input instanceof Request ? input.headers : {})
                )
                apiKey = headers.get("x-cg-pro-api-key")
                return Response.json({ coins: [] })
              })
            ),
          ConfigProvider.fromEnvRecord({})
        )
      )

      expect(requestUrlValue?.origin).toBe("https://api.coingecko.com")
      expect(requestUrlValue?.pathname).toBe("/api/v3/search")
      expect(apiKey).toBeNull()
    })
  )

  it.effect("uses Demo authentication for the generic API key", () =>
    Effect.gen(function* () {
      let requestUrlValue: URL | undefined
      let demoApiKey: string | null = null
      let proApiKey: string | null = null

      yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            return yield* client.searchCoins({ query: "BTC" })
          }),
          (input, init) =>
            runFetchHandler(
              Effect.sync(() => {
                requestUrlValue = requestUrl(input)
                const headers = new Headers(
                  init?.headers ?? (input instanceof Request ? input.headers : {})
                )
                demoApiKey = headers.get("x-cg-demo-api-key")
                proApiKey = headers.get("x-cg-pro-api-key")
                return Response.json({ coins: [] })
              })
            ),
          ConfigProvider.fromEnvRecord({ COINGECKO_API_KEY: "demo-key" })
        )
      )

      expect(requestUrlValue?.origin).toBe("https://api.coingecko.com")
      expect(demoApiKey).toBe("demo-key")
      expect(proApiKey).toBeNull()
    })
  )

  it.effect("shares configuration, Demo authentication, decoding, and market batching", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: URL; readonly apiKey: string | null }> = []
      const fetch: typeof globalThis.fetch = (input, init) =>
        runFetchHandler(
          Effect.sync(() => {
            const url = requestUrl(input)
            const headers = new Headers(
              init?.headers ?? (input instanceof Request ? input.headers : {})
            )
            requests.push({ url, apiKey: headers.get("x-cg-demo-api-key") })

            if (url.pathname.endsWith("/search")) {
              return Response.json({ coins: [{ id: "bitcoin", name: "Bitcoin", symbol: "btc" }] })
            }

            if (url.pathname.endsWith("/coins/bitcoin")) {
              return Response.json({
                id: "bitcoin",
                name: "Bitcoin",
                symbol: "btc",
                asset_platform_id: null,
                platforms: { bitcoin: "" },
                detail_platforms: {},
                image: {
                  thumb: "https://images.example.test/btc-thumb.png",
                  small: "https://images.example.test/btc-small.png",
                  large: "https://images.example.test/btc-large.png",
                },
              })
            }

            if (url.pathname.endsWith("/coins/markets")) {
              const firstId = url.searchParams.get("ids")?.split(",")[0] ?? "missing"
              return Response.json([
                {
                  id: firstId,
                  image: `https://images.example.test/${firstId}.png`,
                  current_price: 123.45,
                },
              ])
            }

            return new Response("not found", { status: 404 })
          })
        )

      const result = yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            const search = yield* client.searchCoins({ query: "BTC" })
            const coin = yield* client.getCoin({ coinId: "bitcoin" })
            const markets = yield* client.listMarkets({
              coinIds: Array.from({ length: 251 }, (_, index) => `coin-${index}`),
              currency: "eur",
            })
            return { search, coin, markets }
          }),
          fetch
        )
      )

      expect(result.search).toEqual([{ id: "bitcoin", name: "Bitcoin", symbol: "btc" }])
      expect(result.coin.id).toBe("bitcoin")
      expect(result.markets).toEqual([
        {
          id: "coin-0",
          image: "https://images.example.test/coin-0.png",
          currentPrice: 123.45,
        },
        {
          id: "coin-250",
          image: "https://images.example.test/coin-250.png",
          currentPrice: 123.45,
        },
      ])
      expect(requests).toHaveLength(4)
      expect(requests.every((request) => request.apiKey === "demo-key")).toBe(true)
      expect(
        requests.every((request) => request.url.origin === "https://coingecko.example.test")
      ).toBe(true)
    })
  )

  it.effect("uses the Pro API only with an explicit Pro key", () =>
    Effect.gen(function* () {
      let requestUrlValue: URL | undefined
      let proApiKey: string | null = null

      yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            return yield* client.searchCoins({ query: "BTC" })
          }),
          (input, init) =>
            runFetchHandler(
              Effect.sync(() => {
                requestUrlValue = requestUrl(input)
                const headers = new Headers(
                  init?.headers ?? (input instanceof Request ? input.headers : {})
                )
                proApiKey = headers.get("x-cg-pro-api-key")
                return Response.json({ coins: [] })
              })
            ),
          ConfigProvider.fromEnvRecord({ COINGECKO_PRO_API_KEY: "pro-key" })
        )
      )

      expect(requestUrlValue?.origin).toBe("https://pro-api.coingecko.com")
      expect(proApiKey).toBe("pro-key")
    })
  )

  it.effect("returns one client error for non-success responses", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            return yield* Effect.result(client.searchCoins({ query: "BTC" }))
          }),
          () =>
            runFetchHandler(
              Effect.sync(() => {
                return new Response("rate limited", { status: 429 })
              })
            )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("CoinGeckoClientError")
        expect(result.failure.message).toContain("429")
        expect(result.failure.message).toContain("rate limited")
      }
    })
  )

  it.effect("returns one client error for malformed endpoint payloads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runClient(
          Effect.gen(function* () {
            const client = yield* CoinGeckoClient
            return yield* Effect.result(client.searchCoins({ query: "BTC" }))
          }),
          () =>
            runFetchHandler(
              Effect.sync(() => {
                return Response.json({ coins: [{ id: 123 }] })
              })
            )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("CoinGeckoClientError")
        expect(result.failure.message).toContain("Failed to decode CoinGecko response")
      }
    })
  )
})
