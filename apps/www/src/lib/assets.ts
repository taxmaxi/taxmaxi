import type { AssetCatalogAsset } from "taxmaxi"

export type TaxMaxiAsset = AssetCatalogAsset
export type TaxMaxiAssetRepresentation = TaxMaxiAsset["representations"][number]
export type TaxMaxiAssetType = TaxMaxiAssetRepresentation["type"]

export function filterTaxMaxiAssets({
  assets,
  query,
}: {
  readonly assets: ReadonlyArray<TaxMaxiAsset>
  readonly query: string
}): ReadonlyArray<TaxMaxiAsset> {
  const normalizedQuery = query.trim().toLowerCase()

  if (normalizedQuery.length === 0) {
    return assets
  }

  return assets.filter((asset) => {
    const representationSearch = asset.representations.flatMap((representation) => [
      representation.blockchainName,
      representation.blockchainChainType,
      representation.contractAddress ?? "",
    ])

    return [
      asset.id,
      asset.name,
      asset.symbol,
      asset.coingeckoCoinId ?? "",
      ...representationSearch,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  })
}

export function formatAssetType(assetType: TaxMaxiAssetType): string {
  switch (assetType) {
    case "native":
      return "Native asset"
    case "token":
      return "Token"
    case "nft":
      return "NFT"
  }
}

export function formatBlockchainName(name: string): string {
  return name
    .split(/[\s_-]+/)
    .map((part) => (part.length === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(" ")
}

export function describeTaxMaxiAsset(asset: TaxMaxiAsset): string {
  const count = asset.representations.length
  return `${asset.name} is one economic asset with ${count} known network representation${count === 1 ? "" : "s"} used for valuation, inventory, and tax reporting.`
}

export function getTaxMaxiAssetExplorerHref(
  representation: TaxMaxiAssetRepresentation
): string | null {
  if (representation.blockchainExplorerUrl === null) {
    return null
  }

  const explorerBaseUrl = representation.blockchainExplorerUrl.replace(/\/+$/, "")
  return representation.contractAddress === null
    ? explorerBaseUrl
    : `${explorerBaseUrl}/address/${representation.contractAddress}`
}
