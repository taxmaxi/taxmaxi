// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query"
import { TaxMaxi } from "taxmaxi"
import { describe, expect, it } from "vitest"

import { queries } from "./queries"

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input
  }

  return input instanceof URL ? input.toString() : input.url
}

describe("asset catalog infinite queries", () => {
  it("forwards the approved page cursor returned by the previous response", async () => {
    const requestedUrls: Array<string> = []
    const responseBodies = [
      { assets: [], page: { hasMore: true, nextCursor: "approved-page-2" } },
      { assets: [], page: { hasMore: false, nextCursor: null } },
    ]
    const taxmaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://catalog.example.test",
      fetch: async (input) => {
        requestedUrls.push(getRequestUrl(input))
        return Response.json(responseBodies.shift(), { status: 200 })
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const result = await queryClient.fetchInfiniteQuery({
      ...queries.assetList(taxmaxi, { limit: 1, query: "btc" }),
      pages: 2,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.pageParams).toEqual([null, "approved-page-2"])
    expect(requestedUrls).toEqual([
      "https://catalog.example.test/v1/assets?q=btc&limit=1",
      "https://catalog.example.test/v1/assets?q=btc&cursor=approved-page-2&limit=1",
    ])
  })

  it("forwards the pending page cursor returned by the previous response", async () => {
    const requestedUrls: Array<string> = []
    const responseBodies = [
      { pendingAssets: [], page: { hasMore: true, nextCursor: "pending-page-2" } },
      { pendingAssets: [], page: { hasMore: false, nextCursor: null } },
    ]
    const taxmaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://catalog.example.test",
      fetch: async (input) => {
        requestedUrls.push(getRequestUrl(input))
        return Response.json(responseBodies.shift(), { status: 200 })
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const result = await queryClient.fetchInfiniteQuery({
      ...queries.pendingAssetList(taxmaxi, {
        limit: 1,
        provider: "coinbase",
        query: "eth",
      }),
      pages: 2,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.pageParams).toEqual([null, "pending-page-2"])
    expect(requestedUrls).toEqual([
      "https://catalog.example.test/v1/assets/pending?q=eth&provider=coinbase&limit=1",
      "https://catalog.example.test/v1/assets/pending?q=eth&provider=coinbase&cursor=pending-page-2&limit=1",
    ])
  })
})
