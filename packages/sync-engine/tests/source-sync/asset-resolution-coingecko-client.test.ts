import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { describe, expect, it } from "vitest"
import { AssetResolutionCoinGeckoClientLayer } from "../../src/layers/AssetResolutionCoinGeckoClientLive.ts"
import {
  AssetResolutionCoinGeckoClient,
  AssetResolutionCoinGeckoRetryableError,
} from "../../src/services/AssetResolutionCoinGeckoClient.ts"

const COIN_PAYLOAD = {
  id: "orb",
  symbol: "orb",
  name: "Orb",
  asset_platform_id: "solana",
  platforms: { solana: "OrbMint1111111111111111111111111111111111111" },
  detail_platforms: {},
}

const testConfigProvider = ConfigProvider.fromEnvRecord({
  COINGECKO_REQUEST_TIMEOUT_MS: "50",
  COINGECKO_RETRY_ATTEMPTS: "2",
  COINGECKO_RETRY_BASE_DELAY_MS: "1",
})

const ORB_MINT = "OrbMint1111111111111111111111111111111111111"

const runFetch = ({
  handler,
}: {
  readonly handler: (
    url: URL
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
}) =>
  Effect.runPromise(
    Effect.flatMap(AssetResolutionCoinGeckoClient, (client) =>
      client.fetchCoinByContract({ platformId: "solana", address: ORB_MINT }).pipe(Effect.result)
    ).pipe(
      Effect.provide(
        AssetResolutionCoinGeckoClientLayer.pipe(
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

const jsonResponse = (url: URL, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get(url.toString()),
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  )

describe("AssetResolutionCoinGeckoClientLive", () => {
  it("returns the decoded payload for a 2xx response", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (url) =>
        Effect.sync(() => {
          requests += 1
          return jsonResponse(url, COIN_PAYLOAD)
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success" && result.success._tag === "payload") {
      expect(result.success.payload).toMatchObject({ id: "orb" })
    } else {
      throw new Error("Expected a payload evidence value")
    }
  })

  it("URL-encodes the platform id and address into the request path", async () => {
    const urls: Array<string> = []

    await Effect.runPromise(
      Effect.flatMap(AssetResolutionCoinGeckoClient, (client) =>
        client
          .fetchCoinByContract({ platformId: "weird/id", address: "0xAb?x=1" })
          .pipe(Effect.result)
      ).pipe(
        Effect.provide(
          AssetResolutionCoinGeckoClientLayer.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((_request, url) =>
                  Effect.sync(() => {
                    urls.push(url.toString())
                    return jsonResponse(url, COIN_PAYLOAD)
                  })
                )
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, testConfigProvider)
      )
    )

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("/coins/weird%2Fid/contract/0xAb%3Fx%3D1")
    expect(urls[0]).not.toContain("/coins/weird/id")
  })

  it.each([[429], [500], [503]])(
    "retries a %s response and fails retryable once attempts are exhausted",
    async (status) => {
      let requests = 0

      const result = await runFetch({
        handler: (url) =>
          Effect.sync(() => {
            requests += 1
            return jsonResponse(url, {}, status)
          }),
      })

      // 1 initial attempt + 2 retries.
      expect(requests).toBe(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AssetResolutionCoinGeckoRetryableError)
        expect(result.failure.status).toBe(status)
      }
    }
  )

  it("recovers when a retried attempt succeeds", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (url) =>
        Effect.sync(() => {
          requests += 1
          return requests === 1 ? jsonResponse(url, {}, 429) : jsonResponse(url, COIN_PAYLOAD)
        }),
    })

    expect(requests).toBe(2)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("payload")
    }
  })

  it("fails retryable on a transport error", async () => {
    let requests = 0

    const result = await runFetch({
      handler: () =>
        Effect.sync(() => {
          requests += 1
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new HttpClientError({
                reason: new TransportError({
                  request: HttpClientRequest.get("https://example.test"),
                  description: "connection refused",
                }),
              })
            )
          )
        ),
    })

    expect(requests).toBe(3)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(AssetResolutionCoinGeckoRetryableError)
      expect(result.failure.status).toBeNull()
    }
  })

  it("fails retryable when the request times out", async () => {
    const result = await runFetch({
      handler: (url) => Effect.delay(Effect.succeed(jsonResponse(url, COIN_PAYLOAD)), "5 seconds"),
    })

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(AssetResolutionCoinGeckoRetryableError)
      expect(result.failure.status).toBeNull()
    }
  }, 10_000)

  it("treats a 404 as a definitive not-found answer without retrying", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (url) =>
        Effect.sync(() => {
          requests += 1
          return jsonResponse(url, { error: "coin not found" }, 404)
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("registry_not_found")
    }
  })

  it("treats an unexpected 4xx as a terminal upstream failure without retrying", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (url) =>
        Effect.sync(() => {
          requests += 1
          return jsonResponse(url, { error: "bad request" }, 400)
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("upstream_failure")
    }
  })

  it("treats an unreadable 200 body as a terminal upstream failure without retrying", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (url) =>
        Effect.sync(() => {
          requests += 1
          return HttpClientResponse.fromWeb(
            HttpClientRequest.get(url.toString()),
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("upstream_failure")
    }
  })
})
