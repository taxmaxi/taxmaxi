import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useCallback, useMemo, useState } from "react"

import { AssetCatalog, type AssetCatalogFeeds } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import {
  closeAssetCatalog,
  loadAssetCatalogFeeds,
  retryAssetCatalogFeed,
  useDebouncedCatalogQuery,
} from "#/lib/asset-catalog-route"
import { seo } from "#/lib/seo"
import { m } from "#/paraglide/messages"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }

export const Route = createFileRoute("/assets/")({
  loader: async ({ abortController, context }) => {
    const taxmaxi = context.taxmaxi()
    const approvedQuery = queries.assetList(taxmaxi, assetListInput)
    const pendingQuery = queries.pendingAssetList(taxmaxi, pendingAssetListInput)

    return loadAssetCatalogFeeds({
      cancelApproved: () =>
        context.queryClient.cancelQueries({ exact: true, queryKey: approvedQuery.queryKey }),
      cancelPending: () =>
        context.queryClient.cancelQueries({ exact: true, queryKey: pendingQuery.queryKey }),
      loadApproved: () => context.queryClient.ensureInfiniteQueryData(approvedQuery),
      loadPending: () => context.queryClient.ensureInfiniteQueryData(pendingQuery),
      signal: abortController.signal,
    })
  },
  head: () => ({
    meta: seo({
      title: m["assetCatalog.seoTitle"](),
      description: m["assetCatalog.seoDescription"](),
    }),
  }),
  component: AssetsIndexRoute,
})

function AssetsIndexRoute() {
  const { taxmaxi } = Route.useRouteContext()
  const navigate = Route.useNavigate()
  const router = useRouter()
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
  const assetQuery = useInfiniteQuery(queries.assetList(taxmaxi(), searchedAssetListInput))
  const pendingAssetQuery = useInfiniteQuery(
    queries.pendingAssetList(taxmaxi(), searchedPendingAssetListInput)
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
  const closeCatalog = useCallback(() => {
    closeAssetCatalog({
      history: router.history,
      navigateToFallback: (navigation) => {
        void navigate(navigation)
      },
    })
  }, [navigate, router.history])

  return <AssetCatalog feeds={feeds} onClose={closeCatalog} onQueryChange={setCatalogQuery} />
}
