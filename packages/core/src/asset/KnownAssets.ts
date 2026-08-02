/** Stable identities for economic assets shipped in TaxMaxi reference data. */
export const KNOWN_ASSET_IDS = {
  BTC: "00000000-0000-4000-8000-000000000001",
  ETH: "00000000-0000-4000-8000-000000000002",
  SOL: "00000000-0000-4000-8000-000000000003",
  USDC: "00000000-0000-4000-8000-000000000004",
  USDT: "00000000-0000-4000-8000-000000000005",
  ADA: "00000000-0000-4000-8000-000000000006",
  DOT: "00000000-0000-4000-8000-000000000007",
  ZEC: "00000000-0000-4000-8000-000000000008",
  EURC: "00000000-0000-4000-8000-000000000009",
  TAO: "00000000-0000-4000-8000-000000000010",
} as const

/** Stable identities for exact network representations shipped in TaxMaxi reference data. */
export const KNOWN_ASSET_REPRESENTATION_IDS = {
  BTC_BITCOIN: "10000000-0000-4000-8000-000000000001",
  ETH_ETHEREUM: "10000000-0000-4000-8000-000000000002",
  ETH_BASE: "10000000-0000-4000-8000-000000000003",
  SOL_SOLANA: "10000000-0000-4000-8000-000000000004",
  USDC_SOLANA: "10000000-0000-4000-8000-000000000005",
  USDT_SOLANA: "10000000-0000-4000-8000-000000000006",
  USDC_ETHEREUM: "10000000-0000-4000-8000-000000000007",
  USDC_BASE: "10000000-0000-4000-8000-000000000008",
} as const

export type KnownAssetSymbol = keyof typeof KNOWN_ASSET_IDS

export interface KnownEconomicAsset {
  readonly id: (typeof KNOWN_ASSET_IDS)[KnownAssetSymbol]
  readonly name: string
  readonly symbol: KnownAssetSymbol
  readonly coingeckoCoinId: string
  readonly type: "fungible"
}

/** Exact economic asset reference data used by seeds and provider mappings. */
export const KNOWN_ECONOMIC_ASSETS: ReadonlyArray<KnownEconomicAsset> = [
  {
    id: KNOWN_ASSET_IDS.BTC,
    name: "Bitcoin",
    symbol: "BTC",
    coingeckoCoinId: "bitcoin",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.ETH,
    name: "Ether",
    symbol: "ETH",
    coingeckoCoinId: "ethereum",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.SOL,
    name: "Solana",
    symbol: "SOL",
    coingeckoCoinId: "solana",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.USDC,
    name: "USD Coin",
    symbol: "USDC",
    coingeckoCoinId: "usd-coin",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.USDT,
    name: "Tether",
    symbol: "USDT",
    coingeckoCoinId: "tether",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.ADA,
    name: "Cardano",
    symbol: "ADA",
    coingeckoCoinId: "cardano",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.DOT,
    name: "Polkadot",
    symbol: "DOT",
    coingeckoCoinId: "polkadot",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.ZEC,
    name: "Zcash",
    symbol: "ZEC",
    coingeckoCoinId: "zcash",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.EURC,
    name: "EURC",
    symbol: "EURC",
    coingeckoCoinId: "euro-coin",
    type: "fungible",
  },
  {
    id: KNOWN_ASSET_IDS.TAO,
    name: "Bittensor",
    symbol: "TAO",
    coingeckoCoinId: "bittensor",
    type: "fungible",
  },
]
