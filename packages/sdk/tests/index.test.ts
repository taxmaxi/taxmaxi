import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import {
  DEFAULT_BASE_URL,
  TaxMaxi,
  TaxMaxiError,
  isTaxMaxiUnauthorizedError,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  toTaxMaxiError,
  type TaxMaxiHeaders,
} from "../src/index.ts"
import { TaxMaxiInternal } from "../src/internal.ts"

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
    providerKey: "helius-solana",
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
  claim: {
    requestId: "00000000-0000-4000-8000-000000000004",
    claimToken: "claim-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
  },
})

const sourceResponse = {
  id: "00000000-0000-4000-8000-000000000001",
  principalId: "00000000-0000-4000-8000-000000000002",
  name: "Demo Solana wallet",
  providerKey: "helius-solana",
  sourceRef: {
    _tag: "onchain",
    addressId: "00000000-0000-4000-8000-000000000003",
  },
  createdAt: {
    epochMillis: 1_767_225_600_000,
  },
} as const

const sourceOverviewResponseBody = JSON.stringify({
  source: sourceResponse,
  latestSync: {
    status: null,
    mode: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    lastSyncedAt: null,
    lastErrorMessage: null,
    importedRecords: null,
    normalizedRecords: null,
    failedRecords: null,
  },
  totals: {
    transactionCount: 0,
    legCount: 0,
    assetCount: 0,
    fifoLotCount: 0,
    disposalCount: 0,
    incomeCount: 0,
    feeCount: 0,
    realizedGainLoss: "0",
    incomeTotal: "0",
    currency: null,
  },
  review: {
    status: "ok",
    needsReviewCount: 0,
    blockingIssueCount: 0,
    issues: [],
  },
})

const emptySourceAssetPnlResponseBody = JSON.stringify({ assets: [] })
const emptyProviderAssetReviewsResponseBody = JSON.stringify({
  providerAssets: [],
  page: {
    nextCursor: null,
    hasMore: false,
  },
})
const assetCanonicalizationResponseBody = JSON.stringify({
  providerAsset: {
    id: "00000000-0000-4000-8000-000000000009",
    provider: "coinbase",
    providerAssetId: "63062039-7afb-56ff-8e19-5e3215dc404a",
    naturalKey: null,
    currencyCode: "ADA",
    name: "Cardano",
    exponent: 6,
    providerType: "crypto",
    mappingKind: "asset",
    canonicalAssetId: "00000000-0000-4000-8000-000000000010",
    canonicalAssetSymbol: "ADA",
    canonicalFiatCurrency: null,
    mappingStatus: "approved",
    reviewerNotes: "Looks correct.",
    sourceNotes: "Approved with CoinGecko asset/platform metadata.",
  },
  canonicalAsset: {
    id: "00000000-0000-4000-8000-000000000010",
    blockchainId: "00000000-0000-4000-8000-000000000011",
    blockchainName: "cardano",
    name: "Cardano",
    symbol: "ADA",
    decimals: 6,
    contractAddress: null,
    type: "native",
  },
  evidence: {
    source: "coingecko",
    coinId: "cardano",
    coinName: "Cardano",
    coinSymbol: "ADA",
    platformId: "cardano",
    platformName: "Cardano",
    contractAddress: null,
  },
})
const emptySourceTransactionsResponseBody = JSON.stringify({
  transactions: [],
  page: { nextCursor: null, hasMore: false },
})
const emptySourceTaxEventsResponseBody = JSON.stringify({
  taxEvents: [],
  page: { nextCursor: null, hasMore: false },
})
const emptySourceFifoLotsResponseBody = JSON.stringify({
  fifoLots: [],
  page: { nextCursor: null, hasMore: false },
})
const sourceDisposalExplanationResponseBody = JSON.stringify({
  disposalLegId: "00000000-0000-4000-8000-000000000006",
  transactionId: "00000000-0000-4000-8000-000000000007",
  asset: {
    assetId: "00000000-0000-4000-8000-000000000008",
    symbol: "BTC",
    name: "Bitcoin",
  },
  amount: "0.1",
  proceeds: "500",
  costBasis: "500",
  gainLoss: "0",
  acquiredAt: "2025-01-01T00:00:00.000Z",
  disposedAt: "2025-02-01T00:00:00.000Z",
  taxableTreatment: "non_taxable",
  provenance: "deterministic",
  derivationRule: "internal_transfer_out",
  matchedLots: [],
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
        providerKey: "helius-solana",
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

  it("plumbs source report endpoints through the public sources resource", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const sourceId = "00000000-0000-4000-8000-000000000001"
    const legId = "00000000-0000-4000-8000-000000000006"
    const responseBodies = [
      sourceOverviewResponseBody,
      emptySourceAssetPnlResponseBody,
      emptySourceTransactionsResponseBody,
      emptySourceTaxEventsResponseBody,
      emptySourceFifoLotsResponseBody,
      sourceDisposalExplanationResponseBody,
    ]
    const taxmaxi = new TaxMaxi({
      apiKey: "tm_report",
      baseUrl: "https://sdk.example.test",
      fetch: async (input, init) => {
        capturedRequests.push({
          credentials: init?.credentials === undefined ? undefined : String(init.credentials),
          headers: toHeaderRecord(init?.headers),
          url: getRequestUrl(input),
        })

        return new Response(responseBodies.shift() ?? emptySourceAssetPnlResponseBody, {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        })
      },
    })

    await taxmaxi.sources.getOverview({ sourceId })
    await taxmaxi.sources.listAssetPnl({ sourceId })
    await taxmaxi.sources.listTransactions({ sourceId, limit: 25 })
    await taxmaxi.sources.listTaxEvents({ sourceId, cursor: "cursor-value", limit: 10 })
    await taxmaxi.sources.listFifoLots({ sourceId })
    await taxmaxi.sources.explainDisposal({ sourceId, legId })

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/overview",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/assets/pnl",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/transactions?limit=25",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/tax-events?cursor=cursor-value&limit=10",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/fifo-lots",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/disposals/00000000-0000-4000-8000-000000000006/explanation",
      }),
    ])
  })

  it("plumbs asset review endpoints through the internal assets resource", async () => {
    const capturedRequests: Array<CapturedRequest> = []
    const providerAssetId = "00000000-0000-4000-8000-000000000009"
    const responseBodies = [
      emptyProviderAssetReviewsResponseBody,
      assetCanonicalizationResponseBody,
    ]
    const taxmaxi = new TaxMaxiInternal({
      apiKey: "tm_assets",
      baseUrl: "https://sdk.example.test",
      fetch: async (input, init) => {
        capturedRequests.push({
          credentials: init?.credentials === undefined ? undefined : String(init.credentials),
          headers: toHeaderRecord(init?.headers),
          url: getRequestUrl(input),
        })

        return new Response(responseBodies.shift() ?? emptyProviderAssetReviewsResponseBody, {
          headers: {
            "Content-Type": "application/json",
          },
          status: 200,
        })
      },
    })

    await expect(
      taxmaxi.assets.listProviderAssetReviews({
        provider: "coinbase",
        status: "pending_review",
        cursor: "00000000-0000-4000-8000-000000000008",
        limit: 25,
      })
    ).resolves.toEqual({
      providerAssets: [],
      page: {
        nextCursor: null,
        hasMore: false,
      },
    })
    await expect(
      taxmaxi.assets.canonicalizeProviderAsset({
        id: providerAssetId,
        reviewerNotes: "Looks correct.",
      })
    ).resolves.toMatchObject({
      providerAsset: {
        canonicalAssetSymbol: "ADA",
        mappingStatus: "approved",
      },
    })

    expect(capturedRequests).toEqual([
      expect.objectContaining({
        url: "https://sdk.example.test/v1/assets/provider-assets?provider=coinbase&status=pending_review&cursor=00000000-0000-4000-8000-000000000008&limit=25",
      }),
      expect.objectContaining({
        url: "https://sdk.example.test/v1/assets/provider-assets/00000000-0000-4000-8000-000000000009/canonicalize",
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

  it("preserves UnauthorizedError status when Effect wraps the API error code", () => {
    const error = toTaxMaxiError({
      _tag: "(FiberFailure) UnauthorizedError",
      message: "Anon session required.",
    })

    expect(error).toBeInstanceOf(TaxMaxiError)
    expect(error.code).toBe("(FiberFailure) UnauthorizedError")
    expect(error.message).toBe("Anon session required.")
    expect(error.status).toBe(401)
    expect(isTaxMaxiUnauthorizedError(error)).toBe(true)
  })

  it("recognizes wrapped UnauthorizedError codes even if status was mis-normalized", () => {
    const error = new TaxMaxiError({
      code: "(FiberFailure) UnauthorizedError",
      message: "Anon session required.",
      status: 500,
    })

    expect(isTaxMaxiUnauthorizedError(error)).toBe(true)
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
