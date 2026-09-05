import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { listSourceTransactions } from "../src/api/sources.ts"
import { disposeController, fetchSourceTransactions } from "../src/tui/controller.ts"

const session = {
  apiUrl: "https://api.example.test",
  sessionToken: "test-session",
  userId: "test-user",
  connectedAt: "2026-09-05T00:00:00.000Z",
}
const sourceId = "00000000-0000-4000-8000-000000000128"
const fetchMock = vi.fn<typeof globalThis.fetch>()

const emptyPage = {
  transactions: [],
  page: { nextCursor: null, hasMore: false },
  totalCount: 0,
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterAll(() => disposeController().then(() => vi.unstubAllGlobals()))

describe("canonical CLI source transactions", () => {
  it("uses the canonical SDK route, source scope, cursor and bearer header", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Request[] = []
        fetchMock.mockImplementation((input, init) => {
          requests.push(new Request(input, init))
          return Promise.resolve(Response.json(emptyPage))
        })
        const result = yield* listSourceTransactions({ ...session, sourceId, cursor: "page-two" })
        expect(result).toEqual(emptyPage)
        expect(requests).toHaveLength(1)
        const request = requests[0]
        expect(request).toBeDefined()
        if (request === undefined) return
        const url = new URL(request.url)
        expect(url.pathname).toBe("/v1/transactions")
        expect(url.searchParams.get("sourceId")).toBe(sourceId)
        expect(url.searchParams.get("cursor")).toBe("page-two")
        expect(request.method).toBe("GET")
        expect(request.headers.get("authorization")).toBe("Bearer test-session")
      })
    ))

  it("omits the first-page cursor and preserves an empty canonical result", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Request[] = []
        fetchMock.mockImplementation((input, init) => {
          requests.push(new Request(input, init))
          return Promise.resolve(Response.json(emptyPage))
        })
        const result = yield* Effect.promise(() =>
          fetchSourceTransactions(session, { sourceId, cursor: null })
        )
        expect(result).toEqual({ _tag: "ok", data: emptyPage })
        expect(requests.map((request) => new URL(request.url).searchParams.has("cursor"))).toEqual([
          false,
        ])
      })
    ))

  it.each([
    [401, "unauthorized"],
    [500, "error"],
  ] as const)("preserves the controller's %s outcome", (status, tag) =>
    Effect.runPromise(
      Effect.gen(function* () {
        fetchMock.mockImplementation(() =>
          Promise.resolve(Response.json({ message: "Request failed" }, { status }))
        )
        const result = yield* Effect.promise(() => fetchSourceTransactions(session, { sourceId }))
        expect(result).toMatchObject({ _tag: tag })
      })
    )
  )
})
