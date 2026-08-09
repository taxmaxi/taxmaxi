import { ChevronRight, Search } from "lucide-react"

import { AssetCatalogEmptyState } from "#/components/asset-catalog-empty-state"
import { AssetCatalogItemMark } from "#/components/asset-catalog-item-mark"
import {
  ASSET_CATALOG_LIST_ID,
  ASSET_CATALOG_SEARCH_ID,
  getCatalogItemDomId,
  getCatalogItemKey,
  getCatalogItemName,
  type CatalogItem,
  type CatalogScope,
} from "#/components/asset-catalog-model"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group"
import { Separator } from "#/components/ui/separator"
import { ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH } from "#/lib/assets"
import { cn } from "#/lib/utils"

export function AssetCatalogListPane({
  approvedAssetsUnavailable,
  approvedItemsCount,
  canLoadMoreNow,
  canRetryNow,
  catalogStatus,
  hasLoadError,
  hasMoreItems,
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
}: {
  readonly approvedAssetsUnavailable: boolean
  readonly approvedItemsCount: number
  readonly canLoadMoreNow: boolean
  readonly canRetryNow: boolean
  readonly catalogStatus: string
  readonly hasLoadError: boolean
  readonly hasMoreItems: boolean
  readonly mobileDetailOpen: boolean
  readonly onLoadMore: () => void
  readonly onQueryChange: (query: string) => void
  readonly onRetry: () => void
  readonly onScopeChange: (scope: CatalogScope) => void
  readonly onSelect: (item: CatalogItem) => void
  readonly pendingAssetsUnavailable: boolean
  readonly query: string
  readonly scope: CatalogScope
  readonly selectedItem: CatalogItem | undefined
  readonly selectedItemKey: string
  readonly visibleItems: ReadonlyArray<CatalogItem>
}) {
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
              onClick={() => onScopeChange(value)}
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
            onSelect={() => onSelect(item)}
          />
        ))}
        {visibleItems.length === 0 ? (
          <AssetCatalogEmptyState
            approvedAssetsUnavailable={approvedAssetsUnavailable && scope !== "pending"}
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
            aria-label={canLoadMoreNow ? "Load more assets" : "Loading assets"}
            className="h-11 shrink-0"
            disabled={!canLoadMoreNow}
            onClick={onLoadMore}
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
            onClick={onRetry}
            size="sm"
            variant="outline"
          >
            {canRetryNow ? "Retry" : "Retrying…"}
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
      <AssetCatalogItemMark item={item} size="sm" />
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
        aria-label="Search assets"
        autoComplete="off"
        id={ASSET_CATALOG_SEARCH_ID}
        maxLength={ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search symbol, name, network, or provider"
        role="combobox"
        spellCheck={false}
        type="search"
        value={query}
      />
    </InputGroup>
  )
}
