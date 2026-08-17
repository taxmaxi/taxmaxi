/**
 * ProviderAssetCandidateServiceLive - Evidence-backed provider asset proposals.
 *
 * @module ProviderAssetCandidateServiceLive
 */

import { AssetCatalogRepository, type AssetCatalogAssetRecord } from "@my/persistence/services"
import {
  ProviderAssetRepository,
  type ProviderAssetObservedRepresentationRecord,
  type ProviderAssetRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ProviderAssetCandidateService,
  ProviderAssetCandidateError,
} from "../services/ProviderAssetCandidateService.ts"
import type {
  ProviderAssetInvestigationLink,
  ProviderAssetResolutionProposal,
  ProviderAssetResolutionProposalSearchResult,
} from "../services/ProviderAssetReviewService.ts"
import { CoinGeckoClient, type CoinGeckoCoin } from "../services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"
import { selectNativePlatform } from "../services/coingecko/CoinGeckoPlatformSelection.ts"

const PAGE_SIZE = 100

const normalize = (value: string) => value.trim().toLowerCase()

const matchesAddress = (left: string | null, right: string | null) =>
  left !== null && right !== null && normalize(left) === normalize(right)

const evidenceStrengthFor = ({
  providerAsset,
  candidate,
}: {
  readonly providerAsset: ProviderAssetRecord
  readonly candidate: { readonly name: string; readonly symbol: string }
}): "name_and_symbol" | "symbol_only" =>
  providerAsset.name !== null && normalize(providerAsset.name) === normalize(candidate.name)
    ? "name_and_symbol"
    : "symbol_only"

const coinGeckoLink = (coinId: string): ProviderAssetInvestigationLink => ({
  _tag: "market_data",
  label: "View on CoinGecko",
  source: "coingecko",
  url: `https://www.coingecko.com/en/coins/${encodeURIComponent(coinId)}`,
})

interface RepresentationIdentity {
  readonly blockchainName: string
  readonly type: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}

const observedMatchesRepresentation = ({
  observed,
  representation,
}: {
  readonly observed: ProviderAssetObservedRepresentationRecord
  readonly representation: RepresentationIdentity
}) =>
  normalize(observed.blockchainName) === normalize(representation.blockchainName) &&
  observed.representationType !== null &&
  observed.representationType === representation.type &&
  observed.decimals !== null &&
  observed.decimals === representation.decimals &&
  (observed.representationType === "native"
    ? observed.contractAddress === null &&
      observed.mintAddress === null &&
      representation.contractAddress === null &&
      representation.mintAddress === null
    : (observed.contractAddress !== null &&
        matchesAddress(observed.contractAddress, representation.contractAddress)) ||
      (observed.mintAddress !== null && observed.mintAddress === representation.mintAddress))

type ProposedRepresentation = RepresentationIdentity

const proposedRepresentationsFor = ({
  coin,
  providerAsset,
}: {
  readonly coin: CoinGeckoCoin
  readonly providerAsset: ProviderAssetRecord
}): ReadonlyArray<ProposedRepresentation> => {
  const nativePlatform = selectNativePlatform({
    coinId: coin.id,
    assetPlatforms: coinGeckoAssetPlatformSnapshot,
  })
  const native =
    nativePlatform === null
      ? []
      : [
          {
            blockchainName: nativePlatform.id,
            type: "native" as const,
            contractAddress: null,
            mintAddress: null,
            decimals: providerAsset.exponent,
          },
        ]
  const tokens = Object.entries(coin.platforms).flatMap(([platformId, address]) => {
    const trimmed = address.trim()
    if (trimmed === "") return []
    const platform = coinGeckoAssetPlatformSnapshot.find(({ id }) => id === platformId)
    const isSolana = platformId === "solana" || platform?.name.toLowerCase() === "solana"

    return [
      {
        blockchainName: platformId,
        type: providerAsset.providerType === "nft" ? ("nft" as const) : ("token" as const),
        contractAddress: isSolana ? null : trimmed,
        mintAddress: isSolana ? trimmed : null,
        decimals: coin.detail_platforms[platformId]?.decimal_place ?? providerAsset.exponent,
      },
    ]
  })

  return [...native, ...tokens]
}

const proposalRank = (proposal: ProviderAssetResolutionProposal): number => {
  switch (proposal.effect._tag) {
    case "UseExistingRepresentation":
      return 0
    case "UseExistingAsset":
      return 1
    case "AddRepresentation":
      return 2
    case "CreateEconomicAsset":
      return 3
    case "CreateAssetWithRepresentation":
      return 4
  }
}

const evidenceStateFor = ({
  reviewEvidenceState,
  exactProposalCount,
  proposalCount,
}: {
  readonly reviewEvidenceState: ProviderAssetResolutionProposalSearchResult["evidenceState"]
  readonly exactProposalCount: number
  readonly proposalCount: number
}): ProviderAssetResolutionProposalSearchResult["evidenceState"] => {
  if (reviewEvidenceState === "conflicting") return "conflicting"
  if (exactProposalCount === 1) return "exact"
  if (proposalCount === 0) return "insufficient"
  return "ambiguous"
}

const make = Effect.gen(function* () {
  const providerAssets = yield* ProviderAssetRepository
  const assetCatalog = yield* AssetCatalogRepository
  const coinGecko = yield* CoinGeckoClient

  const loadReview = (providerAssetRowId: string) =>
    providerAssets.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () => new ProviderAssetCandidateError({ message: "Failed to load provider asset." })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ProviderAssetCandidateError({ message: "Provider asset not found." })),
          onSome: Effect.succeed,
        })
      )
    )

  const loadMatchingAssets = (query: string) => {
    const loop = (
      cursor: { readonly assetId: string } | null,
      pages: ReadonlyArray<ReadonlyArray<AssetCatalogAssetRecord>>
    ): Effect.Effect<
      ReadonlyArray<ReadonlyArray<AssetCatalogAssetRecord>>,
      ProviderAssetCandidateError
    > =>
      assetCatalog.listAssets({ cursor, query, limit: PAGE_SIZE }).pipe(
        Effect.mapError(
          () => new ProviderAssetCandidateError({ message: "TaxMaxi asset search failed." })
        ),
        Effect.flatMap((page) => {
          const next = page.at(-1)
          return page.length < PAGE_SIZE || next === undefined
            ? Effect.succeed([...pages, page])
            : loop({ assetId: next.id }, [...pages, page])
        })
      )

    return loop(null, []).pipe(Effect.map((pages) => pages.flat()))
  }

  const loadCoinGeckoMatches = ({
    query,
    symbol,
  }: {
    readonly query: string
    readonly symbol: string
  }) =>
    coinGecko.searchCoins({ query }).pipe(
      Effect.mapError(
        () => new ProviderAssetCandidateError({ message: "CoinGecko search failed." })
      ),
      Effect.map((coins) => coins.filter((coin) => normalize(coin.symbol) === normalize(symbol)))
    )

  const searchProposals = ({
    providerAssetRowId,
    query,
  }: {
    readonly providerAssetRowId: string
    readonly query: string | null
  }) =>
    Effect.gen(function* () {
      const review = yield* loadReview(providerAssetRowId)
      const providerAsset = review.providerAsset
      const observed = yield* providerAssets
        .listProviderAssetObservedRepresentations({ providerAssetRowId })
        .pipe(
          Effect.mapError(
            () => new ProviderAssetCandidateError({ message: "Failed to load exact evidence." })
          )
        )
      const searchQuery = query?.trim() || providerAsset.currencyCode
      const [assets, searchCoins] = yield* Effect.all([
        loadMatchingAssets(searchQuery),
        loadCoinGeckoMatches({ query: searchQuery, symbol: providerAsset.currencyCode }),
      ])
      const coinDetails = yield* Effect.forEach(
        searchCoins,
        (candidate) =>
          coinGecko.getCoin({ coinId: candidate.id }).pipe(
            Effect.mapError(
              () => new ProviderAssetCandidateError({ message: "CoinGecko candidate failed." })
            ),
            Effect.map((coin) => ({ candidate, coin }))
          ),
        { concurrency: 5 }
      )
      const coinDetailsById = new Map(coinDetails.map((detail) => [detail.coin.id, detail]))

      const proposals: Array<ProviderAssetResolutionProposal> = []

      for (const asset of assets) {
        const matchingRepresentations = asset.representations.filter((representation) =>
          observed.some((observation) =>
            observedMatchesRepresentation({ observed: observation, representation })
          )
        )
        for (const representation of matchingRepresentations) {
          proposals.push({
            id: `existing-representation:${asset.id}:${representation.id}`,
            effect: {
              _tag: "UseExistingRepresentation",
              canonicalAssetId: asset.id,
              assetRepresentationId: representation.id,
            },
            economicAsset: {
              _tag: "existing",
              id: asset.id,
              name: asset.name,
              symbol: asset.symbol,
              coinGeckoCoinId: asset.coingeckoCoinId,
            },
            representation: {
              _tag: "existing",
              id: representation.id,
              blockchainName: representation.blockchainName,
              representationType: representation.type,
              contractAddress: representation.contractAddress,
              mintAddress: representation.mintAddress,
              decimals: representation.decimals,
            },
            evidenceStrength: "exact",
            matchReasons: ["Exact observed network representation match."],
            conflicts: [],
            warnings: [],
            investigationLinks: [],
          })
        }

        if (observed.length === 0) {
          proposals.push({
            id: `existing-asset:${asset.id}`,
            effect: { _tag: "UseExistingAsset", canonicalAssetId: asset.id },
            economicAsset: {
              _tag: "existing",
              id: asset.id,
              name: asset.name,
              symbol: asset.symbol,
              coinGeckoCoinId: asset.coingeckoCoinId,
            },
            representation: null,
            evidenceStrength: evidenceStrengthFor({ providerAsset, candidate: asset }),
            matchReasons: ["Compatible chainless economic asset."],
            conflicts: [],
            warnings: [],
            investigationLinks:
              asset.coingeckoCoinId === null ? [] : [coinGeckoLink(asset.coingeckoCoinId)],
          })
        }

        if (asset.coingeckoCoinId !== null && matchingRepresentations.length === 0) {
          const detail = coinDetailsById.get(asset.coingeckoCoinId)
          const proposed =
            detail?.coin === undefined
              ? undefined
              : proposedRepresentationsFor({ coin: detail.coin, providerAsset }).find(
                  (representation) =>
                    observed.some((observation) =>
                      observedMatchesRepresentation({ observed: observation, representation })
                    )
                )
          if (proposed !== undefined) {
            proposals.push({
              id: `add-representation:${asset.id}:${asset.coingeckoCoinId}`,
              effect: {
                _tag: "AddRepresentation",
                canonicalAssetId: asset.id,
                selectedCoinGeckoCoinId: asset.coingeckoCoinId,
              },
              economicAsset: {
                _tag: "existing",
                id: asset.id,
                name: asset.name,
                symbol: asset.symbol,
                coinGeckoCoinId: asset.coingeckoCoinId,
              },
              representation: {
                _tag: "proposed",
                ...proposed,
                representationType: proposed.type,
              },
              evidenceStrength: "exact",
              matchReasons: ["CoinGecko representation matches exact observed identity."],
              conflicts: [],
              warnings: [],
              investigationLinks: [coinGeckoLink(asset.coingeckoCoinId)],
            })
          }
        }
      }

      const existingCoinIds = new Set(
        assets.flatMap((asset) => (asset.coingeckoCoinId === null ? [] : [asset.coingeckoCoinId]))
      )
      for (const { candidate, coin } of coinDetails) {
        if (existingCoinIds.has(coin.id)) continue
        const matchingRepresentation = proposedRepresentationsFor({ coin, providerAsset }).find(
          (representation) =>
            observed.some((observation) =>
              observedMatchesRepresentation({ observed: observation, representation })
            )
        )
        const strength = evidenceStrengthFor({ providerAsset, candidate })
        if (observed.length === 0) {
          proposals.push({
            id: `create-economic-asset:${coin.id}`,
            effect: { _tag: "CreateEconomicAsset", selectedCoinGeckoCoinId: coin.id },
            economicAsset: {
              _tag: "proposed",
              coinGeckoCoinId: coin.id,
              name: coin.name,
              symbol: coin.symbol.toUpperCase(),
            },
            representation: null,
            evidenceStrength: strength,
            matchReasons: [
              strength === "name_and_symbol"
                ? "Provider name and symbol match CoinGecko."
                : "Provider symbol matches CoinGecko.",
            ],
            conflicts: [],
            warnings:
              strength === "symbol_only"
                ? ["Symbol-only evidence requires an explicit choice."]
                : [],
            investigationLinks: [coinGeckoLink(coin.id)],
          })
        } else if (matchingRepresentation !== undefined) {
          proposals.push({
            id: `create-asset-with-representation:${coin.id}`,
            effect: {
              _tag: "CreateAssetWithRepresentation",
              selectedCoinGeckoCoinId: coin.id,
            },
            economicAsset: {
              _tag: "proposed",
              coinGeckoCoinId: coin.id,
              name: coin.name,
              symbol: coin.symbol.toUpperCase(),
            },
            representation: {
              _tag: "proposed",
              ...matchingRepresentation,
              representationType: matchingRepresentation.type,
            },
            evidenceStrength: "exact",
            matchReasons: ["CoinGecko contract or mint matches the observed identity."],
            conflicts: [],
            warnings: [],
            investigationLinks: [coinGeckoLink(coin.id)],
          })
        }
      }

      proposals.sort(
        (left, right) => proposalRank(left) - proposalRank(right) || left.id.localeCompare(right.id)
      )
      const exact = proposals.filter(
        (proposal) => proposal.evidenceStrength === "exact" && proposal.conflicts.length === 0
      )
      const evidenceState = evidenceStateFor({
        reviewEvidenceState: review.evidenceState,
        exactProposalCount: exact.length,
        proposalCount: proposals.length,
      })

      return {
        evidenceState,
        recommendedProposalId:
          evidenceState === "exact" && exact.length === 1 ? (exact[0]?.id ?? null) : null,
        proposals,
      } satisfies ProviderAssetResolutionProposalSearchResult
    })

  return ProviderAssetCandidateService.of({ searchProposals })
})

/** Live candidate resolver. */
export const ProviderAssetCandidateServiceLive = Layer.effect(ProviderAssetCandidateService, make)
