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

// Characters that render as a blank on screen: control and format characters,
// spaces, Hangul fillers, the halfwidth filler, and the blank Braille pattern.
// Spam tokens use these as their symbol so the label looks empty.
const BLANK_LABEL_CHARACTERS = /[\p{C}\p{Z}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu

/** Trimmed label, or null when every character in it renders as a blank. */
export function readableAssetLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) {
    return null
  }

  const trimmed = label.trim()
  return trimmed.replaceAll(BLANK_LABEL_CHARACTERS, "").length === 0 ? null : trimmed
}

/** Fields an asset exception offers for picking a readable symbol. */
export type AssetExceptionLabelSource = {
  readonly currencyCode: string
  readonly name: string | null
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly providerAssetRowId: string
}

/**
 * Symbol shown for an asset exception: the first readable value among the
 * provider symbol, the provider name, and the provider identifiers.
 */
export function getAssetExceptionDisplaySymbol(exception: AssetExceptionLabelSource): string {
  return (
    readableAssetLabel(exception.currencyCode) ??
    readableAssetLabel(exception.name) ??
    exception.providerAssetId ??
    exception.naturalKey ??
    exception.providerAssetRowId
  )
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
