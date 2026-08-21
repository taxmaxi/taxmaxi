/**
 * AssetResolutionJobExecutorLive - Runs one durable asset resolution job.
 *
 * Claims the job, builds chain evidence from stored observations and
 * registry evidence from a CoinGecko contract lookup, discovers existing
 * economic assets through exact representation identity, market-data
 * identity, and display metadata, and decides
 * attach/create_standalone/pending/fail_closed through the resolution
 * policy. The decision is appended to immutable audit history; on attach or
 * create the affected representation, ownership decision, and provider
 * mapping become durable and a replay of every affected source is scheduled
 * through the existing replay mechanism.
 *
 * @module AssetResolutionJobExecutorLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  ASSET_RESOLUTION_POLICY_REVISION,
  AssetResolutionConflictingEvidence,
  AssetResolutionMalformedPayload,
  AttachRepresentationDecision,
  canonicalizeAddress,
  decodeCoinGeckoClaim,
  RegistryLookupSkipped,
  evaluateAssetResolution,
  type AssetResolutionDecision,
  type AssetResolutionEconomicAsset,
  type AssetResolutionIdentitySnapshot,
  type AssetResolutionOwnedRepresentation,
  type AssetResolutionProviderEvidence,
  type AssetResolutionRegistryEvidence,
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

const RESOLUTION_POLICY_ACTOR = "system:asset-resolution-policy"
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
}): AssetResolutionDecisionRecord => {
  switch (decision._tag) {
    case "attach":
      return {
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
        actor: RESOLUTION_POLICY_ACTOR,
      }
    case "create_standalone":
      // The asset and representation ids are filled in by the repository
      // inside the creation transaction, once the standalone rows exist.
      return {
        providerAssetRowId,
        evidenceRevision,
        policyRevision: decision.policyRevision,
        outcome: "create_standalone",
        assetId: null,
        assetRepresentationId: null,
        blockchain: decision.blockchain,
        representationType: decision.type,
        contractAddress: decision.contractAddress,
        mintAddress: decision.mintAddress,
        decimals: decision.decimals,
        reason: null,
        evidence,
        actor: RESOLUTION_POLICY_ACTOR,
      }
    default:
      return {
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
        actor: RESOLUTION_POLICY_ACTOR,
      }
  }
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
    displayName,
    observations,
  }: {
    readonly providerAssetRowId: string
    readonly evidenceRevision: number
    readonly retrievedAt: Date
    readonly currencyCode: string
    readonly displayName: string | null
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
      const providerDisplay = { name: displayName, symbol: currencyCode }
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
            policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
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

      const factAddress =
        chainResult.fact === null
          ? null
          : (chainResult.fact.contractAddress ?? chainResult.fact.mintAddress)
      if (chainResult.fact === null || factAddress === null) {
        // Without one exact addressed fact there is nothing to look up: the
        // registry evidence honestly says the lookup was skipped, and the
        // policy decides from the chain evidence failure or unsupported shape.
        const decision = yield* evaluateAssetResolution({
          chain: chainResult.evidence,
          registry: new RegistryLookupSkipped(),
          identity: {
            registryOwner: null,
            displayCandidates: [],
            representations: ownedForReuse,
          },
          legitimacy: [],
          providerDisplay,
        })
        return { decision, evidence: [chainEvidenceRecord] }
      }

      const platformId = chainResult.fact.blockchain.trim().toLowerCase()
      const registryEvidence: AssetResolutionRegistryEvidence =
        yield* coinGeckoClient.fetchCoinByContract({ platformId, address: factAddress })
      const registryRetrievedAt = nowDate()
      const registryDecodedClaim =
        registryEvidence._tag === "payload"
          ? yield* Effect.result(decodeCoinGeckoClaim(registryEvidence.payload)).pipe(
              Effect.map((decoded) => (decoded._tag === "Success" ? decoded.success : null))
            )
          : null
      const registryEvidenceRecord: AssetResolutionEvidenceRecord = {
        authority: "coingecko",
        claimKind: "registry_platform_mapping",
        sourceLocator: `coingecko://coins/${platformId}/contract/${factAddress}`,
        retrievedAt: registryRetrievedAt,
        evidenceRevision,
        decodedClaim: registryDecodedClaim,
        rawPayload:
          registryEvidence._tag === "payload" ? registryEvidence : { _tag: registryEvidence._tag },
      }

      const registryOwner: AssetResolutionEconomicAsset | null =
        registryDecodedClaim === null
          ? null
          : yield* assetRepository
              .findAssetByCoinGeckoId({ coingeckoCoinId: registryDecodedClaim.coinId })
              .pipe(
                Effect.map(
                  Option.match({
                    onNone: () => null,
                    onSome: (asset) => ({
                      assetKey: asset.id,
                      coingeckoCoinId: registryDecodedClaim.coinId,
                      type: asset.type,
                    }),
                  })
                )
              )

      // Both the provider's display metadata and the registry's name and
      // symbol can raise a possible duplicate: the created asset would carry
      // the registry's display values when they exist, so they must collide
      // with existing assets the same way the provider's do.
      const providerCandidateRows = yield* assetRepository.findAssetResolutionCandidatesByDisplay({
        symbol: currencyCode,
        name: displayName,
      })
      const registryCandidateRows =
        registryDecodedClaim === null
          ? []
          : yield* assetRepository.findAssetResolutionCandidatesByDisplay({
              symbol: registryDecodedClaim.symbol,
              name: registryDecodedClaim.name,
            })
      const displayCandidatesByAsset = new Map(
        [...providerCandidateRows, ...registryCandidateRows].map((candidate) => [
          candidate.id,
          {
            assetKey: candidate.id,
            coingeckoCoinId: candidate.coingeckoCoinId,
            type: candidate.type,
          },
        ])
      )

      const identity: AssetResolutionIdentitySnapshot = {
        registryOwner,
        displayCandidates: [...displayCandidatesByAsset.values()],
        representations: ownedForReuse,
      }

      const decision = yield* evaluateAssetResolution({
        chain: chainResult.evidence,
        registry: registryEvidence,
        identity,
        legitimacy: [],
        providerDisplay,
      })

      return { decision, evidence: [chainEvidenceRecord, registryEvidenceRecord] }
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

  const settleApprovedResolution = ({
    jobId,
    providerAssetRowId,
    assetId,
    assetRepresentationId,
    policyRevision,
    observations,
    providerAssetRetrievedAt,
    sourceNotes,
  }: {
    readonly jobId: string
    readonly providerAssetRowId: string
    readonly assetId: string
    readonly assetRepresentationId: string
    readonly policyRevision: string
    readonly observations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly providerAssetRetrievedAt: Date
    readonly sourceNotes: string
  }): Effect.Effect<void, SyncEngineStorageError> =>
    Effect.gen(function* () {
      // The ownership conclusion is keyed on the representation itself so a
      // later provider observing the same identity can reuse it. Recording is
      // a no-op when the representation's owner is already settled.
      yield* assetRepository.recordRepresentationOwnershipDecision({
        assetRepresentationId,
        assetId,
        policyRevision,
        actor: RESOLUTION_POLICY_ACTOR,
      })

      yield* providerAssetRepository.approveProviderAssetMappingAndRequestReplay({
        mapping: {
          providerAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: assetId,
          assetRepresentationId,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes,
        },
        expectedObservedRepresentations: observations,
        expectedProviderAssetRetrievedAt: providerAssetRetrievedAt,
      })

      yield* assetResolutionJobRepository.finishResolutionJob({ jobId, status: "completed" })
    })

  const decideAndResolve = ({
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
        displayName: providerAsset.name,
        observations,
      })

      const decisionRecord = decisionToRecord({
        providerAssetRowId,
        evidenceRevision,
        decision,
        evidence,
      })

      if (decision._tag === "attach") {
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
            ...decisionRecord,
            assetId: decision.assetKey,
            assetRepresentationId: representation.id,
          },
        })

        yield* settleApprovedResolution({
          jobId,
          providerAssetRowId,
          assetId: decision.assetKey,
          assetRepresentationId: representation.id,
          policyRevision: decision.policyRevision,
          observations,
          providerAssetRetrievedAt: providerAsset.retrievedAt,
          sourceNotes: `Resolution policy ${decision.policyRevision} attached the exact representation and requested a replay of affected sources.`,
        })

        return {
          outcome: "attached",
          providerAssetRowId,
          evidenceRevision,
        } satisfies AssetResolutionJobExecutionResult
      }

      if (decision._tag === "create_standalone") {
        // The repository records the create_standalone decision inside the
        // creation transaction, so the audit can never show a created asset
        // without the decision that created it.
        const created = yield* assetRepository.createStandaloneAssetRepresentation({
          blockchainName: decision.blockchain,
          asset: {
            name: decision.name,
            symbol: decision.symbol,
            coingeckoCoinId: decision.coingeckoCoinId,
            logoUrl: null,
            type: decision.type === "nft" ? "nft" : "fungible",
          },
          representation: {
            contractAddress: decision.contractAddress,
            mintAddress: decision.mintAddress,
            decimals: decision.decimals,
            type: decision.type,
            logoUrl: null,
            isSpam: false,
            metadata: null,
          },
          decision: decisionRecord,
        })

        yield* settleApprovedResolution({
          jobId,
          providerAssetRowId,
          assetId: created.id,
          assetRepresentationId: created.representationId,
          policyRevision: decision.policyRevision,
          observations,
          providerAssetRetrievedAt: providerAsset.retrievedAt,
          sourceNotes: `Resolution policy ${decision.policyRevision} created a standalone economic asset for the exact representation and requested a replay of affected sources.`,
        })

        return {
          outcome: "created",
          providerAssetRowId,
          evidenceRevision,
        } satisfies AssetResolutionJobExecutionResult
      }

      yield* recordDecision({ jobId, record: decisionRecord })
      yield* assetResolutionJobRepository.finishResolutionJob({ jobId, status: "completed" })
      return {
        outcome: decision._tag,
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

      return yield* decideAndResolve({
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
