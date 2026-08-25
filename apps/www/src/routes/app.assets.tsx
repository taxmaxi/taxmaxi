import { createFileRoute } from "@tanstack/react-router"

import { useAppOverlayClose } from "#/components/app-overlay"
import { AssetCatalog } from "#/components/asset-catalog"
import { useAssetCatalogFeeds } from "#/hooks/use-asset-catalog-feeds"
import { assetCatalogLoader } from "#/routes/assets/index"

/**
 * In-app asset catalog. Renders as an overlay above the mounted dashboard
 * and is link-masked as /assets, so sharing or reloading the URL lands on
 * the standalone public catalog page instead.
 */
export const Route = createFileRoute("/app/assets")({
  loader: assetCatalogLoader,
  component: AppAssetsRoute,
})

function AppAssetsRoute() {
  const { taxmaxi } = Route.useRouteContext()
  const onClose = useAppOverlayClose()
  const { feeds, onQueryChange } = useAssetCatalogFeeds(taxmaxi())

  return (
    <AssetCatalog feeds={feeds} onClose={onClose} onQueryChange={onQueryChange} surface="overlay" />
  )
}
