/**
 * AssetCanonicalizationServiceLive - CoinGecko-backed asset canonicalization.
 *
 * @module AssetCanonicalizationServiceLive
 */

import {
  ProviderAssetRepository,
  SourceSyncService,
  type CanonicalAssetDraft,
  type CanonicalBlockchainDraft,
  type ProviderAssetRecord,
} from "@my/sync-engine/services"
import { AssetCatalogRepository } from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  AssetCanonicalizationBadRequestError,
  AssetCanonicalizationConflictError,
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

export const isObservedProviderChainMatch = ({
  blockchainChainType,
  provider,
  providerType,
}: {
  readonly blockchainChainType: string
  readonly provider: string
  readonly providerType: string | null
}): boolean => {
  const normalizedProviderType = providerType === null ? "" : normalize(providerType)
  const isSolanaObservation =
    normalize(provider).includes("solana") ||
    normalizedProviderType.startsWith("spl-token") ||
    normalizedProviderType === "nft"

  return !isSolanaObservation || normalize(blockchainChainType) === "solana"
}

export const hasStrongProviderIdentityEvidence = ({
  candidateContractAddress,
  coinName,
  observedTokenId,
  providerName,
}: {
  readonly candidateContractAddress: string | null
  readonly coinName: string
  readonly observedTokenId: string | null
  readonly providerName: string | null
}): boolean =>
  candidateContractAddress === null
    ? observedTokenId === null &&
      providerName !== null &&
      normalize(providerName) === normalize(coinName)
    : observedTokenId !== null

const upperSymbol = (value: string) => value.trim().toUpperCase()

export const providerAssetCanonicalType = (providerType: string | null): "nft" | "token" =>
  providerType?.trim().toLowerCase() === "nft" ? "nft" : "token"

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

export const providerTokenIdentifiersMatch = ({
  chainType,
  observedTokenId,
  canonicalTokenId,
}: {
  readonly chainType: string
  readonly observedTokenId: string
  readonly canonicalTokenId: string
}): boolean =>
  chainType === "evm"
    ? observedTokenId.trim().toLowerCase() === canonicalTokenId.trim().toLowerCase()
    : observedTokenId.trim() === canonicalTokenId.trim()

export const selectExactTokenPlatform = ({
  assetPlatforms,
  observedTokenId,
  tokenPlatforms,
}: {
  readonly assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform>
  readonly observedTokenId: string
  readonly tokenPlatforms: ReadonlyArray<readonly [string, string]>
}): readonly [string, string] | null => {
  const matches = tokenPlatforms.filter(([platformId, contractAddress]) => {
    const platform = assetPlatforms.find((candidate) => candidate.id === platformId)
    return (
      platform !== undefined &&
      providerTokenIdentifiersMatch({
        chainType: deriveChainType(platform),
        observedTokenId,
        canonicalTokenId: contractAddress,
      })
    )
  })

  return matches.length === 1 ? (matches[0] ?? null) : null
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

export const resolveNativeAssetDecimals = ({
  coinId,
  platform,
  providerExponent,
}: {
  readonly coinId: string
  readonly platform: CoinGeckoAssetPlatform
  readonly providerExponent: number | null
}): number | null => {
  const knownDecimals = deriveNativeAssetDecimals({ coinId, platform })
  if (knownDecimals !== null) {
    return knownDecimals
  }

  return providerExponent !== null && Number.isInteger(providerExponent) && providerExponent >= 0
    ? providerExponent
    : null
}

const makeBadRequest = (message: string) => new AssetCanonicalizationBadRequestError({ message })

export const optionalCandidateResolution = <A>(
  effect: Effect.Effect<
    A,
    AssetCanonicalizationBadRequestError | AssetCanonicalizationProviderError
  >
) =>
  effect.pipe(
    Effect.map((candidate) => ({ _tag: "Candidate" as const, candidate })),
    Effect.catchTag("AssetCanonicalizationBadRequestError", (error) =>
      Effect.succeed({
        _tag: "UnavailableCandidate" as const,
        reason: error.message,
      })
    )
  )

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

export const selectNativeCoinPlatform = ({
  coin,
  assetPlatforms,
}: {
  readonly coin: CoinGeckoCoin
  readonly assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform>
}): CoinGeckoAssetPlatform | null => {
  const knownPlatform = selectNativePlatform({ coinId: coin.id, assetPlatforms })
  if (knownPlatform !== null) {
    return knownPlatform
  }

  if (coin.asset_platform_id !== null) {
    return null
  }

  return {
    id: coin.id,
    chain_identifier: null,
    name: coin.name,
    shortname: upperSymbol(coin.symbol),
    native_coin_id: coin.id,
  }
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
  return providerTokenIdentifiersMatch({
    chainType,
    observedTokenId,
    canonicalTokenId: contractAddress,
  })
    ? Effect.void
    : Effect.fail(
        makeBadRequest(
          `CoinGecko token contract does not match observed provider asset id for ${providerAsset.currencyCode}.`
        )
      )
}

export const selectCoinCandidate = ({
  coinId,
  providerAssetSymbol,
  searchCoins,
}: {
  readonly coinId: string
  readonly providerAssetSymbol: string
  readonly searchCoins: ReadonlyArray<CoinGeckoSearchCoin>
}): Effect.Effect<CoinGeckoSearchCoin, AssetCanonicalizationBadRequestError> => {
  const selected = searchCoins.find(
    (coin) => coin.id === coinId && normalize(coin.symbol) === normalize(providerAssetSymbol)
  )
  if (selected === undefined) {
    return Effect.fail(
      makeBadRequest(
        `CoinGecko candidate ${coinId} is not a symbol match for ${providerAssetSymbol}.`
      )
    )
  }
  return Effect.succeed(selected)
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
    decimals,
    coingeckoCoinId: coin.id,
    logoUrl: coin.image?.small ?? null,
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
  readonly providerAsset: ProviderAssetRecord
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
      nativeAssetSymbol: deriveNativeAssetSymbol(platform),
      explorerUrl: null,
      logoUrl: null,
      coingeckoPlatformId: platform.id,
    },
    asset: {
      contractAddress,
      name: coin.name,
      symbol: upperSymbol(coin.symbol),
      decimals: detail?.decimal_place ?? providerAsset.exponent ?? 0,
      coingeckoCoinId: coin.id,
      logoUrl: coin.image?.small ?? null,
      type: providerAssetCanonicalType(providerAsset.providerType),
      isSpam: false,
    },
  }
}

const make = Effect.gen(function* () {
  const coinGeckoClient = yield* CoinGeckoClient
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetCatalogRepository = yield* AssetCatalogRepository
  const sourceSyncService = yield* SourceSyncService

  const mapCoinGeckoError = (error: { readonly message: string }) =>
    new AssetCanonicalizationProviderError({ message: error.message })

  const resolveSelectedCoinGeckoDrafts = ({
    selectedCoin,
    providerAsset,
  }: {
    readonly selectedCoin: CoinGeckoSearchCoin
    readonly providerAsset: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const coin = yield* coinGeckoClient
        .getCoin({ coinId: selectedCoin.id })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const observedTokenId = observedProviderTokenId(providerAsset)
      const assetPlatforms: ReadonlyArray<CoinGeckoAssetPlatform> = coinGeckoAssetPlatformSnapshot
      const nativePlatforms = assetPlatforms.filter(
        (platform) => platform.native_coin_id === coin.id
      )
      const nativePlatform = selectNativeCoinPlatform({ coin, assetPlatforms })

      if (nativePlatform !== null) {
        if (
          !hasStrongProviderIdentityEvidence({
            candidateContractAddress: null,
            coinName: coin.name,
            observedTokenId,
            providerName: providerAsset.name,
          })
        ) {
          return yield* Effect.fail(
            makeBadRequest(
              `CoinGecko symbol ${providerAsset.currencyCode} is not sufficient without matching provider name or contract evidence.`
            )
          )
        }
        const nativeDecimals = resolveNativeAssetDecimals({
          coinId: coin.id,
          platform: nativePlatform,
          providerExponent: providerAsset.exponent,
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
          warnings: Object.values(coin.platforms).some(isNonEmptyString)
            ? [
                "CoinGecko also lists token or bridged representations. They were ignored because the provider supplied no matching chain and contract.",
              ]
            : [],
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

      if (observedTokenId === null) {
        return yield* Effect.fail(
          makeBadRequest(
            `CoinGecko only identified token or bridged representations for ${providerAsset.currencyCode}, but the provider supplied no chain and contract evidence.`
          )
        )
      }

      const tokenPlatformEntry = selectExactTokenPlatform({
        assetPlatforms,
        observedTokenId,
        tokenPlatforms,
      })
      if (tokenPlatformEntry === null) {
        return yield* Effect.fail(
          makeBadRequest(
            `No single CoinGecko chain and contract matches the observed provider asset id for ${providerAsset.currencyCode}.`
          )
        )
      }

      const [platformId, contractAddress] = tokenPlatformEntry
      if (
        !hasStrongProviderIdentityEvidence({
          candidateContractAddress: contractAddress,
          coinName: coin.name,
          observedTokenId,
          providerName: providerAsset.name,
        })
      ) {
        return yield* Effect.fail(
          makeBadRequest(
            `CoinGecko symbol ${providerAsset.currencyCode} is not sufficient without matching provider name or contract evidence.`
          )
        )
      }
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
        warnings: [],
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

  const resolveCoinGeckoDrafts = ({
    coinId,
    providerAsset,
  }: {
    readonly coinId: string
    readonly providerAsset: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const searchCoins = yield* coinGeckoClient
        .searchCoins({ query: providerAsset.currencyCode })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const selectedCoin = yield* selectCoinCandidate({
        coinId,
        providerAssetSymbol: providerAsset.currencyCode,
        searchCoins,
      })
      return yield* resolveSelectedCoinGeckoDrafts({ selectedCoin, providerAsset })
    })

  const loadPendingReview = (providerAssetRowId: string) =>
    Effect.gen(function* () {
      const review = yield* providerAssetRepository
        .findProviderAssetReviewById({ providerAssetRowId })
        .pipe(
          Effect.mapError(
            () =>
              new AssetCanonicalizationInternalError({
                message: "Failed to load provider asset review row.",
              })
          )
        )
      if (Option.isNone(review)) {
        return yield* Effect.fail(
          new AssetCanonicalizationNotFoundError({ message: "Provider asset not found." })
        )
      }
      if (review.value.mapping?.mappingStatus !== "pending_review") {
        return yield* Effect.fail(
          new AssetCanonicalizationConflictError({
            message: "Provider asset mapping is no longer pending review.",
          })
        )
      }
      return review.value
    })

  const loadReviewAfterDecision = (providerAssetRowId: string) =>
    providerAssetRepository.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () =>
          new AssetCanonicalizationInternalError({
            message: "Failed to load reviewed provider asset mapping.",
          })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AssetCanonicalizationInternalError({
                message: "Reviewed provider asset mapping was not available after update.",
              })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const queueAffectedSourceReplays = (
    sources: ReadonlyArray<{ readonly sourceId: string; readonly principalId: string }>
  ) =>
    Effect.forEach(sources, (source) =>
      sourceSyncService
        .replaySourceSyncJob({
          principalId: source.principalId,
          sourceId: source.sourceId,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({
              sourceId: source.sourceId,
              jobId: null,
              status: "failed_to_queue" as const,
              message: error._tag,
            }),
            onSuccess: (job) => ({
              sourceId: source.sourceId,
              jobId: job.jobId,
              status: "queued" as const,
              message: job.message,
            }),
          })
        )
    )

  const decide = (
    params: Parameters<AssetCanonicalizationServiceShape["rejectProviderAsset"]>[0] & {
      readonly canonicalAssetId: string | null
      readonly canonicalAssetSymbol: string | null
      readonly canonicalAssetDraft: {
        readonly blockchain: CanonicalBlockchainDraft
        readonly asset: CanonicalAssetDraft
      } | null
      readonly mappingStatus: "approved" | "rejected"
      readonly reviewerNotes: string | null
      readonly sourceNotes: string | null
      readonly createReplayJobs: boolean
    }
  ) =>
    providerAssetRepository
      .decideProviderAssetMapping({
        providerAssetRowId: params.providerAssetRowId,
        mappingKind: "asset",
        canonicalAssetId: params.canonicalAssetId,
        canonicalAssetSymbol: params.canonicalAssetSymbol,
        canonicalAssetDraft: params.canonicalAssetDraft,
        mappingStatus: params.mappingStatus,
        reviewerNotes: params.reviewerNotes,
        sourceNotes: params.sourceNotes,
        reviewedBy: params.reviewedBy,
        reviewedAt: new Date(),
        createReplayJobs: params.createReplayJobs,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AssetCanonicalizationInternalError({
              message: "Failed to persist provider asset review decision.",
            })
        ),
        Effect.flatMap((result) =>
          result.updated
            ? Effect.succeed(result)
            : Effect.fail(
                new AssetCanonicalizationConflictError({
                  message: "Provider asset mapping was reviewed by another administrator.",
                })
              )
        )
      )

  const listCoinGeckoCandidates: AssetCanonicalizationServiceShape["listCoinGeckoCandidates"] = ({
    providerAssetRowId,
  }) =>
    Effect.gen(function* () {
      const review = yield* loadPendingReview(providerAssetRowId)
      const searchCoins = yield* coinGeckoClient
        .searchCoins({ query: review.providerAsset.currencyCode })
        .pipe(Effect.mapError(mapCoinGeckoError))
      const symbolMatches = searchCoins.filter(
        (coin) => normalize(coin.symbol) === normalize(review.providerAsset.currencyCode)
      )

      const candidates = yield* Effect.forEach(symbolMatches, (match) =>
        optionalCandidateResolution(
          resolveSelectedCoinGeckoDrafts({
            selectedCoin: match,
            providerAsset: review.providerAsset,
          })
        ).pipe(Effect.map((resolution) => ({ match, resolution })))
      )

      return candidates.map(({ match, resolution }) => {
        const exactNameMatch =
          review.providerAsset.name !== null &&
          normalize(review.providerAsset.name) === normalize(match.name)
        const basicEvidenceStrength: "exact_name_and_symbol" | "symbol_only" = exactNameMatch
          ? "exact_name_and_symbol"
          : "symbol_only"
        const basicMatchReasons = [
          `Symbol matches ${review.providerAsset.currencyCode.toUpperCase()}.`,
          ...(exactNameMatch ? ["Name matches the provider exactly."] : []),
        ]

        if (resolution._tag === "UnavailableCandidate") {
          return {
            availability: "unavailable" as const,
            coinId: match.id,
            coinName: match.name,
            coinSymbol: upperSymbol(match.symbol),
            platformId: null,
            platformName: null,
            contractAddress: null,
            exactContractMatch: false,
            evidenceStrength: basicEvidenceStrength,
            representation: "unknown" as const,
            matchReasons: basicMatchReasons,
            warnings: [],
            unavailableReason: resolution.reason,
            proposedAsset: null,
          }
        }
        const candidate = resolution.candidate

        const observedTokenId = observedProviderTokenId(review.providerAsset)
        const evidencePlatform = coinGeckoAssetPlatformSnapshot.find(
          (platform) => platform.id === candidate.evidence.platformId
        )
        const exactContractMatch =
          candidate.evidence.contractAddress !== null &&
          observedTokenId !== null &&
          evidencePlatform !== undefined &&
          providerTokenIdentifiersMatch({
            chainType: deriveChainType(evidencePlatform),
            observedTokenId,
            canonicalTokenId: candidate.evidence.contractAddress,
          })
        const evidenceStrength: "exact_contract" | "exact_name_and_symbol" | "symbol_only" =
          exactContractMatch ? "exact_contract" : basicEvidenceStrength

        return {
          availability: "actionable" as const,
          coinId: candidate.evidence.coinId,
          coinName: candidate.evidence.coinName,
          coinSymbol: candidate.evidence.coinSymbol,
          platformId: candidate.evidence.platformId,
          platformName: candidate.evidence.platformName,
          contractAddress: candidate.evidence.contractAddress,
          exactContractMatch,
          evidenceStrength,
          representation:
            candidate.asset.type === "native" ? ("native" as const) : ("token" as const),
          matchReasons: exactContractMatch
            ? [...basicMatchReasons, "Chain and contract match the provider observation."]
            : basicMatchReasons,
          warnings: candidate.warnings,
          unavailableReason: null,
          proposedAsset: {
            blockchainName: candidate.blockchain.name,
            contractAddress: candidate.asset.contractAddress,
            name: candidate.asset.name,
            symbol: candidate.asset.symbol,
            decimals: candidate.asset.decimals,
            logoUrl: candidate.asset.logoUrl,
            type: candidate.asset.type,
          },
        }
      })
    })

  const canonicalizeProviderAssetFromCoinGecko: AssetCanonicalizationServiceShape["canonicalizeProviderAssetFromCoinGecko"] =
    ({ providerAssetRowId, coinId, reviewerNotes, reviewedBy }) =>
      Effect.gen(function* () {
        const providerAssetReview = yield* loadPendingReview(providerAssetRowId)

        if (providerAssetReview.providerAsset.providerType?.trim().toLowerCase() === "fiat") {
          return yield* Effect.fail(makeBadRequest("Fiat provider assets cannot become assets."))
        }

        const resolved = yield* resolveCoinGeckoDrafts({
          coinId,
          providerAsset: providerAssetReview.providerAsset,
        })
        const decision = yield* decide({
          providerAssetRowId,
          rejectionReason: "",
          reviewedBy,
          canonicalAssetId: null,
          canonicalAssetSymbol: null,
          canonicalAssetDraft: { blockchain: resolved.blockchain, asset: resolved.asset },
          mappingStatus: "approved",
          reviewerNotes,
          sourceNotes: COINGECKO_SOURCE_NOTES,
          createReplayJobs: true,
        })
        const canonicalAsset = decision.canonicalAsset
        if (canonicalAsset === null) {
          return yield* Effect.fail(
            new AssetCanonicalizationInternalError({
              message: "Canonical asset was not returned by the review transaction.",
            })
          )
        }
        const approvedProviderAsset = yield* loadReviewAfterDecision(providerAssetRowId)
        const replays = yield* queueAffectedSourceReplays(decision.affectedSources)

        return {
          providerAsset: approvedProviderAsset,
          canonicalAsset,
          evidence: resolved.evidence,
          replays,
        }
      })

  const mapProviderAssetToExisting: AssetCanonicalizationServiceShape["mapProviderAssetToExisting"] =
    ({ providerAssetRowId, canonicalAssetId, reviewerNotes, reviewedBy }) =>
      Effect.gen(function* () {
        const review = yield* loadPendingReview(providerAssetRowId)
        if (review.providerAsset.providerType?.trim().toLowerCase() === "fiat") {
          return yield* Effect.fail(makeBadRequest("Fiat provider assets cannot become assets."))
        }
        const target = yield* assetCatalogRepository
          .findAssetById({ assetId: canonicalAssetId })
          .pipe(
            Effect.mapError(
              () =>
                new AssetCanonicalizationInternalError({
                  message: "Failed to load canonical asset.",
                })
            )
          )
        if (Option.isNone(target)) {
          return yield* Effect.fail(
            new AssetCanonicalizationBadRequestError({
              message: "Canonical asset does not exist or is marked as spam.",
            })
          )
        }
        const observedTokenId = observedProviderTokenId(review.providerAsset)
        if (
          observedTokenId !== null &&
          (!isObservedProviderChainMatch({
            blockchainChainType: target.value.blockchainChainType,
            provider: review.providerAsset.provider,
            providerType: review.providerAsset.providerType,
          }) ||
            target.value.contractAddress === null ||
            !providerTokenIdentifiersMatch({
              chainType: target.value.blockchainChainType,
              observedTokenId,
              canonicalTokenId: target.value.contractAddress,
            }))
        ) {
          return yield* Effect.fail(
            makeBadRequest(
              "Canonical asset chain and contract do not match the provider observation."
            )
          )
        }
        const decision = yield* decide({
          providerAssetRowId,
          rejectionReason: "",
          reviewedBy,
          canonicalAssetId: target.value.id,
          canonicalAssetSymbol: target.value.symbol,
          canonicalAssetDraft: null,
          mappingStatus: "approved",
          reviewerNotes,
          sourceNotes: "Mapped to an existing canonical TaxMaxi asset.",
          createReplayJobs: true,
        })
        const providerAsset = yield* loadReviewAfterDecision(providerAssetRowId)
        const replays = yield* queueAffectedSourceReplays(decision.affectedSources)
        return { providerAsset, replays }
      })

  const rejectProviderAsset: AssetCanonicalizationServiceShape["rejectProviderAsset"] = ({
    providerAssetRowId,
    rejectionReason,
    reviewedBy,
  }) =>
    Effect.gen(function* () {
      yield* loadPendingReview(providerAssetRowId)
      const reason = rejectionReason.trim()
      if (reason === "") {
        return yield* Effect.fail(makeBadRequest("A rejection reason is required."))
      }
      yield* decide({
        providerAssetRowId,
        rejectionReason: reason,
        reviewedBy,
        canonicalAssetId: null,
        canonicalAssetSymbol: null,
        canonicalAssetDraft: null,
        mappingStatus: "rejected",
        reviewerNotes: reason,
        sourceNotes: "Rejected during provider asset review.",
        createReplayJobs: false,
      })
      const providerAsset = yield* loadReviewAfterDecision(providerAssetRowId)
      return { providerAsset, replays: [] }
    })

  const loadAffectedSource = ({
    providerAssetRowId,
    sourceId,
  }: {
    readonly providerAssetRowId: string
    readonly sourceId: string
  }) =>
    providerAssetRepository.listAffectedSources({ providerAssetRowId }).pipe(
      Effect.mapError(
        () =>
          new AssetCanonicalizationInternalError({
            message: "Failed to load the provider asset's affected sources.",
          })
      ),
      Effect.flatMap((sources) => {
        const source = sources.find((candidate) => candidate.sourceId === sourceId)
        return source === undefined
          ? Effect.fail(
              new AssetCanonicalizationNotFoundError({
                message: "Affected source was not found for this provider asset.",
              })
            )
          : Effect.succeed(source)
      })
    )

  const getProviderAssetReplay: AssetCanonicalizationServiceShape["getProviderAssetReplay"] = ({
    providerAssetRowId,
    sourceId,
    jobId,
  }) =>
    Effect.gen(function* () {
      const source = yield* loadAffectedSource({ providerAssetRowId, sourceId })
      return yield* sourceSyncService
        .getSourceSyncJob({ principalId: source.principalId, sourceId, jobId })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SourceSyncJobNotFoundError"
              ? new AssetCanonicalizationNotFoundError({ message: "Replay job was not found." })
              : new AssetCanonicalizationInternalError({
                  message: "Failed to load the replay job.",
                })
          )
        )
    })

  const retryProviderAssetReplay: AssetCanonicalizationServiceShape["retryProviderAssetReplay"] = ({
    providerAssetRowId,
    sourceId,
  }) =>
    Effect.gen(function* () {
      const source = yield* loadAffectedSource({ providerAssetRowId, sourceId })
      return yield* sourceSyncService
        .replaySourceSyncJob({ principalId: source.principalId, sourceId })
        .pipe(
          Effect.mapError(
            () =>
              new AssetCanonicalizationInternalError({
                message: "Failed to queue the source replay.",
              })
          )
        )
    })

  return AssetCanonicalizationService.of({
    listCoinGeckoCandidates,
    canonicalizeProviderAssetFromCoinGecko,
    mapProviderAssetToExisting,
    rejectProviderAsset,
    getProviderAssetReplay,
    retryProviderAssetReplay,
  } satisfies AssetCanonicalizationServiceShape)
})

export const AssetCanonicalizationServiceLive = Layer.effect(AssetCanonicalizationService, make)
