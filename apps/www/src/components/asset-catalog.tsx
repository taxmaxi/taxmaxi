import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  CircleDotDashed,
  Clock3,
  Coins,
  LibraryBig,
  Search,
  ShieldCheck,
  X,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group"
import { Separator } from "#/components/ui/separator"
import {
  ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH,
  describeTaxMaxiAsset,
  filterTaxMaxiAssets,
  formatAssetType,
  formatBlockchainName,
  matchesAssetCatalogQuery,
  type TaxMaxiAsset,
  type TaxMaxiPendingAsset,
} from "#/lib/assets"
import { cn } from "#/lib/utils"

type CatalogItem =
  | { readonly kind: "approved"; readonly asset: TaxMaxiAsset }
  | { readonly kind: "pending"; readonly asset: TaxMaxiPendingAsset }
type CatalogScope = "all" | "approved" | "pending"

const SURFACE_OPEN_TRANSFORM = "translate3d(0, 0, 0) scale(1)"
const SURFACE_CLOSED_TRANSFORM = "translate3d(0, 4px, 0) scale(0.992)"
const SURFACE_ENTER_TRANSITION = { bounce: 0, duration: 0.32, type: "spring" } as const
const REDUCED_MOTION_TRANSITION = { duration: 0.15 } as const
const ASSET_CATALOG_LIST_ID = "asset-catalog-list"
const ASSET_CATALOG_SEARCH_ID = "asset-catalog-search"
const INITIAL_VISIBLE_ITEM_LIMIT = 80

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
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEM_LIMIT)
  const mobileBackButtonRef = useRef<HTMLButtonElement>(null)
  const approvedItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      filterTaxMaxiAssets({ assets, query }).map((asset) => ({ kind: "approved" as const, asset })),
    [assets, query]
  )
  const pendingItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      pendingAssets
        .filter((asset) => matchesPendingAsset(asset, query))
        .map((asset) => ({
          kind: "pending" as const,
          asset,
        })),
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
  const visibleItems = useMemo(() => items.slice(0, visibleItemLimit), [items, visibleItemLimit])
  const [selectedKey, setSelectedKey] = useState(() => getCatalogItemKey(visibleItems[0]))
  const selectedItem =
    visibleItems.find((item) => getCatalogItemKey(item) === selectedKey) ??
    (selectedKey.length === 0 ? visibleItems[0] : undefined)
  const selectedItemKey = getCatalogItemKey(selectedItem)

  useEffect(() => {
    if (selectedKey.length === 0 || selectedItem !== undefined) {
      return
    }

    const shouldRestoreFocus = mobileDetailOpen || document.activeElement === document.body
    const nextItem = visibleItems[0]
    setMobileDetailOpen(false)
    setSelectedKey(getCatalogItemKey(nextItem))

    if (shouldRestoreFocus) {
      window.requestAnimationFrame(() => {
        const focusTargetId =
          nextItem === undefined ? ASSET_CATALOG_SEARCH_ID : getCatalogItemDomId(nextItem)
        document.getElementById(focusTargetId)?.focus()
      })
    }
  }, [mobileDetailOpen, selectedItem, selectedKey, visibleItems])

  useEffect(() => {
    if (mobileDetailOpen) {
      mobileBackButtonRef.current?.focus()
    }
  }, [mobileDetailOpen])

  const selectItem = (item: CatalogItem) => {
    setSelectedKey(getCatalogItemKey(item))

    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileDetailOpen(true)
    }
  }

  const showMobileList = () => {
    setMobileDetailOpen(false)

    if (selectedItem === undefined) {
      return
    }

    window.requestAnimationFrame(() => {
      document.getElementById(getCatalogItemDomId(selectedItem))?.focus()
    })
  }

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1024px)")
    const moveFocusToDesktopList = (matches: boolean) => {
      if (!matches || !mobileDetailOpen || selectedItem === undefined) {
        return
      }

      setMobileDetailOpen(false)
      window.requestAnimationFrame(() => {
        document.getElementById(getCatalogItemDomId(selectedItem))?.focus()
      })
    }
    const onDesktopChange = (event: MediaQueryListEvent) => {
      moveFocusToDesktopList(event.matches)
    }

    moveFocusToDesktopList(desktopQuery.matches)
    desktopQuery.addEventListener("change", onDesktopChange)
    return () => desktopQuery.removeEventListener("change", onDesktopChange)
  }, [mobileDetailOpen, selectedItem])

  useEffect(() => {
    if (selectedItem === undefined) {
      return
    }

    document.getElementById(getCatalogItemDomId(selectedItem))?.scrollIntoView({ block: "nearest" })
  }, [selectedItem])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const searchTarget =
        target instanceof HTMLInputElement && target.getAttribute("role") === "combobox"
      const optionTarget =
        target instanceof HTMLElement ? target.closest("[data-asset-catalog-option]") : null
      const isArrowKey = event.key === "ArrowDown" || event.key === "ArrowUp"
      const activatesSearchSelection = event.key === "Enter" && searchTarget

      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        mobileDetailOpen ||
        (!isArrowKey && !activatesSearchSelection) ||
        (!searchTarget && optionTarget === null) ||
        visibleItems.length === 0
      ) {
        return
      }

      if (activatesSearchSelection) {
        if (selectedItem !== undefined) {
          event.preventDefault()
          selectItem(selectedItem)
        }
        return
      }

      event.preventDefault()
      const currentIndex = Math.max(
        visibleItems.findIndex((item) => getCatalogItemKey(item) === selectedItemKey),
        0
      )
      const nextIndex =
        event.key === "ArrowDown"
          ? Math.min(currentIndex + 1, visibleItems.length - 1)
          : Math.max(currentIndex - 1, 0)
      const nextItem = visibleItems[nextIndex]

      if (nextItem === undefined) {
        return
      }

      setSelectedKey(getCatalogItemKey(nextItem))

      if (optionTarget !== null) {
        window.requestAnimationFrame(() => {
          document.getElementById(getCatalogItemDomId(nextItem))?.focus()
        })
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [mobileDetailOpen, selectedItem, selectedItemKey, visibleItems])

  const hasLocallyHiddenItems = visibleItems.length < items.length
  const canLoadMoreApprovedForScope =
    scope !== "pending" && canLoadMoreApproved && !approvedAssetsUnavailable
  const canLoadMorePendingForScope =
    scope !== "approved" && canLoadMorePending && !pendingAssetsUnavailable
  const hasMoreItems =
    hasLocallyHiddenItems || canLoadMoreApprovedForScope || canLoadMorePendingForScope
  const canLoadMoreNow =
    hasLocallyHiddenItems ||
    (canLoadMoreApprovedForScope && !isLoadingApproved) ||
    (canLoadMorePendingForScope && !isLoadingPending)
  const hasLoadError =
    (scope !== "pending" && approvedAssetsUnavailable) ||
    (scope !== "approved" && pendingAssetsUnavailable)
  const canRetryApproved = scope !== "pending" && approvedAssetsUnavailable && !isLoadingApproved
  const canRetryPending = scope !== "approved" && pendingAssetsUnavailable && !isLoadingPending
  const canRetryNow = canRetryApproved || canRetryPending
  const isLoadingVisibleFeed =
    (scope !== "pending" && isLoadingApproved) || (scope !== "approved" && isLoadingPending)
  const catalogStatus = [
    isLoadingVisibleFeed ? "Loading assets." : null,
    hasLoadError ? "Some assets could not be loaded." : null,
    `Showing ${visibleItems.length} loaded ${visibleItems.length === 1 ? "match" : "matches"}`,
  ]
    .filter((message) => message !== null)
    .join(" ")
  const loadMore = () => {
    const needsMoreLoadedItems = visibleItems.length >= items.length
    setVisibleItemLimit((currentLimit) => currentLimit + INITIAL_VISIBLE_ITEM_LIMIT)

    if (!needsMoreLoadedItems) {
      return
    }

    if (canLoadMoreApprovedForScope && !isLoadingApproved) {
      void onLoadMoreApproved()
    }
    if (canLoadMorePendingForScope && !isLoadingPending) {
      void onLoadMorePending()
    }
  }
  const retryLoad = () => {
    if (canRetryApproved) {
      void onRetryApproved()
    }
    if (canRetryPending) {
      void onRetryPending()
    }
  }

  return (
    <div
      className="grid h-full min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]"
      data-mobile-view={mobileDetailOpen ? "detail" : "list"}
    >
      <aside
        className={cn(
          "min-h-0 flex-col border-border lg:flex lg:border-r",
          mobileDetailOpen ? "hidden" : "flex"
        )}
      >
        <div className="flex flex-col gap-3 p-4">
          <SearchField
            activeDescendant={
              selectedItem === undefined ? undefined : getCatalogItemDomId(selectedItem)
            }
            controls={ASSET_CATALOG_LIST_ID}
            onChange={(nextQuery) => {
              setQuery(nextQuery)
              setVisibleItemLimit(INITIAL_VISIBLE_ITEM_LIMIT)
              onQueryChange(nextQuery)
            }}
            query={query}
          />
          <div
            aria-label="Asset scope"
            className="grid h-11 grid-cols-3 rounded-full bg-muted p-1"
            role="group"
          >
            {(["all", "approved", "pending"] as const).map((value) => (
              <button
                aria-pressed={scope === value}
                className={cn(
                  "rounded-full px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  scope === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                )}
                key={value}
                onClick={() => {
                  setScope(value)
                  setVisibleItemLimit(INITIAL_VISIBLE_ITEM_LIMIT)
                }}
                type="button"
              >
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <Separator />
        <div
          aria-label="Assets"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          id={ASSET_CATALOG_LIST_ID}
          role="listbox"
        >
          {visibleItems.map((item) => (
            <NavigatorRow
              active={getCatalogItemKey(item) === selectedItemKey}
              id={getCatalogItemDomId(item)}
              item={item}
              key={getCatalogItemKey(item)}
              onSelect={() => selectItem(item)}
            />
          ))}
          {items.length === 0 ? (
            <NoResults
              approvedAssetsUnavailable={approvedAssetsUnavailable && scope !== "pending"}
              pendingAssetsUnavailable={
                pendingAssetsUnavailable &&
                (scope === "pending" || (scope === "all" && approvedItems.length === 0))
              }
              query={query}
            />
          ) : null}
        </div>
        <div className="flex min-h-14 flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span aria-atomic="true" aria-live="polite" className="min-w-0 flex-1" role="status">
            {catalogStatus}
          </span>
          {hasMoreItems ? (
            <Button
              aria-label={canLoadMoreNow ? "Load more assets" : "Loading assets"}
              className="h-11 shrink-0"
              disabled={!canLoadMoreNow}
              onClick={loadMore}
              size="sm"
              variant="outline"
            >
              {canLoadMoreNow ? "Load more" : "Loading…"}
            </Button>
          ) : null}
          {hasLoadError ? (
            <Button
              aria-label={canRetryNow ? "Retry loading assets" : "Retrying asset feeds"}
              className="h-11 shrink-0"
              disabled={!canRetryNow}
              onClick={retryLoad}
              size="sm"
              variant="outline"
            >
              {canRetryNow ? "Retry" : "Retrying…"}
            </Button>
          ) : null}
        </div>
      </aside>
      <section
        className={cn(
          "h-full min-w-0 overflow-y-auto overscroll-contain p-5 pb-28 sm:p-8 sm:pb-28 lg:block lg:p-10",
          mobileDetailOpen ? "block" : "hidden"
        )}
      >
        {mobileDetailOpen ? (
          <Button
            className="-ml-2 mb-6 h-11 lg:hidden"
            onClick={showMobileList}
            ref={mobileBackButtonRef}
            variant="ghost"
          >
            <ArrowLeft data-icon="inline-start" />
            Back to asset list
          </Button>
        ) : null}
        {selectedItem ? (
          <CatalogItemDetail item={selectedItem} />
        ) : (
          <NoResults
            approvedAssetsUnavailable={approvedAssetsUnavailable && scope !== "pending"}
            pendingAssetsUnavailable={pendingAssetsUnavailable && scope !== "approved"}
            query={query}
          />
        )}
      </section>
    </div>
  )
}

function NavigatorRow({
  active,
  id,
  item,
  onSelect,
}: {
  readonly active: boolean
  readonly id: string
  readonly item: CatalogItem
  readonly onSelect: () => void
}) {
  const symbol = item.asset.symbol
  const name = getCatalogItemName(item)

  return (
    <button
      aria-selected={active}
      className={cn(
        "flex min-h-16 w-full items-center gap-3 border-b border-border px-4 py-3 text-left outline-none [content-visibility:auto] [contain-intrinsic-size:auto_4rem] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        active ? "bg-secondary" : "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"
      )}
      data-asset-catalog-option=""
      id={id}
      onClick={onSelect}
      role="option"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <AssetMark item={item} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{symbol}</span>
          {item.kind === "pending" ? <Badge variant="outline">Pending</Badge> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{name}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function CatalogItemDetail({ item }: { readonly item: CatalogItem }) {
  if (item.kind === "pending") {
    return <PendingAssetDetail asset={item.asset} />
  }

  const networkNames = getNetworkNames(item.asset)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <AssetMark item={item} size="lg" />
          <div className="min-w-0">
            <Badge variant="secondary">
              <ShieldCheck data-icon="inline-start" />
              Approved
            </Badge>
            <h2 className="mt-3 truncate text-3xl font-semibold tracking-tight sm:text-5xl">
              {item.asset.symbol}
            </h2>
            <p className="mt-1 truncate text-base text-muted-foreground">{item.asset.name}</p>
          </div>
        </div>
        <Badge variant="outline">{formatAssetType(item.asset.type)}</Badge>
      </div>

      <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
        {describeTaxMaxiAsset(item.asset)}
      </p>

      <Button asChild={true} className="h-11 self-start" variant="outline">
        <a href={`/assets/${encodeURIComponent(item.asset.id)}`}>
          Open public asset page
          <ArrowUpRight data-icon="inline-end" />
        </a>
      </Button>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Representations" value={item.asset.representations.length.toString()} />
        <StatCard label="Networks" value={networkNames.length.toString()} />
        <StatCard label="Registry status" value="Approved" />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border">
        <div className="px-4 py-3">
          <h3 className="text-sm font-medium">Network representations</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Identities that resolve to this economic asset.
          </p>
        </div>
        <Separator />
        {item.asset.representations.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            This asset currently has no network representation.
          </p>
        ) : (
          item.asset.representations.map((representation, index) => (
            <Fragment key={representation.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                  {formatBlockchainName(representation.blockchainName).slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {formatBlockchainName(representation.blockchainName)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {representation.type === "native"
                      ? "Native network asset"
                      : (representation.contractAddress ??
                        representation.mintAddress ??
                        "Token identity")}
                  </p>
                </div>
                <Badge variant="outline">{representation.type}</Badge>
              </div>
              {index < item.asset.representations.length - 1 ? <Separator /> : null}
            </Fragment>
          ))
        )}
      </section>
    </div>
  )
}

function PendingAssetDetail({ asset }: { readonly asset: TaxMaxiPendingAsset }) {
  const item: CatalogItem = { kind: "pending", asset }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex min-w-0 items-center gap-4">
        <AssetMark item={item} size="lg" />
        <div className="min-w-0">
          <Badge variant="outline">
            <Clock3 data-icon="inline-start" />
            Waiting for review
          </Badge>
          <h2 className="mt-3 truncate text-3xl font-semibold tracking-tight sm:text-5xl">
            {asset.symbol}
          </h2>
          <p className="mt-1 truncate text-base text-muted-foreground">
            {getPendingAssetName(asset)}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-secondary p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <CircleDotDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <h3 className="text-sm font-medium">This asset is on TaxMaxi’s radar</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              TaxMaxi admins are reviewing whether this provider asset maps to an existing canonical
              asset. You do not need to take action.
            </p>
          </div>
        </div>
      </div>

      <dl className="overflow-hidden rounded-2xl border border-border">
        <DetailRow label="Reported by" value={asset.provider} />
        <Separator />
        <DetailRow label="Provider asset ID" value={asset.providerAssetId ?? "Not supplied"} />
        <Separator />
        <DetailRow label="Provider type" value={asset.providerType ?? "Not supplied"} />
        <Separator />
        <DetailRow label="Review status" value="Waiting for TaxMaxi review" />
      </dl>
    </div>
  )
}

function SearchField({
  activeDescendant,
  controls,
  onChange,
  query,
}: {
  readonly activeDescendant?: string
  readonly controls: string
  readonly onChange: (query: string) => void
  readonly query: string
}) {
  return (
    <InputGroup className="h-11 border border-border bg-background">
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        aria-activedescendant={activeDescendant}
        aria-label="Search assets"
        aria-autocomplete="list"
        aria-controls={controls}
        aria-expanded="true"
        autoComplete="off"
        id={ASSET_CATALOG_SEARCH_ID}
        maxLength={ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search symbol, name, network, or provider"
        spellCheck={false}
        type="search"
        value={query}
        role="combobox"
      />
    </InputGroup>
  )
}

function AssetMark({ item, size }: { readonly item: CatalogItem; readonly size: "sm" | "lg" }) {
  const symbol = item.asset.symbol
  const logoUrl = item.kind === "approved" ? item.asset.logoUrl : null
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const usableLogoUrl = logoUrl === failedLogoUrl ? null : logoUrl

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary font-medium text-secondary-foreground",
        size === "lg" ? "size-16 text-lg" : "size-10 text-xs"
      )}
    >
      {usableLogoUrl ? (
        <img
          alt={`${getCatalogItemName(item)} logo`}
          className="size-full object-cover"
          loading="lazy"
          onError={() => setFailedLogoUrl(usableLogoUrl)}
          src={usableLogoUrl}
        />
      ) : (
        <span aria-hidden="true">{symbol.slice(0, 2)}</span>
      )}
    </span>
  )
}

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-card-foreground">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-medium tabular-nums">{value}</p>
    </div>
  )
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm sm:text-right">{value}</dd>
    </div>
  )
}

function NoResults({
  approvedAssetsUnavailable = false,
  pendingAssetsUnavailable = false,
  query,
}: {
  readonly approvedAssetsUnavailable?: boolean
  readonly pendingAssetsUnavailable?: boolean
  readonly query: string
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center">
      <Coins aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">
        {approvedAssetsUnavailable
          ? "Approved assets unavailable"
          : pendingAssetsUnavailable
            ? "Pending assets unavailable"
            : "No assets found"}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
        {approvedAssetsUnavailable
          ? pendingAssetsUnavailable
            ? "The asset feeds are unavailable. Try again in a moment."
            : "Pending assets are still available. Try loading approved assets again."
          : pendingAssetsUnavailable
            ? "Approved assets are still available. Try loading pending assets again."
            : query.trim().length === 0
              ? "The registry has no assets to show yet."
              : "Try a symbol, provider, network, or contract address."}
      </p>
    </div>
  )
}

function matchesPendingAsset(asset: TaxMaxiPendingAsset, query: string): boolean {
  return matchesAssetCatalogQuery({
    query,
    values: [
      asset.symbol,
      asset.name ?? "",
      asset.provider,
      asset.providerAssetId ?? "",
      asset.providerType ?? "",
    ],
  })
}

function getPendingAssetName(asset: TaxMaxiPendingAsset): string {
  return asset.name ?? asset.symbol
}

function getCatalogItemName(item: CatalogItem): string {
  return item.kind === "pending" ? getPendingAssetName(item.asset) : item.asset.name
}

function getCatalogItemKey(item: CatalogItem | undefined): string {
  if (!item) {
    return ""
  }

  return `${item.kind}:${item.asset.id}`
}

function getCatalogItemDomId(item: CatalogItem): string {
  return `asset-catalog-option-${item.kind}-${item.asset.id}`
}

function getNetworkNames(asset: TaxMaxiAsset): ReadonlyArray<string> {
  return Array.from(
    new Set(
      asset.representations.map((representation) =>
        formatBlockchainName(representation.blockchainName)
      )
    )
  )
}
