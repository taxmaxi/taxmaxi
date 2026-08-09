import { useCallback, useMemo, useState } from "react"

import {
  INITIAL_VISIBLE_ITEM_LIMIT,
  type CatalogItem,
  type CatalogScope,
} from "./asset-catalog-model"

export function useAssetCatalogPaging({
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
}: {
  readonly approvedAssetsUnavailable: boolean
  readonly canLoadMoreApproved: boolean
  readonly canLoadMorePending: boolean
  readonly isLoadingApproved: boolean
  readonly isLoadingPending: boolean
  readonly items: ReadonlyArray<CatalogItem>
  readonly onLoadMoreApproved: () => Promise<unknown> | void
  readonly onLoadMorePending: () => Promise<unknown> | void
  readonly onRetryApproved: () => Promise<unknown> | void
  readonly onRetryPending: () => Promise<unknown> | void
  readonly pendingAssetsUnavailable: boolean
  readonly scope: CatalogScope
}) {
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEM_LIMIT)
  const visibleItems = useMemo(() => items.slice(0, visibleItemLimit), [items, visibleItemLimit])
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

  const loadMore = useCallback(() => {
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
  }, [
    canLoadMoreApprovedForScope,
    canLoadMorePendingForScope,
    isLoadingApproved,
    isLoadingPending,
    items.length,
    onLoadMoreApproved,
    onLoadMorePending,
    visibleItems.length,
  ])

  const retryLoad = useCallback(() => {
    if (canRetryApproved) {
      void onRetryApproved()
    }
    if (canRetryPending) {
      void onRetryPending()
    }
  }, [canRetryApproved, canRetryPending, onRetryApproved, onRetryPending])

  const resetVisibleItems = useCallback(() => {
    setVisibleItemLimit(INITIAL_VISIBLE_ITEM_LIMIT)
  }, [])

  return {
    canLoadMoreNow,
    canRetryNow,
    catalogStatus,
    hasLoadError,
    hasMoreItems,
    isLoadingVisibleFeed,
    loadMore,
    resetVisibleItems,
    retryLoad,
    visibleItems,
  }
}
