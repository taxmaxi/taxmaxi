import { useEffect, useState } from "react"

import { restoreAssetCatalogReturnFocus } from "#/lib/asset-catalog-focus"

export const ASSET_CATALOG_SEARCH_DEBOUNCE_MS = 300

export function useDebouncedCatalogQuery(query: string): string {
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query)
    }, ASSET_CATALOG_SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timeout)
  }, [query])

  return debouncedQuery
}

type AssetCatalogHistory = {
  readonly back: () => void
  readonly canGoBack: () => boolean
}

type AssetCatalogFallbackNavigation = {
  readonly replace: true
  readonly to: "/"
}

export function closeAssetCatalog({
  history,
  navigateToFallback,
  restoreFocus = restoreAssetCatalogReturnFocus,
}: {
  readonly history: AssetCatalogHistory
  readonly navigateToFallback: (navigation: AssetCatalogFallbackNavigation) => void
  readonly restoreFocus?: () => void
}) {
  if (history.canGoBack()) {
    history.back()
    restoreFocus()
    return
  }

  navigateToFallback({ replace: true, to: "/" })
  restoreFocus()
}

export function retryAssetCatalogFeed({
  fetchNextPage,
  isFetchNextPageError,
  refetch,
}: {
  readonly fetchNextPage: () => Promise<unknown>
  readonly isFetchNextPageError: boolean
  readonly refetch: () => Promise<unknown>
}): Promise<unknown> {
  return isFetchNextPageError ? fetchNextPage() : refetch()
}

export function loadAssetCatalogFeeds({
  cancelApproved,
  cancelPending,
  loadApproved,
  loadPending,
  signal,
}: {
  readonly cancelApproved: () => Promise<unknown>
  readonly cancelPending: () => Promise<unknown>
  readonly loadApproved: () => Promise<unknown>
  readonly loadPending: () => Promise<unknown>
  readonly signal: AbortSignal
}): void {
  if (signal.aborted) {
    return
  }

  const cancelLoads = () => {
    void Promise.allSettled([cancelApproved(), cancelPending()])
  }
  signal.addEventListener("abort", cancelLoads, { once: true })

  if (signal.aborted) {
    cancelLoads()
    return
  }

  void Promise.allSettled([loadApproved(), loadPending()]).finally(() => {
    signal.removeEventListener("abort", cancelLoads)
  })
}

export function loadAssetExceptionFeed(load: () => Promise<unknown>): void {
  void load().catch(() => undefined)
}
