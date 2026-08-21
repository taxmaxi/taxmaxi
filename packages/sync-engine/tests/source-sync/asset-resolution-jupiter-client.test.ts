import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { describe, expect, it } from "vitest"
import { AssetResolutionJupiterClientLayer } from "../../src/providers/jupiter/layers/AssetResolutionJupiterClientLive.ts"
import {
  AssetResolutionJupiterClient,
  AssetResolutionJupiterRetryableError,
} from "../../src/providers/jupiter/services/AssetResolutionJupiterClient.ts"

const ORB_MINT = "OrbMint1111111111111111111111111111111111111"

const SEARCH_PAYLOAD = [
  {
    id: ORB_MINT,
    name: "Orb",
    symbol: "ORB",
    decimals: 9,
    tags: ["banned"],
    audit: { isSus: true },
  },
]

const testConfigProvider = ConfigProvider.fromEnvRecord({
  JUPITER_API_KEY: "  test-api-key \n",
  JUPITER_REQUEST_TIMEOUT_MS: "50",
  JUPITER_RETRY_ATTEMPTS: "2",
  JUPITER_RETRY_BASE_DELAY_MS: "1",
})

const runFetch = ({
  handler,
}: {
  readonly handler: (
    request: HttpClientRequest.HttpClientRequest,
    url: URL
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
}) =>
  Effect.runPromise(
    Effect.flatMap(AssetResolutionJupiterClient, (client) =>
      client.fetchTokenByMint({ mintAddress: ORB_MINT }).pipe(Effect.result)
    ).pipe(
      Effect.provide(
        AssetResolutionJupiterClientLayer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request, url) => handler(request, url))
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

describe("AssetResolutionJupiterClientLive", () => {
  it("returns the raw payload for a 2xx response", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (_request, url) =>
        Effect.sync(() => {
          requests += 1
          return jsonResponse(url, SEARCH_PAYLOAD)
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success" && result.success._tag === "payload") {
      expect(result.success.payload).toEqual([expect.objectContaining({ id: ORB_MINT })])
    } else {
      throw new Error("Expected a payload evidence value")
    }
  })

  it("calls the search endpoint with the URL-encoded mint and the API key header", async () => {
    const urls: Array<string> = []
    const headers: Array<string | undefined> = []

    await Effect.runPromise(
      Effect.flatMap(AssetResolutionJupiterClient, (client) =>
        client.fetchTokenByMint({ mintAddress: "Weird?Mint=1" }).pipe(Effect.result)
      ).pipe(
        Effect.provide(
          AssetResolutionJupiterClientLayer.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request, url) =>
                  Effect.sync(() => {
                    urls.push(url.toString())
                    headers.push(request.headers["x-api-key"])
                    return jsonResponse(url, [])
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
    expect(urls[0]).toContain("/tokens/v2/search?query=Weird%3FMint%3D1")
    expect(headers).toEqual(["test-api-key"])
  })

  it("fails at construction when JUPITER_API_KEY is missing", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(AssetResolutionJupiterClient, (client) =>
        client.fetchTokenByMint({ mintAddress: ORB_MINT })
      ).pipe(
        Effect.provide(
          AssetResolutionJupiterClientLayer.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((_request, url) => Effect.sync(() => jsonResponse(url, [])))
              )
            )
          )
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
        Effect.result
      )
    )

    expect(result._tag).toBe("Failure")
  })

  it.each(["", " \t\n "])(
    "fails layer construction when JUPITER_API_KEY is blank (%j)",
    async (apiKey) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            AssetResolutionJupiterClientLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((_request, url) => Effect.sync(() => jsonResponse(url, [])))
                )
              )
            )
          )
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ JUPITER_API_KEY: apiKey })
          ),
          Effect.result
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(Config.ConfigError)
      }
    }
  )

  it.each([[429], [500], [503]])(
    "retries a %s response and fails retryable once attempts are exhausted",
    async (status) => {
      let requests = 0

      const result = await runFetch({
        handler: (_request, url) =>
          Effect.sync(() => {
            requests += 1
            return jsonResponse(url, {}, status)
          }),
      })

      // 1 initial attempt + 2 retries.
      expect(requests).toBe(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
        expect(result.failure.status).toBe(status)
      }
    }
  )

  it("recovers when a retried attempt succeeds", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (_request, url) =>
        Effect.sync(() => {
          requests += 1
          return requests === 1 ? jsonResponse(url, {}, 429) : jsonResponse(url, SEARCH_PAYLOAD)
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
      expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
      expect(result.failure.status).toBeNull()
    }
  })

  it("fails retryable when the request times out", async () => {
    const result = await runFetch({
      handler: (_request, url) =>
        Effect.delay(Effect.succeed(jsonResponse(url, SEARCH_PAYLOAD)), "5 seconds"),
    })

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
      expect(result.failure.status).toBeNull()
    }
  }, 10_000)

  it("treats an unexpected 4xx as a terminal upstream failure without retrying", async () => {
    let requests = 0

    const result = await runFetch({
      handler: (_request, url) =>
        Effect.sync(() => {
          requests += 1
          return jsonResponse(url, { status: 400, message: "Invalid query." }, 400)
        }),
    })

    expect(requests).toBe(1)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("upstream_failure")
    }
  })

  it("treats an unreadable body as a terminal upstream failure", async () => {
    const result = await runFetch({
      handler: (_request, url) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            HttpClientRequest.get(url.toString()),
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        ),
    })

    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success._tag).toBe("upstream_failure")
    }
  })
})
