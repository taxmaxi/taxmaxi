import { LibraryBig } from "lucide-react"
import { useEffect } from "react"

import { AppFocusSurface } from "#/components/app-focus-surface"
import {
  AssetCatalogProvider,
  type AssetExceptionActions,
  type AssetCatalogFeeds,
  useAssetCatalog,
} from "#/components/asset-catalog-context"
import { AssetCatalogDetailPane } from "#/components/asset-catalog-detail-pane"
import { AssetCatalogListPane } from "#/components/asset-catalog-list-pane"
import { ASSET_CATALOG_SEARCH_ID } from "#/components/asset-catalog-model"
import { m } from "#/paraglide/messages"

export type { AssetCatalogFeeds }

export function AssetCatalog({
  exceptionActions,
  feeds,
  onClose,
  onQueryChange,
}: {
  readonly exceptionActions?: AssetExceptionActions
  readonly feeds: AssetCatalogFeeds
  readonly onClose: () => void
  readonly onQueryChange?: (query: string) => void
}) {
  useEffect(() => {
    if (document.activeElement === document.body) {
      document.getElementById(ASSET_CATALOG_SEARCH_ID)?.focus()
    }
  }, [])

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
      <AssetCatalogProvider
        exceptionActions={exceptionActions}
        feeds={feeds}
        onQueryChange={onQueryChange}
      >
        <AssetCatalogNavigator />
      </AssetCatalogProvider>
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
