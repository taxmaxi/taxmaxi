import { LibraryBig } from "lucide-react"
import { useEffect } from "react"

import { AppFocusSurface } from "#/components/app-focus-surface"
import { AppOverlay } from "#/components/app-overlay"
import {
  AssetCatalogProvider,
  type AssetCatalogFeeds,
  useAssetCatalog,
} from "#/components/asset-catalog-context"
import { AssetCatalogDetailPane } from "#/components/asset-catalog-detail-pane"
import { AssetCatalogListPane } from "#/components/asset-catalog-list-pane"
import { ASSET_CATALOG_SEARCH_ID } from "#/components/asset-catalog-model"
import { m } from "#/paraglide/messages"

export type { AssetCatalogFeeds }

const focusCatalogSearch = () => document.getElementById(ASSET_CATALOG_SEARCH_ID)?.focus()

/**
 * The asset catalog renders on two surfaces: the standalone public /assets
 * page, and an overlay above the dashboard for the in-app /app/assets route.
 */
export function AssetCatalog({
  feeds,
  onClose,
  onQueryChange,
  surface = "page",
}: {
  readonly feeds: AssetCatalogFeeds
  readonly onClose: () => void
  readonly onQueryChange?: (query: string) => void
  readonly surface?: "overlay" | "page"
}) {
  useEffect(() => {
    if (surface === "page" && document.activeElement === document.body) {
      focusCatalogSearch()
    }
  }, [surface])

  const catalog = (
    <AssetCatalogProvider feeds={feeds} onQueryChange={onQueryChange}>
      <AssetCatalogNavigator />
    </AssetCatalogProvider>
  )

  if (surface === "overlay") {
    return (
      <AppOverlay
        bodyClassName="min-h-0 flex-1 overflow-hidden"
        closeLabel={m["assetCatalog.close"]()}
        icon={<LibraryBig aria-hidden="true" className="size-4" />}
        onClose={onClose}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusCatalogSearch()
        }}
        subtitle={m["assetCatalog.subtitle"]()}
        surfaceProps={{ "data-asset-catalog-surface": "" }}
        title={m["assetCatalog.title"]()}
      >
        {catalog}
      </AppOverlay>
    )
  }

  return (
    <AppFocusSurface
      closeLabel={m["assetCatalog.close"]()}
      icon={<LibraryBig aria-hidden="true" className="size-4" />}
      onClose={onClose}
      subtitle={m["assetCatalog.subtitle"]()}
      surfaceProps={{ "data-asset-catalog-surface": "" }}
      title={m["assetCatalog.title"]()}
      titleId="asset-catalog-title"
    >
      {catalog}
    </AppFocusSurface>
  )
}

function AssetCatalogNavigator() {
  const { mobileDetailOpen } = useAssetCatalog()

  return (
    <div
      className="grid h-full min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]"
      data-mobile-view={mobileDetailOpen ? "detail" : "list"}
    >
      <AssetCatalogListPane />
      <AssetCatalogDetailPane />
    </div>
  )
}
