import { describe, expect, it } from "vitest"
import {
  ProviderAssetRepository,
  SourceSyncQueueError,
  SourceSyncService,
  type EconomicAssetRepresentationRecord,
  type ProviderAssetRepositoryShape,
  type ProviderAssetReviewRecord,
  type SourceSyncServiceShape,
} from "@my/sync-engine/services"
import { ProviderAssetReplayServiceLive } from "@my/sync-engine/layers"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { ProviderAssetReviewServiceLive } from "../src/layers/ProviderAssetReviewServiceLive.ts"
import {
  AssetCanonicalizationService,
  type AssetCanonicalizationServiceShape,
} from "../src/services/AssetCanonicalizationService.ts"
import {
  ProviderAssetCandidateService,
  type ProviderAssetCandidateServiceShape,
} from "../src/services/ProviderAssetCandidateService.ts"
import { ProviderAssetReviewService } from "../src/services/ProviderAssetReviewService.ts"

const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000001"
const ASSET_ID = "00000000-0000-4000-8000-000000000002"
const REPRESENTATION_ID = "00000000-0000-4000-8000-000000000003"
const SOURCE_ID = "00000000-0000-4000-8000-000000000004"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000005"
const JOB_ID = "00000000-0000-4000-8000-000000000006"
const NEXT_JOB_ID = "00000000-0000-4000-8000-000000000007"
const REVIEWER_ID = "00000000-0000-4000-8000-000000000008"

const makeReview = ({
  providerType = "crypto",
  status = "pending_review",
}: {
  readonly providerType?: string
  readonly status?: "approved" | "pending_review" | "rejected"
} = {}): ProviderAssetReviewRecord => ({
  providerAsset: {
    id: PROVIDER_ASSET_ID,
    provider: "coinbase",
    providerAssetId: "coinbase-usdc",
    naturalKey: null,
    currencyCode: providerType === "fiat" ? "EUR" : "USDC",
    name: providerType === "fiat" ? "Euro" : "USD Coin",
    exponent: providerType === "fiat" ? 2 : 6,
    providerType,
    rawProviderPayload: {},
    discoveredAt: new Date("2026-08-17T08:00:00.000Z"),
    retrievedAt: new Date("2026-08-17T08:00:00.000Z"),
  },
  mapping: {
    providerAssetRowId: PROVIDER_ASSET_ID,
    mappingKind: providerType === "fiat" ? "fiat" : "asset",
    canonicalAssetId: status === "approved" && providerType !== "fiat" ? ASSET_ID : null,
    assetRepresentationId: null,
    canonicalFiatCurrency: status === "approved" && providerType === "fiat" ? "EUR" : null,
    mappingStatus: status,
    reviewerNotes: null,
    sourceNotes: null,
    reviewedBy: status === "pending_review" ? null : REVIEWER_ID,
    reviewedAt: status === "pending_review" ? null : new Date("2026-08-17T09:00:00.000Z"),
  },
})

const canonicalAsset = (
  representationId = REPRESENTATION_ID
): EconomicAssetRepresentationRecord => ({
  id: ASSET_ID,
  name: "USD Coin",
  symbol: "USDC",
  type: "fungible",
  representationId,
  blockchainId: "00000000-0000-4000-8000-000000000009",
  blockchainName: "ethereum",
  decimals: 6,
  contractAddress: "0xa0b8",
  mintAddress: null,
  representationType: "token",
})

const unexpected = () => Effect.die("Unexpected test call")

const makeRepository = ({
  review = makeReview(),
  rejectUpdated = true,
  replayJobId = JOB_ID,
  onReplaceReplay = () => undefined,
}: {
  readonly review?: ProviderAssetReviewRecord
  readonly rejectUpdated?: boolean
  readonly replayJobId?: string
  readonly onReplaceReplay?: (jobId: string) => void
} = {}): ProviderAssetRepositoryShape => ({
  upsertProviderAssets: unexpected,
  upsertProviderAssetMappings: unexpected,
  approveProviderAssetMappingAndRequestReplay: ({ mapping }) =>
    Effect.succeed({
      mappingChanged: true,
      replays: [{ sourceId: SOURCE_ID, principalId: PRINCIPAL_ID, jobId: replayJobId }],
      mapping,
    }),
  rejectProviderAssetMapping: () => Effect.succeed(rejectUpdated),
  findProviderAssetReviewReplay: () =>
    Effect.succeed(
      Option.some({ sourceId: SOURCE_ID, principalId: PRINCIPAL_ID, jobId: replayJobId })
    ),
  replaceProviderAssetReviewReplay: ({ nextJobId }) =>
    Effect.sync(() => {
      onReplaceReplay(nextJobId)
      return true
    }),
  lockProviderAssetApprovalSnapshot: unexpected,
  recordProviderAssetSourceUses: unexpected,
  seedProviderAssetMappingsIfMissing: unexpected,
  findProviderAssetByProviderAssetId: unexpected,
  findProviderAssetByNaturalKey: unexpected,
  findProviderAssetByCurrencyCode: unexpected,
  findProviderAssetReviewById: () => Effect.succeed(Option.some(review)),
  listProviderAssetReviews: unexpected,
  listProviderAssetObservedRepresentations: () => Effect.succeed([]),
  findProviderAssetMapping: unexpected,
})

const makeCanonicalization = ({
  onMap = () => undefined,
  onRequirePendingReview = () => undefined,
  representationId = REPRESENTATION_ID,
}: {
  readonly onMap?: (representationId: string | null) => void
  readonly onRequirePendingReview?: (required: boolean | undefined) => void
  readonly representationId?: string
} = {}): AssetCanonicalizationServiceShape => ({
  approveProviderAssetMapping: ({ assetRepresentationId, requirePendingReview }) => {
    onMap(assetRepresentationId)
    onRequirePendingReview(requirePendingReview)
    return Effect.succeed({
      ...makeReview({ status: "approved" }),
      replays: [{ sourceId: SOURCE_ID, principalId: PRINCIPAL_ID, jobId: JOB_ID }],
    })
  },
  canonicalizeProviderAssetFromCoinGecko: ({ requirePendingReview }) => {
    onRequirePendingReview(requirePendingReview)
    return Effect.succeed({
      providerAsset: makeReview({ status: "approved" }),
      canonicalAsset: canonicalAsset(representationId),
      evidence: {
        source: "coingecko",
        coinId: "usd-coin",
        coinName: "USD Coin",
        coinSymbol: "USDC",
        platformId: "ethereum",
        platformName: "Ethereum",
        contractAddress: "0xa0b8",
      },
      replays: [{ sourceId: SOURCE_ID, principalId: PRINCIPAL_ID, jobId: JOB_ID }],
    })
  },
})

const makeCandidates = (): ProviderAssetCandidateServiceShape => ({
  listCandidates: () =>
    Effect.succeed([
      {
        economicAsset: { coinId: "usd-coin", name: "USD Coin", symbol: "USDC" },
        representationEvidence: [],
        matchStrength: "exact_name_and_symbol",
      },
      {
        economicAsset: { coinId: "bridged-usdc", name: "Bridged USDC", symbol: "USDC" },
        representationEvidence: [],
        matchStrength: "symbol_only",
      },
    ]),
})

const makeSourceSync = ({
  replayFails = false,
}: { readonly replayFails?: boolean } = {}): SourceSyncServiceShape => ({
  startSourceSyncJob: unexpected,
  replaySourceSyncJob: () =>
    replayFails
      ? Effect.fail(
          new SourceSyncQueueError({ operation: "test.replay", cause: "queue unavailable" })
        )
      : Effect.succeed({
          sourceId: SOURCE_ID,
          jobId: NEXT_JOB_ID,
          status: "queued",
          message: null,
        }),
  getSourceSyncJob: () =>
    Effect.succeed({
      sourceId: SOURCE_ID,
      jobId: NEXT_JOB_ID,
      status: "failed",
      message: "worker failed",
      phase: null,
      processedRecords: null,
      totalRecords: null,
      progressPercent: null,
      importedRecords: null,
      normalizedRecords: null,
      failedRecords: null,
    }),
})

const runReview = <A>(
  effect: Effect.Effect<A, unknown, ProviderAssetReviewService>,
  options: {
    readonly repository?: ProviderAssetRepositoryShape
    readonly canonicalization?: AssetCanonicalizationServiceShape
    readonly candidates?: ProviderAssetCandidateServiceShape
    readonly sourceSync?: SourceSyncServiceShape
  } = {}
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        ProviderAssetReviewServiceLive.pipe(
          Layer.provide(ProviderAssetReplayServiceLive),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderAssetRepository, options.repository ?? makeRepository()),
              Layer.succeed(
                AssetCanonicalizationService,
                options.canonicalization ?? makeCanonicalization()
              ),
              Layer.succeed(ProviderAssetCandidateService, options.candidates ?? makeCandidates()),
              Layer.succeed(SourceSyncService, options.sourceSync ?? makeSourceSync())
            )
          )
        )
      )
    )
  )

describe("ProviderAssetReviewService", () => {
  it.each([
    ["economic asset only", null],
    ["existing representation", REPRESENTATION_ID],
  ])("maps to an existing %s target", async (_, assetRepresentationId) => {
    let selectedRepresentation: string | null | undefined
    let requirePendingReview: boolean | undefined
    const result = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "MapToExisting", canonicalAssetId: ASSET_ID, assetRepresentationId },
          reviewerNotes: null,
          reviewedBy: REVIEWER_ID,
        })
      ),
      {
        canonicalization: makeCanonicalization({
          onMap: (value) => {
            selectedRepresentation = value
          },
          onRequirePendingReview: (required) => {
            requirePendingReview = required
          },
        }),
      }
    )

    expect(selectedRepresentation).toBe(assetRepresentationId)
    expect(requirePendingReview).toBe(true)
    expect(result.providerAsset.mapping?.mappingStatus).toBe("approved")
  })

  it.each([
    ["first representation for a new economic asset", REPRESENTATION_ID],
    ["new representation for an existing economic asset", NEXT_JOB_ID],
  ])("creates %s from reviewed CoinGecko evidence", async (_, representationId) => {
    const result = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "CreateFromCoinGecko", coinId: "usd-coin" },
          reviewerNotes: null,
          reviewedBy: REVIEWER_ID,
        })
      ),
      { canonicalization: makeCanonicalization({ representationId }) }
    )

    expect(result.canonicalAsset).toMatchObject({ id: ASSET_ID, representationId })
  })

  it("returns ambiguous candidates without selecting one", async () => {
    const candidates = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.listCandidates({ providerAssetRowId: PROVIDER_ASSET_ID })
      )
    )

    expect(candidates.map((candidate) => candidate.economicAsset.coinId)).toEqual([
      "usd-coin",
      "bridged-usdc",
    ])
  })

  it("approves a chainless fiat observation and returns durable replay work", async () => {
    const result = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "ApproveAsFiat" },
          reviewerNotes: "Verified EUR.",
          reviewedBy: REVIEWER_ID,
        })
      ),
      { repository: makeRepository({ review: makeReview({ providerType: "fiat" }) }) }
    )

    expect(result.replays).toEqual([
      { sourceId: SOURCE_ID, principalId: PRINCIPAL_ID, jobId: JOB_ID },
    ])
  })

  it("rejects a pending observation and rejects a stale decision", async () => {
    const rejected = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Reject", reason: "Unsupported asset." },
          reviewerNotes: null,
          reviewedBy: REVIEWER_ID,
        })
      )
    )
    const stale = runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.decide({
          providerAssetRowId: PROVIDER_ASSET_ID,
          decision: { _tag: "Reject", reason: "Second decision." },
          reviewerNotes: null,
          reviewedBy: REVIEWER_ID,
        })
      ),
      { repository: makeRepository({ rejectUpdated: false }) }
    )

    expect(rejected.replays).toEqual([])
    await expect(stale).rejects.toMatchObject({ _tag: "ProviderAssetReviewConflictError" })
  })

  it("keeps replay failure separate from the durable decision and supports retry", async () => {
    const replay = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.getReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      )
    )
    const failed = runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      ),
      { sourceSync: makeSourceSync({ replayFails: true }) }
    )
    let linkedJobId: string | undefined
    const retried = await runReview(
      Effect.flatMap(ProviderAssetReviewService, (service) =>
        service.retryReplay({
          providerAssetRowId: PROVIDER_ASSET_ID,
          sourceId: SOURCE_ID,
          jobId: JOB_ID,
        })
      ),
      {
        repository: makeRepository({
          onReplaceReplay: (jobId) => {
            linkedJobId = jobId
          },
        }),
      }
    )

    expect(replay.status).toBe("failed")
    expect(replay.jobId).toBe(JOB_ID)
    await expect(failed).rejects.toMatchObject({ _tag: "ProviderAssetReviewInternalError" })
    expect(retried.jobId).toBe(NEXT_JOB_ID)
    expect(linkedJobId).toBe(NEXT_JOB_ID)
  })
})
