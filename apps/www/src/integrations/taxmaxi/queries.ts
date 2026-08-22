import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query"
import {
  TaxMaxiError,
  type AssetCatalogListInput,
  type AssetExceptionListInput,
  type PendingAssetListInput,
  type TransactionListInput,
  type TaxMaxi,
} from "taxmaxi"

export const DEFAULT_TAXMAXI_ASSET_LIMIT = 40
export const DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT = 40

type AssetCatalogPageInput = Omit<AssetCatalogListInput, "cursor">
type PendingAssetPageInput = Omit<PendingAssetListInput, "cursor">
type AssetExceptionPageInput = Omit<AssetExceptionListInput, "cursor">

const getInitialPageCursor = (): string | null => null

const normalizeAssetCatalogListInput = (
  input: AssetCatalogPageInput = {}
): AssetCatalogPageInput => ({
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
})

const normalizePendingAssetListInput = (
  input: PendingAssetPageInput = {}
): PendingAssetPageInput => ({
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.provider !== undefined ? { provider: input.provider } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
})

export const queryKeys = {
  all: ["taxmaxi"] as const,
  assets: () => [...queryKeys.all, "assets"] as const,
  assetList: (input: AssetCatalogPageInput = {}) =>
    [...queryKeys.assets(), "list", normalizeAssetCatalogListInput(input)] as const,
  assetDetail: (assetId: string) => [...queryKeys.assets(), "detail", assetId] as const,
  pendingAssetList: (input: PendingAssetPageInput = {}) =>
    [...queryKeys.assets(), "pending", normalizePendingAssetListInput(input)] as const,
  assetExceptionList: (input: AssetExceptionPageInput = {}) =>
    [...queryKeys.assets(), "exceptions", input] as const,
  sources: () => [...queryKeys.all, "sources"] as const,
  sourceList: () => [...queryKeys.sources(), "list"] as const,
  sourceOverview: (sourceId: string) => [...queryKeys.sources(), sourceId, "overview"] as const,
  portfolioAssets: (sourceId?: string) =>
    [...queryKeys.all, "portfolio", "assets", sourceId ?? "all"] as const,
  transactions: () => [...queryKeys.all, "transactions"] as const,
  transactionList: (input: TransactionListInput = {}) =>
    [...queryKeys.transactions(), "list", input] as const,
}

export const queries = {
  assetList: (taxmaxi: TaxMaxi, input: AssetCatalogPageInput = {}) => {
    const normalizedInput = normalizeAssetCatalogListInput(input)

    return infiniteQueryOptions({
      queryKey: queryKeys.assetList(normalizedInput),
      queryFn: ({ pageParam, signal }) =>
        taxmaxi.assets.list({ ...normalizedInput, cursor: pageParam }, { signal }),
      initialPageParam: getInitialPageCursor(),
      getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
      placeholderData: keepPreviousData,
      staleTime: 5 * 60 * 1000,
    })
  },
  assetDetail: (taxmaxi: TaxMaxi, assetId: string) =>
    queryOptions({
      queryKey: queryKeys.assetDetail(assetId),
      queryFn: async () => taxmaxi.assets.get({ assetId }),
      staleTime: 5 * 60 * 1000,
    }),
  pendingAssetList: (taxmaxi: TaxMaxi, input: PendingAssetPageInput = {}) => {
    const normalizedInput = normalizePendingAssetListInput(input)

    return infiniteQueryOptions({
      queryKey: queryKeys.pendingAssetList(normalizedInput),
      queryFn: ({ pageParam, signal }) =>
        taxmaxi.assets.listPending({ ...normalizedInput, cursor: pageParam }, { signal }),
      initialPageParam: getInitialPageCursor(),
      getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
      placeholderData: keepPreviousData,
      staleTime: 60 * 1000,
    })
  },
  assetExceptionList: (taxmaxi: TaxMaxi, input: AssetExceptionPageInput = {}) =>
    infiniteQueryOptions({
      queryKey: queryKeys.assetExceptionList(input),
      queryFn: ({ pageParam, signal }) =>
        taxmaxi.assets.listExceptions({ ...input, cursor: pageParam }, { signal }),
      initialPageParam: getInitialPageCursor(),
      getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
      staleTime: 30 * 1000,
    }),
  sourceList: (taxmaxi: TaxMaxi) =>
    queryOptions({
      queryKey: queryKeys.sourceList(),
      queryFn: async () => taxmaxi.sources.list(),
      staleTime: 30 * 1000,
    }),
  sourceOverview: (taxmaxi: TaxMaxi, sourceId: string) =>
    queryOptions({
      queryKey: queryKeys.sourceOverview(sourceId),
      queryFn: async () => taxmaxi.sources.getOverview({ sourceId }),
      staleTime: 30 * 1000,
    }),
  portfolioAssets: (taxmaxi: TaxMaxi, sourceId?: string) =>
    queryOptions({
      queryKey: queryKeys.portfolioAssets(sourceId),
      queryFn: async () => taxmaxi.portfolio.listAssets({ sourceId, currency: "eur" }),
      staleTime: 60 * 1000,
    }),
  transactionList: (taxmaxi: TaxMaxi, input: TransactionListInput = {}) =>
    queryOptions({
      queryKey: queryKeys.transactionList(input),
      queryFn: async () => taxmaxi.transactions.list(input),
      staleTime: 30 * 1000,
    }),
}

export const isTaxMaxiAssetNotFoundError = (error: unknown): boolean =>
  error instanceof TaxMaxiError && (error.status === 400 || error.status === 404)
