import type { QueryClient } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useCallback } from "react"
import type { TaxMaxi } from "taxmaxi"

import { AssetCatalog } from "#/components/asset-catalog"
import { queries } from "#/integrations/taxmaxi/queries"
import {
  assetListInput,
  pendingAssetListInput,
  useAssetCatalogFeeds,
} from "#/hooks/use-asset-catalog-feeds"
import { closeAssetCatalog, loadAssetCatalogFeeds } from "#/lib/asset-catalog-route"
import { seo } from "#/lib/seo"
import { m } from "#/paraglide/messages"

/** Shared by the public /assets page and the in-app /app/assets overlay. */
export const assetCatalogLoader = ({
  abortController,
  context,
}: {
  readonly abortController: AbortController
  readonly context: {
    readonly queryClient: QueryClient
    readonly taxmaxi: () => TaxMaxi
  }
}) => {
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
}

export const Route = createFileRoute("/assets/")({
  loader: assetCatalogLoader,
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
  const { feeds, onQueryChange } = useAssetCatalogFeeds(taxmaxi())

  const closeCatalog = useCallback(() => {
    closeAssetCatalog({
      history: router.history,
      navigateToFallback: (navigation) => {
        void navigate(navigation)
      },
    })
  }, [navigate, router.history])

  return <AssetCatalog feeds={feeds} onClose={closeCatalog} onQueryChange={onQueryChange} />
}
