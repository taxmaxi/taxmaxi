/**
 * AssetResolutionJobExecutorLive - Runs one durable attach-only resolution job.
 *
 * Claims the job, builds chain evidence from stored observations and
 * CoinGecko evidence from the controlled evidence client, decides
 * attach/pending/fail_closed through the attach-only policy, appends the
 * decision to immutable audit history, and, on attach, attaches the new
 * representation and durably schedules a replay of every affected source
 * through the existing replay mechanism.
 *
 * @module AssetResolutionJobExecutorLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
  AssetResolutionConflictingEvidence,
  AssetResolutionMalformedPayload,
  AttachRepresentationDecision,
  canonicalizeAddress,
  decodeCoinGeckoClaim,
  evaluateAttachOnlyResolution,
  PendingResolutionDecision,
  type AssetResolutionDecision,
  type AssetResolutionIdentitySnapshot,
  type AssetResolutionOwnedRepresentation,
  type AssetResolutionProviderEvidence,
  ChainFactPayload,
} from "@my/core/assets"
import {
  AssetRepository,
  AssetResolutionCoinGeckoClient,
  AssetResolutionJobExecutor,
  AssetResolutionJobRepository,
  ProviderAssetRepository,
  type AssetResolutionDecisionRecord,
  type AssetResolutionEvidenceRecord,
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

interface ChainEvidenceResult {
  readonly evidence: AssetResolutionProviderEvidence
  readonly fact: ChainFactPayload | null
}

const chainFactKey = (fact: ChainFactPayload): string =>
  JSON.stringify([
    fact.blockchain.trim().toLowerCase(),
    fact.type,
    canonicalizeAddress(fact.contractAddress),
    canonicalizeAddress(fact.mintAddress),
    fact.decimals,
  ])

/**
 * Reduce every recorded on-chain observation for a provider asset to the one
 * exact chain fact evidence can prove. No usable observation fails closed as
 * malformed chain evidence; observations that contradict each other fail
 * closed as conflicting chain evidence. Neither guesses. Addresses are
 * compared through the policy's canonicalizer, so case only merges facts on
 * chains where case is not significant.
 */
export const buildChainEvidence = (
  observations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
): ChainEvidenceResult => {
  const facts = new Map<string, ChainFactPayload>()

  for (const observation of observations) {
    if (observation.representationType === null || observation.decimals === null) {
      continue
    }

    const fact: ChainFactPayload = {
      blockchain: observation.blockchainName,
      type: observation.representationType,
      contractAddress: observation.contractAddress,
      mintAddress: observation.mintAddress,
      decimals: observation.decimals,
    }
    facts.set(chainFactKey(fact), fact)
  }

  const [fact, ...extraFacts] = facts.values()
  if (fact === undefined) {
    return { evidence: new AssetResolutionMalformedPayload({ source: "chain" }), fact: null }
  }
  if (extraFacts.length > 0) {
    return { evidence: new AssetResolutionConflictingEvidence({ source: "chain" }), fact: null }
  }

  return { evidence: { _tag: "payload", payload: fact }, fact }
}

const decisionToRecord = ({
  providerAssetRowId,
  evidenceRevision,
  decision,
  evidence,
}: {
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly decision: AssetResolutionDecision
  readonly evidence: ReadonlyArray<AssetResolutionEvidenceRecord>
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
        evidence,
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
        evidence,
        actor: ATTACH_ONLY_ACTOR,
      }

const make = Effect.gen(function* () {
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetResolutionJobRepository = yield* AssetResolutionJobRepository
  const assetRepository = yield* AssetRepository
  const coinGeckoClient = yield* AssetResolutionCoinGeckoClient

  const findOwnedRepresentations = (
    fact: ChainFactPayload
  ): Effect.Effect<ReadonlyArray<AssetResolutionOwnedRepresentation>, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const factAddress = fact.contractAddress ?? fact.mintAddress
      if (fact.type !== "native" && factAddress === null) {
        // No address means no identity to look up; the policy fails closed
        // on the malformed fact instead of matching an empty address.
        return []
      }

      const existing =
        fact.type === "native" || factAddress === null
          ? yield* assetRepository.findNativeRepresentationForBlockchain({
              blockchainName: fact.blockchain,
            })
          : yield* assetRepository.findRepresentationByBlockchainAndAddress({
              blockchainName: fact.blockchain,
              address: factAddress,
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
    providerAssetRowId,
    evidenceRevision,
    retrievedAt,
    currencyCode,
    observations,
  }: {
    readonly providerAssetRowId: string
    readonly evidenceRevision: number
    readonly retrievedAt: Date
    readonly currencyCode: string
    readonly observations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
  }): Effect.Effect<
    {
      readonly decision: AssetResolutionDecision
      readonly evidence: ReadonlyArray<AssetResolutionEvidenceRecord>
    },
    AssetResolutionJobExecutorError
  > =>
    Effect.gen(function* () {
      const chainResult = buildChainEvidence(observations)
      const chainEvidenceRecord: AssetResolutionEvidenceRecord = {
        authority: "chain",
        claimKind: "chain_fact",
        sourceLocator: `taxmaxi://provider-assets/${providerAssetRowId}/observed-representations`,
        retrievedAt,
        evidenceRevision,
        decodedClaim: chainResult.fact,
        rawPayload: observations,
      }
      // A representation whose owner is already settled resolves locally:
      // exact chain identity is enough, and no registry call is needed.
      const ownedForReuse =
        chainResult.fact === null ? [] : yield* findOwnedRepresentations(chainResult.fact)
      const [settled] = ownedForReuse
      if (
        settled !== undefined &&
        settled.type === chainResult.fact?.type &&
        settled.decimals === chainResult.fact.decimals
      ) {
        return {
          decision: AttachRepresentationDecision.make({
            policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
            assetKey: settled.assetKey,
            blockchain: settled.blockchain.toLowerCase(),
            type: settled.type,
            contractAddress: settled.contractAddress,
            mintAddress: settled.mintAddress,
            decimals: settled.decimals,
          }),
          evidence: [chainEvidenceRecord],
        }
      }

      const candidates = yield* assetRepository.findAssetResolutionCandidatesBySymbol({
        symbol: currencyCode,
      })

      // Ambiguity counts every asset sharing the symbol, including ones
      // without a CoinGecko id: picking the only id-carrying asset out of
      // several same-symbol assets would attach on symbol luck, not evidence.
      const [candidate, ...extraCandidates] = candidates
      if (candidate === undefined || extraCandidates.length > 0) {
        return {
          decision: PendingResolutionDecision.make({
            policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
            reason:
              candidate === undefined
                ? "missing_existing_economic_asset"
                : "ambiguous_symbol_candidates",
          }),
          evidence: [chainEvidenceRecord],
        }
      }

      const coingeckoCoinId = candidate.coingeckoCoinId
      if (coingeckoCoinId === null) {
        return {
          decision: PendingResolutionDecision.make({
            policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
            reason: "missing_registry_identity",
          }),
          evidence: [chainEvidenceRecord],
        }
      }

      const coinGeckoEvidence = yield* coinGeckoClient.fetchCoin({
        coinGeckoCoinId: coingeckoCoinId,
      })
      const coinGeckoRetrievedAt = nowDate()
      const coinGeckoDecodedClaim =
        coinGeckoEvidence._tag === "payload"
          ? yield* Effect.result(decodeCoinGeckoClaim(coinGeckoEvidence.payload)).pipe(
              Effect.map((decoded) => (decoded._tag === "Success" ? decoded.success : null))
            )
          : null
      const coinGeckoEvidenceRecord: AssetResolutionEvidenceRecord = {
        authority: "coingecko",
        claimKind: "registry_platform_mapping",
        sourceLocator: `coingecko://coins/${coingeckoCoinId}`,
        retrievedAt: coinGeckoRetrievedAt,
        evidenceRevision,
        decodedClaim: coinGeckoDecodedClaim,
        rawPayload: coinGeckoEvidence,
      }
      const identity: AssetResolutionIdentitySnapshot = {
        economicAssets: [
          {
            assetKey: candidate.id,
            coingeckoCoinId,
            type: candidate.type,
          },
        ],
        representations: ownedForReuse,
      }

      const decision = yield* evaluateAttachOnlyResolution({
        chain: chainResult.evidence,
        coinGecko: coinGeckoEvidence,
        identity,
      })

      return { decision, evidence: [chainEvidenceRecord, coinGeckoEvidenceRecord] }
    })

  // A replay after a crash between recording and the follow-up steps still
  // finishes idempotently, but it must be visible as a replay rather than
  // pass for a first decision.
  const recordDecision = ({
    jobId,
    record,
  }: {
    readonly jobId: string
    readonly record: AssetResolutionDecisionRecord
  }): Effect.Effect<void, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const { recorded } = yield* providerAssetRepository.recordAssetResolutionDecision({
        decision: record,
      })
      if (!recorded) {
        yield* Effect.logInfo(
          {
            jobId,
            providerAssetRowId: record.providerAssetRowId,
            evidenceRevision: record.evidenceRevision,
            outcome: record.outcome,
          },
          "asset-resolution:decision-replay-detected"
        )
      }
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
        yield* assetResolutionJobRepository.finishResolutionJob({ jobId, status: "completed" })
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
      const { decision, evidence } = yield* decideForProviderAsset({
        providerAssetRowId,
        evidenceRevision,
        retrievedAt: providerAsset.retrievedAt,
        currencyCode: providerAsset.currencyCode,
        observations,
      })

      if (decision._tag !== "attach") {
        yield* recordDecision({
          jobId,
          record: decisionToRecord({
            providerAssetRowId,
            evidenceRevision,
            decision,
            evidence,
          }),
        })
        yield* assetResolutionJobRepository.finishResolutionJob({ jobId, status: "completed" })
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

      yield* recordDecision({
        jobId,
        record: {
          ...decisionToRecord({
            providerAssetRowId,
            evidenceRevision,
            decision,
            evidence,
          }),
          assetRepresentationId: representation.id,
        },
      })

      // The ownership conclusion is keyed on the representation itself so a
      // later provider observing the same identity can reuse it. Recording is
      // a no-op when the representation's owner is already settled.
      yield* assetRepository.recordRepresentationOwnershipDecision({
        assetRepresentationId: representation.id,
        assetId: decision.assetKey,
        policyRevision: decision.policyRevision,
        actor: ATTACH_ONLY_ACTOR,
      })

      yield* providerAssetRepository.approveProviderAssetMappingAndRequestReplay({
        mapping: {
          providerAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: decision.assetKey,
          assetRepresentationId: representation.id,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes: `Attach-only policy ${decision.policyRevision} attached the exact representation and requested a replay of affected sources.`,
        },
        expectedObservedRepresentations: observations,
        expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
      })

      yield* assetResolutionJobRepository.finishResolutionJob({ jobId, status: "completed" })

      return {
        outcome: "attached",
        providerAssetRowId,
        evidenceRevision,
      } satisfies AssetResolutionJobExecutionResult
    }).pipe(
      Effect.catch((error) =>
        assetResolutionJobRepository
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
      const claim = yield* assetResolutionJobRepository.claimResolutionJob({
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
