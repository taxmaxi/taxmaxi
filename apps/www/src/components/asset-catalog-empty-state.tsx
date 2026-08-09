import { Coins } from "lucide-react"

import { m } from "#/paraglide/messages"

export function AssetCatalogEmptyState({
  approvedAssetsUnavailable = false,
  isLoading = false,
  pendingAssetsUnavailable = false,
  query,
}: {
  readonly approvedAssetsUnavailable?: boolean
  readonly isLoading?: boolean
  readonly pendingAssetsUnavailable?: boolean
  readonly query: string
}) {
  const title = getEmptyStateTitle({
    approvedAssetsUnavailable,
    isLoading,
    pendingAssetsUnavailable,
  })
  const description = getEmptyStateDescription({
    approvedAssetsUnavailable,
    isLoading,
    pendingAssetsUnavailable,
    query,
  })

  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center">
      <Coins aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

type EmptyState = {
  readonly approvedAssetsUnavailable: boolean
  readonly isLoading: boolean
  readonly pendingAssetsUnavailable: boolean
}

function getEmptyStateTitle({
  approvedAssetsUnavailable,
  isLoading,
  pendingAssetsUnavailable,
}: EmptyState): string {
  if (approvedAssetsUnavailable) {
    return m["assetCatalog.empty.approvedUnavailableTitle"]()
  }
  if (pendingAssetsUnavailable) {
    return m["assetCatalog.empty.pendingUnavailableTitle"]()
  }
  return isLoading
    ? m["assetCatalog.empty.loadingTitle"]()
    : m["assetCatalog.empty.notFoundTitle"]()
}

function getEmptyStateDescription({
  approvedAssetsUnavailable,
  isLoading,
  pendingAssetsUnavailable,
  query,
}: EmptyState & { readonly query: string }): string {
  if (approvedAssetsUnavailable && pendingAssetsUnavailable) {
    return m["assetCatalog.empty.allUnavailable"]()
  }
  if (approvedAssetsUnavailable) {
    return isLoading
      ? m["assetCatalog.empty.pendingLoading"]()
      : m["assetCatalog.empty.pendingAvailable"]()
  }
  if (pendingAssetsUnavailable) {
    return isLoading
      ? m["assetCatalog.empty.approvedLoading"]()
      : m["assetCatalog.empty.approvedAvailable"]()
  }
  if (isLoading) {
    return m["assetCatalog.empty.fetching"]()
  }
  return query.trim().length === 0
    ? m["assetCatalog.empty.registryEmpty"]()
    : m["assetCatalog.empty.searchHint"]()
}
