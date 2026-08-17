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
  findAssetById: unexpected,
}

const coinGecko: CoinGeckoClientShape = {
  searchCoins: () => Effect.succeed([]),
  getCoin: unexpected,
  listMarkets: unexpected,
}

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
      reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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

  it("does not treat incomplete representation evidence as exact", async () => {
    const incompleteRepository: ProviderAssetRepositoryShape = {
      ...repository,
      listProviderAssetObservedRepresentations: () =>
        Effect.succeed([
          {
            blockchainName: "solana",
            representationType: "token",
            contractAddress: null,
            mintAddress: "So11111111111111111111111111111111111111112",
            decimals: null,
          },
        ]),
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
      canonicalizeProviderAssetFromCoinGecko: () =>
        Effect.succeed({
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
        }),
    }
    const proposalsForEffect: ProviderAssetCandidateServiceShape = {
      searchProposals: () =>
        Effect.succeed({
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
        }),
    }

    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Resolve", proposalId: "proposal", effect },
          reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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
    expect(result.replays).toEqual([
      expect.objectContaining({ sourceId: SOURCE_ID, status: "failed_to_queue" }),
    ])
  })

  it("persists an attributed rejection without scheduling replays", async () => {
    let persistedReviewerNotes: string | null = null
    let persistedReviewedBy: string | null = null
    const rejectingRepository: ProviderAssetRepositoryShape = {
      ...repository,
      rejectProviderAssetMapping: (params) => {
        persistedReviewerNotes = params.reviewerNotes
        persistedReviewedBy = params.reviewedBy
        return Effect.succeed(true)
      },
    }
    const result = await Effect.runPromise(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Reject" },
          reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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
        reviewRevision: "2026-08-17T09:00:00.000Z:2026-08-17T09:00:00.000Z",
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
