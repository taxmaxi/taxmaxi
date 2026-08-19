/**
 * AssetResolutionJobExecutorLive - Runs one durable attach-only resolution job.
 *
 * Claims the job, builds chain evidence from stored observations and
 * CoinGecko evidence from the controlled evidence client, decides
 * attach/pending/fail_closed through the attach-only policy, appends the
 * decision to immutable audit history, and, on attach, attaches the new
 * representation and durably schedules rematerialization for every affected
 * source through the existing replay mechanism.
 *
 * @module AssetResolutionJobExecutorLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
  AssetResolutionUpstreamFailure,
  evaluateAttachOnlyResolution,
  PendingResolutionDecision,
  type AssetResolutionDecision,
  type AssetResolutionIdentitySnapshot,
  type AssetResolutionOwnedRepresentation,
  type AssetResolutionProviderEvidence,
} from "@my/core/assets"
import {
  AssetRepository,
  AssetResolutionCoinGeckoClient,
  AssetResolutionJobExecutor,
  ProviderAssetRepository,
  type AssetResolutionCandidateAsset,
  type AssetResolutionDecisionRecord,
  type AssetResolutionJobExecutionResult,
  type AssetResolutionJobExecutorError,
  type AssetResolutionJobExecutorShape,
  type ProviderAssetObservedRepresentationRecord,
  type SyncEngineStorageError,
} from "../services/index.ts"
import { nowDate } from "./internal/SourceSyncTelemetry.ts"

const ATTACH_ONLY_ACTOR = "system:attach-only-policy"
const DEFAULT_ASSET_RESOLUTION_WORKER_ID = "asset-resolution-inline-executor"
const ASSET_RESOLUTION_JOB_STALE_AFTER_MS = 5 * 60 * 1000

interface ChainFact {
  readonly blockchain: string
  readonly type: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
}

interface ChainEvidenceResult {
  readonly evidence: AssetResolutionProviderEvidence
  readonly fact: ChainFact | null
}

const chainFactKey = (fact: ChainFact): string =>
  JSON.stringify([
    fact.blockchain.trim().toLowerCase(),
    fact.type,
    fact.contractAddress?.trim().toLowerCase() ?? null,
    fact.mintAddress,
    fact.decimals,
  ])

/**
 * Reduce every recorded on-chain observation for a provider asset to the one
 * exact chain fact evidence can prove. Zero or conflicting observations fail
 * closed as a chain evidence upstream failure rather than guessing.
 */
const buildChainEvidence = (
  observations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
): ChainEvidenceResult => {
  const facts = new Map<string, ChainFact>()

  for (const observation of observations) {
    if (observation.representationType === null || observation.decimals === null) {
      continue
    }

    const fact: ChainFact = {
      blockchain: observation.blockchainName,
      type: observation.representationType,
      contractAddress: observation.contractAddress,
      mintAddress: observation.mintAddress,
      decimals: observation.decimals,
    }
    facts.set(chainFactKey(fact), fact)
  }

  const [fact, ...extraFacts] = facts.values()
  if (fact === undefined || extraFacts.length > 0) {
    return { evidence: new AssetResolutionUpstreamFailure({ source: "chain" }), fact: null }
  }

  return { evidence: { _tag: "payload", payload: fact }, fact }
}

const decisionToRecord = ({
  providerAssetRowId,
  evidenceRevision,
  decision,
  chainEvidence,
  coinGeckoEvidence,
}: {
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly decision: AssetResolutionDecision
  readonly chainEvidence: unknown
  readonly coinGeckoEvidence: unknown
}): AssetResolutionDecisionRecord =>
  decision._tag === "attach"
    ? {
        providerAssetRowId,
        evidenceRevision,
        policyRevision: decision.policyRevision,
        outcome: "attach",
        assetId: decision.assetKey,
        assetRepresentationId: null,
        blockchain: decision.blockchain,
        representationType: decision.type,
        contractAddress: decision.contractAddress,
        mintAddress: decision.mintAddress,
        decimals: decision.decimals,
        reason: null,
        chainEvidence,
        coinGeckoEvidence,
        actor: ATTACH_ONLY_ACTOR,
      }
    : {
        providerAssetRowId,
        evidenceRevision,
        policyRevision: decision.policyRevision,
        outcome: decision._tag,
        assetId: null,
        assetRepresentationId: null,
        blockchain: null,
        representationType: null,
        contractAddress: null,
        mintAddress: null,
        decimals: null,
        reason: decision.reason,
        chainEvidence,
        coinGeckoEvidence,
        actor: ATTACH_ONLY_ACTOR,
      }

const make = Effect.gen(function* () {
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetRepository = yield* AssetRepository
  const coinGeckoClient = yield* AssetResolutionCoinGeckoClient

  const findOwnedRepresentations = (
    fact: ChainFact
  ): Effect.Effect<ReadonlyArray<AssetResolutionOwnedRepresentation>, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const existing =
        fact.type === "native"
          ? yield* assetRepository.findNativeRepresentationForBlockchain({
              blockchainName: fact.blockchain,
            })
          : yield* assetRepository.findRepresentationByBlockchainAndAddress({
              blockchainName: fact.blockchain,
              address: fact.contractAddress ?? fact.mintAddress ?? "",
            })

      if (Option.isNone(existing)) {
        return []
      }

      return [
        {
          assetKey: existing.value.assetId,
          blockchain: existing.value.blockchainName,
          type: existing.value.representationType,
          contractAddress: existing.value.contractAddress,
          mintAddress: existing.value.mintAddress,
          decimals: existing.value.decimals,
        },
      ]
    })

  const decideForProviderAsset = ({
    currencyCode,
    observations,
  }: {
    readonly currencyCode: string
    readonly observations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
  }): Effect.Effect<
    {
      readonly decision: AssetResolutionDecision
      readonly chainEvidence: AssetResolutionProviderEvidence
      readonly coinGeckoEvidence: AssetResolutionProviderEvidence | null
    },
    AssetResolutionJobExecutorError
  > =>
    Effect.gen(function* () {
      const chainResult = buildChainEvidence(observations)
      const candidates = yield* assetRepository.findAssetResolutionCandidatesBySymbol({
        symbol: currencyCode,
      })
      const withCoinGeckoId = candidates.filter(
        (candidate): candidate is AssetResolutionCandidateAsset & { coingeckoCoinId: string } =>
          candidate.coingeckoCoinId !== null
      )

      const [candidate, ...extraCandidates] = withCoinGeckoId
      if (candidate === undefined || extraCandidates.length > 0) {
        return {
          decision: PendingResolutionDecision.make({
            policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
            reason: "missing_existing_economic_asset",
          }),
          chainEvidence: chainResult.evidence,
          coinGeckoEvidence: null,
        }
      }

      const coinGeckoEvidence = yield* coinGeckoClient.fetchCoin({
        coinGeckoCoinId: candidate.coingeckoCoinId,
      })
      const ownedRepresentations =
        chainResult.fact === null ? [] : yield* findOwnedRepresentations(chainResult.fact)

      const identity: AssetResolutionIdentitySnapshot = {
        economicAssets: [
          {
            assetKey: candidate.id,
            coingeckoCoinId: candidate.coingeckoCoinId,
            type: candidate.type,
          },
        ],
        representations: ownedRepresentations,
      }

      const decision = yield* evaluateAttachOnlyResolution({
        chain: chainResult.evidence,
        coinGecko: coinGeckoEvidence,
        identity,
      })

      return { decision, chainEvidence: chainResult.evidence, coinGeckoEvidence }
    })

  const decideAndAttach = ({
    jobId,
    workerId,
    providerAssetRowId,
    evidenceRevision,
  }: {
    readonly jobId: string
    readonly workerId: string
    readonly providerAssetRowId: string
    readonly evidenceRevision: number
  }): Effect.Effect<AssetResolutionJobExecutionResult, AssetResolutionJobExecutorError> =>
    Effect.gen(function* () {
      const reviewOption = yield* providerAssetRepository.findProviderAssetReviewById({
        providerAssetRowId,
      })

      if (Option.isNone(reviewOption)) {
        yield* providerAssetRepository.finishResolutionJob({ jobId, status: "completed" })
        return {
          outcome: "stale",
          providerAssetRowId,
          evidenceRevision,
        } satisfies AssetResolutionJobExecutionResult
      }

      const { providerAsset } = reviewOption.value
      const observations = yield* providerAssetRepository.listProviderAssetObservedRepresentations({
        providerAssetRowId,
      })
      const { decision, chainEvidence, coinGeckoEvidence } = yield* decideForProviderAsset({
        currencyCode: providerAsset.currencyCode,
        observations,
      })

      if (decision._tag !== "attach") {
        const { recorded } = yield* providerAssetRepository.recordAssetResolutionDecision({
          decision: decisionToRecord({
            providerAssetRowId,
            evidenceRevision,
            decision,
            chainEvidence,
            coinGeckoEvidence,
          }),
        })
        if (!recorded) {
          yield* Effect.logInfo(
            { jobId, providerAssetRowId, evidenceRevision, outcome: decision._tag },
            "asset-resolution:decision-replay-detected"
          )
        }
        yield* providerAssetRepository.finishResolutionJob({ jobId, status: "completed" })
        return {
          outcome: decision._tag,
          providerAssetRowId,
          evidenceRevision,
        } satisfies AssetResolutionJobExecutionResult
      }

      const representation = yield* assetRepository.attachRepresentationToExistingAsset({
        assetId: decision.assetKey,
        blockchainName: decision.blockchain,
        representation: {
          contractAddress: decision.contractAddress,
          mintAddress: decision.mintAddress,
          decimals: decision.decimals,
          type: decision.type,
          logoUrl: null,
          isSpam: false,
          metadata: null,
        },
      })

      const { recorded } = yield* providerAssetRepository.recordAssetResolutionDecision({
        decision: {
          ...decisionToRecord({
            providerAssetRowId,
            evidenceRevision,
            decision,
            chainEvidence,
            coinGeckoEvidence,
          }),
          assetRepresentationId: representation.id,
        },
      })

      // A replay after a crash between recording and mapping approval still
      // finishes the idempotent approval below, but it must be visible as a
      // replay rather than pass for a first decision.
      if (!recorded) {
        yield* Effect.logInfo(
          { jobId, providerAssetRowId, evidenceRevision, outcome: "attach" },
          "asset-resolution:decision-replay-detected"
        )
      }

      yield* providerAssetRepository.approveProviderAssetMappingAndRequestReplay({
        mapping: {
          providerAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: decision.assetKey,
          assetRepresentationId: representation.id,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes: `Attach-only policy ${decision.policyRevision} attached the exact representation and requested rematerialization.`,
        },
        expectedObservedRepresentations: observations,
        expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
      })

      yield* providerAssetRepository.finishResolutionJob({ jobId, status: "completed" })

      return {
        outcome: "attached",
        providerAssetRowId,
        evidenceRevision,
      } satisfies AssetResolutionJobExecutionResult
    }).pipe(
      Effect.catch((error) =>
        providerAssetRepository
          .releaseResolutionJobAfterFailure({ jobId, workerId, message: error.message })
          .pipe(Effect.andThen(Effect.fail(error)))
      )
    )

  const executeJob: AssetResolutionJobExecutorShape["executeJob"] = ({
    jobId,
    workerId = DEFAULT_ASSET_RESOLUTION_WORKER_ID,
  }) =>
    Effect.gen(function* () {
      const startedAt = nowDate()
      const staleBefore = new Date(startedAt.getTime() - ASSET_RESOLUTION_JOB_STALE_AFTER_MS)
      const claim = yield* providerAssetRepository.claimResolutionJob({
        jobId,
        workerId,
        startedAt,
        staleBefore,
      })

      if (claim._tag !== "claimed") {
        return {
          outcome: claim._tag === "stale" ? "stale" : "already_claimed",
          providerAssetRowId: null,
          evidenceRevision: null,
        } satisfies AssetResolutionJobExecutionResult
      }

      return yield* decideAndAttach({
        jobId,
        workerId,
        providerAssetRowId: claim.providerAssetRowId,
        evidenceRevision: claim.evidenceRevision,
      })
    })

  return AssetResolutionJobExecutor.of({ executeJob })
})

/**
 * AssetResolutionJobExecutorLive - Live layer for durable resolution job execution.
 */
export const AssetResolutionJobExecutorLive = Layer.effect(AssetResolutionJobExecutor, make)
