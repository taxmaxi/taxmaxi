import { queryOptions } from "@tanstack/react-query"
import {
  TaxMaxiError,
  type AssetCatalogListInput,
  type PendingAsset,
  type PendingAssetList,
  type PendingAssetListInput,
  type TaxMaxi,
} from "taxmaxi"

export const DEFAULT_TAXMAXI_ASSET_LIMIT = 500
export const DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT = 100

const normalizeAssetCatalogListInput = (
  input: AssetCatalogListInput = {}
): AssetCatalogListInput => ({
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
})

const normalizePendingAssetListInput = (
  input: PendingAssetListInput = {}
): PendingAssetListInput => ({
  ...(input.provider !== undefined ? { provider: input.provider } : {}),
  ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
})

const listAllPendingAssets = async (
  taxmaxi: TaxMaxi,
  input: PendingAssetListInput
): Promise<PendingAssetList> => {
  const pendingAssets: Array<PendingAsset> = []
  let cursor = input.cursor ?? null

  while (true) {
    const response = await taxmaxi.assets.listPending({ ...input, cursor })
    pendingAssets.push(...response.pendingAssets)

    if (!response.page.hasMore || response.page.nextCursor === null) {
      return {
        pendingAssets,
        page: response.page,
      }
    }

    cursor = response.page.nextCursor
  }
}

export const queryKeys = {
  all: ["taxmaxi"] as const,
  assets: () => [...queryKeys.all, "assets"] as const,
  assetList: (input: AssetCatalogListInput = {}) =>
    [...queryKeys.assets(), "list", normalizeAssetCatalogListInput(input)] as const,
  assetDetail: (assetId: string) => [...queryKeys.assets(), "detail", assetId] as const,
  pendingAssetList: (input: PendingAssetListInput = {}) =>
    [...queryKeys.assets(), "pending", normalizePendingAssetListInput(input)] as const,
  sources: () => [...queryKeys.all, "sources"] as const,
  sourceList: () => [...queryKeys.sources(), "list"] as const,
  sourceOverview: (sourceId: string) => [...queryKeys.sources(), sourceId, "overview"] as const,
  portfolioAssets: (sourceId?: string) =>
    [...queryKeys.all, "portfolio", "assets", sourceId ?? "all"] as const,
}

export const queries = {
  assetList: (taxmaxi: TaxMaxi, input: AssetCatalogListInput = {}) => {
    const normalizedInput = normalizeAssetCatalogListInput(input)

    return queryOptions({
      queryKey: queryKeys.assetList(normalizedInput),
      queryFn: async () => taxmaxi.assets.list(normalizedInput),
      staleTime: 5 * 60 * 1000,
    })
  },
  assetDetail: (taxmaxi: TaxMaxi, assetId: string) =>
    queryOptions({
      queryKey: queryKeys.assetDetail(assetId),
      queryFn: async () => taxmaxi.assets.get({ assetId }),
      staleTime: 5 * 60 * 1000,
    }),
  pendingAssetList: (taxmaxi: TaxMaxi, input: PendingAssetListInput = {}) => {
    const normalizedInput = normalizePendingAssetListInput(input)

    return queryOptions({
      queryKey: queryKeys.pendingAssetList(normalizedInput),
      queryFn: async () => listAllPendingAssets(taxmaxi, normalizedInput),
      staleTime: 60 * 1000,
    })
  },
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
}

export const isTaxMaxiAssetNotFoundError = (error: unknown): boolean =>
  error instanceof TaxMaxiError && (error.status === 400 || error.status === 404)
