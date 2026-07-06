import type { AssetCatalogAsset } from "taxmaxi"

export type TaxMaxiAsset = AssetCatalogAsset
export type TaxMaxiAssetType = TaxMaxiAsset["type"]

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

  return assets.filter((asset) =>
    [
      asset.id,
      asset.name,
      asset.symbol,
      asset.blockchainName,
      asset.blockchainChainType,
      asset.contractAddress ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  )
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
  const blockchainName = formatBlockchainName(asset.blockchainName)

  if (asset.type === "native") {
    return `Native ${blockchainName} asset used for network fees, balances, and transfer normalization.`
  }

  if (asset.type === "nft") {
    return `Canonical ${blockchainName} NFT asset resolved by TaxMaxi during activity normalization.`
  }

  return `Canonical ${blockchainName} token used to normalize transfers, swaps, balances, and tax reports.`
}

export function getTaxMaxiAssetExplorerHref(asset: TaxMaxiAsset): string | null {
  if (asset.blockchainExplorerUrl === null) {
    return null
  }

  const explorerBaseUrl = asset.blockchainExplorerUrl.replace(/\/+$/, "")
  return asset.contractAddress === null
    ? explorerBaseUrl
    : `${explorerBaseUrl}/address/${asset.contractAddress}`
}
