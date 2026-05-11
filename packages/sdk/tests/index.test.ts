import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  DEFAULT_BASE_URL,
  TaxMaxi,
  TaxMaxiError,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  type TaxMaxiHeaders,
} from "../src/index.ts"

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>

type CapturedRequest = {
  readonly credentials: string | undefined
  readonly headers: TaxMaxiHeaders
  readonly url: string
}

const healthResponseBody = JSON.stringify({
  status: "ok",
  timestamp: "2026-04-29T00:00:00.000Z",
  version: null,
})

const sourceListResponseBody = JSON.stringify({
  sources: [],
})

const toHeaderRecord = (headers: FetchInit["headers"]): TaxMaxiHeaders => {
  const record: Record<string, string> = {}

  for (const [key, value] of new Headers(headers)) {
    record[key] = value
  }

  return record
}

const getRequestUrl = (input: FetchInput): string => {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

const makeFetch =
  (
    capturedRequests: Array<CapturedRequest>,
    responseBody: string = healthResponseBody
  ): typeof globalThis.fetch =>
  async (input, init) => {
    capturedRequests.push({
      credentials: init?.credentials === undefined ? undefined : String(init.credentials),
      headers: toHeaderRecord(init?.headers),
      url: getRequestUrl(input),
    })

    return new Response(responseBody, {
      headers: {
        "Content-Type": "application/json",
      },
      status: 200,
    })
  }

describe("normalizeBaseUrl", () => {
  it("defaults to the production API URL", () => {
    expect(normalizeBaseUrl()).toBe(DEFAULT_BASE_URL)
  })

  it("removes trailing slashes, search params, and hash fragments", () => {
    expect(normalizeBaseUrl("https://api.example.test/v1/")).toBe("https://api.example.test/v1")
    expect(normalizeBaseUrl(new URL("http://localhost:4000/api/?ignored=true#hash"))).toBe(
      "http://localhost:4000/api"
    )
  })
})

describe("TaxMaxi Effect client foundation", () => {
  it("constructs a TaxMaxiApi HttpApiClient with injected fetch, credentials, and headers", async () => {
    const capturedRequests: Array<CapturedRequest> = []

    const client = await Effect.runPromise(
      TaxMaxi.makeEffectClient({
        apiKey: "tm_test_phase_1",
        baseUrl: "https://sdk.example.test/",
        credentials: "include",
        fetch: makeFetch(capturedRequests),
        headers: {
          Authorization: "Bearer should-be-overridden",
          "X-TaxMaxi-Client": "phase-1",
        },
      })
    )

    await Effect.runPromise(client.health.healthCheck(undefined))

    expect(capturedRequests).toEqual([
      {
        credentials: "include",
        headers: expect.objectContaining({
          authorization: "Bearer tm_test_phase_1",
          "x-taxmaxi-client": "phase-1",
        }),
        url: "https://sdk.example.test/health",
      },
    ])
  })

  it("resolves dynamic headers for each request", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    let requestCount = 0

    const client = await Effect.runPromise(
      TaxMaxi.makeEffectClient({
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests),
        headers: () => {
          requestCount += 1
          return {
            "X-Request-Count": String(requestCount),
          }
        },
      })
    )

    await Effect.runPromise(client.health.healthCheck(undefined))
    await Effect.runPromise(client.health.healthCheck(undefined))

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({ "x-request-count": "1" }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-request-count": "2" }),
      }),
    ])
  })

  it("exposes the same client construction through TaxMaxi instances", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = new TaxMaxi({
      apiKey: "tm_instance",
      baseUrl: "https://sdk.example.test",
      fetch: makeFetch(capturedRequests, sourceListResponseBody),
    })

    await taxmaxi.sources.list()

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer tm_instance",
        }),
        url: "https://sdk.example.test/v1/sources",
      }),
    ])
  })

  it("exports the request transform for lower-level Effect composition", () => {
    expect(typeof makeTaxMaxiHttpClientTransform).toBe("function")
  })
})

describe("TaxMaxi Promise client", () => {
  it("plumbs successful resource responses through Promise methods", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = new TaxMaxi({
      apiKey: "tm_test_phase_2",
      baseUrl: "https://sdk.example.test",
      fetch: makeFetch(capturedRequests, sourceListResponseBody),
    })

    await expect(taxmaxi.sources.list()).resolves.toEqual({
      sources: [],
    })

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer tm_test_phase_2",
        }),
        url: "https://sdk.example.test/v1/sources",
      }),
    ])
  })

  it("keeps Effect-native resource methods available", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = new TaxMaxi({
      apiKey: "tm_test_phase_2",
      baseUrl: "https://sdk.example.test",
      fetch: makeFetch(capturedRequests, sourceListResponseBody),
    })

    await expect(Effect.runPromise(taxmaxi.effect.sources.list())).resolves.toEqual({
      sources: [],
    })
  })

  it("normalizes Promise method failures into TaxMaxiError", async () => {
    const taxmaxi = new TaxMaxi({
      apiKey: "tm_test_phase_2",
      baseUrl: "https://sdk.example.test",
      fetch: async () => {
        throw new TypeError("socket closed")
      },
    })

    try {
      await taxmaxi.sources.list()
    } catch (error) {
      expect(error).toBeInstanceOf(TaxMaxiError)

      if (error instanceof TaxMaxiError) {
        expect(error.status).toBe(0)
        expect(error.message).toContain("Could not reach the TaxMaxi API")
      }

      return
    }

    expect.unreachable("Expected TaxMaxiError")
  })

  it("builds explicit first-party request clients with cookie headers", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = TaxMaxi.fromRequest({
      baseUrl: "https://sdk.example.test",
      cookieHeader: "sid=session-value",
      fetch: makeFetch(capturedRequests, sourceListResponseBody),
    })

    await taxmaxi.sources.list()

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "sid=session-value",
        }),
      }),
    ])
  })
})
