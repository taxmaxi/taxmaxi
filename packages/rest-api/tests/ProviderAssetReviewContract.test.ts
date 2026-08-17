import { describe, expect, it } from "vitest"
import { AssetCatalogRepository, type AssetCatalogRepositoryShape } from "@my/persistence/services"
import {
  ProviderAssetRepository,
  SyncEngineStorageError,
  type ProviderAssetRepositoryShape,
  type ProviderAssetReviewRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { ProviderAssetReviewServiceLive } from "../src/layers/ProviderAssetReviewServiceLive.ts"
import { ProviderAssetCandidateServiceLive } from "../src/layers/ProviderAssetCandidateServiceLive.ts"
import {
  AssetCanonicalizationInternalError,
  AssetCanonicalizationService,
  type AssetCanonicalizationServiceShape,
} from "../src/services/AssetCanonicalizationService.ts"
import {
  ProviderAssetCandidateService,
  type ProviderAssetCandidateServiceShape,
} from "../src/services/ProviderAssetCandidateService.ts"
import { ProviderAssetReviewService } from "../src/services/ProviderAssetReviewService.ts"
import {
  CoinGeckoClient,
  CoinGeckoClientError,
  type CoinGeckoClientShape,
} from "../src/services/coingecko/CoinGeckoClient.ts"
import { ProviderAssetReplayService } from "@my/sync-engine/services"

const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000001"
const SOURCE_ID = "00000000-0000-4000-8000-000000000002"

const review: ProviderAssetReviewRecord = {
  providerAsset: {
    id: PROVIDER_ASSET_ID,
    provider: "helius-solana",
    providerAssetId: "So11111111111111111111111111111111111111112",
    naturalKey: "solana:mint:So11111111111111111111111111111111111111112",
    currencyCode: "SOL",
    name: "Wrapped SOL",
    exponent: 9,
    providerType: "spl-token",
    rawProviderPayload: { image: "https://example.com/sol.png" },
    discoveredAt: new Date("2026-08-17T08:00:00.000Z"),
    retrievedAt: new Date("2026-08-17T09:00:00.000Z"),
  },
  mapping: {
    providerAssetRowId: PROVIDER_ASSET_ID,
    mappingKind: "asset",
    canonicalAssetId: null,
    assetRepresentationId: null,
    canonicalFiatCurrency: null,
    mappingStatus: "pending_review",
    reviewerNotes: null,
    sourceNotes: "Observed while syncing source.",
    reviewedBy: null,
    reviewedAt: null,
    updatedAt: new Date("2026-08-17T09:00:00.000Z"),
  },
  evidenceState: "exact",
  evidenceRevision: "evidence-v1",
  affectedSourceCount: 1,
}

const unexpected = () => Effect.die("Unexpected test call")

const repository: ProviderAssetRepositoryShape = {
  upsertProviderAssets: unexpected,
  upsertProviderAssetMappings: unexpected,
  approveProviderAssetMappingAndRequestReplay: unexpected,
  rejectProviderAssetMapping: unexpected,
  findProviderAssetReviewReplay: unexpected,
  listProviderAssetReviewReplays: () =>
    Effect.succeed([
      {
        sourceId: SOURCE_ID,
        principalId: "00000000-0000-4000-8000-000000000003",
        jobId: "00000000-0000-4000-8000-000000000004",
        dispatchState: "queued",
        errorMessage: null,
      },
    ]),
  replaceProviderAssetReviewReplay: unexpected,
  reserveProviderAssetReviewReplayRetry: unexpected,
  markProviderAssetReviewReplayDispatch: unexpected,
  lockProviderAssetApprovalSnapshot: unexpected,
  recordProviderAssetSourceUses: unexpected,
  seedProviderAssetMappingsIfMissing: unexpected,
  findProviderAssetByProviderAssetId: unexpected,
  findProviderAssetByNaturalKey: unexpected,
  findProviderAssetByCurrencyCode: unexpected,
  findProviderAssetReviewById: () => Effect.succeed(Option.some(review)),
  listProviderAssetReviews: () => Effect.succeed([review]),
  listProviderAssetObservedRepresentations: () =>
    Effect.succeed([
      {
        blockchainName: "solana",
        representationType: "token",
        contractAddress: null,
        mintAddress: "So11111111111111111111111111111111111111112",
        decimals: 9,
      },
    ]),
  findProviderAssetMapping: unexpected,
}

const canonicalization: AssetCanonicalizationServiceShape = {
  approveProviderAssetMapping: unexpected,
  canonicalizeEconomicAssetFromCoinGecko: unexpected,
  canonicalizeProviderAssetFromCoinGecko: unexpected,
}

const candidates: ProviderAssetCandidateServiceShape = {
  searchProposals: () =>
    Effect.succeed({
      evidenceState: "exact",
      recommendedProposalId: "existing-representation:asset:representation",
      proposals: [
        {
          id: "existing-representation:asset:representation",
          effect: {
            _tag: "UseExistingRepresentation",
            canonicalAssetId: "asset",
            assetRepresentationId: "representation",
          },
          economicAsset: {
            _tag: "existing",
            id: "asset",
            name: "Wrapped SOL",
            symbol: "SOL",
            coinGeckoCoinId: "wrapped-solana",
          },
          representation: {
            _tag: "existing",
            id: "representation",
            blockchainName: "solana",
            representationType: "token",
            contractAddress: null,
            mintAddress: "So11111111111111111111111111111111111111112",
            decimals: 9,
          },
          evidenceStrength: "exact",
          matchReasons: ["Exact Solana mint match."],
          conflicts: [],
          warnings: [],
          investigationLinks: [],
        },
      ],
    }),
}

const assetCatalog: AssetCatalogRepositoryShape = {
  listAssets: () =>
    Effect.succeed([
      {
        id: "00000000-0000-4000-8000-000000000010",
        name: "Wrapped SOL",
        symbol: "SOL",
        coingeckoCoinId: null,
        logoUrl: null,
        type: "fungible",
        representations: [
          {
            id: "00000000-0000-4000-8000-000000000011",
            blockchainId: "00000000-0000-4000-8000-000000000013",
            blockchainName: "solana",
            blockchainChainType: "solana",
            blockchainChainId: null,
            blockchainExplorerUrl: null,
            blockchainLogoUrl: null,
            type: "token",
            contractAddress: null,
            mintAddress: "So11111111111111111111111111111111111111112",
            decimals: 9,
            logoUrl: null,
            metadata: null,
          },
        ],
      },
    ]),
  listPendingAssets: unexpected,
  findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
  findAssetById: unexpected,
}

const coinGecko: CoinGeckoClientShape = {
  searchCoins: () => Effect.succeed([]),
  getCoin: unexpected,
  listMarkets: unexpected,
}

const runCandidateSearch = ({
  candidateRepository = repository,
  catalog = assetCatalog,
  client = coinGecko,
  query = null,
  requiredCoinGeckoCoinId,
}: {
  readonly candidateRepository?: ProviderAssetRepositoryShape
  readonly catalog?: AssetCatalogRepositoryShape
  readonly client?: CoinGeckoClientShape
  readonly query?: string | null
  readonly requiredCoinGeckoCoinId?: string
}) =>
  Effect.runPromise(
    Effect.flatMap(ProviderAssetCandidateService, (service) =>
      service.searchProposals({
        providerAssetRowId: PROVIDER_ASSET_ID,
        query,
        ...(requiredCoinGeckoCoinId === undefined ? {} : { requiredCoinGeckoCoinId }),
      })
    ).pipe(
      Effect.provide(
        ProviderAssetCandidateServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderAssetRepository, candidateRepository),
              Layer.succeed(AssetCatalogRepository, catalog),
              Layer.succeed(CoinGeckoClient, client)
            )
          )
        )
      )
    )
  )

describe("ProviderAssetReviewService admin contract", () => {
  it("lists and reads review evidence through the same public interface", async () => {
    const program = Effect.gen(function* () {
      const service = yield* ProviderAssetReviewService
      const rows = yield* service.listReviews({
        provider: "helius-solana",
        status: "pending_review",
        evidenceState: "exact",
        query: "So111",
        cursor: null,
        limit: 25,
      })
      const detail = yield* service.getReview({ providerAssetRowId: PROVIDER_ASSET_ID })
      return { rows, detail }
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ProviderAssetReviewServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, repository),
                Layer.succeed(AssetCanonicalizationService, canonicalization),
                Layer.succeed(ProviderAssetCandidateService, candidates),
                Layer.succeed(ProviderAssetReplayService, {
                  scheduleReplays: () => Effect.succeed([]),
                  getReplay: ({ sourceId, jobId }) =>
                    Effect.succeed({ sourceId, jobId, status: "queued", message: null }),
                  retryReplay: unexpected,
                })
              )
            )
          )
        )
      )
    )

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      id: PROVIDER_ASSET_ID,
      evidenceState: "exact",
      affectedSourceCount: 1,
      reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
      investigationLinks: [
        {
          _tag: "chain_explorer",
          label: "View mint on Solscan",
          source: "solscan",
          url: "https://solscan.io/token/So11111111111111111111111111111111111111112",
        },
      ],
    })
    expect(result.detail.observedRepresentations).toEqual([
      expect.objectContaining({ mintAddress: "So11111111111111111111111111111111111111112" }),
    ])
    expect(result.detail.investigationLinks).toEqual([
      {
        _tag: "chain_explorer",
        label: "View mint on Solscan",
        source: "solscan",
        url: "https://solscan.io/token/So11111111111111111111111111111111111111112",
      },
    ])
    expect(result.detail.replays).toEqual([
      expect.objectContaining({ sourceId: SOURCE_ID, status: "queued" }),
    ])
  })

  it("returns an explicit five-effect proposal contract and one exact recommendation", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.searchProposals({
          providerAssetRowId: PROVIDER_ASSET_ID,
          query: "wrapped sol",
        })
      ).pipe(
        Effect.provide(
          ProviderAssetReviewServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, repository),
                Layer.succeed(AssetCanonicalizationService, canonicalization),
                Layer.succeed(ProviderAssetCandidateService, candidates),
                Layer.succeed(ProviderAssetReplayService, {
                  scheduleReplays: () => Effect.succeed([]),
                  getReplay: unexpected,
                  retryReplay: unexpected,
                })
              )
            )
          )
        )
      )
    )

    expect(result.recommendedProposalId).toBe("existing-representation:asset:representation")
    expect(result.proposals[0]).toMatchObject({
      effect: { _tag: "UseExistingRepresentation" },
      evidenceStrength: "exact",
      conflicts: [],
      warnings: [],
    })
  })

  it("keeps local proposals available when CoinGecko search or detail lookup fails", async () => {
    const searchFailure = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.fail(new CoinGeckoClientError({ message: "CoinGecko search timed out." })),
      getCoin: unexpected,
      listMarkets: unexpected,
    })
    const detailFailure = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
      getCoin: () => Effect.fail(new CoinGeckoClientError({ message: "CoinGecko detail failed." })),
      listMarkets: unexpected,
    })

    const [afterSearchFailure, afterDetailFailure] = await Promise.all([
      runCandidateSearch({ client: searchFailure }),
      runCandidateSearch({ client: detailFailure }),
    ])

    for (const result of [afterSearchFailure, afterDetailFailure]) {
      expect(result.proposals).toEqual([
        expect.objectContaining({
          effect: expect.objectContaining({ _tag: "UseExistingRepresentation" }),
        }),
      ])
      expect(result.recommendedProposalId).not.toBeNull()
    }

    await expect(
      runCandidateSearch({
        client: detailFailure,
        requiredCoinGeckoCoinId: "wrapped-solana",
      })
    ).rejects.toMatchObject({
      _tag: "ProviderAssetCandidateError",
      message: "CoinGecko candidate failed.",
    })
  })

  it("filters custom text matches with a different symbol and retains valid symbol neighbors", async () => {
    const chainlessReview: ProviderAssetReviewRecord = {
      ...review,
      providerAsset: {
        ...review.providerAsset,
        provider: "coinbase",
        providerAssetId: "sol",
        naturalKey: null,
        name: "Solana",
        providerType: "crypto",
      },
    }
    const chainlessRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () => Effect.succeed(Option.some(chainlessReview)),
      listProviderAssetObservedRepresentations: () => Effect.succeed([]),
    }
    const makeAsset = ({ symbol }: { readonly symbol: string }) => ({
      id: `asset-${symbol.toLowerCase()}`,
      name: "Custom query match",
      symbol,
      coingeckoCoinId: null,
      logoUrl: null,
      type: "fungible" as const,
      representations: [],
    })
    const mismatchedCatalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: () => Effect.succeed([makeAsset({ symbol: "ETH" })]),
    }
    const neighboringCatalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: () => Effect.succeed([makeAsset({ symbol: "SOL" })]),
    }

    const [mismatched, neighboring] = await Promise.all([
      runCandidateSearch({
        candidateRepository: chainlessRepository,
        catalog: mismatchedCatalog,
        query: "custom query",
      }),
      runCandidateSearch({
        candidateRepository: chainlessRepository,
        catalog: neighboringCatalog,
        query: "custom query",
      }),
    ])

    expect(mismatched.proposals).toEqual([])
    expect(neighboring.proposals).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ _tag: "UseExistingAsset" }),
        evidenceStrength: "symbol_only",
        warnings: ["Symbol-only evidence requires an explicit choice."],
      }),
    ])
  })

  it("preserves an exact observed representation when the local symbol is stale", async () => {
    const staleSymbolCatalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: (params) =>
        assetCatalog
          .listAssets(params)
          .pipe(Effect.map((assets) => assets.map((asset) => ({ ...asset, symbol: "STALE" })))),
    }

    const result = await runCandidateSearch({
      catalog: staleSymbolCatalog,
      query: "custom exact representation",
    })

    expect(result.proposals).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ _tag: "UseExistingRepresentation" }),
        evidenceStrength: "exact",
      }),
    ])
  })

  it("validates a required custom CoinGecko choice by direct id", async () => {
    const chainlessReview: ProviderAssetReviewRecord = {
      ...review,
      providerAsset: {
        ...review.providerAsset,
        provider: "coinbase",
        providerAssetId: "sol",
        naturalKey: null,
        name: "Solana",
        providerType: "crypto",
      },
    }
    const chainlessRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () => Effect.succeed(Option.some(chainlessReview)),
      listProviderAssetObservedRepresentations: () => Effect.succeed([]),
    }
    const identityAsset = {
      id: "00000000-0000-4000-8000-000000000010",
      name: "Solana",
      symbol: "STALE",
      coingeckoCoinId: "custom-solana",
      logoUrl: null,
      type: "fungible" as const,
      representations: [],
    }
    const identityCatalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: () => Effect.succeed([]),
      findAssetByCoinGeckoId: ({ coingeckoCoinId }) =>
        Effect.succeed(
          coingeckoCoinId === identityAsset.coingeckoCoinId
            ? Option.some(identityAsset)
            : Option.none()
        ),
    }
    const directClient = CoinGeckoClient.of({
      searchCoins: () => Effect.die("Required choices must not depend on search results"),
      getCoin: ({ coinId }) =>
        Effect.succeed({
          id: coinId,
          symbol: "sol",
          name: "Solana",
          asset_platform_id: null,
          platforms: {},
          detail_platforms: {},
        }),
      listMarkets: unexpected,
    })
    const mismatchedDirectClient = CoinGeckoClient.of({
      ...directClient,
      getCoin: ({ coinId }) =>
        Effect.succeed({
          id: coinId,
          symbol: "eth",
          name: "Ethereum",
          asset_platform_id: null,
          platforms: {},
          detail_platforms: {},
        }),
    })

    const [result, mismatched] = await Promise.all([
      runCandidateSearch({
        candidateRepository: chainlessRepository,
        catalog: identityCatalog,
        client: directClient,
        query: "custom search that no longer returns the choice",
        requiredCoinGeckoCoinId: "custom-solana",
      }),
      runCandidateSearch({
        candidateRepository: chainlessRepository,
        catalog: identityCatalog,
        client: mismatchedDirectClient,
        query: "custom search with a mismatched symbol",
        requiredCoinGeckoCoinId: "custom-solana",
      }),
    ])

    expect(result.proposals).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ _tag: "UseExistingAsset" }),
        evidenceStrength: "name_and_symbol",
      }),
    ])
    expect(mismatched.proposals).toEqual([])
  })

  it.each([
    ["UseExistingRepresentation", true],
    ["AddRepresentation", false],
  ] as const)(
    "returns $0 for a CoinGecko-bound asset outside the custom text results",
    async (expectedEffect, includeRepresentation) => {
      const representation = {
        id: "00000000-0000-4000-8000-000000000011",
        blockchainId: "00000000-0000-4000-8000-000000000013",
        blockchainName: "solana",
        blockchainChainType: "solana",
        blockchainChainId: null,
        blockchainExplorerUrl: null,
        blockchainLogoUrl: null,
        type: "token" as const,
        contractAddress: null,
        mintAddress: "So11111111111111111111111111111111111111112",
        decimals: 9,
        logoUrl: null,
        metadata: null,
      }
      const identityAsset = {
        id: "00000000-0000-4000-8000-000000000010",
        name: "Wrapped SOL",
        symbol: "STALE",
        coingeckoCoinId: "wrapped-solana",
        logoUrl: null,
        type: "fungible" as const,
        representations: includeRepresentation ? [representation] : [],
      }
      const identityCatalog: AssetCatalogRepositoryShape = {
        ...assetCatalog,
        listAssets: () => Effect.succeed([]),
        findAssetByCoinGeckoId: ({ coingeckoCoinId }) =>
          Effect.succeed(
            coingeckoCoinId === "wrapped-solana" ? Option.some(identityAsset) : Option.none()
          ),
      }
      const identityCoinGecko = CoinGeckoClient.of({
        searchCoins: () =>
          Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
        getCoin: () =>
          Effect.succeed({
            id: "wrapped-solana",
            symbol: "sol",
            name: "Wrapped SOL",
            asset_platform_id: "solana",
            platforms: {
              solana: "So11111111111111111111111111111111111111112",
            },
            detail_platforms: {
              solana: {
                contract_address: "So11111111111111111111111111111111111111112",
                decimal_place: 9,
              },
            },
          }),
        listMarkets: unexpected,
      })

      const result = await runCandidateSearch({
        catalog: identityCatalog,
        client: identityCoinGecko,
        query: "custom wrapped token",
      })

      expect(result.proposals).toEqual([
        expect.objectContaining({ effect: expect.objectContaining({ _tag: expectedEffect }) }),
      ])
      expect(
        result.proposals.some(({ effect }) => effect._tag === "CreateAssetWithRepresentation")
      ).toBe(false)
    }
  )

  it.each([
    {
      addressKind: "contract",
      blockchainName: "ethereum",
      description: "a different CoinGecko id and stale symbol",
      identityAddress: "0x1111111111111111111111111111111111111111",
      ownerCoinGeckoCoinId: "stale-wrapped-solana",
      placeOwnerAfterFullPage: false,
    },
    {
      addressKind: "mint",
      blockchainName: "solana",
      description: "no CoinGecko id, stale symbol, and a later catalog page",
      identityAddress: "So11111111111111111111111111111111111111112",
      ownerCoinGeckoCoinId: null,
      placeOwnerAfterFullPage: true,
    },
  ])(
    "prefers the existing representation and conflicts duplicate creation when its owner has $description",
    async ({
      addressKind,
      blockchainName,
      identityAddress,
      ownerCoinGeckoCoinId,
      placeOwnerAfterFullPage,
    }) => {
      const owner = {
        id: "00000000-0000-4000-8000-000000000020",
        name: "Stale local owner",
        symbol: "STALE",
        coingeckoCoinId: ownerCoinGeckoCoinId,
        logoUrl: null,
        type: "fungible" as const,
        representations: [
          {
            id: "00000000-0000-4000-8000-000000000021",
            blockchainId: "00000000-0000-4000-8000-000000000013",
            blockchainName,
            blockchainChainType: addressKind === "contract" ? "evm" : "solana",
            blockchainChainId: addressKind === "contract" ? 1 : null,
            blockchainExplorerUrl: null,
            blockchainLogoUrl: null,
            type: "token" as const,
            contractAddress: addressKind === "contract" ? identityAddress : null,
            mintAddress: addressKind === "mint" ? identityAddress : null,
            decimals: 9,
            logoUrl: null,
            metadata: null,
          },
        ],
      }
      const fillerAssets = Array.from({ length: 100 }, (_, index) => ({
        id: `filler-${index.toString().padStart(3, "0")}`,
        name: "Unrelated asset",
        symbol: "OTHER",
        coingeckoCoinId: null,
        logoUrl: null,
        type: "fungible" as const,
        representations: [],
      }))
      let ownershipPageCalls = 0
      let ownerVisible = false
      const ownershipCatalog: AssetCatalogRepositoryShape = {
        ...assetCatalog,
        listAssets: ({ cursor, query }) => {
          if (query !== identityAddress || !ownerVisible) return Effect.succeed([])

          ownershipPageCalls += 1
          if (placeOwnerAfterFullPage && cursor === null) {
            return Effect.succeed(fillerAssets)
          }
          return Effect.succeed([owner])
        },
        findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
      }
      const ownershipRepository: ProviderAssetRepositoryShape = {
        ...repository,
        listProviderAssetObservedRepresentations: () =>
          Effect.succeed([
            {
              blockchainName,
              representationType: "token",
              contractAddress: addressKind === "contract" ? identityAddress : null,
              mintAddress: addressKind === "mint" ? identityAddress : null,
              decimals: 9,
            },
          ]),
      }
      const matchingCoinGecko = CoinGeckoClient.of({
        searchCoins: () =>
          Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
        getCoin: () =>
          Effect.succeed({
            id: "wrapped-solana",
            symbol: "sol",
            name: "Wrapped SOL",
            asset_platform_id: blockchainName,
            platforms: { [blockchainName]: identityAddress },
            detail_platforms: {
              [blockchainName]: { contract_address: identityAddress, decimal_place: 9 },
            },
          }),
        listMarkets: unexpected,
      })

      const previouslyReceived = await runCandidateSearch({
        candidateRepository: ownershipRepository,
        catalog: ownershipCatalog,
        client: matchingCoinGecko,
      })
      const previouslyReceivedCreate = previouslyReceived.proposals.find(
        ({ effect }) => effect._tag === "CreateAssetWithRepresentation"
      )
      expect(previouslyReceivedCreate).toMatchObject({ conflicts: [] })
      expect(previouslyReceived.recommendedProposalId).toBe(previouslyReceivedCreate?.id)

      ownerVisible = true
      const result = await runCandidateSearch({
        candidateRepository: ownershipRepository,
        catalog: ownershipCatalog,
        client: matchingCoinGecko,
      })
      const existing = result.proposals.find(
        ({ effect }) => effect._tag === "UseExistingRepresentation"
      )
      const duplicateCreate = result.proposals.find(
        ({ effect }) => effect._tag === "CreateAssetWithRepresentation"
      )

      expect(existing).toMatchObject({
        economicAsset: { _tag: "existing", id: owner.id, symbol: "STALE" },
        evidenceStrength: "exact",
        conflicts: [],
      })
      expect(duplicateCreate).toMatchObject({
        economicAsset: { _tag: "proposed", coinGeckoCoinId: "wrapped-solana" },
        evidenceStrength: "exact",
        conflicts: [expect.stringContaining(owner.id)],
      })
      expect(result.recommendedProposalId).toBe(existing?.id)
      expect(ownershipPageCalls).toBe(placeOwnerAfterFullPage ? 2 : 1)

      if (previouslyReceivedCreate === undefined) {
        throw new Error("Expected a previously received duplicate-create proposal.")
      }
      const liveCandidates = ProviderAssetCandidateServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderAssetRepository, ownershipRepository),
            Layer.succeed(AssetCatalogRepository, ownershipCatalog),
            Layer.succeed(CoinGeckoClient, matchingCoinGecko)
          )
        )
      )
      const decision = Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: {
            _tag: "Resolve",
            proposalId: previouslyReceivedCreate.id,
            effect: previouslyReceivedCreate.effect,
          },
          reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
          reviewerNotes: null,
          reviewedBy: "00000000-0000-4000-8000-000000000012",
        })
      )

      await expect(
        Effect.runPromise(
          decision.pipe(
            Effect.provide(
              ProviderAssetReviewServiceLive.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(ProviderAssetRepository, ownershipRepository),
                    Layer.succeed(AssetCanonicalizationService, canonicalization),
                    liveCandidates,
                    Layer.succeed(ProviderAssetReplayService, {
                      scheduleReplays: unexpected,
                      getReplay: unexpected,
                      retryReplay: unexpected,
                    })
                  )
                )
              )
            )
          )
        )
      ).rejects.toMatchObject({
        _tag: "ProviderAssetReviewBadRequestError",
        message: "The selected resolution proposal is no longer valid.",
      })
    }
  )

  it("never recommends a proposal when review evidence is conflicting", async () => {
    const conflictingReview: ProviderAssetReviewRecord = { ...review, evidenceState: "conflicting" }
    const conflictingRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () => Effect.succeed(Option.some(conflictingReview)),
    }
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetCandidateService, (service) =>
        service.searchProposals({ providerAssetRowId: PROVIDER_ASSET_ID, query: null })
      ).pipe(
        Effect.provide(
          ProviderAssetCandidateServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, conflictingRepository),
                Layer.succeed(AssetCatalogRepository, assetCatalog),
                Layer.succeed(CoinGeckoClient, coinGecko)
              )
            )
          )
        )
      )
    )

    expect(result.evidenceState).toBe("conflicting")
    expect(result.proposals).toHaveLength(1)
    expect(result.recommendedProposalId).toBeNull()
  })

  it("keeps an exact local match unrecommended when another observation is incomplete", async () => {
    const insufficientReview: ProviderAssetReviewRecord = {
      ...review,
      evidenceState: "insufficient",
    }
    const insufficientRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () => Effect.succeed(Option.some(insufficientReview)),
      listProviderAssetObservedRepresentations: () =>
        Effect.succeed([
          {
            blockchainName: "solana",
            representationType: "token",
            contractAddress: null,
            mintAddress: "So11111111111111111111111111111111111111112",
            decimals: 9,
          },
          {
            blockchainName: "solana",
            representationType: "token",
            contractAddress: null,
            mintAddress: "DifferentIncompleteMint111111111111111111111",
            decimals: null,
          },
        ]),
    }

    const result = await runCandidateSearch({ candidateRepository: insufficientRepository })

    expect(result.evidenceState).toBe("insufficient")
    expect(result.proposals).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ _tag: "UseExistingRepresentation" }),
      }),
    ])
    expect(result.recommendedProposalId).toBeNull()
  })

  it.each([
    {
      label: "missing decimals",
      observation: {
        blockchainName: "solana",
        representationType: "token" as const,
        contractAddress: null,
        mintAddress: "So11111111111111111111111111111111111111112",
        decimals: null,
      },
    },
    {
      label: "blockchain-only evidence",
      observation: {
        blockchainName: "solana",
        representationType: null,
        contractAddress: null,
        mintAddress: null,
        decimals: null,
      },
    },
  ])("does not treat $label as chainless or exact", async ({ observation }) => {
    const incompleteRepository: ProviderAssetRepositoryShape = {
      ...repository,
      listProviderAssetObservedRepresentations: () => Effect.succeed([observation]),
    }
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetCandidateService, (service) =>
        service.searchProposals({ providerAssetRowId: PROVIDER_ASSET_ID, query: null })
      ).pipe(
        Effect.provide(
          ProviderAssetCandidateServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, incompleteRepository),
                Layer.succeed(AssetCatalogRepository, assetCatalog),
                Layer.succeed(CoinGeckoClient, coinGecko)
              )
            )
          )
        )
      )
    )

    expect(result.evidenceState).toBe("insufficient")
    expect(result.recommendedProposalId).toBeNull()
    expect(result.proposals).toEqual([])
  })

  it("conflicts AddRepresentation when another asset owns the observed mint", async () => {
    const identityAsset = {
      id: "00000000-0000-4000-8000-000000000030",
      name: "Wrapped SOL candidate",
      symbol: "SOL",
      coingeckoCoinId: "wrapped-solana",
      logoUrl: null,
      type: "fungible" as const,
      representations: [],
    }
    const owner = {
      id: "00000000-0000-4000-8000-000000000031",
      name: "Existing mint owner",
      symbol: "STALE",
      coingeckoCoinId: null,
      logoUrl: null,
      type: "fungible" as const,
      representations: [
        {
          id: "00000000-0000-4000-8000-000000000032",
          blockchainId: "00000000-0000-4000-8000-000000000013",
          blockchainName: "solana",
          blockchainChainType: "solana",
          blockchainChainId: null,
          blockchainExplorerUrl: null,
          blockchainLogoUrl: null,
          type: "token" as const,
          contractAddress: null,
          mintAddress: "So11111111111111111111111111111111111111112",
          decimals: 9,
          logoUrl: null,
          metadata: null,
        },
      ],
    }
    const catalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: ({ query }) =>
        Effect.succeed(query === "So11111111111111111111111111111111111111112" ? [owner] : []),
      findAssetByCoinGeckoId: () => Effect.succeed(Option.some(identityAsset)),
    }
    const client = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
      getCoin: () =>
        Effect.succeed({
          id: "wrapped-solana",
          symbol: "sol",
          name: "Wrapped SOL",
          asset_platform_id: "solana",
          platforms: { solana: "So11111111111111111111111111111111111111112" },
          detail_platforms: {
            solana: {
              contract_address: "So11111111111111111111111111111111111111112",
              decimal_place: 9,
            },
          },
        }),
      listMarkets: unexpected,
    })

    const result = await runCandidateSearch({ catalog, client })
    const add = result.proposals.find(({ effect }) => effect._tag === "AddRepresentation")

    expect(add?.conflicts).toEqual([expect.stringContaining(owner.id)])
    expect(result.recommendedProposalId).toContain("existing-representation")
  })

  it("adds an exact representation to a compatible asset without a CoinGecko id", async () => {
    const compatibleAsset = {
      id: "00000000-0000-4000-8000-000000000033",
      name: "Wrapped SOL",
      symbol: "SOL",
      coingeckoCoinId: null,
      logoUrl: null,
      type: "fungible" as const,
      representations: [],
    }
    const catalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: ({ query }) =>
        Effect.succeed(query === review.providerAsset.currencyCode ? [compatibleAsset] : []),
      findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
    }
    const client = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
      getCoin: () =>
        Effect.succeed({
          id: "wrapped-solana",
          symbol: "sol",
          name: "Wrapped SOL",
          asset_platform_id: "solana",
          platforms: { solana: "So11111111111111111111111111111111111111112" },
          detail_platforms: {
            solana: {
              contract_address: "So11111111111111111111111111111111111111112",
              decimal_place: 9,
            },
          },
        }),
      listMarkets: unexpected,
    })

    const result = await runCandidateSearch({ catalog, client })

    expect(result.proposals).toEqual([
      expect.objectContaining({
        id: `add-representation:${compatibleAsset.id}:wrapped-solana`,
        effect: {
          _tag: "AddRepresentation",
          canonicalAssetId: compatibleAsset.id,
          selectedCoinGeckoCoinId: "wrapped-solana",
        },
        conflicts: [],
      }),
    ])
    expect(result.recommendedProposalId).toBe(
      `add-representation:${compatibleAsset.id}:wrapped-solana`
    )
  })

  it("uses spam representations for ownership conflicts without proposing them", async () => {
    const spamOwner = {
      id: "00000000-0000-4000-8000-000000000034",
      name: "Hidden mint owner",
      symbol: "STALE",
      coingeckoCoinId: null,
      logoUrl: null,
      type: "fungible" as const,
      representations: [
        {
          id: "00000000-0000-4000-8000-000000000035",
          blockchainId: "00000000-0000-4000-8000-000000000013",
          blockchainName: "solana",
          blockchainChainType: "solana",
          blockchainChainId: null,
          blockchainExplorerUrl: null,
          blockchainLogoUrl: null,
          type: "token" as const,
          contractAddress: null,
          mintAddress: "So11111111111111111111111111111111111111112",
          decimals: 9,
          logoUrl: null,
          metadata: null,
          isSpam: true,
        },
      ],
    }
    const catalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: ({ includeSpamRepresentations, query }) =>
        Effect.succeed(
          includeSpamRepresentations === true &&
            query === "So11111111111111111111111111111111111111112"
            ? [spamOwner]
            : []
        ),
      findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
    }
    const client = CoinGeckoClient.of({
      searchCoins: () =>
        Effect.succeed([{ id: "wrapped-solana", name: "Wrapped SOL", symbol: "sol" }]),
      getCoin: () =>
        Effect.succeed({
          id: "wrapped-solana",
          symbol: "sol",
          name: "Wrapped SOL",
          asset_platform_id: "solana",
          platforms: { solana: "So11111111111111111111111111111111111111112" },
          detail_platforms: {
            solana: {
              contract_address: "So11111111111111111111111111111111111111112",
              decimal_place: 9,
            },
          },
        }),
      listMarkets: unexpected,
    })

    const result = await runCandidateSearch({ catalog, client })
    const create = result.proposals.find(
      ({ effect }) => effect._tag === "CreateAssetWithRepresentation"
    )

    expect(result.proposals.some(({ effect }) => effect._tag === "UseExistingRepresentation")).toBe(
      false
    )
    expect(create?.conflicts).toEqual([expect.stringContaining(spamOwner.id)])
    expect(result.recommendedProposalId).toBeNull()
  })

  it("finds a stale native owner and uses canonical native decimals", async () => {
    const nativeReview: ProviderAssetReviewRecord = {
      ...review,
      providerAsset: {
        ...review.providerAsset,
        providerAssetId: "ethereum",
        naturalKey: null,
        currencyCode: "ETH",
        name: "Ethereum",
        exponent: 8,
        providerType: "crypto",
      },
    }
    const nativeRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () => Effect.succeed(Option.some(nativeReview)),
      listProviderAssetObservedRepresentations: () =>
        Effect.succeed([
          {
            blockchainName: "ethereum",
            representationType: "native",
            contractAddress: null,
            mintAddress: null,
            decimals: 18,
          },
        ]),
    }
    const owner = {
      id: "00000000-0000-4000-8000-000000000040",
      name: "Stale native owner",
      symbol: "STALE",
      coingeckoCoinId: null,
      logoUrl: null,
      type: "fungible" as const,
      representations: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          blockchainId: "00000000-0000-4000-8000-000000000042",
          blockchainName: "ethereum",
          blockchainChainType: "evm",
          blockchainChainId: 1,
          blockchainExplorerUrl: null,
          blockchainLogoUrl: null,
          type: "native" as const,
          contractAddress: null,
          mintAddress: null,
          decimals: 18,
          logoUrl: null,
          metadata: null,
        },
      ],
    }
    const catalog: AssetCatalogRepositoryShape = {
      ...assetCatalog,
      listAssets: ({ query }) => Effect.succeed(query === "ethereum" ? [owner] : []),
      findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
    }
    const client = CoinGeckoClient.of({
      searchCoins: () => Effect.succeed([{ id: "ethereum", name: "Ethereum", symbol: "eth" }]),
      getCoin: () =>
        Effect.succeed({
          id: "ethereum",
          symbol: "eth",
          name: "Ethereum",
          asset_platform_id: null,
          platforms: {},
          detail_platforms: {},
        }),
      listMarkets: unexpected,
    })

    const result = await runCandidateSearch({
      candidateRepository: nativeRepository,
      catalog,
      client,
    })
    const existing = result.proposals.find(
      ({ effect }) => effect._tag === "UseExistingRepresentation"
    )
    const duplicate = result.proposals.find(
      ({ effect }) => effect._tag === "CreateAssetWithRepresentation"
    )

    expect(existing).toMatchObject({ representation: { decimals: 18 } })
    expect(duplicate?.conflicts).toEqual([expect.stringContaining(owner.id)])
    expect(result.recommendedProposalId).toBe(existing?.id)
  })

  it.each([
    {
      _tag: "UseExistingAsset" as const,
      canonicalAssetId: "00000000-0000-4000-8000-000000000010",
    },
    {
      _tag: "UseExistingRepresentation" as const,
      canonicalAssetId: "00000000-0000-4000-8000-000000000010",
      assetRepresentationId: "00000000-0000-4000-8000-000000000011",
    },
    {
      _tag: "AddRepresentation" as const,
      canonicalAssetId: "00000000-0000-4000-8000-000000000010",
      selectedCoinGeckoCoinId: "wrapped-solana",
    },
    {
      _tag: "CreateEconomicAsset" as const,
      selectedCoinGeckoCoinId: "wrapped-solana",
    },
    {
      _tag: "CreateAssetWithRepresentation" as const,
      selectedCoinGeckoCoinId: "wrapped-solana",
    },
  ])("applies the $._tag resolution effect only at the loaded revision", async (effect) => {
    const pendingMapping = review.mapping
    if (pendingMapping === null) {
      throw new Error("Expected a pending review mapping fixture.")
    }
    const approvedReview: ProviderAssetReviewRecord = {
      ...review,
      mapping: {
        ...pendingMapping,
        canonicalAssetId:
          "canonicalAssetId" in effect
            ? effect.canonicalAssetId
            : "00000000-0000-4000-8000-000000000010",
        assetRepresentationId:
          "assetRepresentationId" in effect ? effect.assetRepresentationId : null,
        mappingStatus: "approved",
        reviewedBy: "00000000-0000-4000-8000-000000000012",
        reviewedAt: new Date("2026-08-17T10:00:00.000Z"),
        updatedAt: new Date("2026-08-17T10:00:00.000Z"),
      },
    }
    const canonicalAssetId = approvedReview.mapping?.canonicalAssetId ?? ""
    const decisionReplay = {
      sourceId: SOURCE_ID,
      principalId: "00000000-0000-4000-8000-000000000003",
      jobId: "00000000-0000-4000-8000-000000000004",
      dispatchState: "failed_to_queue" as const,
      errorMessage: null,
    }
    let expectedCanonicalAssetId: string | undefined
    let searchedProposalQuery: string | null = null
    let requiredCoinGeckoCoinId: string | undefined
    const canonicalizationForEffect: AssetCanonicalizationServiceShape = {
      approveProviderAssetMapping: () =>
        Effect.succeed({ ...approvedReview, replays: [decisionReplay] }),
      canonicalizeEconomicAssetFromCoinGecko: () =>
        Effect.succeed({
          providerAsset: approvedReview,
          canonicalAsset: {
            id: canonicalAssetId,
            name: "Wrapped SOL",
            symbol: "SOL",
            type: "fungible",
          },
          replays: [decisionReplay],
        }),
      canonicalizeProviderAssetFromCoinGecko: (params) => {
        expectedCanonicalAssetId = params.expectedCanonicalAssetId
        return Effect.succeed({
          providerAsset: approvedReview,
          canonicalAsset: {
            id: canonicalAssetId,
            name: "Wrapped SOL",
            symbol: "SOL",
            type: "fungible",
            representationId: "00000000-0000-4000-8000-000000000011",
            blockchainId: "00000000-0000-4000-8000-000000000013",
            blockchainName: "solana",
            decimals: 9,
            contractAddress: null,
            mintAddress: "So11111111111111111111111111111111111111112",
            representationType: "token",
          },
          evidence: {
            source: "coingecko",
            coinId: "wrapped-solana",
            coinName: "Wrapped SOL",
            coinSymbol: "SOL",
            platformId: "solana",
            platformName: "Solana",
            contractAddress: "So11111111111111111111111111111111111111112",
          },
          replays: [decisionReplay],
        })
      },
    }
    const proposalsForEffect: ProviderAssetCandidateServiceShape = {
      searchProposals: ({ query, requiredCoinGeckoCoinId: requiredCoinId }) => {
        searchedProposalQuery = query
        requiredCoinGeckoCoinId = requiredCoinId
        return Effect.succeed({
          evidenceState: "exact",
          recommendedProposalId: "proposal",
          proposals: [
            {
              id: "proposal",
              effect,
              economicAsset: {
                _tag: "existing",
                id: canonicalAssetId,
                name: "Wrapped SOL",
                symbol: "SOL",
                coinGeckoCoinId: "wrapped-solana",
              },
              representation: null,
              evidenceStrength: "exact",
              matchReasons: ["Exact evidence."],
              conflicts: [],
              warnings: [],
              investigationLinks: [],
            },
          ],
        })
      },
    }

    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Resolve", proposalId: "proposal", effect },
          proposalQuery: "wrapped sol",
          reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
          reviewerNotes: null,
          reviewedBy: "00000000-0000-4000-8000-000000000012",
        })
      ).pipe(
        Effect.provide(
          ProviderAssetReviewServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, repository),
                Layer.succeed(AssetCanonicalizationService, canonicalizationForEffect),
                Layer.succeed(ProviderAssetCandidateService, proposalsForEffect),
                Layer.succeed(ProviderAssetReplayService, {
                  scheduleReplays: () =>
                    Effect.succeed([
                      {
                        sourceId: SOURCE_ID,
                        jobId: decisionReplay.jobId,
                        status: "failed_to_queue",
                        message: "Failed to queue replay.",
                      },
                    ]),
                  getReplay: unexpected,
                  retryReplay: unexpected,
                })
              )
            )
          )
        )
      )
    )

    expect(result.resolutionEffect).toEqual(effect)
    expect(searchedProposalQuery).toBe("wrapped sol")
    expect(expectedCanonicalAssetId).toBe(
      effect._tag === "AddRepresentation" ? effect.canonicalAssetId : undefined
    )
    expect(requiredCoinGeckoCoinId).toBe(
      effect._tag === "UseExistingAsset" || effect._tag === "UseExistingRepresentation"
        ? undefined
        : effect.selectedCoinGeckoCoinId
    )
    expect(result.replays).toEqual([
      expect.objectContaining({ sourceId: SOURCE_ID, status: "failed_to_queue" }),
    ])
  })

  it("persists an attributed rejection without scheduling replays", async () => {
    let persistedReviewerNotes: string | null = null
    let persistedReviewedBy: string | null = null
    let expectedEvidenceRevision: string | null = null
    const rejectingRepository: ProviderAssetRepositoryShape = {
      ...repository,
      rejectProviderAssetMapping: (params) => {
        persistedReviewerNotes = params.reviewerNotes
        persistedReviewedBy = params.reviewedBy
        expectedEvidenceRevision = params.expectedEvidenceRevision
        return Effect.succeed(true)
      },
    }
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Reject" },
          reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
          reviewerNotes: "  Unsupported representation.  ",
          reviewedBy: "00000000-0000-4000-8000-000000000012",
        })
      ).pipe(
        Effect.provide(
          ProviderAssetReviewServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderAssetRepository, rejectingRepository),
                Layer.succeed(AssetCanonicalizationService, canonicalization),
                Layer.succeed(ProviderAssetCandidateService, candidates),
                Layer.succeed(ProviderAssetReplayService, {
                  scheduleReplays: unexpected,
                  getReplay: unexpected,
                  retryReplay: unexpected,
                })
              )
            )
          )
        )
      )
    )

    expect(result).toEqual({ resolutionEffect: null, replays: [] })
    expect(persistedReviewerNotes).toBe("Unsupported representation.")
    expect(persistedReviewedBy).toBe("00000000-0000-4000-8000-000000000012")
    expect(expectedEvidenceRevision).toBe("evidence-v1")

    const failingRepository: ProviderAssetRepositoryShape = {
      ...repository,
      rejectProviderAssetMapping: () =>
        Effect.fail(
          new SyncEngineStorageError({
            operation: "test.reject",
            cause: "database unavailable",
          })
        ),
    }
    const failedRejection = Effect.flatMap(ProviderAssetReviewService, (service) =>
      service.decide({
        providerAssetRowId: PROVIDER_ASSET_ID,
        decision: { _tag: "Reject" },
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
        reviewerNotes: "Unsupported representation.",
        reviewedBy: "00000000-0000-4000-8000-000000000012",
      })
    )
    const failingLayer = ProviderAssetReviewServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, failingRepository),
          Layer.succeed(AssetCanonicalizationService, canonicalization),
          Layer.succeed(ProviderAssetCandidateService, candidates),
          Layer.succeed(ProviderAssetReplayService, {
            scheduleReplays: unexpected,
            getReplay: unexpected,
            retryReplay: unexpected,
          })
        )
      )
    )

    await expect(
      Effect.runPromise(failedRejection.pipe(Effect.provide(failingLayer)))
    ).rejects.toMatchObject({ _tag: "ProviderAssetReviewInternalError" })
  })

  it("returns the winning decision when a compare-and-set race is lost", async () => {
    const pendingMapping = review.mapping
    if (pendingMapping === null) {
      throw new Error("Expected a pending review mapping fixture.")
    }
    const completedReview: ProviderAssetReviewRecord = {
      ...review,
      mapping: {
        ...pendingMapping,
        canonicalAssetId: "00000000-0000-4000-8000-000000000010",
        mappingStatus: "approved",
        reviewedBy: "00000000-0000-4000-8000-000000000099",
        reviewedAt: new Date("2026-08-17T10:00:00.000Z"),
        updatedAt: new Date("2026-08-17T10:00:00.000Z"),
      },
    }
    let loadCount = 0
    const racingRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () =>
        Effect.sync(() => Option.some(loadCount++ === 0 ? review : completedReview)),
    }
    const racingCanonicalization: AssetCanonicalizationServiceShape = {
      ...canonicalization,
      approveProviderAssetMapping: () =>
        Effect.fail(
          new AssetCanonicalizationInternalError({
            message: "Provider asset evidence changed before manual approval.",
          })
        ),
    }
    const existingAssetCandidates: ProviderAssetCandidateServiceShape = {
      searchProposals: () =>
        Effect.succeed({
          evidenceState: "exact",
          recommendedProposalId: "proposal",
          proposals: [
            {
              id: "proposal",
              effect: {
                _tag: "UseExistingAsset",
                canonicalAssetId: "00000000-0000-4000-8000-000000000010",
              },
              economicAsset: {
                _tag: "existing",
                id: "00000000-0000-4000-8000-000000000010",
                name: "Wrapped SOL",
                symbol: "SOL",
                coinGeckoCoinId: null,
              },
              representation: null,
              evidenceStrength: "exact",
              matchReasons: ["Exact evidence."],
              conflicts: [],
              warnings: [],
              investigationLinks: [],
            },
          ],
        }),
    }
    const decision = Effect.flatMap(ProviderAssetReviewService, (service) =>
      service.decide({
        providerAssetRowId: PROVIDER_ASSET_ID,
        decision: {
          _tag: "Resolve",
          proposalId: "proposal",
          effect: {
            _tag: "UseExistingAsset",
            canonicalAssetId: "00000000-0000-4000-8000-000000000010",
          },
        },
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
        reviewerNotes: null,
        reviewedBy: "00000000-0000-4000-8000-000000000012",
      })
    )

    await expect(
      Effect.runPromise(
        decision.pipe(
          Effect.provide(
            ProviderAssetReviewServiceLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ProviderAssetRepository, racingRepository),
                  Layer.succeed(AssetCanonicalizationService, racingCanonicalization),
                  Layer.succeed(ProviderAssetCandidateService, existingAssetCandidates),
                  Layer.succeed(ProviderAssetReplayService, {
                    scheduleReplays: unexpected,
                    getReplay: unexpected,
                    retryReplay: unexpected,
                  })
                )
              )
            )
          )
        )
      )
    ).rejects.toMatchObject({
      _tag: "ProviderAssetReviewConflictError",
      latestDecision: {
        mappingStatus: "approved",
        reviewedBy: "00000000-0000-4000-8000-000000000099",
        updatedAt: "2026-08-17T10:00:00.000Z",
      },
    })
  })

  it("rejects a decision when source evidence changed at the same row timestamps", async () => {
    let rejectionAttempted = false
    const changedEvidenceRepository: ProviderAssetRepositoryShape = {
      ...repository,
      findProviderAssetReviewById: () =>
        Effect.succeed(Option.some({ ...review, evidenceRevision: "evidence-v2" })),
      rejectProviderAssetMapping: () => {
        rejectionAttempted = true
        return Effect.succeed(true)
      },
    }
    const decision = Effect.flatMap(ProviderAssetReviewService, (service) =>
      service.decide({
        providerAssetRowId: PROVIDER_ASSET_ID,
        decision: { _tag: "Reject" },
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
        reviewerNotes: "Evidence is stale.",
        reviewedBy: "00000000-0000-4000-8000-000000000012",
      })
    )

    await expect(
      Effect.runPromise(
        decision.pipe(
          Effect.provide(
            ProviderAssetReviewServiceLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ProviderAssetRepository, changedEvidenceRepository),
                  Layer.succeed(AssetCanonicalizationService, canonicalization),
                  Layer.succeed(ProviderAssetCandidateService, candidates),
                  Layer.succeed(ProviderAssetReplayService, {
                    scheduleReplays: unexpected,
                    getReplay: unexpected,
                    retryReplay: unexpected,
                  })
                )
              )
            )
          )
        )
      )
    ).rejects.toMatchObject({ _tag: "ProviderAssetReviewConflictError" })
    expect(rejectionAttempted).toBe(false)
  })

  it("rejects stale revisions with the latest completed decision and requires rejection notes", async () => {
    const stale = Effect.flatMap(ProviderAssetReviewService, (service) =>
      service.decide({
        providerAssetRowId: PROVIDER_ASSET_ID,
        decision: { _tag: "Reject" },
        reviewRevision: "stale",
        reviewerNotes: "Not supported.",
        reviewedBy: "00000000-0000-4000-8000-000000000012",
      })
    )
    const missingNotes = Effect.flatMap(ProviderAssetReviewService, (service) =>
      service.decide({
        providerAssetRowId: PROVIDER_ASSET_ID,
        decision: { _tag: "Reject" },
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z:evidence-v1",
        reviewerNotes: " ",
        reviewedBy: "00000000-0000-4000-8000-000000000012",
      })
    )
    const layer = ProviderAssetReviewServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAssetRepository, repository),
          Layer.succeed(AssetCanonicalizationService, canonicalization),
          Layer.succeed(ProviderAssetCandidateService, candidates),
          Layer.succeed(ProviderAssetReplayService, {
            scheduleReplays: () => Effect.succeed([]),
            getReplay: unexpected,
            retryReplay: unexpected,
          })
        )
      )
    )

    await expect(Effect.runPromise(stale.pipe(Effect.provide(layer)))).rejects.toMatchObject({
      _tag: "ProviderAssetReviewConflictError",
      latestDecision: {
        mappingStatus: "pending_review",
        updatedAt: "2026-08-17T09:00:00.000Z",
      },
    })
    await expect(Effect.runPromise(missingNotes.pipe(Effect.provide(layer)))).rejects.toMatchObject(
      { _tag: "ProviderAssetReviewBadRequestError" }
    )
  })
})
