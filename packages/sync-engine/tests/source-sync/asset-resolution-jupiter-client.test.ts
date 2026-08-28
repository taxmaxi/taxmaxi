import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { describe, expect, it } from "@effect/vitest"
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

const stalledJsonResponse = (url: URL) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get(url.toString()),
    new Response(
      new ReadableStream<Uint8Array>({
        start: () => undefined,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    )
  )

describe("AssetResolutionJupiterClientLive", () => {
  it.effect("returns the raw payload for a 2xx response", () =>
    Effect.gen(function* () {
      let requests = 0

      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (_request, url) =>
            Effect.sync(() => {
              requests += 1
              return jsonResponse(url, SEARCH_PAYLOAD)
            }),
        })
      )

      expect(requests).toBe(1)
      expect(result._tag).toBe("Success")
      if (result._tag === "Success" && result.success._tag === "payload") {
        expect(result.success.payload).toEqual([expect.objectContaining({ id: ORB_MINT })])
      } else {
        throw new Error("Expected a payload evidence value")
      }
    })
  )

  it.effect("calls the search endpoint with the URL-encoded mint and the API key header", () =>
    Effect.gen(function* () {
      const urls: Array<string> = []
      const headers: Array<string | undefined> = []

      yield* Effect.flatMap(AssetResolutionJupiterClient, (client) =>
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

      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain("/tokens/v2/search?query=Weird%3FMint%3D1")
      expect(headers).toEqual(["test-api-key"])
    })
  )

  it.effect("fails at construction when JUPITER_API_KEY is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flatMap(AssetResolutionJupiterClient, (client) =>
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

      expect(result._tag).toBe("Failure")
    })
  )

  it.effect.each(["", " \t\n "])(
    "fails layer construction when JUPITER_API_KEY is blank (%j)",
    (apiKey) =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
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

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(Config.ConfigError)
        }
      })
  )

  it.effect.each([429, 500, 503])(
    "retries a %s response and fails retryable once attempts are exhausted",
    (status) =>
      Effect.gen(function* () {
        let requests = 0

        const result = yield* Effect.promise(() =>
          runFetch({
            handler: (_request, url) =>
              Effect.sync(() => {
                requests += 1
                return jsonResponse(url, {}, status)
              }),
          })
        )

        // 1 initial attempt + 2 retries.
        expect(requests).toBe(3)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
          expect(result.failure.status).toBe(status)
        }
      })
  )

  it.effect("recovers when a retried attempt succeeds", () =>
    Effect.gen(function* () {
      let requests = 0

      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (_request, url) =>
            Effect.sync(() => {
              requests += 1
              return requests === 1 ? jsonResponse(url, {}, 429) : jsonResponse(url, SEARCH_PAYLOAD)
            }),
        })
      )

      expect(requests).toBe(2)
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.success._tag).toBe("payload")
      }
    })
  )

  it.effect("fails retryable on a transport error", () =>
    Effect.gen(function* () {
      let requests = 0

      const result = yield* Effect.promise(() =>
        runFetch({
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
      )

      expect(requests).toBe(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
        expect(result.failure.status).toBeNull()
      }
    })
  )

  it.effect(
    "fails retryable when the request times out",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          runFetch({
            handler: (_request, url) =>
              Effect.delay(Effect.succeed(jsonResponse(url, SEARCH_PAYLOAD)), "5 seconds"),
          })
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
          expect(result.failure.status).toBeNull()
        }
      }),
    10_000
  )

  it.effect("times out and retries when response headers arrive but the body stalls", () =>
    Effect.gen(function* () {
      let requests = 0

      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (_request, url) =>
            Effect.sync(() => {
              requests += 1
              return stalledJsonResponse(url)
            }),
        })
      )

      expect(requests).toBe(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
        expect(result.failure.status).toBeNull()
      }
    })
  )

  it.effect("fails retryable when a successful response stalls while reading the body", () =>
    Effect.gen(function* () {
      const testSafetyTimeout = Symbol("test-safety-timeout")
      const result = yield* Effect.race(
        Effect.promise(() =>
          runFetch({
            handler: (_request, url) =>
              Effect.sync(() =>
                HttpClientResponse.fromWeb(
                  HttpClientRequest.get(url.toString()),
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start: (controller) => {
                        controller.enqueue(new TextEncoder().encode("["))
                      },
                    }),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }
                  )
                )
              ),
          })
        ),
        Effect.sleep("500 millis").pipe(Effect.as(testSafetyTimeout))
      )

      expect(result).not.toBe(testSafetyTimeout)
      if (result === testSafetyTimeout) {
        return yield* Effect.die("Jupiter response-body read exceeded the request timeout")
      }
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AssetResolutionJupiterRetryableError)
        expect(result.failure.status).toBeNull()
      }
    })
  )

  it.effect("treats an unexpected 4xx as a terminal upstream failure without retrying", () =>
    Effect.gen(function* () {
      let requests = 0

      const result = yield* Effect.promise(() =>
        runFetch({
          handler: (_request, url) =>
            Effect.sync(() => {
              requests += 1
              return jsonResponse(url, { status: 400, message: "Invalid query." }, 400)
            }),
        })
      )

      expect(requests).toBe(1)
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.success._tag).toBe("upstream_failure")
      }
    })
  )

  it.effect("treats an unreadable body as a terminal upstream failure", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runFetch({
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
      )

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.success._tag).toBe("upstream_failure")
      }
    })
  )
})
