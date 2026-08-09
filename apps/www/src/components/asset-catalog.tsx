import { LibraryBig, X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useState } from "react"

import { AssetCatalogDetailPane } from "#/components/asset-catalog-detail-pane"
import { AssetCatalogListPane } from "#/components/asset-catalog-list-pane"
import {
  ASSET_CATALOG_SEARCH_ID,
  matchesPendingAsset,
  type CatalogItem,
  type CatalogScope,
} from "#/components/asset-catalog-model"
import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { useAssetCatalogPaging } from "#/components/use-asset-catalog-paging"
import { useAssetCatalogSelection } from "#/components/use-asset-catalog-selection"
import { filterTaxMaxiAssets, type TaxMaxiAsset, type TaxMaxiPendingAsset } from "#/lib/assets"

const SURFACE_OPEN_TRANSFORM = "translate3d(0, 0, 0) scale(1)"
const SURFACE_CLOSED_TRANSFORM = "translate3d(0, 4px, 0) scale(0.992)"
const SURFACE_ENTER_TRANSITION = { bounce: 0, duration: 0.32, type: "spring" } as const
const REDUCED_MOTION_TRANSITION = { duration: 0.15 } as const

export function AssetCatalog({
  approvedAssetsUnavailable = false,
  assets,
  canLoadMoreApproved = false,
  canLoadMorePending = false,
  isLoadingApproved = false,
  isLoadingPending = false,
  onClose,
  onLoadMoreApproved = () => undefined,
  onLoadMorePending = () => undefined,
  onQueryChange = () => undefined,
  onRetryApproved = () => undefined,
  onRetryPending = () => undefined,
  pendingAssets,
  pendingAssetsUnavailable = false,
}: {
  readonly approvedAssetsUnavailable?: boolean
  readonly assets: ReadonlyArray<TaxMaxiAsset>
  readonly canLoadMoreApproved?: boolean
  readonly canLoadMorePending?: boolean
  readonly isLoadingApproved?: boolean
  readonly isLoadingPending?: boolean
  readonly onClose: () => void
  readonly onLoadMoreApproved?: () => Promise<unknown> | void
  readonly onLoadMorePending?: () => Promise<unknown> | void
  readonly onQueryChange?: (query: string) => void
  readonly onRetryApproved?: () => Promise<unknown> | void
  readonly onRetryPending?: () => Promise<unknown> | void
  readonly pendingAssets: ReadonlyArray<TaxMaxiPendingAsset>
  readonly pendingAssetsUnavailable?: boolean
}) {
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 })

    if (document.activeElement === document.body) {
      document.getElementById(ASSET_CATALOG_SEARCH_ID)?.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const initialTransform = reduceMotion ? SURFACE_OPEN_TRANSFORM : SURFACE_CLOSED_TRANSFORM
  const surfaceVariants = {
    initial: {
      opacity: 0,
      transform: initialTransform,
    },
    open: {
      opacity: 1,
      transform: SURFACE_OPEN_TRANSFORM,
      transition: reduceMotion ? REDUCED_MOTION_TRANSITION : SURFACE_ENTER_TRANSITION,
    },
  }

  return (
    <div
      className="relative isolate min-h-dvh overflow-hidden bg-[var(--app-page-fallback)] text-foreground"
      data-page="app"
    >
      <AppBackdrop />
      <motion.div
        aria-hidden="true"
        animate={{ opacity: 1 }}
        className="fixed inset-0 bg-foreground/20"
        initial={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.main
        animate="open"
        aria-labelledby="asset-catalog-title"
        className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl outline-none sm:inset-3 sm:rounded-[1.75rem] sm:ring-1 sm:ring-foreground/10"
        data-asset-catalog-surface=""
        initial="initial"
        style={{ transformOrigin: "calc(100% - 3rem) 2rem" }}
        variants={surfaceVariants}
      >
        <FocusSurfaceHeader onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <AssetCatalogNavigator
            approvedAssetsUnavailable={approvedAssetsUnavailable}
            assets={assets}
            canLoadMoreApproved={canLoadMoreApproved}
            canLoadMorePending={canLoadMorePending}
            isLoadingApproved={isLoadingApproved}
            isLoadingPending={isLoadingPending}
            onLoadMoreApproved={onLoadMoreApproved}
            onLoadMorePending={onLoadMorePending}
            onQueryChange={onQueryChange}
            onRetryApproved={onRetryApproved}
            onRetryPending={onRetryPending}
            pendingAssets={pendingAssets}
            pendingAssetsUnavailable={pendingAssetsUnavailable}
          />
        </div>
      </motion.main>
    </div>
  )
}

function AppBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden [background:var(--app-page-background)]"
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(var(--app-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--app-grid-line) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />
    </div>
  )
}

function FocusSurfaceHeader({ onClose }: { readonly onClose: () => void }) {
  return (
    <>
      <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <LibraryBig aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium" id="asset-catalog-title">
              Asset catalog
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              TaxMaxi canonical asset registry
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground md:inline">Esc</span>
          <Button
            aria-label="Close asset catalog"
            className="relative before:absolute before:-inset-0.5"
            onClick={onClose}
            size="icon-lg"
            variant="secondary"
          >
            <X />
          </Button>
        </div>
      </header>
      <Separator />
    </>
  )
}

function AssetCatalogNavigator({
  approvedAssetsUnavailable,
  assets,
  canLoadMoreApproved,
  canLoadMorePending,
  isLoadingApproved,
  isLoadingPending,
  onLoadMoreApproved,
  onLoadMorePending,
  onQueryChange,
  onRetryApproved,
  onRetryPending,
  pendingAssets,
  pendingAssetsUnavailable,
}: {
  readonly approvedAssetsUnavailable: boolean
  readonly assets: ReadonlyArray<TaxMaxiAsset>
  readonly canLoadMoreApproved: boolean
  readonly canLoadMorePending: boolean
  readonly isLoadingApproved: boolean
  readonly isLoadingPending: boolean
  readonly onLoadMoreApproved: () => Promise<unknown> | void
  readonly onLoadMorePending: () => Promise<unknown> | void
  readonly onQueryChange: (query: string) => void
  readonly onRetryApproved: () => Promise<unknown> | void
  readonly onRetryPending: () => Promise<unknown> | void
  readonly pendingAssets: ReadonlyArray<TaxMaxiPendingAsset>
  readonly pendingAssetsUnavailable: boolean
}) {
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<CatalogScope>("all")
  const approvedItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      filterTaxMaxiAssets({ assets, query }).map((asset) => ({ kind: "approved" as const, asset })),
    [assets, query]
  )
  const pendingItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      pendingAssets
        .filter((asset) => matchesPendingAsset(asset, query))
        .map((asset) => ({ kind: "pending" as const, asset })),
    [pendingAssets, query]
  )
  const items = useMemo(() => {
    switch (scope) {
      case "approved":
        return approvedItems
      case "pending":
        return pendingItems
      case "all":
        return [...pendingItems, ...approvedItems]
    }
  }, [approvedItems, pendingItems, scope])
  const paging = useAssetCatalogPaging({
    approvedAssetsUnavailable,
    canLoadMoreApproved,
    canLoadMorePending,
    isLoadingApproved,
    isLoadingPending,
    items,
    onLoadMoreApproved,
    onLoadMorePending,
    onRetryApproved,
    onRetryPending,
    pendingAssetsUnavailable,
    scope,
  })
  const selection = useAssetCatalogSelection({ visibleItems: paging.visibleItems })

  return (
    <div
      className="grid h-full min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]"
      data-mobile-view={selection.mobileDetailOpen ? "detail" : "list"}
    >
      <AssetCatalogListPane
        approvedAssetsUnavailable={approvedAssetsUnavailable}
        approvedItemsCount={approvedItems.length}
        canLoadMoreNow={paging.canLoadMoreNow}
        canRetryNow={paging.canRetryNow}
        catalogStatus={paging.catalogStatus}
        hasLoadError={paging.hasLoadError}
        hasMoreItems={paging.hasMoreItems}
        isLoading={paging.isLoadingVisibleFeed}
        mobileDetailOpen={selection.mobileDetailOpen}
        onLoadMore={paging.loadMore}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery)
          paging.resetVisibleItems()
          onQueryChange(nextQuery)
        }}
        onRetry={paging.retryLoad}
        onScopeChange={(nextScope) => {
          setScope(nextScope)
          paging.resetVisibleItems()
        }}
        onSelect={selection.selectItem}
        pendingAssetsUnavailable={pendingAssetsUnavailable}
        query={query}
        scope={scope}
        selectedItem={selection.selectedItem}
        selectedItemKey={selection.selectedItemKey}
        visibleItems={paging.visibleItems}
      />
      <AssetCatalogDetailPane
        approvedAssetsUnavailable={approvedAssetsUnavailable}
        isLoading={paging.isLoadingVisibleFeed}
        mobileBackButtonRef={selection.mobileBackButtonRef}
        mobileDetailOpen={selection.mobileDetailOpen}
        onShowMobileList={selection.showMobileList}
        pendingAssetsUnavailable={pendingAssetsUnavailable}
        query={query}
        scope={scope}
        selectedItem={selection.selectedItem}
      />
    </div>
  )
}
