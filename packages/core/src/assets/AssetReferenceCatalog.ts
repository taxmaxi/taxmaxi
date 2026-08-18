/**
 * Version-controlled trusted economic asset, network representation, and provider alias facts.
 *
 * @module assets/AssetReferenceCatalog
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

/** Exact Solana mint used for wrapped native SOL. */
export const SOLANA_WRAPPED_NATIVE_MINT = "So11111111111111111111111111111111111111112"

/** Exact Solana mint for USDC. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

/** Exact Solana mint for USDT. */
export const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

/** Stable local identity for Helius native SOL observations. */
export const HELIUS_SOLANA_NATIVE_NATURAL_KEY = "solana:native:SOL"

export type AssetReferenceKey =
  | "ada"
  | "btc"
  | "dot"
  | "eth"
  | "eurc"
  | "sol"
  | "tao"
  | "usdc"
  | "usdt"
  | "zec"

export type AssetReferenceProvider = "coinbase" | "helius-solana"

export interface AssetReferenceSource {
  readonly authority: "taxmaxi"
  readonly reference: string
}

export interface EconomicAssetReference {
  readonly key: AssetReferenceKey
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string
  readonly logoUrl: string
  readonly type: "fungible"
  readonly source: AssetReferenceSource
}

export interface NetworkRepresentationReference {
  readonly key: string
  readonly assetKey: AssetReferenceKey
  readonly blockchain: "base" | "bitcoin" | "ethereum" | "solana"
  readonly type: "native" | "token"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
  readonly source: AssetReferenceSource
}

export interface ProviderAliasReference {
  readonly provider: AssetReferenceProvider
  readonly alias: string
  readonly naturalKey: string
  readonly assetKey: AssetReferenceKey
  readonly representationKey: string | null
  readonly displayName: string
  readonly providerType: "crypto" | "native" | "spl-token"
  readonly sourceNotes: string
  readonly source: AssetReferenceSource
}

export interface AssetReferenceCatalog {
  readonly revision: string
  readonly assets: ReadonlyArray<EconomicAssetReference>
  readonly representations: ReadonlyArray<NetworkRepresentationReference>
  readonly providerAliases: ReadonlyArray<ProviderAliasReference>
}

export type AssetReferenceCatalogViolationCode =
  | "conflicting_representation_ownership"
  | "duplicate_asset_key"
  | "duplicate_exact_representation"
  | "duplicate_provider_alias"
  | "duplicate_representation_key"
  | "missing_referenced_asset"
  | "missing_referenced_representation"
  | "representation_asset_mismatch"

export interface AssetReferenceCatalogViolation {
  readonly code: AssetReferenceCatalogViolationCode
  readonly reference: string
}

export class AssetReferenceCatalogValidationError extends Data.TaggedError(
  "AssetReferenceCatalogValidationError"
)<{
  readonly violations: ReadonlyArray<AssetReferenceCatalogViolation>
}> {}

export interface AssetReferenceCatalogProjections {
  readonly revision: string
  readonly economicAssets: ReadonlyArray<EconomicAssetReference>
  readonly networkRepresentations: ReadonlyArray<NetworkRepresentationReference>
  readonly providerAliases: ReadonlyArray<ProviderAliasReference>
  readonly coinbaseAliases: ReadonlyArray<{
    readonly currencyCode: string
    readonly assetKey: AssetReferenceKey
    readonly canonicalAssetCoinGeckoId: string
    readonly sourceNotes: string
  }>
  readonly heliusSolanaAliases: ReadonlyArray<{
    readonly mintAddress: string | null
    readonly naturalKey: string
    readonly currencyCode: string
    readonly name: string
    readonly decimals: number
    readonly providerType: "native" | "spl-token"
    readonly assetKey: AssetReferenceKey
    readonly representationKey: string
    readonly sourceNotes: string
  }>
}

const catalogSource = (reference: string): AssetReferenceSource => ({
  authority: "taxmaxi",
  reference,
})

const assetSource = catalogSource("docs/asset-reference-catalog.md#economic-assets")
const representationSource = catalogSource(
  "docs/asset-reference-catalog.md#network-representations"
)
const coinbaseSource = catalogSource("docs/asset-reference-catalog.md#coinbase-aliases")
const heliusSource = catalogSource("docs/asset-reference-catalog.md#helius-solana-aliases")

const assets = [
  {
    key: "btc",
    name: "Bitcoin",
    symbol: "BTC",
    coingeckoCoinId: "bitcoin",
    logoUrl: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "eth",
    name: "Ether",
    symbol: "ETH",
    coingeckoCoinId: "ethereum",
    logoUrl: "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "sol",
    name: "Solana",
    symbol: "SOL",
    coingeckoCoinId: "solana",
    logoUrl: "https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "usdc",
    name: "USD Coin",
    symbol: "USDC",
    coingeckoCoinId: "usd-coin",
    logoUrl: "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "usdt",
    name: "Tether",
    symbol: "USDT",
    coingeckoCoinId: "tether",
    logoUrl: "https://coin-images.coingecko.com/coins/images/325/large/Tether.png?1696501661",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "ada",
    name: "Cardano",
    symbol: "ADA",
    coingeckoCoinId: "cardano",
    logoUrl: "https://coin-images.coingecko.com/coins/images/975/large/cardano.png?1696502090",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "dot",
    name: "Polkadot",
    symbol: "DOT",
    coingeckoCoinId: "polkadot",
    logoUrl: "https://coin-images.coingecko.com/coins/images/12171/large/polkadot.jpg?1766533446",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "zec",
    name: "Zcash",
    symbol: "ZEC",
    coingeckoCoinId: "zcash",
    logoUrl:
      "https://coin-images.coingecko.com/coins/images/486/large/Brandmark-Yellow_%281%29.png?1785810558",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "eurc",
    name: "EURC",
    symbol: "EURC",
    coingeckoCoinId: "euro-coin",
    logoUrl: "https://coin-images.coingecko.com/coins/images/26045/large/EURC.png?1769615705",
    type: "fungible",
    source: assetSource,
  },
  {
    key: "tao",
    name: "Bittensor",
    symbol: "TAO",
    coingeckoCoinId: "bittensor",
    logoUrl:
      "https://coin-images.coingecko.com/coins/images/28452/large/ARUsPeNQ_400x400.jpeg?1696527447",
    type: "fungible",
    source: assetSource,
  },
] as const satisfies ReadonlyArray<EconomicAssetReference>

const representations = [
  {
    key: "bitcoin:native",
    assetKey: "btc",
    blockchain: "bitcoin",
    type: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 8,
    source: representationSource,
  },
  {
    key: "ethereum:native",
    assetKey: "eth",
    blockchain: "ethereum",
    type: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 18,
    source: representationSource,
  },
  {
    key: "base:native",
    assetKey: "eth",
    blockchain: "base",
    type: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 18,
    source: representationSource,
  },
  {
    key: "solana:native",
    assetKey: "sol",
    blockchain: "solana",
    type: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 9,
    source: representationSource,
  },
  {
    key: `solana:mint:${SOLANA_WRAPPED_NATIVE_MINT}`,
    assetKey: "sol",
    blockchain: "solana",
    type: "token",
    contractAddress: null,
    mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
    decimals: 9,
    source: representationSource,
  },
  {
    key: `solana:mint:${SOLANA_USDC_MINT}`,
    assetKey: "usdc",
    blockchain: "solana",
    type: "token",
    contractAddress: null,
    mintAddress: SOLANA_USDC_MINT,
    decimals: 6,
    source: representationSource,
  },
  {
    key: `solana:mint:${SOLANA_USDT_MINT}`,
    assetKey: "usdt",
    blockchain: "solana",
    type: "token",
    contractAddress: null,
    mintAddress: SOLANA_USDT_MINT,
    decimals: 6,
    source: representationSource,
  },
  {
    key: "ethereum:contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    assetKey: "usdc",
    blockchain: "ethereum",
    type: "token",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    mintAddress: null,
    decimals: 6,
    source: representationSource,
  },
  {
    key: "base:contract:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetKey: "usdc",
    blockchain: "base",
    type: "token",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    mintAddress: null,
    decimals: 6,
    source: representationSource,
  },
] as const satisfies ReadonlyArray<NetworkRepresentationReference>

const coinbaseAlias = ({
  alias,
  assetKey,
  sourceNotes = "Direct Coinbase currency mapping.",
}: {
  readonly alias: string
  readonly assetKey: AssetReferenceKey
  readonly sourceNotes?: string
}): ProviderAliasReference => ({
  provider: "coinbase",
  alias,
  naturalKey: `currency:${alias.toUpperCase()}`,
  assetKey,
  representationKey: null,
  displayName: alias,
  providerType: "crypto",
  sourceNotes,
  source: coinbaseSource,
})

const heliusAlias = ({
  alias,
  assetKey,
  representationKey,
  displayName,
  providerType,
  sourceNotes,
}: {
  readonly alias: string
  readonly assetKey: AssetReferenceKey
  readonly representationKey: string
  readonly displayName: string
  readonly providerType: "native" | "spl-token"
  readonly sourceNotes: string
}): ProviderAliasReference => ({
  provider: "helius-solana",
  alias,
  naturalKey: providerType === "native" ? HELIUS_SOLANA_NATIVE_NATURAL_KEY : `solana:mint:${alias}`,
  assetKey,
  representationKey,
  displayName,
  providerType,
  sourceNotes,
  source: heliusSource,
})

const providerAliases = [
  coinbaseAlias({ alias: "BTC", assetKey: "btc" }),
  coinbaseAlias({ alias: "ETH", assetKey: "eth" }),
  coinbaseAlias({
    alias: "ETH2",
    assetKey: "eth",
    sourceNotes: "Coinbase-specific alias for staked / deprecated ETH balances.",
  }),
  coinbaseAlias({ alias: "ADA", assetKey: "ada" }),
  coinbaseAlias({ alias: "DOT", assetKey: "dot" }),
  coinbaseAlias({ alias: "SOL", assetKey: "sol" }),
  coinbaseAlias({ alias: "USDC", assetKey: "usdc" }),
  coinbaseAlias({ alias: "ZEC", assetKey: "zec" }),
  coinbaseAlias({ alias: "EURC", assetKey: "eurc" }),
  coinbaseAlias({ alias: "TAO", assetKey: "tao" }),
  heliusAlias({
    alias: "SOL",
    assetKey: "sol",
    representationKey: "solana:native",
    displayName: "Solana",
    providerType: "native",
    sourceNotes: "TaxMaxi built-in Solana native SOL mapping.",
  }),
  heliusAlias({
    alias: SOLANA_WRAPPED_NATIVE_MINT,
    assetKey: "sol",
    representationKey: `solana:mint:${SOLANA_WRAPPED_NATIVE_MINT}`,
    displayName: "Wrapped SOL",
    providerType: "spl-token",
    sourceNotes: "TaxMaxi built-in wrapped SOL mint mapping.",
  }),
  heliusAlias({
    alias: SOLANA_USDC_MINT,
    assetKey: "usdc",
    representationKey: `solana:mint:${SOLANA_USDC_MINT}`,
    displayName: "USD Coin",
    providerType: "spl-token",
    sourceNotes: "TaxMaxi built-in Solana USDC mint mapping.",
  }),
  heliusAlias({
    alias: SOLANA_USDT_MINT,
    assetKey: "usdt",
    representationKey: `solana:mint:${SOLANA_USDT_MINT}`,
    displayName: "Tether USD",
    providerType: "spl-token",
    sourceNotes: "TaxMaxi built-in Solana USDT mint mapping.",
  }),
] as const satisfies ReadonlyArray<ProviderAliasReference>

export const assetReferenceCatalog = {
  revision: "2026-08-18.1",
  assets,
  representations,
  providerAliases,
} as const satisfies AssetReferenceCatalog

const exactRepresentationKey = (representation: NetworkRepresentationReference): string => {
  if (representation.type === "native") {
    return `${representation.blockchain}:native`
  }

  return representation.contractAddress === null
    ? `${representation.blockchain}:mint:${representation.mintAddress ?? "missing"}`
    : `${representation.blockchain}:contract:${representation.contractAddress.toLowerCase()}`
}

const validateCatalog = (
  catalog: AssetReferenceCatalog
): ReadonlyArray<AssetReferenceCatalogViolation> => {
  const violations: Array<AssetReferenceCatalogViolation> = []
  const assetKeys = new Set<AssetReferenceKey>()
  const representationsByKey = new Map<string, NetworkRepresentationReference>()
  const exactRepresentations = new Map<string, NetworkRepresentationReference>()
  const providerAliasKeys = new Set<string>()

  for (const asset of catalog.assets) {
    if (assetKeys.has(asset.key)) {
      violations.push({ code: "duplicate_asset_key", reference: asset.key })
    } else {
      assetKeys.add(asset.key)
    }
  }

  for (const representation of catalog.representations) {
    if (representationsByKey.has(representation.key)) {
      violations.push({
        code: "duplicate_representation_key",
        reference: representation.key,
      })
    } else {
      representationsByKey.set(representation.key, representation)
    }

    if (!assetKeys.has(representation.assetKey)) {
      violations.push({
        code: "missing_referenced_asset",
        reference: `representation:${representation.key}:${representation.assetKey}`,
      })
    }

    const exactKey = exactRepresentationKey(representation)
    const existing = exactRepresentations.get(exactKey)
    if (existing !== undefined) {
      violations.push({
        code:
          existing.assetKey === representation.assetKey
            ? "duplicate_exact_representation"
            : "conflicting_representation_ownership",
        reference: exactKey,
      })
    } else {
      exactRepresentations.set(exactKey, representation)
    }
  }

  for (const alias of catalog.providerAliases) {
    if (!assetKeys.has(alias.assetKey)) {
      violations.push({
        code: "missing_referenced_asset",
        reference: `provider-alias:${alias.provider}:${alias.alias}:${alias.assetKey}`,
      })
    }

    const aliasKey = `${alias.provider}:${alias.alias}`
    if (providerAliasKeys.has(aliasKey)) {
      violations.push({ code: "duplicate_provider_alias", reference: aliasKey })
    } else {
      providerAliasKeys.add(aliasKey)
    }

    if (alias.provider === "helius-solana" && alias.representationKey === null) {
      violations.push({
        code: "missing_referenced_representation",
        reference: aliasKey,
      })
    } else if (alias.representationKey !== null) {
      const representation = representationsByKey.get(alias.representationKey)
      if (representation === undefined) {
        violations.push({
          code: "missing_referenced_representation",
          reference: `${aliasKey}:${alias.representationKey}`,
        })
      } else if (representation.assetKey !== alias.assetKey) {
        violations.push({
          code: "representation_asset_mismatch",
          reference: `${aliasKey}:${alias.representationKey}`,
        })
      }
    }
  }

  return violations
}

/**
 * Validate a catalog and derive stable runtime projections in catalog order.
 */
export const deriveAssetReferenceCatalogProjections = (
  catalog: AssetReferenceCatalog
): Effect.Effect<AssetReferenceCatalogProjections, AssetReferenceCatalogValidationError> => {
  const violations = validateCatalog(catalog)
  if (violations.length > 0) {
    return Effect.fail(new AssetReferenceCatalogValidationError({ violations }))
  }

  const assetsByKey = new Map(catalog.assets.map((asset) => [asset.key, asset] as const))
  const representationsByKey = new Map(
    catalog.representations.map((representation) => [representation.key, representation] as const)
  )
  const coinbaseAliases = catalog.providerAliases.flatMap((alias) => {
    if (alias.provider !== "coinbase") {
      return []
    }

    const asset = assetsByKey.get(alias.assetKey)
    return asset === undefined
      ? []
      : [
          {
            currencyCode: alias.alias,
            assetKey: alias.assetKey,
            canonicalAssetCoinGeckoId: asset.coingeckoCoinId,
            sourceNotes: alias.sourceNotes,
          },
        ]
  })
  const heliusSolanaAliases = catalog.providerAliases.flatMap((alias) => {
    if (alias.provider !== "helius-solana" || alias.representationKey === null) {
      return []
    }

    const asset = assetsByKey.get(alias.assetKey)
    const representation = representationsByKey.get(alias.representationKey)
    return asset === undefined || representation === undefined
      ? []
      : [
          {
            mintAddress: alias.providerType === "native" ? null : alias.alias,
            naturalKey: alias.naturalKey,
            currencyCode: asset.symbol,
            name: alias.displayName,
            decimals: representation.decimals,
            providerType: alias.providerType === "crypto" ? "spl-token" : alias.providerType,
            assetKey: alias.assetKey,
            representationKey: alias.representationKey,
            sourceNotes: alias.sourceNotes,
          },
        ]
  })

  return Effect.succeed({
    revision: catalog.revision,
    economicAssets: catalog.assets,
    networkRepresentations: catalog.representations,
    providerAliases: catalog.providerAliases,
    coinbaseAliases,
    heliusSolanaAliases,
  })
}

/**
 * Validated built-in projections for persistence and provider adapters.
 */
export const assetReferenceCatalogProjections = Effect.runSync(
  deriveAssetReferenceCatalogProjections(assetReferenceCatalog)
)
