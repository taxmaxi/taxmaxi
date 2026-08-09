import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { AssetCatalog } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import { restoreAssetCatalogReturnFocus } from "#/lib/asset-catalog-focus"
import { seo } from "#/lib/seo"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }
export const ASSET_CATALOG_SEARCH_DEBOUNCE_MS = 300

export function useDebouncedCatalogQuery(query: string): string {
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query)
    }, ASSET_CATALOG_SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timeout)
  }, [query])

  return debouncedQuery
}

type AssetCatalogHistory = {
  readonly back: () => void
  readonly canGoBack: () => boolean
}

type AssetCatalogFallbackNavigation = {
  readonly replace: true
  readonly to: "/"
}

export function closeAssetCatalog({
  history,
  navigateToFallback,
  restoreFocus = restoreAssetCatalogReturnFocus,
}: {
  readonly history: AssetCatalogHistory
  readonly navigateToFallback: (navigation: AssetCatalogFallbackNavigation) => void
  readonly restoreFocus?: () => void
}) {
  if (history.canGoBack()) {
    history.back()
    restoreFocus()
    return
  }

  navigateToFallback({ replace: true, to: "/" })
  restoreFocus()
}

export function retryAssetCatalogFeed({
  fetchNextPage,
  isFetchNextPageError,
  refetch,
}: {
  readonly fetchNextPage: () => Promise<unknown>
  readonly isFetchNextPageError: boolean
  readonly refetch: () => Promise<unknown>
}): Promise<unknown> {
  return isFetchNextPageError ? fetchNextPage() : refetch()
}

export async function loadAssetCatalogFeeds({
  loadApproved,
  loadPending,
}: {
  readonly loadApproved: () => Promise<unknown>
  readonly loadPending: () => Promise<unknown>
}): Promise<void> {
  await Promise.allSettled([loadApproved(), loadPending()])
}

export const Route = createFileRoute("/assets/")({
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    return loadAssetCatalogFeeds({
      loadApproved: () =>
        context.queryClient.ensureInfiniteQueryData(queries.assetList(taxmaxi, assetListInput)),
      loadPending: () =>
        context.queryClient.ensureInfiniteQueryData(
          queries.pendingAssetList(taxmaxi, pendingAssetListInput)
        ),
    })
  },
  head: () => ({
    meta: seo({
      title: "Asset catalog | TaxMaxi",
      description: "Browse TaxMaxi's public canonical asset catalog.",
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
  const searchedAssetListInput = {
    ...assetListInput,
    ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
  }
  const searchedPendingAssetListInput = {
    ...pendingAssetListInput,
    ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
  }
  const assetQuery = useInfiniteQuery(queries.assetList(taxmaxi(), searchedAssetListInput))
  const pendingAssetQuery = useInfiniteQuery(
    queries.pendingAssetList(taxmaxi(), searchedPendingAssetListInput)
  )
  const assets = assetQuery.data?.pages.flatMap((page) => page.assets) ?? []
  const pendingAssets = pendingAssetQuery.data?.pages.flatMap((page) => page.pendingAssets) ?? []

  return (
    <AssetCatalog
      approvedAssetsUnavailable={assetQuery.isError || assetQuery.isFetchNextPageError}
      assets={assets}
      canLoadMoreApproved={assetQuery.hasNextPage}
      canLoadMorePending={pendingAssetQuery.hasNextPage}
      isLoadingApproved={assetQuery.isFetching}
      isLoadingPending={pendingAssetQuery.isFetching}
      onClose={() => {
        closeAssetCatalog({
          history: router.history,
          navigateToFallback: (navigation) => {
            void navigate(navigation)
          },
        })
      }}
      onLoadMoreApproved={assetQuery.fetchNextPage}
      onLoadMorePending={pendingAssetQuery.fetchNextPage}
      onQueryChange={setCatalogQuery}
      onRetryApproved={() =>
        retryAssetCatalogFeed({
          fetchNextPage: assetQuery.fetchNextPage,
          isFetchNextPageError: assetQuery.isFetchNextPageError,
          refetch: assetQuery.refetch,
        })
      }
      onRetryPending={() =>
        retryAssetCatalogFeed({
          fetchNextPage: pendingAssetQuery.fetchNextPage,
          isFetchNextPageError: pendingAssetQuery.isFetchNextPageError,
          refetch: pendingAssetQuery.refetch,
        })
      }
      pendingAssets={pendingAssets}
      pendingAssetsUnavailable={pendingAssetQuery.isError || pendingAssetQuery.isFetchNextPageError}
    />
  )
}
