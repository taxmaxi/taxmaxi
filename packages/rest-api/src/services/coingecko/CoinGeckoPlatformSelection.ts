/**
 * CoinGeckoPlatformSelection - Pure helpers for CoinGecko platform evidence.
 *
 * @module services/coingecko/CoinGeckoPlatformSelection
 */

import * as Schema from "effect/Schema"

const CoinGeckoAssetPlatform = Schema.Struct({
  id: Schema.String,
  chain_identifier: Schema.NullOr(Schema.Number),
  name: Schema.String,
  shortname: Schema.NullOr(Schema.String),
  native_coin_id: Schema.NullOr(Schema.String),
})

/** CoinGecko metadata needed to identify a blockchain platform. */
export type CoinGeckoAssetPlatform = typeof CoinGeckoAssetPlatform.Type

export type CoinGeckoChainType = "bitcoin" | "cardano" | "evm" | "other" | "solana"

/** Symbols for CoinGecko coins that represent native chain assets. */
export const nativeAssetSymbolsByCoinGeckoId: Readonly<Record<string, string>> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  cardano: "ADA",
  binancecoin: "BNB",
  "avalanche-2": "AVAX",
}

const nativeAssetDecimalsByCoinGeckoId: Readonly<Record<string, number>> = {
  bitcoin: 8,
  ethereum: 18,
  weth: 18,
  solana: 9,
  cardano: 6,
  binancecoin: 18,
  wbnb: 18,
  "avalanche-2": 18,
  "matic-network": 18,
}

/** Derive the canonical chain family from CoinGecko platform metadata. */
export const deriveChainType = (platform: CoinGeckoAssetPlatform): CoinGeckoChainType => {
  if (platform.chain_identifier !== null) return "evm"

  const haystack = `${platform.id} ${platform.name}`.toLowerCase()
  if (haystack.includes("solana")) return "solana"
  if (haystack.includes("bitcoin")) return "bitcoin"
  if (haystack.includes("cardano")) return "cardano"
  return "other"
}

/** Return canonical native decimals when CoinGecko identifies the chain unambiguously. */
export const deriveNativeAssetDecimals = ({
  coinId,
  platform,
}: {
  readonly coinId: string
  readonly platform: CoinGeckoAssetPlatform
}): number | null => {
  const coinDecimals = nativeAssetDecimalsByCoinGeckoId[coinId]
  if (coinDecimals !== undefined) return coinDecimals

  if (platform.native_coin_id !== null) {
    const platformDecimals = nativeAssetDecimalsByCoinGeckoId[platform.native_coin_id]
    if (platformDecimals !== undefined) return platformDecimals
  }

  switch (deriveChainType(platform)) {
    case "bitcoin":
      return 8
    case "cardano":
      return 6
    case "evm":
      return 18
    case "solana":
      return 9
    case "other":
      return null
  }
}

const nativeAssetPlatformOverridesByCoinGeckoId: Readonly<Record<string, CoinGeckoAssetPlatform>> =
  {
    bitcoin: {
      id: "bitcoin",
      chain_identifier: null,
      name: "Bitcoin",
      shortname: "BTC",
      native_coin_id: "bitcoin",
    },
  }

/** Select unambiguous native-platform evidence for a CoinGecko coin. */
export const selectNativePlatform = ({
  coinId,
  assetPlatforms,
}: {
  readonly coinId: string
  readonly assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform>
}): CoinGeckoAssetPlatform | null => {
  const nativePlatforms = assetPlatforms.filter((platform) => platform.native_coin_id === coinId)
  const exactPlatform = nativePlatforms.find((platform) => platform.id === coinId)
  if (exactPlatform !== undefined) {
    return exactPlatform
  }

  const overridePlatform = nativeAssetPlatformOverridesByCoinGeckoId[coinId]
  if (overridePlatform !== undefined) {
    return overridePlatform
  }

  if (nativeAssetSymbolsByCoinGeckoId[coinId] === undefined) {
    return null
  }

  const chainlessPlatforms = nativePlatforms.filter(
    (platform) => platform.chain_identifier === null
  )
  const chainlessPlatform = chainlessPlatforms[0]
  if (chainlessPlatforms.length === 1 && chainlessPlatform !== undefined) {
    return chainlessPlatform
  }

  const nativePlatform = nativePlatforms[0]
  return nativePlatforms.length === 1 && nativePlatform !== undefined ? nativePlatform : null
}
