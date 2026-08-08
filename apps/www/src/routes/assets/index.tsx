import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useDeferredValue, useState } from "react"

import { AssetCatalog } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import { seo } from "#/lib/seo"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }

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
}: {
  readonly history: AssetCatalogHistory
  readonly navigateToFallback: (navigation: AssetCatalogFallbackNavigation) => void
}) {
  if (history.canGoBack()) {
    history.back()
    return
  }

  navigateToFallback({ replace: true, to: "/" })
}

export const Route = createFileRoute("/assets/")({
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    return context.queryClient.ensureInfiniteQueryData(queries.assetList(taxmaxi, assetListInput))
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
  const deferredCatalogQuery = useDeferredValue(catalogQuery.trim())
  const searchedAssetListInput = {
    ...assetListInput,
    ...(deferredCatalogQuery.length > 0 ? { query: deferredCatalogQuery } : {}),
  }
  const searchedPendingAssetListInput = {
    ...pendingAssetListInput,
    ...(deferredCatalogQuery.length > 0 ? { query: deferredCatalogQuery } : {}),
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
      isLoadingMore={assetQuery.isFetching || pendingAssetQuery.isFetching}
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
        assetQuery.isFetchNextPageError ? assetQuery.fetchNextPage() : assetQuery.refetch()
      }
      onRetryPending={() =>
        pendingAssetQuery.isFetchNextPageError
          ? pendingAssetQuery.fetchNextPage()
          : pendingAssetQuery.refetch()
      }
      pendingAssets={pendingAssets}
      pendingAssetsUnavailable={pendingAssetQuery.isError || pendingAssetQuery.isFetchNextPageError}
    />
  )
}
