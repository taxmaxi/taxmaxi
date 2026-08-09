import { useState } from "react"

import { cn } from "#/lib/utils"
import { getCatalogItemName, type CatalogItem } from "./asset-catalog-model"

export function AssetCatalogItemMark({
  item,
  size,
}: {
  readonly item: CatalogItem
  readonly size: "sm" | "lg"
}) {
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
