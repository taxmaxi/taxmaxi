import { useCallback, useMemo, useState } from "react"

import {
  INITIAL_VISIBLE_ITEM_LIMIT,
  type CatalogItem,
  type CatalogScope,
} from "./asset-catalog-model"
import { m } from "#/paraglide/messages"

export function useAssetCatalogPaging({
  approvedAssetsUnavailable,
  canLoadMoreApproved,
  canLoadMorePending,
  canLoadMoreExceptions,
  isLoadingApproved,
  isLoadingPending,
  isLoadingExceptions,
  items,
  onLoadMoreApproved,
  onLoadMorePending,
  onLoadMoreExceptions,
  onRetryApproved,
  onRetryPending,
  onRetryExceptions,
  pendingAssetsUnavailable,
  exceptionsUnavailable,
  scope,
}: {
  readonly approvedAssetsUnavailable: boolean
  readonly canLoadMoreApproved: boolean
  readonly canLoadMorePending: boolean
  readonly canLoadMoreExceptions: boolean
  readonly isLoadingApproved: boolean
  readonly isLoadingPending: boolean
  readonly isLoadingExceptions: boolean
  readonly items: ReadonlyArray<CatalogItem>
  readonly onLoadMoreApproved: () => Promise<unknown> | void
  readonly onLoadMorePending: () => Promise<unknown> | void
  readonly onLoadMoreExceptions: () => Promise<unknown> | void
  readonly onRetryApproved: () => Promise<unknown> | void
  readonly onRetryPending: () => Promise<unknown> | void
  readonly onRetryExceptions: () => Promise<unknown> | void
  readonly pendingAssetsUnavailable: boolean
  readonly exceptionsUnavailable: boolean
  readonly scope: CatalogScope
}) {
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEM_LIMIT)
  const visibleItems = useMemo(() => items.slice(0, visibleItemLimit), [items, visibleItemLimit])
  const hasLocallyHiddenItems = visibleItems.length < items.length

  const canLoadMoreApprovedForScope =
    (scope === "all" || scope === "approved") && canLoadMoreApproved && !approvedAssetsUnavailable

  const canLoadMorePendingForScope =
    (scope === "all" || scope === "pending") && canLoadMorePending && !pendingAssetsUnavailable

  const canLoadMoreExceptionsForScope =
    scope === "exceptions" && canLoadMoreExceptions && !exceptionsUnavailable

  const hasMoreItems =
    hasLocallyHiddenItems ||
    canLoadMoreApprovedForScope ||
    canLoadMorePendingForScope ||
    canLoadMoreExceptionsForScope

  const canLoadMoreNow =
    hasLocallyHiddenItems ||
    (canLoadMoreApprovedForScope && !isLoadingApproved) ||
    (canLoadMorePendingForScope && !isLoadingPending) ||
    (canLoadMoreExceptionsForScope && !isLoadingExceptions)

  const hasLoadError =
    ((scope === "all" || scope === "approved") && approvedAssetsUnavailable) ||
    ((scope === "all" || scope === "pending") && pendingAssetsUnavailable) ||
    (scope === "exceptions" && exceptionsUnavailable)

  const canRetryApproved =
    (scope === "all" || scope === "approved") && approvedAssetsUnavailable && !isLoadingApproved

  const canRetryPending =
    (scope === "all" || scope === "pending") && pendingAssetsUnavailable && !isLoadingPending

  const canRetryExceptions = scope === "exceptions" && exceptionsUnavailable && !isLoadingExceptions

  const canRetryNow = canRetryApproved || canRetryPending || canRetryExceptions

  const isLoadingVisibleFeed =
    ((scope === "all" || scope === "approved") && isLoadingApproved) ||
    ((scope === "all" || scope === "pending") && isLoadingPending) ||
    (scope === "exceptions" && isLoadingExceptions)

  const visibleMatchCount = visibleItems.length

  const catalogStatus = [
    isLoadingVisibleFeed ? m["assetCatalog.status.loading"]() : null,
    hasLoadError ? m["assetCatalog.status.partialError"]() : null,
    visibleMatchCount === 1
      ? m["assetCatalog.status.showingOne"]({ count: visibleMatchCount })
      : m["assetCatalog.status.showingMany"]({ count: visibleMatchCount }),
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
    if (canLoadMoreExceptionsForScope && !isLoadingExceptions) {
      void onLoadMoreExceptions()
    }
  }, [
    canLoadMoreApprovedForScope,
    canLoadMorePendingForScope,
    canLoadMoreExceptionsForScope,
    isLoadingApproved,
    isLoadingPending,
    isLoadingExceptions,
    items.length,
    onLoadMoreApproved,
    onLoadMorePending,
    onLoadMoreExceptions,
    visibleItems.length,
  ])

  const retryLoad = useCallback(() => {
    if (canRetryApproved) {
      void onRetryApproved()
    }
    if (canRetryPending) {
      void onRetryPending()
    }
    if (canRetryExceptions) {
      void onRetryExceptions()
    }
  }, [
    canRetryApproved,
    canRetryExceptions,
    canRetryPending,
    onRetryApproved,
    onRetryExceptions,
    onRetryPending,
  ])

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
