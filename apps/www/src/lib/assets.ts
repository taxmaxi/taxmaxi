import type { AssetCatalogAsset, AssetRepresentation, PendingAsset } from "taxmaxi"

import { m } from "#/paraglide/messages"

export type TaxMaxiAsset = AssetCatalogAsset
export type TaxMaxiAssetType = TaxMaxiAsset["type"]
export type TaxMaxiPendingAsset = PendingAsset

export const ASSET_CATALOG_SEARCH_QUERY_MAX_LENGTH = 128

export function matchesAssetCatalogQuery({
  query,
  values,
}: {
  readonly query: string
  readonly values: ReadonlyArray<string>
}): boolean {
  const searchTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const searchableText = values.join(" ").toLowerCase()

  return searchTokens.every((token) => searchableText.includes(token))
}

export function filterTaxMaxiAssets({
  assets,
  query,
}: {
  readonly assets: ReadonlyArray<TaxMaxiAsset>
  readonly query: string
}): ReadonlyArray<TaxMaxiAsset> {
  return assets.filter((asset) =>
    matchesAssetCatalogQuery({
      query,
      values: [
        asset.id,
        asset.name,
        asset.symbol,
        asset.coingeckoCoinId ?? "",
        ...asset.representations.flatMap((representation) => [
          representation.blockchainName,
          representation.blockchainChainType,
          representation.contractAddress ?? "",
          representation.mintAddress ?? "",
        ]),
      ],
    })
  )
}

export function formatAssetType(assetType: TaxMaxiAssetType): string {
  switch (assetType) {
    case "fungible":
      return m["assetCatalog.assetType.fungible"]()
    case "nft":
      return m["assetCatalog.assetType.nft"]()
  }
}

export function formatAssetRepresentationType(type: AssetRepresentation["type"]): string {
  switch (type) {
    case "native":
      return m["assetCatalog.representationType.native"]()
    case "nft":
      return m["assetCatalog.representationType.nft"]()
    case "token":
      return m["assetCatalog.representationType.token"]()
  }
}

export function formatBlockchainName(name: string): string {
  return name
    .split(/[\s_-]+/)
    .map((part) => (part.length === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(" ")
}

export function describeTaxMaxiAsset(asset: TaxMaxiAsset): string {
  if (asset.type === "nft") {
    return m["assetCatalog.description.nft"]()
  }

  const representationCount = asset.representations.length
  return representationCount === 1
    ? m["assetCatalog.description.fungibleOne"]({ count: representationCount })
    : m["assetCatalog.description.fungibleMany"]({ count: representationCount })
}

export function getAssetRepresentationExplorerHref(
  representation: AssetRepresentation
): string | null {
  if (representation.blockchainExplorerUrl === null) {
    return null
  }

  const explorerBaseUrl = representation.blockchainExplorerUrl.replace(/\/+$/, "")
  const address = representation.contractAddress ?? representation.mintAddress
  return address === null ? explorerBaseUrl : `${explorerBaseUrl}/address/${address}`
}
