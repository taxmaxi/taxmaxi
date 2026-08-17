/**
 * AssetCanonicalizationServiceLive - CoinGecko-backed asset canonicalization.
 *
 * @module AssetCanonicalizationServiceLive
 */

import {
  AssetRepository,
  ProviderAssetRepository,
  SyncEngineTransaction,
  type AssetRepresentationDraft,
  type CanonicalBlockchainDraft,
  type EconomicAssetDraft,
  type ProviderAssetObservedRepresentationRecord,
  type ProviderAssetRecord,
  type ProviderAssetReviewRecord,
  type SyncEngineAssetRepresentation,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetCanonicalizationBadRequestError,
  AssetCanonicalizationConflictError,
  AssetCanonicalizationInternalError,
  AssetCanonicalizationNotFoundError,
  AssetCanonicalizationProviderError,
  AssetCanonicalizationService,
  type AssetCanonicalizationServiceShape,
} from "../services/AssetCanonicalizationService.ts"
import { CoinGeckoClient, type CoinGeckoCoin } from "../services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"
import {
  selectNativePlatform,
  type CoinGeckoAssetPlatform,
} from "../services/coingecko/CoinGeckoPlatformSelection.ts"

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
  const isObservedOnchainToken = provider.includes("solana") || providerType.startsWith("spl-token")

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
  observedRepresentations = [],
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly representationId: string
  readonly observedRepresentations?: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
}): string | null =>
  observedRepresentations.length > 0 ||
  isNativeOnchainObservation(providerAsset) ||
  observedProviderTokenId(providerAsset) !== null
    ? representationId
    : null

interface RepresentationIdentity {
  readonly blockchainName: string
  readonly representationType: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
}

const matchesObservedRepresentation = ({
  representation,
  observed,
}: {
  readonly representation: RepresentationIdentity
  readonly observed: ProviderAssetObservedRepresentationRecord
}) =>
  normalize(representation.blockchainName) === normalize(observed.blockchainName) &&
  observed.representationType !== null &&
  representation.representationType === observed.representationType &&
  (observed.contractAddress === null
    ? representation.contractAddress === null
    : representation.contractAddress !== null &&
      normalize(representation.contractAddress) === normalize(observed.contractAddress)) &&
  representation.mintAddress === observed.mintAddress &&
  observed.decimals !== null &&
  representation.decimals === observed.decimals

const validateManualRepresentationSelection = ({
  providerAsset,
  assetRepresentationId,
  observedRepresentations,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly assetRepresentationId: string | null
  readonly observedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
  const observedRepresentationId = representationIdForProviderObservation({
    providerAsset,
    representationId: assetRepresentationId ?? "",
    observedRepresentations,
  })

  if (observedRepresentationId === null && assetRepresentationId !== null) {
    return Effect.fail(
      makeBadRequest("Provider assets without an observed chain cannot select a representation.")
    )
  }

  if (observedRepresentationId !== null && assetRepresentationId === null) {
    return Effect.fail(
      makeBadRequest("Observed on-chain provider assets require an asset representation.")
    )
  }

  return Effect.void
}

const validateDurableObservationAvailability = ({
  providerAsset,
  observedRepresentations,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly observedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> =>
  (isNativeOnchainObservation(providerAsset) || observedProviderTokenId(providerAsset) !== null) &&
  observedRepresentations.length === 0
    ? Effect.fail(
        makeBadRequest(
          "Observed on-chain identity is temporarily unavailable; finish source replay before approval."
        )
      )
    : Effect.void

export const validateManualRepresentationIdentity = ({
  providerAsset,
  representation,
  observedRepresentations = [],
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly representation: RepresentationIdentity
  readonly observedRepresentations?: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
  if (
    observedRepresentations.length > 0 &&
    !observedRepresentations.every((observed) =>
      matchesObservedRepresentation({ representation, observed })
    )
  ) {
    return Effect.fail(
      makeBadRequest("Selected representation does not match the observed on-chain identity.")
    )
  }

  if (observedRepresentations.length > 0) {
    return Effect.void
  }

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
  const expectedType =
    providerType === "nft" ? "nft" : providerType === "spl-token" ? "token" : null
  return normalize(representation.blockchainName) === "solana" &&
    expectedType !== null &&
    representation.representationType === expectedType &&
    representation.mintAddress === observedTokenId &&
    providerAsset.exponent !== null &&
    representation.decimals === providerAsset.exponent
    ? Effect.void
    : Effect.fail(
        makeBadRequest("Selected representation does not match the observed Solana mint.")
      )
}

export const validateEconomicAssetType = ({
  assetType,
  representation,
}: {
  readonly assetType: "fungible" | "nft"
  readonly representation: SyncEngineAssetRepresentation
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> =>
  (representation.representationType === "nft") === (assetType === "nft")
    ? Effect.void
    : Effect.fail(
        makeBadRequest("Asset representation type does not match the selected economic asset type.")
      )

const validateProviderEconomicAssetType = ({
  assetType,
  providerAsset,
}: {
  readonly assetType: "fungible" | "nft"
  readonly providerAsset: ProviderAssetRecord
}): Effect.Effect<void, AssetCanonicalizationBadRequestError> => {
  const providerType = providerAsset.providerType?.trim().toLowerCase() ?? null
  const expectedAssetType =
    providerType === "nft" ? "nft" : providerType === "crypto" ? "fungible" : null

  if (expectedAssetType === null) {
    return Effect.fail(
      makeBadRequest("Provider asset type does not prove a fungible or NFT economic asset.")
    )
  }

  return expectedAssetType === assetType
    ? Effect.void
    : Effect.fail(
        makeBadRequest("Provider asset type does not match the selected economic asset type.")
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
  const syncEngineTransaction = yield* SyncEngineTransaction

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

  const loadObservedRepresentations = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    providerAssetRepository.listProviderAssetObservedRepresentations({ providerAssetRowId }).pipe(
      Effect.mapError(
        () =>
          new AssetCanonicalizationInternalError({
            message: "Failed to load observed provider asset representations.",
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

  const loadApprovedProviderAsset = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    providerAssetRepository.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () =>
          new AssetCanonicalizationInternalError({
            message: "Failed to load approved provider asset mapping.",
          })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AssetCanonicalizationInternalError({
                message: "Approved provider asset mapping was not available after update.",
              })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const approveProviderAssetMapping: AssetCanonicalizationServiceShape["approveProviderAssetMapping"] =
    ({
      providerAssetRowId,
      canonicalAssetId,
      assetRepresentationId,
      reviewerNotes,
      reviewedBy,
      requirePendingReview = false,
    }) =>
      Effect.gen(function* () {
        const initialProviderAssetReview = yield* loadProviderAssetReview({ providerAssetRowId })
        yield* validateApprovableProviderAsset(initialProviderAssetReview)
        const initialObservedRepresentations = yield* loadObservedRepresentations({
          providerAssetRowId,
        })

        return yield* syncEngineTransaction
          .run(
            Effect.gen(function* () {
              const providerAssetReview = yield* providerAssetRepository
                .lockProviderAssetApprovalSnapshot({
                  providerAssetRowId,
                  expectedObservedRepresentations: initialObservedRepresentations,
                  expectedProviderAssetRetrievedAt:
                    initialProviderAssetReview.providerAsset.retrievedAt,
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new AssetCanonicalizationInternalError({
                        message: "Provider asset evidence changed before manual approval.",
                      })
                  )
                )
              if (
                requirePendingReview &&
                providerAssetReview.mapping?.mappingStatus !== "pending_review"
              ) {
                return yield* new AssetCanonicalizationConflictError({
                  message: "Provider asset has already been reviewed.",
                })
              }
              yield* validateApprovableProviderAsset(providerAssetReview)
              const existingMapping = providerAssetReview.mapping
              if (
                existingMapping?.mappingStatus === "approved" &&
                (existingMapping.mappingKind !== "asset" ||
                  existingMapping.canonicalAssetId !== canonicalAssetId ||
                  existingMapping.assetRepresentationId !== assetRepresentationId)
              ) {
                return yield* makeBadRequest(
                  "Provider asset mapping is already approved for a different target."
                )
              }

              const observedRepresentations = initialObservedRepresentations
              yield* validateManualRepresentationSelection({
                providerAsset: providerAssetReview.providerAsset,
                assetRepresentationId,
                observedRepresentations,
              })
              yield* validateDurableObservationAvailability({
                providerAsset: providerAssetReview.providerAsset,
                observedRepresentations,
              })

              const canonicalAsset = yield* assetRepository
                .findAssetById({ assetId: canonicalAssetId, lockForApproval: true })
                .pipe(
                  Effect.mapError(
                    () =>
                      new AssetCanonicalizationInternalError({
                        message: "Failed to load the selected canonical asset.",
                      })
                  )
                )
              if (Option.isNone(canonicalAsset)) {
                return yield* new AssetCanonicalizationNotFoundError({
                  message: "Canonical asset not found.",
                })
              }

              if (assetRepresentationId === null) {
                yield* validateProviderEconomicAssetType({
                  assetType: canonicalAsset.value.type,
                  providerAsset: providerAssetReview.providerAsset,
                })
              } else {
                const representation = yield* assetRepository
                  .findRepresentationById({
                    assetRepresentationId,
                    lockForApproval: true,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new AssetCanonicalizationInternalError({
                          message: "Failed to load the selected asset representation.",
                        })
                    )
                  )
                if (Option.isNone(representation)) {
                  return yield* new AssetCanonicalizationNotFoundError({
                    message: "Asset representation not found.",
                  })
                }
                if (representation.value.assetId !== canonicalAssetId) {
                  return yield* makeBadRequest(
                    "Asset representation does not belong to the selected asset."
                  )
                }

                yield* validateManualRepresentationIdentity({
                  providerAsset: providerAssetReview.providerAsset,
                  representation: representation.value,
                  observedRepresentations,
                })
                yield* validateEconomicAssetType({
                  assetType: canonicalAsset.value.type,
                  representation: representation.value,
                })
              }

              const approval = yield* providerAssetRepository
                .approveProviderAssetMappingAndRequestReplay({
                  mapping: {
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
                  reviewedBy: reviewedBy ?? null,
                  reviewedAt: new Date(),
                  expectedObservedRepresentations: observedRepresentations,
                  expectedProviderAssetRetrievedAt: providerAssetReview.providerAsset.retrievedAt,
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.gen(function* () {
                      const latest = yield* loadProviderAssetReview({ providerAssetRowId })
                      const latestMapping = latest.mapping
                      if (
                        latestMapping?.mappingStatus === "approved" &&
                        (latestMapping.mappingKind !== "asset" ||
                          latestMapping.canonicalAssetId !== canonicalAssetId ||
                          latestMapping.assetRepresentationId !== assetRepresentationId)
                      ) {
                        return yield* makeBadRequest(
                          "Provider asset mapping was concurrently approved for a different target."
                        )
                      }
                      if (latestMapping?.mappingStatus === "rejected") {
                        return yield* makeBadRequest(
                          "Provider asset mapping was concurrently rejected."
                        )
                      }

                      return yield* new AssetCanonicalizationInternalError({
                        message: "Failed to approve provider asset mapping.",
                      })
                    })
                  )
                )

              const providerAsset = yield* loadApprovedProviderAsset({ providerAssetRowId })

              return { ...providerAsset, replays: approval.replays }
            })
          )
          .pipe(
            Effect.catchTag(
              "SyncEngineStorageError",
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to commit manual asset approval.",
                })
            )
          )
      })

  const resolveCoinGeckoDrafts = ({
    providerAsset,
    coinId,
    observedRepresentations,
  }: {
    readonly providerAsset: ProviderAssetRecord
    readonly coinId: string
    readonly observedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
  }) =>
    Effect.gen(function* () {
      const searchCoins = yield* coinGeckoClient
        .searchCoins({ query: providerAsset.currencyCode })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const selectedCoin = searchCoins.find((candidate) => candidate.id === coinId)
      if (selectedCoin === undefined) {
        return yield* makeBadRequest("The selected CoinGecko candidate is not available.")
      }
      if (normalize(selectedCoin.symbol) !== normalize(providerAsset.currencyCode)) {
        return yield* makeBadRequest(
          "The selected CoinGecko candidate symbol does not match the provider observation."
        )
      }
      const coin = yield* coinGeckoClient
        .getCoin({ coinId: selectedCoin.id })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform> = coinGeckoAssetPlatformSnapshot
      const nativePlatforms = assetPlatforms.filter(
        (platform) => platform.native_coin_id === coin.id
      )
      const nativePlatform = selectNativePlatform({ coinId: coin.id, assetPlatforms })
      const tokenPlatforms = Object.entries(coin.platforms).filter(([, contractAddress]) =>
        isNonEmptyString(contractAddress)
      )

      const observedTokenPlatforms = tokenPlatforms.filter(([platformId, contractAddress]) => {
        const platform = assetPlatforms.find((candidate) => candidate.id === platformId)
        if (platform === undefined) return false

        return observedRepresentations.some((observation) => {
          const observedAddress = observation.contractAddress ?? observation.mintAddress
          if (observedAddress === null) return false

          const chainMatches =
            normalize(observation.blockchainName) === normalize(platform.id) ||
            normalize(observation.blockchainName) === normalize(platform.name)
          const addressMatches =
            deriveChainType(platform) === "evm"
              ? normalize(observedAddress) === normalize(contractAddress)
              : observedAddress.trim() === contractAddress.trim()

          return chainMatches && addressMatches
        })
      })
      if (observedTokenPlatforms.length > 1) {
        return yield* makeBadRequest(
          `CoinGecko returned multiple representations matching the reviewed evidence for ${providerAsset.currencyCode}.`
        )
      }

      const observedTokenPlatform = observedTokenPlatforms[0]
      if (observedTokenPlatform === undefined && nativePlatform !== null) {
        yield* validateNativeProviderIdentity(providerAsset)

        const nativeDecimals = deriveNativeAssetDecimals({
          coinId: coin.id,
          platform: nativePlatform,
        })
        if (nativeDecimals === null) {
          return yield* makeBadRequest(
            `CoinGecko did not identify native asset decimals for ${providerAsset.currencyCode}; manual review is required.`
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

      if (observedTokenPlatform === undefined && nativePlatforms.length > 1) {
        return yield* makeBadRequest(
          `CoinGecko has multiple native platforms for ${providerAsset.currencyCode}; manual review is required.`
        )
      }

      const tokenPlatformEntry =
        observedTokenPlatform ?? (tokenPlatforms.length === 1 ? tokenPlatforms[0] : undefined)

      if (tokenPlatformEntry === undefined) {
        return yield* makeBadRequest(
          `CoinGecko did not identify one representation matching the reviewed evidence for ${providerAsset.currencyCode}.`
        )
      }

      const [platformId, contractAddress] = tokenPlatformEntry
      const tokenPlatform = assetPlatforms.find((platform) => platform.id === platformId)
      if (tokenPlatform === undefined) {
        return yield* makeBadRequest(
          `CoinGecko platform ${platformId} is not available in asset_platforms.`
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
    ({ providerAssetRowId, coinId, reviewerNotes, reviewedBy, requirePendingReview = false }) =>
      Effect.gen(function* () {
        const initialProviderAssetReview = yield* loadProviderAssetReview({ providerAssetRowId })
        yield* validateApprovableProviderAsset(initialProviderAssetReview)
        const initialObservedRepresentations = yield* loadObservedRepresentations({
          providerAssetRowId,
        })
        yield* validateDurableObservationAvailability({
          providerAsset: initialProviderAssetReview.providerAsset,
          observedRepresentations: initialObservedRepresentations,
        })

        if (
          initialProviderAssetReview.mapping?.mappingStatus === "pending_review" &&
          initialObservedRepresentations.length === 0 &&
          !isNativeOnchainObservation(initialProviderAssetReview.providerAsset) &&
          observedProviderTokenId(initialProviderAssetReview.providerAsset) === null
        ) {
          return yield* makeBadRequest(
            "Provider assets without exact on-chain identity require a reviewed canonical target."
          )
        }

        const resolved = yield* resolveCoinGeckoDrafts({
          providerAsset: initialProviderAssetReview.providerAsset,
          coinId,
          observedRepresentations: initialObservedRepresentations,
        })

        return yield* syncEngineTransaction
          .run(
            Effect.gen(function* () {
              const providerAssetReview = yield* providerAssetRepository
                .lockProviderAssetApprovalSnapshot({
                  providerAssetRowId,
                  expectedObservedRepresentations: initialObservedRepresentations,
                  expectedProviderAssetRetrievedAt:
                    initialProviderAssetReview.providerAsset.retrievedAt,
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new AssetCanonicalizationInternalError({
                        message: "Provider asset evidence changed before canonical approval.",
                      })
                  )
                )
              if (
                requirePendingReview &&
                providerAssetReview.mapping?.mappingStatus !== "pending_review"
              ) {
                return yield* new AssetCanonicalizationConflictError({
                  message: "Provider asset has already been reviewed.",
                })
              }
              yield* validateApprovableProviderAsset(providerAssetReview)
              const observedRepresentations = initialObservedRepresentations
              yield* validateDurableObservationAvailability({
                providerAsset: providerAssetReview.providerAsset,
                observedRepresentations,
              })
              const existingMapping = providerAssetReview.mapping
              if (existingMapping?.mappingStatus === "approved") {
                const existingAsset = yield* assetRepository
                  .findAssetByCoinGeckoId({ coingeckoCoinId: resolved.asset.coingeckoCoinId ?? "" })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new AssetCanonicalizationInternalError({
                          message: "Failed to validate the approved CoinGecko target.",
                        })
                    )
                  )
                const selectsRepresentation =
                  representationIdForProviderObservation({
                    providerAsset: providerAssetReview.providerAsset,
                    representationId: "resolved-representation",
                    observedRepresentations,
                  }) !== null
                const targetAssetMatches =
                  existingMapping.mappingKind === "asset" &&
                  Option.isSome(existingAsset) &&
                  existingMapping.canonicalAssetId === existingAsset.value.id
                const representationPresenceMatches = selectsRepresentation
                  ? existingMapping.assetRepresentationId !== null
                  : existingMapping.assetRepresentationId === null

                let representationMatches = !selectsRepresentation
                if (selectsRepresentation && existingMapping.assetRepresentationId !== null) {
                  const existingRepresentation = yield* assetRepository
                    .findRepresentationById({
                      assetRepresentationId: existingMapping.assetRepresentationId,
                    })
                    .pipe(
                      Effect.mapError(
                        () =>
                          new AssetCanonicalizationInternalError({
                            message: "Failed to validate the approved CoinGecko representation.",
                          })
                      )
                    )
                  representationMatches =
                    Option.isSome(existingRepresentation) &&
                    normalize(existingRepresentation.value.blockchainName) ===
                      normalize(resolved.blockchain.name) &&
                    existingRepresentation.value.representationType ===
                      resolved.representation.type &&
                    normalize(existingRepresentation.value.contractAddress ?? "") ===
                      normalize(resolved.representation.contractAddress ?? "") &&
                    existingRepresentation.value.mintAddress ===
                      resolved.representation.mintAddress &&
                    existingRepresentation.value.decimals === resolved.representation.decimals
                }

                if (
                  !targetAssetMatches ||
                  !representationPresenceMatches ||
                  !representationMatches
                ) {
                  return yield* makeBadRequest(
                    "Provider asset mapping is already approved for a different target."
                  )
                }
              }
              if (existingMapping?.mappingStatus === "pending_review") {
                const latest = yield* loadProviderAssetReview({ providerAssetRowId })
                if (latest.mapping?.mappingStatus === "approved") {
                  return yield* makeBadRequest(
                    "Provider asset mapping was concurrently approved before canonical writes."
                  )
                }
              }
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

              const assetRepresentationId = representationIdForProviderObservation({
                providerAsset: providerAssetReview.providerAsset,
                representationId: canonicalAsset.representationId,
                observedRepresentations,
              })
              if (assetRepresentationId !== null) {
                yield* validateManualRepresentationIdentity({
                  providerAsset: providerAssetReview.providerAsset,
                  representation: canonicalAsset,
                  observedRepresentations,
                })
                if (
                  (canonicalAsset.representationType === "nft") !==
                  (canonicalAsset.type === "nft")
                ) {
                  return yield* makeBadRequest(
                    "Asset representation type does not match the selected economic asset type."
                  )
                }
              }

              const approval = yield* providerAssetRepository
                .approveProviderAssetMappingAndRequestReplay({
                  mapping: {
                    providerAssetRowId,
                    mappingKind: "asset",
                    canonicalAssetId: canonicalAsset.id,
                    assetRepresentationId,
                    canonicalFiatCurrency: null,
                    mappingStatus: "approved",
                    reviewerNotes,
                    sourceNotes: appendSourceNote({
                      existing: providerAssetReview.mapping?.sourceNotes,
                      note: COINGECKO_SOURCE_NOTES,
                    }),
                  },
                  reviewedBy: reviewedBy ?? null,
                  reviewedAt: new Date(),
                  expectedObservedRepresentations: observedRepresentations,
                  expectedProviderAssetRetrievedAt: providerAssetReview.providerAsset.retrievedAt,
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.gen(function* () {
                      const latest = yield* loadProviderAssetReview({ providerAssetRowId })
                      const latestMapping = latest.mapping
                      if (
                        latestMapping?.mappingStatus === "approved" &&
                        latestMapping.mappingKind === "asset" &&
                        latestMapping.canonicalAssetId === canonicalAsset.id &&
                        latestMapping.assetRepresentationId === assetRepresentationId
                      ) {
                        return { mappingChanged: false, replays: [] }
                      }
                      if (latestMapping?.mappingStatus === "approved") {
                        return yield* makeBadRequest(
                          "Provider asset mapping was concurrently approved for a different target."
                        )
                      }
                      if (latestMapping?.mappingStatus === "rejected") {
                        return yield* makeBadRequest(
                          "Provider asset mapping was concurrently rejected."
                        )
                      }

                      return yield* new AssetCanonicalizationInternalError({
                        message: "Failed to approve provider asset mapping.",
                      })
                    })
                  )
                )

              const approvedProviderAsset = yield* loadApprovedProviderAsset({ providerAssetRowId })

              return {
                providerAsset: approvedProviderAsset,
                canonicalAsset,
                evidence: resolved.evidence,
                replays: approval.replays,
              }
            })
          )
          .pipe(
            Effect.catchTag(
              "SyncEngineStorageError",
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to commit canonical asset approval.",
                })
            )
          )
      })

  return AssetCanonicalizationService.of({
    approveProviderAssetMapping,
    canonicalizeProviderAssetFromCoinGecko,
  } satisfies AssetCanonicalizationServiceShape)
})

export const AssetCanonicalizationServiceLive = Layer.effect(AssetCanonicalizationService, make)
