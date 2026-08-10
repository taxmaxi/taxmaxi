import {
  formatBlockchainName,
  matchesAssetCatalogQuery,
  type TaxMaxiAsset,
  type TaxMaxiPendingAsset,
} from "#/lib/assets"

export type CatalogItem =
  | { readonly kind: "approved"; readonly asset: TaxMaxiAsset }
  | { readonly kind: "pending"; readonly asset: TaxMaxiPendingAsset }

export type CatalogScope = "all" | "approved" | "pending"

export const ASSET_CATALOG_LIST_ID = "asset-catalog-list"
export const ASSET_CATALOG_SEARCH_ID = "asset-catalog-search"
export const INITIAL_VISIBLE_ITEM_LIMIT = 80

const assetCatalogCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

export function matchesPendingAsset(asset: TaxMaxiPendingAsset, query: string): boolean {
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

export function getPendingAssetName(asset: TaxMaxiPendingAsset): string {
  return asset.name ?? asset.symbol
}

export function getCatalogItemName(item: CatalogItem): string {
  return item.kind === "pending" ? getPendingAssetName(item.asset) : item.asset.name
}

export function compareCatalogItems(left: CatalogItem, right: CatalogItem): number {
  return (
    assetCatalogCollator.compare(left.asset.symbol, right.asset.symbol) ||
    assetCatalogCollator.compare(getCatalogItemName(left), getCatalogItemName(right)) ||
    assetCatalogCollator.compare(getCatalogItemKey(left), getCatalogItemKey(right))
  )
}

export function getCatalogItemKey(item: CatalogItem | undefined): string {
  if (!item) {
    return ""
  }

  return `${item.kind}:${item.asset.id}`
}

export function getCatalogItemDomId(item: CatalogItem): string {
  return `asset-catalog-option-${item.kind}-${item.asset.id}`
}

export function getNetworkNames(asset: TaxMaxiAsset): ReadonlyArray<string> {
  return Array.from(
    new Set(
      asset.representations.map((representation) =>
        formatBlockchainName(representation.blockchainName)
      )
    )
  )
}
