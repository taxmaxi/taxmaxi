import { Coins } from "lucide-react"

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
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center">
      <Coins aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">
        {approvedAssetsUnavailable
          ? "Approved assets unavailable"
          : pendingAssetsUnavailable
            ? "Pending assets unavailable"
            : isLoading
              ? "Loading assets"
              : "No assets found"}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
        {approvedAssetsUnavailable
          ? pendingAssetsUnavailable
            ? "The asset feeds are unavailable. Try again in a moment."
            : isLoading
              ? "Pending assets are still loading."
              : "Pending assets are still available. Try loading approved assets again."
          : pendingAssetsUnavailable
            ? isLoading
              ? "Approved assets are still loading."
              : "Approved assets are still available. Try loading pending assets again."
            : isLoading
              ? "Fetching the asset registry."
              : query.trim().length === 0
                ? "The registry has no assets to show yet."
                : "Try a symbol, provider, network, or contract address."}
      </p>
    </div>
  )
}
