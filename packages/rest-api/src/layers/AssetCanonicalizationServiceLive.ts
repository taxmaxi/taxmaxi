/**
 * AssetCanonicalizationServiceLive - CoinGecko-backed asset canonicalization.
 *
 * @module AssetCanonicalizationServiceLive
 */

import {
  AssetRepository,
  ProviderAssetRepository,
  type CanonicalAssetDraft,
  type CanonicalAssetRepresentationDraft,
  type CanonicalBlockchainDraft,
  type ProviderAssetRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  AssetCanonicalizationBadRequestError,
  AssetCanonicalizationInternalError,
  AssetCanonicalizationNotFoundError,
  AssetCanonicalizationProviderError,
  AssetCanonicalizationService,
  type AssetCanonicalizationServiceShape,
} from "../services/AssetCanonicalizationService.ts"
import {
  CoinGeckoClient,
  type CoinGeckoCoin,
  type CoinGeckoSearchCoin,
} from "../services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

const COINGECKO_SOURCE_NOTES = "Approved with CoinGecko asset/platform metadata."

const CoinGeckoAssetPlatform = Schema.Struct({
  id: Schema.String,
  chain_identifier: Schema.NullOr(Schema.Number),
  name: Schema.String,
  shortname: Schema.NullOr(Schema.String),
  native_coin_id: Schema.NullOr(Schema.String),
})

export type CoinGeckoAssetPlatform = typeof CoinGeckoAssetPlatform.Type
type CoinGeckoChainType = "bitcoin" | "cardano" | "evm" | "other" | "solana"

const normalize = (value: string) => value.trim().toLowerCase()

const upperSymbol = (value: string) => value.trim().toUpperCase()

const isNonEmptyString = (value: string) => value.trim() !== ""

const nativeAssetSymbolsByCoinGeckoId: Readonly<Record<string, string>> = {
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

const deriveNativeAssetSymbol = (platform: CoinGeckoAssetPlatform) => {
  if (platform.native_coin_id !== null) {
    const symbol = nativeAssetSymbolsByCoinGeckoId[platform.native_coin_id]
    if (symbol !== undefined) {
      return symbol
    }
  }

  const fallback = platform.shortname ?? platform.name
  return upperSymbol(fallback)
}

export const deriveChainType = (platform: CoinGeckoAssetPlatform): CoinGeckoChainType => {
  if (platform.chain_identifier !== null) {
    return "evm"
  }

  const haystack = `${platform.id} ${platform.name}`.toLowerCase()
  if (haystack.includes("solana")) {
    return "solana"
  }
  if (haystack.includes("bitcoin")) {
    return "bitcoin"
  }
  if (haystack.includes("cardano")) {
    return "cardano"
  }
  return "other"
}

export const deriveNativeAssetDecimals = ({
  coinId,
  platform,
}: {
  readonly coinId: string
  readonly platform: CoinGeckoAssetPlatform
}): number | null => {
  const coinDecimals = nativeAssetDecimalsByCoinGeckoId[coinId]
  if (coinDecimals !== undefined) {
    return coinDecimals
  }

  if (platform.native_coin_id !== null) {
    const platformNativeCoinDecimals = nativeAssetDecimalsByCoinGeckoId[platform.native_coin_id]
    if (platformNativeCoinDecimals !== undefined) {
      return platformNativeCoinDecimals
    }
  }

  const chainType = deriveChainType(platform)
  switch (chainType) {
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

const makeBadRequest = (message: string) => new AssetCanonicalizationBadRequestError({ message })

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
  if (nativePlatforms.length === 1 && nativePlatform !== undefined) {
    return nativePlatform
  }

  return null
}

const trimOrNull = (value: string | null): string | null => {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const observedTokenIdFromNaturalKey = (naturalKey: string | null): string | null => {
  const trimmed = trimOrNull(naturalKey)
  if (trimmed === null) {
    return null
  }

  const solanaMintPrefix = "solana:mint:"
  return trimmed.startsWith(solanaMintPrefix) ? trimmed.slice(solanaMintPrefix.length) : null
}

const observedProviderTokenId = (providerAsset: ProviderAssetRecord): string | null => {
  const provider = normalize(providerAsset.provider)
  const providerType =
    providerAsset.providerType === null ? "" : normalize(providerAsset.providerType)
  const isObservedOnchainToken =
    provider.includes("solana") || providerType.startsWith("spl-token") || providerType === "nft"

  if (!isObservedOnchainToken) {
    return null
  }

  return (
    trimOrNull(providerAsset.providerAssetId) ??
    observedTokenIdFromNaturalKey(providerAsset.naturalKey)
  )
}

const validateProviderTokenIdentity = ({
  contractAddress,
  platform,
  providerAsset,
}: {
  readonly contractAddress: string
  readonly platform: CoinGeckoAssetPlatform
  readonly providerAsset: ProviderAssetRecord
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
  const observedTokenId = observedProviderTokenId(providerAsset)
  if (observedTokenId === null) {
    return Effect.void
  }

  const chainType = deriveChainType(platform)
  const expectedTokenId = chainType === "evm" ? observedTokenId.toLowerCase() : observedTokenId
  const selectedTokenId =
    chainType === "evm" ? contractAddress.trim().toLowerCase() : contractAddress.trim()

  return expectedTokenId === selectedTokenId
    ? Effect.void
    : Effect.fail(
        makeBadRequest(
          `CoinGecko token contract does not match observed provider asset id for ${providerAsset.currencyCode}.`
        )
      )
}

const selectCoin = ({
  providerAsset,
  searchCoins,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly searchCoins: ReadonlyArray<CoinGeckoSearchCoin>
}): Effect.Effect<CoinGeckoSearchCoin, AssetCanonicalizationBadRequestError> => {
  const symbol = normalize(providerAsset.currencyCode)
  const name = providerAsset.name === null ? null : normalize(providerAsset.name)
  const exactSymbolAndName = searchCoins.filter(
    (coin) => normalize(coin.symbol) === symbol && name !== null && normalize(coin.name) === name
  )
  const exactSymbolAndNameCoin = exactSymbolAndName[0]

  if (exactSymbolAndName.length === 1 && exactSymbolAndNameCoin !== undefined) {
    return Effect.succeed(exactSymbolAndNameCoin)
  }

  const exactSymbol = searchCoins.filter((coin) => normalize(coin.symbol) === symbol)
  const exactSymbolCoin = exactSymbol[0]
  if (exactSymbol.length === 1 && exactSymbolCoin !== undefined) {
    return Effect.succeed(exactSymbolCoin)
  }

  if (exactSymbol.length === 0) {
    return Effect.fail(
      makeBadRequest(`CoinGecko did not return a coin for symbol ${providerAsset.currencyCode}.`)
    )
  }

  return Effect.fail(
    makeBadRequest(
      `CoinGecko returned multiple candidates for ${providerAsset.currencyCode}; pass a reviewed canonical asset instead.`
    )
  )
}

const buildNativeCanonicalDrafts = ({
  coin,
  decimals,
  platform,
}: {
  readonly coin: CoinGeckoCoin
  readonly decimals: number
  readonly platform: CoinGeckoAssetPlatform
}): {
  readonly blockchain: CanonicalBlockchainDraft
  readonly asset: CanonicalAssetDraft
  readonly representation: CanonicalAssetRepresentationDraft
} => ({
  blockchain: {
    name: platform.id,
    chainType: deriveChainType(platform),
    chainId: platform.chain_identifier,
    nativeAssetSymbol: upperSymbol(coin.symbol),
    explorerUrl: null,
    logoUrl: null,
    coingeckoPlatformId: platform.id,
  },
  asset: {
    name: coin.name,
    symbol: upperSymbol(coin.symbol),
    coingeckoCoinId: coin.id,
    logoUrl: coin.image?.small ?? null,
    isSpam: false,
  },
  representation: {
    contractAddress: null,
    decimals,
    type: "native",
    metadata: null,
  },
})

const buildTokenCanonicalDrafts = ({
  coin,
  platform,
  contractAddress,
  providerAsset,
}: {
  readonly coin: CoinGeckoCoin
  readonly platform: CoinGeckoAssetPlatform
  readonly contractAddress: string
  readonly providerAsset: ProviderAssetRecord
}): {
  readonly blockchain: CanonicalBlockchainDraft
  readonly asset: CanonicalAssetDraft
  readonly representation: CanonicalAssetRepresentationDraft
} => {
  const detail = coin.detail_platforms[platform.id]
  return {
    blockchain: {
      name: platform.id,
      chainType: deriveChainType(platform),
      chainId: platform.chain_identifier,
      nativeAssetSymbol: deriveNativeAssetSymbol(platform),
      explorerUrl: null,
      logoUrl: null,
      coingeckoPlatformId: platform.id,
    },
    asset: {
      name: coin.name,
      symbol: upperSymbol(coin.symbol),
      coingeckoCoinId: coin.id,
      logoUrl: coin.image?.small ?? null,
      isSpam: false,
    },
    representation: {
      contractAddress,
      decimals: detail?.decimal_place ?? providerAsset.exponent ?? 0,
      type: "token",
      metadata: null,
    },
  }
}

const make = Effect.gen(function* () {
  const coinGeckoClient = yield* CoinGeckoClient
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetRepository = yield* AssetRepository

  const mapCoinGeckoError = (error: { readonly message: string }) =>
    new AssetCanonicalizationProviderError({ message: error.message })

  const resolveCoinGeckoDrafts = ({
    providerAsset,
  }: {
    readonly providerAsset: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const searchCoins = yield* coinGeckoClient
        .searchCoins({ query: providerAsset.currencyCode })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const selectedCoin = yield* selectCoin({
        providerAsset,
        searchCoins,
      })
      const coin = yield* coinGeckoClient
        .getCoin({ coinId: selectedCoin.id })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform> = coinGeckoAssetPlatformSnapshot
      const nativePlatforms = assetPlatforms.filter(
        (platform) => platform.native_coin_id === coin.id
      )
      const nativePlatform = selectNativePlatform({ coinId: coin.id, assetPlatforms })

      if (nativePlatform !== null) {
        const nativeDecimals = deriveNativeAssetDecimals({
          coinId: coin.id,
          platform: nativePlatform,
        })
        if (nativeDecimals === null) {
          return yield* Effect.fail(
            makeBadRequest(
              `CoinGecko did not identify native asset decimals for ${providerAsset.currencyCode}; manual review is required.`
            )
          )
        }

        return {
          ...buildNativeCanonicalDrafts({
            coin,
            decimals: nativeDecimals,
            platform: nativePlatform,
          }),
          evidence: {
            source: "coingecko" as const,
            coinId: coin.id,
            coinName: coin.name,
            coinSymbol: upperSymbol(coin.symbol),
            platformId: nativePlatform.id,
            platformName: nativePlatform.name,
            contractAddress: null,
          },
        }
      }

      if (nativePlatforms.length > 1) {
        return yield* Effect.fail(
          makeBadRequest(
            `CoinGecko has multiple native platforms for ${providerAsset.currencyCode}; manual review is required.`
          )
        )
      }

      const tokenPlatforms = Object.entries(coin.platforms).filter(([, contractAddress]) =>
        isNonEmptyString(contractAddress)
      )

      if (tokenPlatforms.length !== 1) {
        return yield* Effect.fail(
          makeBadRequest(
            `CoinGecko did not identify a single canonical platform for ${providerAsset.currencyCode}.`
          )
        )
      }

      const tokenPlatformEntry = tokenPlatforms[0]
      if (tokenPlatformEntry === undefined) {
        return yield* Effect.fail(
          makeBadRequest(
            `CoinGecko did not identify a canonical platform for ${providerAsset.currencyCode}.`
          )
        )
      }

      const [platformId, contractAddress] = tokenPlatformEntry
      const tokenPlatform = assetPlatforms.find((platform) => platform.id === platformId)
      if (tokenPlatform === undefined) {
        return yield* Effect.fail(
          makeBadRequest(`CoinGecko platform ${platformId} is not available in asset_platforms.`)
        )
      }
      yield* validateProviderTokenIdentity({
        contractAddress,
        platform: tokenPlatform,
        providerAsset,
      })

      return {
        ...buildTokenCanonicalDrafts({
          coin,
          platform: tokenPlatform,
          contractAddress,
          providerAsset,
        }),
        evidence: {
          source: "coingecko" as const,
          coinId: coin.id,
          coinName: coin.name,
          coinSymbol: upperSymbol(coin.symbol),
          platformId: tokenPlatform.id,
          platformName: tokenPlatform.name,
          contractAddress,
        },
      }
    })

  const canonicalizeProviderAssetFromCoinGecko: AssetCanonicalizationServiceShape["canonicalizeProviderAssetFromCoinGecko"] =
    ({ providerAssetRowId, reviewerNotes }) =>
      Effect.gen(function* () {
        const providerAssetReview = yield* providerAssetRepository
          .findProviderAssetReviewById({ providerAssetRowId })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to load provider asset review row.",
                })
            )
          )

        if (Option.isNone(providerAssetReview)) {
          return yield* Effect.fail(
            new AssetCanonicalizationNotFoundError({ message: "Provider asset not found." })
          )
        }

        if (providerAssetReview.value.mapping?.mappingStatus !== "pending_review") {
          return yield* Effect.fail(makeBadRequest("Provider asset mapping is not pending review."))
        }

        if (providerAssetReview.value.providerAsset.providerType?.trim().toLowerCase() === "fiat") {
          return yield* Effect.fail(makeBadRequest("Fiat provider assets cannot become assets."))
        }

        const resolved = yield* resolveCoinGeckoDrafts({
          providerAsset: providerAssetReview.value.providerAsset,
        })
        const canonicalAsset = yield* assetRepository
          .upsertCanonicalAsset({
            blockchain: resolved.blockchain,
            asset: resolved.asset,
            representation: resolved.representation,
          })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to persist canonical asset.",
                })
            )
          )

        yield* providerAssetRepository
          .upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: canonicalAsset.id,
                canonicalAssetRepresentationId: canonicalAsset.representationId,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes,
                sourceNotes: COINGECKO_SOURCE_NOTES,
              },
            ],
          })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to approve provider asset mapping.",
                })
            )
          )

        const approvedProviderAsset = yield* providerAssetRepository
          .findProviderAssetReviewById({ providerAssetRowId })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to load approved provider asset mapping.",
                })
            )
          )

        if (Option.isNone(approvedProviderAsset)) {
          return yield* Effect.fail(
            new AssetCanonicalizationInternalError({
              message: "Approved provider asset mapping was not available after update.",
            })
          )
        }

        return {
          providerAsset: approvedProviderAsset.value,
          canonicalAsset,
          evidence: resolved.evidence,
        }
      })

  return AssetCanonicalizationService.of({
    canonicalizeProviderAssetFromCoinGecko,
  } satisfies AssetCanonicalizationServiceShape)
})

export const AssetCanonicalizationServiceLive = Layer.effect(AssetCanonicalizationService, make)
