import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  DEFAULT_BASE_URL,
  TaxMaxi,
  TaxMaxiError,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  toTaxMaxiError,
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

const sourceCreateResponseBody = JSON.stringify({
  source: {
    id: "00000000-0000-4000-8000-000000000001",
    principalId: "00000000-0000-4000-8000-000000000002",
    name: "Demo Solana wallet",
    providerKey: "solana",
    sourceRef: {
      _tag: "onchain",
      addressId: "00000000-0000-4000-8000-000000000003",
    },
    createdAt: {
      epochMillis: 1_767_225_600_000,
    },
  },
  created: true,
  syncJob: null,
  syncUnavailable: null,
  claim: {
    requestId: "00000000-0000-4000-8000-000000000004",
    claimToken: "claim-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
  },
})

const anonSourceJobResponse = {
  sourceId: "00000000-0000-4000-8000-000000000001",
  jobId: "00000000-0000-4000-8000-000000000005",
  status: "queued",
  importedRecords: null,
  normalizedRecords: null,
  failedRecords: null,
  message: null,
}

const anonSourceJobsResponseBody = JSON.stringify({
  jobs: [anonSourceJobResponse],
})

const anonSourceJobResponseBody = JSON.stringify(anonSourceJobResponse)

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

  it("creates paid anonymous sources through the injected fetch implementation", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://sdk.example.test",
      fetch: makeFetch(capturedRequests, sourceCreateResponseBody),
    })

    await expect(
      taxmaxi.sources.create({
        type: "onchain",
        walletAddress: "So11111111111111111111111111111111111111112",
        name: "Demo Solana wallet",
      })
    ).resolves.toMatchObject({
      created: true,
      source: {
        name: "Demo Solana wallet",
        providerKey: "solana",
      },
    })

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        credentials: "include",
        url: "https://sdk.example.test/v1/sources",
      }),
    ])
  })

  it("plumbs anonymous source sync-status methods through browser sessions", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const responseBodies = [anonSourceJobsResponseBody, anonSourceJobResponseBody]
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://sdk.example.test",
      fetch: async (input, init) => {
        capturedRequests.push({
          credentials: init?.credentials === undefined ? undefined : String(init.credentials),
          headers: toHeaderRecord(init?.headers),
          url: getRequestUrl(input),
        })

        return new Response(responseBodies.shift() ?? anonSourceJobResponseBody, {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        })
      },
    })

    await expect(
      taxmaxi.anon.sources.listJobs({
        sourceId: anonSourceJobResponse.sourceId,
      })
    ).resolves.toEqual({
      jobs: [anonSourceJobResponse],
    })
    await expect(
      taxmaxi.anon.sources.getJob({
        sourceId: anonSourceJobResponse.sourceId,
        jobId: anonSourceJobResponse.jobId,
      })
    ).resolves.toEqual(anonSourceJobResponse)

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        credentials: "include",
        url: "https://sdk.example.test/v1/anon/sources/00000000-0000-4000-8000-000000000001/jobs",
      }),
      expect.objectContaining({
        credentials: "include",
        url: "https://sdk.example.test/v1/anon/sources/00000000-0000-4000-8000-000000000001/jobs/00000000-0000-4000-8000-000000000005",
      }),
    ])
  })

  it("allows browser session callers to omit ambient credentials", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://sdk.example.test",
      credentials: "omit",
      fetch: makeFetch(capturedRequests, sourceCreateResponseBody),
    })

    await taxmaxi.sources.create({
      type: "onchain",
      walletAddress: "So11111111111111111111111111111111111111112",
    })

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        credentials: "omit",
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

  it("preserves API error tags and stable codes with x402 guidance", () => {
    const error = toTaxMaxiError({
      _tag: "SourcePaymentRequiredError",
      code: "x402_payment_verification_failed",
      message: "transaction_simulation_failed",
      requestId: "req_123",
    })

    expect(error).toBeInstanceOf(TaxMaxiError)
    expect(error._tag).toBe("SourcePaymentRequiredError")
    expect(error.code).toBe("x402_payment_verification_failed")
    expect(error.requestId).toBe("req_123")
    expect(error.message).toContain("payer devnet USDC/SOL balance")
    expect(error.message).toContain("receiver token account")
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
