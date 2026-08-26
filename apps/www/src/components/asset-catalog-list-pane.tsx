import { ChevronRight, Search } from "lucide-react"

import { useAssetCatalog } from "#/components/asset-catalog-context"
import { AssetCatalogEmptyState } from "#/components/asset-catalog-empty-state"
import { AssetCatalogItemMark } from "#/components/asset-catalog-item-mark"
import {
  ASSET_CATALOG_LIST_ID,
  ASSET_CATALOG_SEARCH_ID,
  getCatalogItemDomId,
  getCatalogItemKey,
  getCatalogItemName,
  getCatalogItemSymbol,
  type CatalogItem,
  type CatalogScope,
} from "#/components/asset-catalog-model"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group"
import { Separator } from "#/components/ui/separator"
import { ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH } from "#/lib/assets"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

export function AssetCatalogListPane() {
  const {
    approvedAssetsUnavailable,
    approvedItemsCount,
    canLoadMoreNow,
    canRetryNow,
    catalogStatus,
    hasLoadError,
    hasMoreItems,
    isLoading,
    exceptionsAvailable,
    mobileDetailOpen,
    onLoadMore,
    onQueryChange,
    onRetry,
    onScopeChange,
    onSelect,
    pendingAssetsUnavailable,
    query,
    scope,
    selectedItem,
    selectedItemKey,
    visibleItems,
  } = useAssetCatalog()

  return (
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
          onChange={onQueryChange}
          query={query}
        />
        <div
          aria-label={m["assetCatalog.scopeLabel"]()}
          className={cn(
            "grid h-11 rounded-full bg-muted p-1",
            exceptionsAvailable ? "grid-cols-4" : "grid-cols-3"
          )}
          role="group"
        >
          {(
            [
              "all",
              "approved",
              "pending",
              ...(exceptionsAvailable ? ["exceptions" as const] : []),
            ] as const
          ).map((value) => (
            <button
              aria-pressed={scope === value}
              className={cn(
                "rounded-full px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                scope === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              )}
              key={value}
              onClick={() => onScopeChange(value)}
              type="button"
            >
              {getScopeLabel(value)}
            </button>
          ))}
        </div>
      </div>
      <Separator />
      <div
        aria-label={m["assetCatalog.listLabel"]()}
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
            onSelect={() => onSelect(item)}
          />
        ))}
        {visibleItems.length === 0 ? (
          <AssetCatalogEmptyState
            approvedAssetsUnavailable={approvedAssetsUnavailable && scope !== "pending"}
            isLoading={isLoading}
            pendingAssetsUnavailable={
              pendingAssetsUnavailable &&
              (scope === "pending" || (scope === "all" && approvedItemsCount === 0))
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
            aria-label={
              canLoadMoreNow
                ? m["assetCatalog.actions.loadMoreLabel"]()
                : m["assetCatalog.actions.loadingLabel"]()
            }
            className="h-11 shrink-0"
            disabled={!canLoadMoreNow}
            onClick={onLoadMore}
            size="sm"
            variant="outline"
          >
            {canLoadMoreNow
              ? m["assetCatalog.actions.loadMore"]()
              : m["assetCatalog.actions.loading"]()}
          </Button>
        ) : null}
        {hasLoadError ? (
          <Button
            aria-label={
              canRetryNow
                ? m["assetCatalog.actions.retryLabel"]()
                : m["assetCatalog.actions.retryingLabel"]()
            }
            className="h-11 shrink-0"
            disabled={!canRetryNow}
            onClick={onRetry}
            size="sm"
            variant="outline"
          >
            {canRetryNow ? m["assetCatalog.actions.retry"]() : m["assetCatalog.actions.retrying"]()}
          </Button>
        ) : null}
      </div>
    </aside>
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
  const symbol = getCatalogItemSymbol(item)
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
      <AssetCatalogItemMark item={item} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{symbol}</span>
          {item.kind === "pending" ? (
            <Badge variant="outline">{m["assetCatalog.detail.pending"]()}</Badge>
          ) : item.kind === "exception" ? (
            <Badge variant="outline">{getExceptionSeverityLabel(item.exception.severity)}</Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{name}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
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
        aria-autocomplete="list"
        aria-controls={controls}
        aria-expanded="true"
        aria-label={m["assetCatalog.search.label"]()}
        autoComplete="off"
        id={ASSET_CATALOG_SEARCH_ID}
        maxLength={ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={m["assetCatalog.search.placeholder"]()}
        role="combobox"
        spellCheck={false}
        type="search"
        value={query}
      />
    </InputGroup>
  )
}

function getScopeLabel(scope: CatalogScope): string {
  switch (scope) {
    case "all":
      return m["assetCatalog.scope.all"]()
    case "approved":
      return m["assetCatalog.scope.approved"]()
    case "pending":
      return m["assetCatalog.scope.pending"]()
    case "exceptions":
      return m["assetCatalog.scope.exceptions"]()
  }
}

function getExceptionSeverityLabel(severity: "critical" | "high" | "medium" | "low"): string {
  switch (severity) {
    case "critical":
      return m["assetCatalog.exceptions.severity.critical"]()
    case "high":
      return m["assetCatalog.exceptions.severity.high"]()
    case "medium":
      return m["assetCatalog.exceptions.severity.medium"]()
    case "low":
      return m["assetCatalog.exceptions.severity.low"]()
  }
}
