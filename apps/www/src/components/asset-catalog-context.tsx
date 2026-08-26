import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"

import {
  compareCatalogItems,
  matchesPendingAsset,
  type CatalogItem,
  type CatalogScope,
} from "#/components/asset-catalog-model"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { useAssetCatalogPaging } from "#/components/use-asset-catalog-paging"
import { useAssetCatalogSelection } from "#/components/use-asset-catalog-selection"
import {
  filterTaxMaxiAssets,
  matchesAssetCatalogQuery,
  type TaxMaxiAsset,
  type TaxMaxiPendingAsset,
} from "#/lib/assets"
import type {
  AssetCatalogList,
  AssetExceptionDecisionInput,
  AssetExceptionDecisionConfirmationInput,
  AssetExceptionDetail,
  AssetExceptionPreview,
} from "taxmaxi"

type AssetCatalogFeed<T> = {
  readonly canLoadMore?: boolean
  readonly isLoading?: boolean
  readonly items: ReadonlyArray<T>
  readonly loadMore?: () => Promise<unknown> | void
  readonly retry?: () => Promise<unknown> | void
  readonly unavailable?: boolean
}

export type AssetCatalogFeeds = {
  readonly approved: AssetCatalogFeed<TaxMaxiAsset>
  readonly pending: AssetCatalogFeed<TaxMaxiPendingAsset>
  readonly exceptions?: AssetCatalogFeed<TaxMaxiAssetException>
}

export type AssetExceptionActions = {
  readonly get: (id: string) => Promise<AssetExceptionDetail>
  readonly preview: (input: AssetExceptionDecisionInput) => Promise<AssetExceptionPreview>
  readonly submit: (input: AssetExceptionDecisionConfirmationInput) => Promise<AssetExceptionDetail>
  readonly searchAssets: (query: string) => Promise<AssetCatalogList>
}

const doNothing = () => undefined

function useAssetCatalogController({
  exceptionActions,
  feeds,
  onQueryChange,
}: {
  readonly exceptionActions?: AssetExceptionActions
  readonly feeds: AssetCatalogFeeds
  readonly onQueryChange: (query: string) => void
}) {
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<CatalogScope>("all")

  const approvedItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      filterTaxMaxiAssets({ assets: feeds.approved.items, query })
        .map((asset) => ({
          kind: "approved" as const,
          asset,
        }))
        .sort(compareCatalogItems),
    [feeds.approved.items, query]
  )

  const pendingItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      feeds.pending.items
        .filter((asset) => matchesPendingAsset(asset, query))
        .map((asset) => ({ kind: "pending" as const, asset }))
        .sort(compareCatalogItems),
    [feeds.pending.items, query]
  )

  const exceptionItems = useMemo<ReadonlyArray<CatalogItem>>(
    () =>
      (feeds.exceptions?.items ?? [])
        .filter((exception) =>
          matchesAssetCatalogQuery({
            query,
            values: [
              exception.currencyCode,
              exception.name ?? "",
              exception.provider,
              exception.providerAssetId ?? "",
              exception.naturalKey ?? "",
              exception.reason,
            ],
          })
        )
        .map((exception) => ({ kind: "exception" as const, exception })),
    [feeds.exceptions?.items, query]
  )

  const items = useMemo(() => {
    switch (scope) {
      case "approved":
        return approvedItems
      case "pending":
        return pendingItems
      case "all":
        return [...pendingItems, ...approvedItems]
      case "exceptions":
        return exceptionItems
    }
  }, [approvedItems, exceptionItems, pendingItems, scope])

  const paging = useAssetCatalogPaging({
    approvedAssetsUnavailable: feeds.approved.unavailable ?? false,
    canLoadMoreApproved: feeds.approved.canLoadMore ?? false,
    canLoadMorePending: feeds.pending.canLoadMore ?? false,
    canLoadMoreExceptions: feeds.exceptions?.canLoadMore ?? false,
    isLoadingApproved: feeds.approved.isLoading ?? false,
    isLoadingPending: feeds.pending.isLoading ?? false,
    isLoadingExceptions: feeds.exceptions?.isLoading ?? false,
    items,
    onLoadMoreApproved: feeds.approved.loadMore ?? doNothing,
    onLoadMorePending: feeds.pending.loadMore ?? doNothing,
    onLoadMoreExceptions: feeds.exceptions?.loadMore ?? doNothing,
    onRetryApproved: feeds.approved.retry ?? doNothing,
    onRetryPending: feeds.pending.retry ?? doNothing,
    onRetryExceptions: feeds.exceptions?.retry ?? doNothing,
    pendingAssetsUnavailable: feeds.pending.unavailable ?? false,
    exceptionsUnavailable: feeds.exceptions?.unavailable ?? false,
    scope,
  })

  const selection = useAssetCatalogSelection({ visibleItems: paging.visibleItems })

  const changeQuery = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery)
      paging.resetVisibleItems()
      onQueryChange(nextQuery)
    },
    [onQueryChange, paging.resetVisibleItems]
  )

  const changeScope = useCallback(
    (nextScope: CatalogScope) => {
      setScope(nextScope)
      paging.resetVisibleItems()
    },
    [paging.resetVisibleItems]
  )

  return useMemo(
    () => ({
      approvedAssetsUnavailable: feeds.approved.unavailable ?? false,
      approvedItemsCount: approvedItems.length,
      canLoadMoreNow: paging.canLoadMoreNow,
      canRetryNow: paging.canRetryNow,
      catalogStatus: paging.catalogStatus,
      hasLoadError: paging.hasLoadError,
      hasMoreItems: paging.hasMoreItems,
      isLoading: paging.isLoadingVisibleFeed,
      mobileBackButtonRef: selection.mobileBackButtonRef,
      mobileDetailOpen: selection.mobileDetailOpen,
      onLoadMore: paging.loadMore,
      onQueryChange: changeQuery,
      onRetry: paging.retryLoad,
      onScopeChange: changeScope,
      onSelect: selection.selectItem,
      onShowMobileList: selection.showMobileList,
      pendingAssetsUnavailable: feeds.pending.unavailable ?? false,
      exceptionsAvailable: feeds.exceptions !== undefined,
      exceptionsUnavailable: feeds.exceptions?.unavailable ?? false,
      exceptionActions,
      query,
      scope,
      selectedItem: selection.selectedItem,
      selectedItemKey: selection.selectedItemKey,
      visibleItems: paging.visibleItems,
    }),
    [
      approvedItems.length,
      changeQuery,
      changeScope,
      exceptionActions,
      feeds.approved.unavailable,
      feeds.pending.unavailable,
      feeds.exceptions,
      paging.canLoadMoreNow,
      paging.canRetryNow,
      paging.catalogStatus,
      paging.hasLoadError,
      paging.hasMoreItems,
      paging.isLoadingVisibleFeed,
      paging.loadMore,
      paging.retryLoad,
      paging.visibleItems,
      query,
      scope,
      selection.mobileBackButtonRef,
      selection.mobileDetailOpen,
      selection.selectItem,
      selection.selectedItem,
      selection.selectedItemKey,
      selection.showMobileList,
    ]
  )
}

type AssetCatalogContextValue = ReturnType<typeof useAssetCatalogController>

const AssetCatalogContext = createContext<AssetCatalogContextValue | null>(null)

export function AssetCatalogProvider({
  children,
  exceptionActions,
  feeds,
  onQueryChange = doNothing,
}: {
  readonly children: ReactNode
  readonly exceptionActions?: AssetExceptionActions
  readonly feeds: AssetCatalogFeeds
  readonly onQueryChange?: (query: string) => void
}) {
  const catalog = useAssetCatalogController({ exceptionActions, feeds, onQueryChange })

  return <AssetCatalogContext value={catalog}>{children}</AssetCatalogContext>
}

export function useAssetCatalog(): AssetCatalogContextValue {
  const catalog = useContext(AssetCatalogContext)

  if (catalog === null) {
    throw new Error("useAssetCatalog must be used within AssetCatalogProvider")
  }

  return catalog
}
