import type { AssetCatalogAsset, AssetRepresentation } from "taxmaxi"

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
      ...asset.representations.flatMap((representation) => [
        representation.blockchainName,
        representation.blockchainChainType,
        representation.contractAddress ?? "",
        representation.mintAddress ?? "",
      ]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  )
}

export function formatAssetType(assetType: TaxMaxiAssetType): string {
  switch (assetType) {
    case "fungible":
      return "Fungible asset"
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
  if (asset.type === "nft") {
    return "Economic NFT identity used consistently across custody sources and network activity."
  }

  const representationCount = asset.representations.length
  const representationLabel = representationCount === 1 ? "representation" : "representations"

  return `Economic asset used for transfers, balances, valuation, and tax reports, with ${representationCount} known network ${representationLabel}.`
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
