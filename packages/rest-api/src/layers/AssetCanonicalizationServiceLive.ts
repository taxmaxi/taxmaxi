/**
 * AssetCanonicalizationServiceLive - CoinGecko-backed asset canonicalization.
 *
 * @module AssetCanonicalizationServiceLive
 */

import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import {
  AssetRepository,
  ProviderAssetRepository,
  type CanonicalAssetDraft,
  type CanonicalBlockchainDraft,
  type ProviderAssetReviewRecord,
  type SyncEngineChainType,
} from "@my/sync-engine/services"
import * as Config from "effect/Config"
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
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

const COINGECKO_SOURCE_NOTES = "Approved with CoinGecko asset/platform metadata."

const CoinGeckoSearchCoin = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.String,
})

const CoinGeckoSearchResponse = Schema.Struct({
  coins: Schema.Array(CoinGeckoSearchCoin),
})

const CoinGeckoDetailPlatform = Schema.Struct({
  decimal_place: Schema.NullOr(Schema.Number),
  contract_address: Schema.String,
})

const CoinGeckoCoin = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  asset_platform_id: Schema.NullOr(Schema.String),
  platforms: Schema.Record({ key: Schema.String, value: Schema.String }),
  detail_platforms: Schema.Record({ key: Schema.String, value: CoinGeckoDetailPlatform }),
})

const CoinGeckoAssetPlatform = Schema.Struct({
  id: Schema.String,
  chain_identifier: Schema.NullOr(Schema.Number),
  name: Schema.String,
  shortname: Schema.NullOr(Schema.String),
  native_coin_id: Schema.NullOr(Schema.String),
})

type CoinGeckoSearchCoin = typeof CoinGeckoSearchCoin.Type
type CoinGeckoCoin = typeof CoinGeckoCoin.Type
type CoinGeckoAssetPlatform = typeof CoinGeckoAssetPlatform.Type

const normalize = (value: string) => value.trim().toLowerCase()

const upperSymbol = (value: string) => value.trim().toUpperCase()

const isNonEmptyString = (value: string) => value.trim() !== ""

const deriveChainType = (platform: CoinGeckoAssetPlatform): SyncEngineChainType => {
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
  return platform.chain_identifier === null ? "other" : "evm"
}

const decodeJson =
  <A, I>(schema: Schema.Schema<A, I, never>, endpoint: string) =>
  (payload: unknown) =>
    Schema.decodeUnknown(schema)(payload).pipe(
      Effect.mapError(
        (error) =>
          new AssetCanonicalizationProviderError({
            message: `Failed to decode CoinGecko response for ${endpoint}: ${error.message}`,
          })
      )
    )

const makeBadRequest = (message: string) => new AssetCanonicalizationBadRequestError({ message })

const makeProviderError = (message: string) => new AssetCanonicalizationProviderError({ message })

const selectNativePlatform = ({
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

const selectCoin = ({
  providerAsset,
  searchCoins,
}: {
  readonly providerAsset: ProviderAssetReviewRecord
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
  platform,
  providerAsset,
}: {
  readonly coin: CoinGeckoCoin
  readonly platform: CoinGeckoAssetPlatform
  readonly providerAsset: ProviderAssetReviewRecord
}): {
  readonly blockchain: CanonicalBlockchainDraft
  readonly asset: CanonicalAssetDraft
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
    contractAddress: null,
    name: coin.name,
    symbol: upperSymbol(coin.symbol),
    decimals: providerAsset.exponent ?? 0,
    logoUrl: null,
    type: "native",
    isSpam: false,
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
  readonly providerAsset: ProviderAssetReviewRecord
}): {
  readonly blockchain: CanonicalBlockchainDraft
  readonly asset: CanonicalAssetDraft
} => {
  const detail = coin.detail_platforms[platform.id]
  return {
    blockchain: {
      name: platform.id,
      chainType: deriveChainType(platform),
      chainId: platform.chain_identifier,
      nativeAssetSymbol: platform.shortname ?? platform.name,
      explorerUrl: null,
      logoUrl: null,
      coingeckoPlatformId: platform.id,
    },
    asset: {
      contractAddress,
      name: coin.name,
      symbol: upperSymbol(coin.symbol),
      decimals: detail?.decimal_place ?? providerAsset.exponent ?? 0,
      logoUrl: null,
      type: "token",
      isSpam: false,
    },
  }
}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetRepository = yield* AssetRepository
  const baseUrl = yield* Config.string("COINGECKO_API_BASE_URL").pipe(
    Config.withDefault("https://api.coingecko.com/api/v3")
  )
  const apiKey = yield* Config.option(Config.string("COINGECKO_API_KEY"))

  const executeGetJson = (endpoint: string) =>
    Effect.gen(function* () {
      const requestUrl = `${baseUrl}${endpoint}`
      const baseRequest = HttpClientRequest.get(requestUrl)
      const request = Option.isSome(apiKey)
        ? baseRequest.pipe(HttpClientRequest.setHeader("x-cg-demo-api-key", apiKey.value))
        : baseRequest
      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.mapError((error) =>
            makeProviderError(`CoinGecko request failed for ${endpoint}: ${error.message}`)
          )
        )

      if (response.status < 200 || response.status >= 300) {
        const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(
          makeProviderError(
            `CoinGecko request failed (${response.status}) ${endpoint}: ${bodyText}`
          )
        )
      }

      return yield* response.json.pipe(
        Effect.mapError((error) =>
          makeProviderError(`Failed to parse CoinGecko JSON for ${endpoint}: ${String(error)}`)
        )
      )
    })

  const fetchSearch = (query: string) =>
    Effect.gen(function* () {
      const endpoint = `/search?query=${encodeURIComponent(query)}`
      const json = yield* executeGetJson(endpoint)
      return yield* decodeJson(CoinGeckoSearchResponse, endpoint)(json)
    })

  const fetchCoin = (coinId: string) =>
    Effect.gen(function* () {
      const endpoint = `/coins/${encodeURIComponent(coinId)}`
      const json = yield* executeGetJson(endpoint)
      return yield* decodeJson(CoinGeckoCoin, endpoint)(json)
    })

  const resolveCoinGeckoDrafts = ({
    providerAsset,
  }: {
    readonly providerAsset: ProviderAssetReviewRecord
  }) =>
    Effect.gen(function* () {
      const search = yield* fetchSearch(providerAsset.currencyCode)
      const selectedCoin = yield* selectCoin({
        providerAsset,
        searchCoins: search.coins,
      })
      const coin = yield* fetchCoin(selectedCoin.id)
      const assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform> = coinGeckoAssetPlatformSnapshot
      const nativePlatforms = assetPlatforms.filter(
        (platform) => platform.native_coin_id === coin.id
      )
      const nativePlatform = selectNativePlatform({ coinId: coin.id, assetPlatforms })

      if (nativePlatform !== null) {
        return {
          ...buildNativeCanonicalDrafts({
            coin,
            platform: nativePlatform,
            providerAsset,
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
        const providerAsset = yield* providerAssetRepository
          .findProviderAssetReviewById({ providerAssetRowId })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to load provider asset review row.",
                })
            )
          )

        if (Option.isNone(providerAsset)) {
          return yield* Effect.fail(
            new AssetCanonicalizationNotFoundError({ message: "Provider asset not found." })
          )
        }

        if (providerAsset.value.mappingStatus !== "pending_review") {
          return yield* Effect.fail(makeBadRequest("Provider asset mapping is not pending review."))
        }

        if (providerAsset.value.providerType?.trim().toLowerCase() === "fiat") {
          return yield* Effect.fail(makeBadRequest("Fiat provider assets cannot become assets."))
        }

        const resolved = yield* resolveCoinGeckoDrafts({ providerAsset: providerAsset.value })
        const canonicalAsset = yield* assetRepository
          .upsertCanonicalAsset({
            blockchain: resolved.blockchain,
            asset: resolved.asset,
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
                canonicalAssetSymbol: canonicalAsset.symbol,
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

        return {
          providerAsset: providerAsset.value,
          canonicalAsset,
          evidence: resolved.evidence,
        }
      })

  return AssetCanonicalizationService.of({
    canonicalizeProviderAssetFromCoinGecko,
  } satisfies AssetCanonicalizationServiceShape)
})

export const AssetCanonicalizationServiceLive = Layer.effect(
  AssetCanonicalizationService,
  make
).pipe(Layer.provide(FetchHttpClient.layer))
