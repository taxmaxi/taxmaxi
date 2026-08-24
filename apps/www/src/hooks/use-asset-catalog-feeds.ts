import { useInfiniteQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import type { TaxMaxi } from "taxmaxi"

import type { AssetCatalogFeeds } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import { retryAssetCatalogFeed, useDebouncedCatalogQuery } from "#/lib/asset-catalog-route"

export const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
export const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }

/**
 * Loads the approved and pending asset feeds with debounced search. Shared
 * by the public /assets page and the in-app /app/assets overlay so both
 * render the same catalog.
 */
export function useAssetCatalogFeeds(taxmaxi: TaxMaxi): {
  readonly feeds: AssetCatalogFeeds
  readonly onQueryChange: (query: string) => void
} {
  const [catalogQuery, setCatalogQuery] = useState("")
  const debouncedCatalogQuery = useDebouncedCatalogQuery(catalogQuery.trim())

  const searchedAssetListInput = useMemo(
    () => ({
      ...assetListInput,
      ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
    }),
    [debouncedCatalogQuery]
  )

  const searchedPendingAssetListInput = useMemo(
    () => ({
      ...pendingAssetListInput,
      ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
    }),
    [debouncedCatalogQuery]
  )

  const assetQuery = useInfiniteQuery(queries.assetList(taxmaxi, searchedAssetListInput))

  const pendingAssetQuery = useInfiniteQuery(
    queries.pendingAssetList(taxmaxi, searchedPendingAssetListInput)
  )

  const assetPages = assetQuery.data?.pages
  const pendingAssetPages = pendingAssetQuery.data?.pages
  const assets = useMemo(() => assetPages?.flatMap((page) => page.assets) ?? [], [assetPages])

  const pendingAssets = useMemo(
    () => pendingAssetPages?.flatMap((page) => page.pendingAssets) ?? [],
    [pendingAssetPages]
  )

  const retryApproved = useCallback(
    () =>
      retryAssetCatalogFeed({
        fetchNextPage: assetQuery.fetchNextPage,
        isFetchNextPageError: assetQuery.isFetchNextPageError,
        refetch: assetQuery.refetch,
      }),
    [assetQuery.fetchNextPage, assetQuery.isFetchNextPageError, assetQuery.refetch]
  )

  const retryPending = useCallback(
    () =>
      retryAssetCatalogFeed({
        fetchNextPage: pendingAssetQuery.fetchNextPage,
        isFetchNextPageError: pendingAssetQuery.isFetchNextPageError,
        refetch: pendingAssetQuery.refetch,
      }),
    [
      pendingAssetQuery.fetchNextPage,
      pendingAssetQuery.isFetchNextPageError,
      pendingAssetQuery.refetch,
    ]
  )

  const feeds = useMemo<AssetCatalogFeeds>(
    () => ({
      approved: {
        canLoadMore: assetQuery.hasNextPage,
        isLoading: assetQuery.isFetching,
        items: assets,
        loadMore: assetQuery.fetchNextPage,
        retry: retryApproved,
        unavailable: assetQuery.isError || assetQuery.isFetchNextPageError,
      },
      pending: {
        canLoadMore: pendingAssetQuery.hasNextPage,
        isLoading: pendingAssetQuery.isFetching,
        items: pendingAssets,
        loadMore: pendingAssetQuery.fetchNextPage,
        retry: retryPending,
        unavailable: pendingAssetQuery.isError || pendingAssetQuery.isFetchNextPageError,
      },
    }),
    [
      assetQuery.fetchNextPage,
      assetQuery.hasNextPage,
      assetQuery.isError,
      assetQuery.isFetchNextPageError,
      assetQuery.isFetching,
      assets,
      pendingAssetQuery.fetchNextPage,
      pendingAssetQuery.hasNextPage,
      pendingAssetQuery.isError,
      pendingAssetQuery.isFetchNextPageError,
      pendingAssetQuery.isFetching,
      pendingAssets,
      retryApproved,
      retryPending,
    ]
  )

  return { feeds, onQueryChange: setCatalogQuery }
}
