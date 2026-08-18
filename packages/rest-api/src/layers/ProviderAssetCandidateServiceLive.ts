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
import {
  CoinGeckoClient,
  type CoinGeckoCoin,
  type CoinGeckoSearchCoin,
} from "../services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"
import {
  deriveNativeAssetDecimals,
  selectNativePlatform,
} from "../services/coingecko/CoinGeckoPlatformSelection.ts"

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

const representationsShareOwnedIdentity = ({
  left,
  right,
}: {
  readonly left: RepresentationIdentity
  readonly right: RepresentationIdentity
}) =>
  normalize(left.blockchainName) === normalize(right.blockchainName) &&
  ((left.type === "native" && right.type === "native") ||
    (left.contractAddress !== null &&
      matchesAddress(left.contractAddress, right.contractAddress)) ||
    (left.mintAddress !== null && left.mintAddress === right.mintAddress))

const economicAssetTypeForRepresentation = (
  representation: RepresentationIdentity
): AssetCatalogAssetRecord["type"] => (representation.type === "nft" ? "nft" : "fungible")

const economicAssetTypeForProviderAsset = (
  providerAsset: ProviderAssetRecord
): AssetCatalogAssetRecord["type"] | null => {
  const providerType = providerAsset.providerType?.trim().toLowerCase() ?? null

  return providerType === "nft" ? "nft" : providerType === "crypto" ? "fungible" : null
}

type ProposedRepresentation = RepresentationIdentity

interface CoinGeckoCandidateDetail {
  readonly candidate: CoinGeckoSearchCoin
  readonly coin: CoinGeckoCoin
}

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
            decimals: deriveNativeAssetDecimals({ coinId: coin.id, platform: nativePlatform }),
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
  if (reviewEvidenceState === "conflicting" || reviewEvidenceState === "insufficient") {
    return reviewEvidenceState
  }
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

  const loadMatchingAssets = ({
    includeSpamRepresentations = false,
    query,
  }: {
    readonly includeSpamRepresentations?: boolean
    readonly query: string
  }) => {
    const loop = (
      cursor: { readonly assetId: string } | null,
      pages: ReadonlyArray<ReadonlyArray<AssetCatalogAssetRecord>>
    ): Effect.Effect<
      ReadonlyArray<ReadonlyArray<AssetCatalogAssetRecord>>,
      ProviderAssetCandidateError
    > =>
      assetCatalog.listAssets({ cursor, query, limit: PAGE_SIZE, includeSpamRepresentations }).pipe(
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
    requiredCoinGeckoCoinId,
  }: {
    readonly providerAssetRowId: string
    readonly query: string | null
    readonly requiredCoinGeckoCoinId?: string
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
      const ownershipQueries = [
        ...new Set(
          observed.flatMap(({ blockchainName, representationType, contractAddress, mintAddress }) =>
            [
              contractAddress,
              mintAddress,
              ...(representationType === "native" ? [blockchainName] : []),
            ].filter((address): address is string => address !== null && address.trim() !== "")
          )
        ),
      ]
      const [textMatchedAssets, ownershipAssetGroups] = yield* Effect.all([
        loadMatchingAssets({ query: searchQuery }),
        Effect.forEach(
          ownershipQueries,
          (ownershipQuery) =>
            loadMatchingAssets({
              query: ownershipQuery,
              includeSpamRepresentations: true,
            }),
          { concurrency: 5 }
        ),
      ])
      const ownershipAssets = ownershipAssetGroups.flat()
      const coinDetails = yield* requiredCoinGeckoCoinId === undefined
        ? Effect.gen(function* () {
            const searchCoins = yield* loadCoinGeckoMatches({
              query: searchQuery,
              symbol: providerAsset.currencyCode,
            }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<CoinGeckoSearchCoin>>([])))
            const groups = yield* Effect.forEach(
              searchCoins,
              (candidate) =>
                coinGecko.getCoin({ coinId: candidate.id }).pipe(
                  Effect.mapError(
                    () =>
                      new ProviderAssetCandidateError({
                        message: "CoinGecko candidate failed.",
                      })
                  ),
                  Effect.map(
                    (coin): ReadonlyArray<CoinGeckoCandidateDetail> =>
                      normalize(coin.symbol) === normalize(providerAsset.currencyCode)
                        ? [{ candidate, coin }]
                        : []
                  ),
                  Effect.catch(() => Effect.succeed<ReadonlyArray<CoinGeckoCandidateDetail>>([]))
                ),
              { concurrency: 5 }
            )
            return groups.flat()
          })
        : coinGecko.getCoin({ coinId: requiredCoinGeckoCoinId }).pipe(
            Effect.mapError(
              () => new ProviderAssetCandidateError({ message: "CoinGecko candidate failed." })
            ),
            Effect.map(
              (coin): ReadonlyArray<CoinGeckoCandidateDetail> =>
                normalize(coin.symbol) === normalize(providerAsset.currencyCode)
                  ? [
                      {
                        candidate: { id: coin.id, name: coin.name, symbol: coin.symbol },
                        coin,
                      },
                    ]
                  : []
            )
          )
      const coinDetailsById = new Map(coinDetails.map((detail) => [detail.coin.id, detail]))
      const identityAssets = yield* Effect.forEach(
        coinDetails,
        ({ coin }) =>
          assetCatalog.findAssetByCoinGeckoId({ coingeckoCoinId: coin.id }).pipe(
            Effect.mapError(
              () =>
                new ProviderAssetCandidateError({
                  message: "TaxMaxi CoinGecko identity lookup failed.",
                })
            ),
            Effect.map(
              Option.match({
                onNone: (): ReadonlyArray<AssetCatalogAssetRecord> => [],
                onSome: (asset): ReadonlyArray<AssetCatalogAssetRecord> => [asset],
              })
            )
          ),
        { concurrency: 5 }
      ).pipe(Effect.map((groups) => groups.flat()))
      const proposalAssetsById = new Map<string, AssetCatalogAssetRecord>()
      for (const asset of [...textMatchedAssets, ...identityAssets]) {
        proposalAssetsById.set(asset.id, asset)
      }
      for (const asset of ownershipAssets) {
        const visibleRepresentations = asset.representations.filter(
          (representation) => representation.isSpam !== true
        )
        if (visibleRepresentations.length === 0) continue

        const existing = proposalAssetsById.get(asset.id)
        proposalAssetsById.set(asset.id, {
          ...asset,
          representations: [
            ...(existing?.representations ?? []),
            ...visibleRepresentations.filter(
              ({ id }) =>
                !existing?.representations.some((representation) => representation.id === id)
            ),
          ],
        })
      }
      const proposalAssets = [...proposalAssetsById.values()]
      const identityAssetIds = new Set(identityAssets.map(({ id }) => id))

      const proposals: Array<ProviderAssetResolutionProposal> = []
      const coinIdsResolvedByExistingAssets = new Set(
        identityAssets.flatMap((asset) =>
          asset.coingeckoCoinId === null ? [] : [asset.coingeckoCoinId]
        )
      )

      for (const asset of proposalAssets) {
        const hasCoinGeckoIdentity = identityAssetIds.has(asset.id)
        const symbolMatches = normalize(asset.symbol) === normalize(providerAsset.currencyCode)
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

        if (observed.length === 0 && (symbolMatches || hasCoinGeckoIdentity)) {
          const identityCandidate =
            asset.coingeckoCoinId === null
              ? undefined
              : coinDetailsById.get(asset.coingeckoCoinId)?.candidate
          const expectedAssetType = economicAssetTypeForProviderAsset(providerAsset)
          const strength = evidenceStrengthFor({
            providerAsset,
            candidate: identityCandidate ?? asset,
          })
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
            evidenceStrength: strength,
            matchReasons: ["Compatible chainless economic asset."],
            conflicts:
              expectedAssetType === null || asset.type === expectedAssetType
                ? []
                : [
                    `Provider type ${providerAsset.providerType} requires a ${expectedAssetType} economic asset, but TaxMaxi asset ${asset.id} is ${asset.type}.`,
                  ],
            warnings:
              strength === "symbol_only"
                ? ["Symbol-only evidence requires an explicit choice."]
                : [],
            investigationLinks:
              asset.coingeckoCoinId === null ? [] : [coinGeckoLink(asset.coingeckoCoinId)],
          })
        }

        if (matchingRepresentations.length === 0 && (symbolMatches || hasCoinGeckoIdentity)) {
          const compatibleCoinDetails =
            asset.coingeckoCoinId === null
              ? coinDetails.filter(
                  ({ candidate }) =>
                    normalize(candidate.symbol) === normalize(asset.symbol) &&
                    normalize(candidate.name) === normalize(asset.name)
                )
              : [coinDetailsById.get(asset.coingeckoCoinId)].filter(
                  (detail): detail is CoinGeckoCandidateDetail => detail !== undefined
                )

          for (const detail of compatibleCoinDetails) {
            const proposed = proposedRepresentationsFor({
              coin: detail.coin,
              providerAsset,
            }).find((representation) =>
              observed.some((observation) =>
                observedMatchesRepresentation({ observed: observation, representation })
              )
            )
            if (proposed === undefined) continue

            const representationOwner = ownershipAssets.find(
              (owner) =>
                owner.id !== asset.id &&
                owner.representations.some((representation) =>
                  representationsShareOwnedIdentity({ left: proposed, right: representation })
                )
            )
            const expectedAssetType = economicAssetTypeForRepresentation(proposed)
            const conflicts = [
              ...(asset.type === expectedAssetType
                ? []
                : [
                    `Representation type ${proposed.type} requires a ${expectedAssetType} economic asset, but TaxMaxi asset ${asset.id} is ${asset.type}.`,
                  ]),
              ...(representationOwner === undefined
                ? []
                : [`Representation is already owned by TaxMaxi asset ${representationOwner.id}.`]),
            ]
            coinIdsResolvedByExistingAssets.add(detail.coin.id)
            proposals.push({
              id: `add-representation:${asset.id}:${detail.coin.id}`,
              effect: {
                _tag: "AddRepresentation",
                canonicalAssetId: asset.id,
                selectedCoinGeckoCoinId: detail.coin.id,
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
              conflicts,
              warnings: [],
              investigationLinks: [coinGeckoLink(detail.coin.id)],
            })
          }
        }
      }

      for (const { candidate, coin } of coinDetails) {
        if (coinIdsResolvedByExistingAssets.has(coin.id)) continue
        const matchingRepresentation = proposedRepresentationsFor({ coin, providerAsset }).find(
          (representation) =>
            observed.some((observation) =>
              observedMatchesRepresentation({ observed: observation, representation })
            )
        )
        const strength = evidenceStrengthFor({ providerAsset, candidate })
        const representationOwner =
          matchingRepresentation === undefined
            ? undefined
            : ownershipAssets.find((asset) =>
                asset.representations.some((representation) =>
                  representationsShareOwnedIdentity({
                    left: matchingRepresentation,
                    right: representation,
                  })
                )
              )
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
            conflicts:
              representationOwner === undefined
                ? []
                : [`Representation is already owned by TaxMaxi asset ${representationOwner.id}.`],
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
