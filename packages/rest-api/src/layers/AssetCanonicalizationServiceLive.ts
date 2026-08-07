/**
 * AssetCanonicalizationServiceLive - CoinGecko-backed asset canonicalization.
 *
 * @module AssetCanonicalizationServiceLive
 */

import {
  AssetRepository,
  ProviderAssetRepository,
  SourceSyncService,
  type AssetRepresentationDraft,
  type CanonicalBlockchainDraft,
  type EconomicAssetDraft,
  type ProviderAssetRecord,
  type ProviderAssetReviewRecord,
  type SyncEngineAssetRepresentation,
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
const MANUAL_SOURCE_NOTES = "Approved by an admin with an existing canonical asset."

const appendSourceNote = ({
  existing,
  note,
}: {
  readonly existing: string | null | undefined
  readonly note: string
}) => {
  if (existing === null || existing === undefined || existing.trim() === "") {
    return note
  }

  return existing.includes(note) ? existing : `${existing}\n${note}`
}

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

const isNativeOnchainObservation = (providerAsset: ProviderAssetRecord): boolean => {
  const provider = normalize(providerAsset.provider)
  const providerType =
    providerAsset.providerType === null ? "" : normalize(providerAsset.providerType)
  const naturalKey = trimOrNull(providerAsset.naturalKey)

  return (
    provider.includes("solana") &&
    (providerType === "native" || naturalKey?.startsWith("solana:native:") === true)
  )
}

export const representationIdForProviderObservation = ({
  providerAsset,
  representationId,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly representationId: string
}): string | null =>
  isNativeOnchainObservation(providerAsset) || observedProviderTokenId(providerAsset) !== null
    ? representationId
    : null

export const validateManualRepresentationIdentity = ({
  providerAsset,
  representation,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly representation: SyncEngineAssetRepresentation
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
  if (isNativeOnchainObservation(providerAsset)) {
    return normalize(representation.blockchainName) === "solana" &&
      representation.representationType === "native"
      ? Effect.void
      : Effect.fail(
          makeBadRequest("Selected representation does not match the observed Solana native asset.")
        )
  }

  const observedTokenId = observedProviderTokenId(providerAsset)
  if (observedTokenId === null) {
    return Effect.void
  }

  const providerType =
    providerAsset.providerType === null ? "" : normalize(providerAsset.providerType)
  const expectedType = providerType === "nft" ? "nft" : "token"
  return normalize(representation.blockchainName) === "solana" &&
    representation.representationType === expectedType &&
    representation.mintAddress === observedTokenId &&
    (providerAsset.exponent === null || representation.decimals === providerAsset.exponent)
    ? Effect.void
    : Effect.fail(
        makeBadRequest("Selected representation does not match the observed Solana mint.")
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

export const validateNativeProviderIdentity = (
  providerAsset: ProviderAssetRecord
): Effect.Effect<void, AssetCanonicalizationBadRequestError> =>
  observedProviderTokenId(providerAsset) === null
    ? Effect.void
    : Effect.fail(
        makeBadRequest(
          `CoinGecko native asset does not match observed provider token id for ${providerAsset.currencyCode}.`
        )
      )

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
  readonly asset: EconomicAssetDraft
  readonly representation: AssetRepresentationDraft
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
    type: "fungible",
  },
  representation: {
    contractAddress: null,
    mintAddress: null,
    decimals,
    logoUrl: coin.image?.small ?? null,
    type: "native",
    isSpam: false,
    metadata: { source: "coingecko", coinId: coin.id, platformId: platform.id },
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
  readonly asset: EconomicAssetDraft
  readonly representation: AssetRepresentationDraft
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
      type: providerAsset.providerType === "nft" ? "nft" : "fungible",
    },
    representation: {
      contractAddress: deriveChainType(platform) === "solana" ? null : contractAddress,
      mintAddress: deriveChainType(platform) === "solana" ? contractAddress : null,
      decimals: detail?.decimal_place ?? providerAsset.exponent ?? 0,
      logoUrl: coin.image?.small ?? null,
      type: providerAsset.providerType === "nft" ? "nft" : "token",
      isSpam: false,
      metadata: { source: "coingecko", coinId: coin.id, platformId: platform.id },
    },
  }
}

const make = Effect.gen(function* () {
  const coinGeckoClient = yield* CoinGeckoClient
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetRepository = yield* AssetRepository
  const sourceSyncService = yield* SourceSyncService

  const mapCoinGeckoError = (error: { readonly message: string }) =>
    new AssetCanonicalizationProviderError({ message: error.message })

  const loadProviderAssetReview = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    providerAssetRepository.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () =>
          new AssetCanonicalizationInternalError({
            message: "Failed to load provider asset review row.",
          })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AssetCanonicalizationNotFoundError({ message: "Provider asset not found." })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const validateApprovableProviderAsset = (
    providerAssetReview: ProviderAssetReviewRecord
  ): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
    const mappingStatus = providerAssetReview.mapping?.mappingStatus
    if (mappingStatus !== "pending_review" && mappingStatus !== "approved") {
      return Effect.fail(
        makeBadRequest("Provider asset mapping cannot be approved from its current state.")
      )
    }

    return providerAssetReview.providerAsset.providerType?.trim().toLowerCase() === "fiat"
      ? Effect.fail(makeBadRequest("Fiat provider assets cannot become assets."))
      : Effect.void
  }

  const loadApprovedProviderAssetAndReplay = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    Effect.gen(function* () {
      const affectedSources = yield* providerAssetRepository
        .listProviderAssetSources({ providerAssetRowId })
        .pipe(
          Effect.mapError(
            () =>
              new AssetCanonicalizationInternalError({
                message: "Failed to load sources affected by provider asset approval.",
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

      yield* Effect.forEach(affectedSources, ({ principalId, sourceId }) =>
        sourceSyncService.replaySourceSyncJob({ principalId, sourceId }).pipe(
          Effect.tap(({ jobId, status }) =>
            Effect.logInfo(
              { principalId, sourceId, providerAssetRowId, jobId, status },
              "Queued source replay after provider asset approval"
            )
          ),
          Effect.tapError((error) =>
            Effect.logError(
              { principalId, sourceId, providerAssetRowId, error },
              "Failed to queue source replay after provider asset approval"
            )
          ),
          Effect.mapError(
            () =>
              new AssetCanonicalizationInternalError({
                message: `Failed to queue source replay for source ${sourceId}.`,
              })
          )
        )
      )

      return approvedProviderAsset.value
    })

  const approveProviderAssetMapping: AssetCanonicalizationServiceShape["approveProviderAssetMapping"] =
    ({ providerAssetRowId, canonicalAssetId, assetRepresentationId, reviewerNotes }) =>
      Effect.gen(function* () {
        const providerAssetReview = yield* loadProviderAssetReview({ providerAssetRowId })
        yield* validateApprovableProviderAsset(providerAssetReview)

        const canonicalAsset = yield* assetRepository
          .findAssetById({ assetId: canonicalAssetId })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to load the selected canonical asset.",
                })
            )
          )
        if (Option.isNone(canonicalAsset)) {
          return yield* Effect.fail(
            new AssetCanonicalizationNotFoundError({ message: "Canonical asset not found." })
          )
        }

        if (assetRepresentationId !== null) {
          const representation = yield* assetRepository
            .findRepresentationById({ assetRepresentationId })
            .pipe(
              Effect.mapError(
                () =>
                  new AssetCanonicalizationInternalError({
                    message: "Failed to load the selected asset representation.",
                  })
              )
            )
          if (Option.isNone(representation)) {
            return yield* Effect.fail(
              new AssetCanonicalizationNotFoundError({ message: "Asset representation not found." })
            )
          }
          if (representation.value.assetId !== canonicalAssetId) {
            return yield* Effect.fail(
              makeBadRequest("Asset representation does not belong to the selected asset.")
            )
          }

          yield* validateManualRepresentationIdentity({
            providerAsset: providerAssetReview.providerAsset,
            representation: representation.value,
          })
        }

        const observedRepresentationId = representationIdForProviderObservation({
          providerAsset: providerAssetReview.providerAsset,
          representationId: assetRepresentationId ?? "",
        })
        if (observedRepresentationId !== null && assetRepresentationId === null) {
          return yield* Effect.fail(
            makeBadRequest("Observed on-chain provider assets require an asset representation.")
          )
        }

        yield* providerAssetRepository
          .upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId,
                assetRepresentationId,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes,
                sourceNotes: appendSourceNote({
                  existing: providerAssetReview.mapping?.sourceNotes,
                  note: MANUAL_SOURCE_NOTES,
                }),
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

        return yield* loadApprovedProviderAssetAndReplay({ providerAssetRowId })
      })

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
        yield* validateNativeProviderIdentity(providerAsset)

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
        const providerAssetReview = yield* loadProviderAssetReview({ providerAssetRowId })
        yield* validateApprovableProviderAsset(providerAssetReview)

        const resolved = yield* resolveCoinGeckoDrafts({
          providerAsset: providerAssetReview.providerAsset,
        })
        const canonicalAsset = yield* assetRepository
          .upsertEconomicAssetRepresentation({
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
                assetRepresentationId: representationIdForProviderObservation({
                  providerAsset: providerAssetReview.providerAsset,
                  representationId: canonicalAsset.representationId,
                }),
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes,
                sourceNotes: appendSourceNote({
                  existing: providerAssetReview.mapping?.sourceNotes,
                  note: COINGECKO_SOURCE_NOTES,
                }),
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

        const approvedProviderAsset = yield* loadApprovedProviderAssetAndReplay({
          providerAssetRowId,
        })

        return {
          providerAsset: approvedProviderAsset,
          canonicalAsset,
          evidence: resolved.evidence,
        }
      })

  return AssetCanonicalizationService.of({
    approveProviderAssetMapping,
    canonicalizeProviderAssetFromCoinGecko,
  } satisfies AssetCanonicalizationServiceShape)
})

export const AssetCanonicalizationServiceLive = Layer.effect(AssetCanonicalizationService, make)
