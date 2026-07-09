import { queryOptions } from "@tanstack/react-query"
import { TaxMaxiError, type AssetCatalogListInput, type TaxMaxi } from "taxmaxi"

export const DEFAULT_TAXMAXI_ASSET_LIMIT = 500

const normalizeAssetCatalogListInput = (
  input: AssetCatalogListInput = {}
): AssetCatalogListInput => ({
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
})

export const queryKeys = {
  all: ["taxmaxi"] as const,
  assets: () => [...queryKeys.all, "assets"] as const,
  assetList: (input: AssetCatalogListInput = {}) =>
    [...queryKeys.assets(), "list", normalizeAssetCatalogListInput(input)] as const,
  assetDetail: (assetId: string) => [...queryKeys.assets(), "detail", assetId] as const,
  sources: () => [...queryKeys.all, "sources"] as const,
  sourceList: () => [...queryKeys.sources(), "list"] as const,
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
  sourceList: (taxmaxi: TaxMaxi) =>
    queryOptions({
      queryKey: queryKeys.sourceList(),
      queryFn: async () => taxmaxi.sources.list(),
      staleTime: 30 * 1000,
    }),
}

export const isTaxMaxiAssetNotFoundError = (error: unknown): boolean =>
  error instanceof TaxMaxiError && (error.status === 400 || error.status === 404)
