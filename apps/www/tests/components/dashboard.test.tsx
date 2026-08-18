// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { TaxMaxi, TransactionListInput } from "taxmaxi"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Dashboard } from "#/components/dashboard"
import { queryKeys } from "#/integrations/taxmaxi/queries"

const syncState = vi.hoisted(() => ({
  onCompleted: undefined as undefined | ((sourceId: string) => void | Promise<void>),
}))

let testTaxMaxi: TaxMaxi

type TransactionListResponse = Awaited<ReturnType<TaxMaxi["transactions"]["list"]>>

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useRouteContext: ({ select }: { readonly select: (context: unknown) => unknown }) =>
      select({ taxmaxi: () => testTaxMaxi }),
  }
})

vi.mock("#/components/source-cards", () => ({
  SourceCards: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("#/components/source-sync-island", () => ({
  SourceSyncIsland: () => null,
}))

vi.mock("#/components/ui/tabs", () => ({
  Tabs: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("#/hooks/use-source-syncs", () => ({
  useSourceSyncs: ({
    onCompleted,
  }: {
    readonly onCompleted?: (sourceId: string) => void | Promise<void>
  }) => {
    syncState.onCompleted = onCompleted
    return {
      activeSyncs: [],
      onDismissSync: vi.fn(),
      onRetrySync: vi.fn(),
      onSourceSync: vi.fn(),
      syncingSourceIds: new Set<string>(),
    }
  },
}))

const transaction = (transactionId: string, description: string) => ({
  transactionId,
  timestamp: "2025-03-10T12:00:00.000Z",
  source: {
    sourceId: "00000000-0000-4000-8000-000000000201",
    name: "Coinbase",
    kind: "cex" as const,
  },
  transactionType: "sell_fiat",
  description,
  externalId: transactionId,
  movements: [{ amount: "0.1", assetSymbol: "BTC", kind: "disposal" as const }],
  realizedGainLoss: "100",
  fiatCurrency: "EUR",
  calculationState: "complete" as const,
  needsReview: false,
})

describe("Dashboard transaction pagination", () => {
  afterEach(() => {
    cleanup()
    syncState.onCompleted = undefined
    vi.clearAllMocks()
  })

  it("uses server cursors and returns to the first page after a completed sync", async () => {
    const requestedCursors: Array<string | null> = []
    const firstPage: TransactionListResponse = {
      transactions: [transaction("00000000-0000-4000-8000-000000000101", "First transaction page")],
      totalCount: 2,
      page: { hasMore: true, nextCursor: "page-2" },
    }
    const secondPage: TransactionListResponse = {
      transactions: [
        transaction("00000000-0000-4000-8000-000000000102", "Second transaction page"),
      ],
      totalCount: 2,
      page: { hasMore: false, nextCursor: null },
    }
    let resolveSecondPage: ((page: TransactionListResponse) => void) | undefined
    const pendingSecondPage = new Promise<TransactionListResponse>((resolve) => {
      resolveSecondPage = resolve
    })
    const listTransactions = vi.fn(async (input: TransactionListInput = {}) => {
      const cursor = input.cursor ?? null
      requestedCursors.push(cursor)
      return cursor === null ? firstPage : pendingSecondPage
    })
    testTaxMaxi = {
      portfolio: {
        listAssets: vi.fn(async () => ({ assets: [], summary: undefined })),
      },
      transactions: { list: listTransactions },
    } as unknown as TaxMaxi
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard
          accounts={[]}
          onSourceSyncCompleted={async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.transactions() })
          }}
        />
      </QueryClientProvider>
    )

    expect(await screen.findByText("First transaction page")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Loading transactions…")).toBeTruthy()
    expect(screen.queryByText("First transaction page")).toBeNull()

    await act(async () => {
      resolveSecondPage?.(secondPage)
    })

    expect(await screen.findByText("Second transaction page")).toBeTruthy()
    expect(requestedCursors).toEqual([null, "page-2"])

    await act(async () => {
      await syncState.onCompleted?.("00000000-0000-4000-8000-000000000201")
    })

    await waitFor(() => expect(requestedCursors.at(-1)).toBeNull())
    expect(await screen.findByText("First transaction page")).toBeTruthy()
  })
})
