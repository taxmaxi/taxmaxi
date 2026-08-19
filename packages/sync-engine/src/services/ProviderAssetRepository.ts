/**
 * ProviderAssetRepository - Durable provider asset identity and mapping persistence contract.
 *
 * @module ProviderAssetRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * ProviderAssetMappingKind - Target mapping kind for a provider asset.
 */
export type ProviderAssetMappingKind = "asset" | "fiat"

/**
 * ProviderAssetMappingStatus - Review lifecycle for provider asset mappings.
 */
export type ProviderAssetMappingStatus = "approved" | "pending_review" | "rejected"

/**
 * ProviderAssetCatalogEntry - Durable provider asset catalog row.
 */
export interface ProviderAssetCatalogEntry {
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly payload: unknown
}

/**
 * ProviderAssetRecord - Persisted provider asset identity row.
 */
export interface ProviderAssetRecord {
  readonly id: string
  readonly provider: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly rawProviderPayload: unknown
  readonly discoveredAt: Date
  readonly retrievedAt: Date
}

/**
 * ProviderAssetMappingDraft - Default or reviewed provider-asset mapping upsert.
 */
export interface ProviderAssetMappingDraft {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/** Result of an idempotent provider-asset approval. */
export interface ProviderAssetApprovalResult {
  readonly mappingChanged: boolean
}

/** Result of scheduling one durable resolution job for an unresolved observation. */
export interface AssetResolutionJobScheduleResult {
  readonly created: boolean
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
}

/** Outcome of an attach-only policy decision, recorded as immutable audit history. */
export type AssetResolutionAuditOutcome = "attach" | "pending" | "fail_closed"

/**
 * One evidence snapshot to store behind a decision, scoped to the authority
 * that provided it and the kind of claim it makes. The decoded claim is what
 * the policy read; the raw payload is what the authority actually returned.
 */
export interface AssetResolutionEvidenceRecord {
  readonly authority: string
  readonly claimKind: string
  readonly sourceLocator: string | null
  readonly retrievedAt: Date
  readonly evidenceRevision: number
  readonly decodedClaim: unknown
  readonly rawPayload: unknown
}

/** One stored evidence snapshot as read back from a decision. */
export interface AssetResolutionEvidenceEntry extends AssetResolutionEvidenceRecord {
  readonly id: string
  readonly decisionId: string
}

/** One immutable attach-only policy decision to append to resolution audit history. */
export interface AssetResolutionDecisionRecord {
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly policyRevision: string
  readonly outcome: AssetResolutionAuditOutcome
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly blockchain: string | null
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
  readonly reason: string | null
  readonly evidence: ReadonlyArray<AssetResolutionEvidenceRecord>
  readonly actor: string
}

/** Result of appending one decision to resolution audit history. */
export interface AssetResolutionDecisionRecordResult {
  readonly recorded: boolean
}

/** Lifecycle status of one recorded resolution decision. */
export type AssetResolutionDecisionStatus = "active" | "superseded"

/** One recorded resolution decision as read back from audit history. */
export interface AssetResolutionDecisionHistoryEntry {
  readonly id: string
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
  readonly policyRevision: string
  readonly outcome: AssetResolutionAuditOutcome
  readonly status: AssetResolutionDecisionStatus
  readonly supersedesDecisionId: string | null
  readonly assetId: string | null
  readonly assetRepresentationId: string | null
  readonly reason: string | null
  readonly actor: string
  readonly createdAt: Date
}

/**
 * Result of appending a superseding decision.
 *
 * - superseded: the new decision is active and the replaced one is marked superseded.
 * - conflict: the named decision does not exist or is no longer active, so
 *   nothing changed; the caller must re-read and decide again.
 */
export type AssetResolutionSupersedeResult =
  | { readonly _tag: "superseded"; readonly decisionId: string }
  | { readonly _tag: "conflict" }

/** Outcome of attempting to claim a durable resolution job for execution. */
export type AssetResolutionJobClaim =
  | {
      readonly _tag: "claimed"
      readonly providerAssetRowId: string
      readonly evidenceRevision: number
      readonly attemptCount: number
    }
  | { readonly _tag: "not_claimable" }
  | { readonly _tag: "stale" }

/** Terminal status a resolution job execution attempt can leave the job in. */
export type AssetResolutionJobFinishStatus = "completed" | "failed"

/** Input for claiming a durable resolution job for worker execution. */
export interface ClaimAssetResolutionJobParams {
  readonly jobId: string
  readonly workerId: string
  readonly startedAt: Date
  /** Heartbeat cutoff a job stuck in processing must be older than to be reclaimed. */
  readonly staleBefore: Date
}

/** Input for listing resolution jobs the worker's poller should dispatch. */
export interface ListDispatchableResolutionJobsParams {
  readonly now: Date
  /** Heartbeat cutoff a job stuck in processing must be older than to be re-dispatched. */
  readonly staleBefore: Date
  readonly limit: number
}

/** One resolution job the worker's poller should dispatch. */
export interface DispatchableResolutionJob {
  readonly jobId: string
}

/** Input for refreshing an executing worker's heartbeat on a resolution job. */
export interface HeartbeatAssetResolutionJobParams {
  readonly jobId: string
  readonly workerId: string
  readonly heartbeatAt: Date
}

/** Outcome of refreshing a resolution job heartbeat. */
export type AssetResolutionJobHeartbeatOutcome = "heartbeated" | "not_owned"

/** Input for releasing a resolution job after an execution failure. */
export interface ReleaseAssetResolutionJobParams {
  readonly jobId: string
  readonly workerId: string
  readonly message: string
}

/**
 * Outcome of releasing a resolution job after an execution failure.
 *
 * - retry_scheduled: the job became runnable again once nextRetryAt passes.
 * - attempts_exhausted: attemptCount reached maxAttempts, so the job is now failed.
 * - not_owned: the calling worker no longer owns the job (already reclaimed or finished).
 */
export type AssetResolutionJobReleaseOutcome =
  | { readonly _tag: "retry_scheduled"; readonly attemptCount: number; readonly nextRetryAt: Date }
  | { readonly _tag: "attempts_exhausted"; readonly attemptCount: number }
  | { readonly _tag: "not_owned" }

/**
 * ProviderAssetMappingState - Provider-asset mapping target and review status.
 */
export interface ProviderAssetMappingState {
  readonly providerAssetRowId: string
  readonly mappingKind: ProviderAssetMappingKind
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
  readonly canonicalFiatCurrency: string | null
  readonly mappingStatus: ProviderAssetMappingStatus
}

/**
 * ProviderAssetReviewMapping - Provider-asset mapping state plus review notes.
 */
export interface ProviderAssetReviewMapping extends ProviderAssetMappingState {
  readonly reviewerNotes: string | null
  readonly sourceNotes: string | null
}

/**
 * ResolvedProviderAssetMapping - Deterministic provider-asset mapping result.
 */
export type ResolvedProviderAssetMapping = ProviderAssetMappingState

/**
 * ProviderAssetReviewRecord - Provider asset plus current review mapping state.
 */
export interface ProviderAssetReviewRecord {
  readonly providerAsset: ProviderAssetRecord
  readonly mapping: ProviderAssetReviewMapping | null
}

/** Exact on-chain identity observed on a movement using one provider asset. */
export interface ProviderAssetObservedRepresentationRecord {
  readonly blockchainName: string
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}

/** Representation evidence prepared for a provider-asset source use; null fields are unknown. */
export interface ProviderAssetSourceUseObservation {
  readonly providerAssetRowId: string
  readonly observedBlockchainId: string
  readonly representationType: "native" | "token" | "nft" | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number | null
}

/**
 * ProviderAssetRepositoryShape - Provider asset persistence and lookup operations.
 */
export interface ProviderAssetRepositoryShape {
  /**
   * Persist provider asset catalog rows. When stored observation facts change,
   * increment evidenceRevision and schedule one unresolved resolution job for
   * the new revision. Retrieved-at-only refreshes leave the revision in place.
   */
  readonly upsertProviderAssets: (params: {
    readonly providerKey: string
    readonly entries: ReadonlyArray<ProviderAssetCatalogEntry>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Persist provider asset mappings.
   */
  readonly upsertProviderAssetMappings: (params: {
    readonly mappings: ReadonlyArray<ProviderAssetMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Approve a reviewed asset mapping and atomically request replay for every
   * source that uses it. Retrying the same target is a successful no-op.
   */
  readonly approveProviderAssetMappingAndRequestReplay: (params: {
    readonly mapping: ProviderAssetMappingDraft
    readonly expectedObservedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly expectedProviderAssetRetrievedAt: Date
  }) => Effect.Effect<ProviderAssetApprovalResult, SyncEngineStorageError>

  /**
   * Lock and reload the provider-asset decision snapshot before a caller writes
   * related canonical rows in the same transaction.
   */
  readonly lockProviderAssetApprovalSnapshot: (params: {
    readonly providerAssetRowId: string
    readonly expectedObservedRepresentations: ReadonlyArray<ProviderAssetObservedRepresentationRecord>
    readonly expectedProviderAssetRetrievedAt: Date
  }) => Effect.Effect<ProviderAssetReviewRecord, SyncEngineStorageError>

  /**
   * Reserve and record that normalization artifacts use this provider asset.
   * The caller must invoke this after taking the normalized artifact locks and keep the
   * reservation plus artifact persistence in one transaction. This makes approval either
   * observe the evidence or win before the evidence is written.
   * If the asset is already approved, request a replay in the same transaction.
   */
  readonly recordProviderAssetSourceUses: (params: {
    readonly sourceId: string
    readonly providerAssetRowIds: ReadonlyArray<string>
    readonly observations: ReadonlyArray<ProviderAssetSourceUseObservation>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Seed provider asset mappings keyed by providerAssetRowId only when no row
   * exists yet. Existing mappings are never updated, preserving admin-reviewed
   * rows. Returns the number of newly inserted rows.
   */
  readonly seedProviderAssetMappingsIfMissing: (params: {
    readonly mappings: ReadonlyArray<ProviderAssetMappingDraft>
  }) => Effect.Effect<number, SyncEngineStorageError>

  /**
   * Load one provider asset by stable provider asset id.
   */
  readonly findProviderAssetByProviderAssetId: (params: {
    readonly providerKey: string
    readonly providerAssetId: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load one provider asset by provider-scoped natural key.
   */
  readonly findProviderAssetByNaturalKey: (params: {
    readonly providerKey: string
    readonly naturalKey: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load the preferred provider asset row for one provider-scoped currency code.
   *
   * Existing mapping decisions take precedence over newer unmapped provider
   * facts so review state is not orphaned when a provider later starts
   * returning a stable provider asset id for a currency initially discovered
   * through a natural key.
   */
  readonly findProviderAssetByCurrencyCode: (params: {
    readonly providerKey: string
    readonly currencyCode: string
  }) => Effect.Effect<Option.Option<ProviderAssetRecord>, SyncEngineStorageError>

  /**
   * Load one provider asset row with its mapping review state.
   */
  readonly findProviderAssetReviewById: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /**
   * List provider asset rows that need mapping review.
   */
  readonly listProviderAssetReviews: (params: {
    readonly providerKey: string | null
    readonly mappingStatus: ProviderAssetMappingStatus
    readonly cursor: {
      readonly providerAssetRowId: string
    } | null
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderAssetReviewRecord>, SyncEngineStorageError>

  /** List exact on-chain identities observed on movements for one provider asset. */
  readonly listProviderAssetObservedRepresentations: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<
    ReadonlyArray<ProviderAssetObservedRepresentationRecord>,
    SyncEngineStorageError
  >

  /**
   * Load the current mapping for one provider asset.
   */
  readonly findProviderAssetMapping: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<Option.Option<ResolvedProviderAssetMapping>, SyncEngineStorageError>

  /**
   * Persist one durable resolution job for an unresolved provider observation
   * and its current evidence revision. A second schedule for the same pair is
   * a no-op. Approved local mappings do not create a job. The job commits
   * outside the caller's transaction, so it survives when the caller fails
   * right after scheduling, as the unmapped-asset path deliberately does.
   */
  readonly scheduleUnresolvedResolutionJob: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<AssetResolutionJobScheduleResult, SyncEngineStorageError>

  /**
   * Claim one durable resolution job for execution. Locks the job row and
   * compares its evidence revision against the provider asset's current
   * evidence revision in the same transaction: a stale job is completed
   * without a decision and reported as stale rather than claimed. A job is
   * claimable when it is pending with no unexpired retry delay, or when it
   * is stuck in processing with a heartbeat older than staleBefore. Any
   * other job (already claimed by a live worker, completed, or failed) is
   * reported not_claimable, making duplicate execution attempts a safe
   * no-op. Claiming increments attemptCount and records the claiming worker
   * and start time.
   */
  readonly claimResolutionJob: (
    params: ClaimAssetResolutionJobParams
  ) => Effect.Effect<AssetResolutionJobClaim, SyncEngineStorageError>

  /**
   * List resolution jobs a worker's poller should enqueue for execution:
   * pending jobs whose retry delay has passed, and processing jobs whose
   * heartbeat is older than staleBefore so a crashed worker's claim can be
   * reclaimed. Oldest first, capped at limit.
   */
  readonly listDispatchableResolutionJobs: (
    params: ListDispatchableResolutionJobsParams
  ) => Effect.Effect<ReadonlyArray<DispatchableResolutionJob>, SyncEngineStorageError>

  /**
   * Refresh the heartbeat for the worker currently owning a processing
   * resolution job. Returns not_owned if the job is no longer processing
   * under that worker, for example after a stale-lease reclaim.
   */
  readonly heartbeatResolutionJob: (
    params: HeartbeatAssetResolutionJobParams
  ) => Effect.Effect<AssetResolutionJobHeartbeatOutcome, SyncEngineStorageError>

  /**
   * Release a resolution job back to pending after an execution failure,
   * scheduling a retry with a delay that grows with the attempt count. A
   * job whose attempt count has reached its limit becomes failed instead
   * and is never handed out again.
   */
  readonly releaseResolutionJobAfterFailure: (
    params: ReleaseAssetResolutionJobParams
  ) => Effect.Effect<AssetResolutionJobReleaseOutcome, SyncEngineStorageError>

  /**
   * Move a resolution job to a terminal status after a decision was
   * recorded (completed) or a non-retryable outcome (failed).
   */
  readonly finishResolutionJob: (params: {
    readonly jobId: string
    readonly status: AssetResolutionJobFinishStatus
  }) => Effect.Effect<void, SyncEngineStorageError>

  /**
   * Append one attach-only policy decision to resolution audit history as
   * the active decision for its provider asset and evidence revision. When
   * an active decision already exists for that pair, nothing is written and
   * the result reports recorded: false, so replaying a resolution job never
   * rewrites history.
   */
  readonly recordAssetResolutionDecision: (params: {
    readonly decision: AssetResolutionDecisionRecord
  }) => Effect.Effect<AssetResolutionDecisionRecordResult, SyncEngineStorageError>

  /**
   * Append a superseding decision that replaces the named active decision.
   * The replaced decision keeps its content and flips to superseded; the new
   * decision becomes active and records which decision it replaced. Fails
   * with a conflict result when the named decision is missing or no longer
   * active, so concurrent supersessions cannot overwrite each other.
   */
  readonly appendSupersedingAssetResolutionDecision: (params: {
    readonly supersedesDecisionId: string
    readonly decision: AssetResolutionDecisionRecord
  }) => Effect.Effect<AssetResolutionSupersedeResult, SyncEngineStorageError>

  /**
   * Read the active decision for one provider asset and evidence revision.
   */
  readonly findActiveAssetResolutionDecision: (params: {
    readonly providerAssetRowId: string
    readonly evidenceRevision: number
  }) => Effect.Effect<Option.Option<AssetResolutionDecisionHistoryEntry>, SyncEngineStorageError>

  /**
   * Read every recorded decision for one provider asset in the order they
   * were appended, including superseded ones.
   */
  readonly listAssetResolutionDecisions: (params: {
    readonly providerAssetRowId: string
  }) => Effect.Effect<ReadonlyArray<AssetResolutionDecisionHistoryEntry>, SyncEngineStorageError>

  /**
   * Read the evidence snapshots stored behind one decision, so the decision
   * can be reproduced without reading any provider payload table.
   */
  readonly listAssetResolutionEvidence: (params: {
    readonly decisionId: string
  }) => Effect.Effect<ReadonlyArray<AssetResolutionEvidenceEntry>, SyncEngineStorageError>
}

/**
 * ProviderAssetRepository - Context tag for provider asset persistence.
 */
export class ProviderAssetRepository extends Context.Service<
  ProviderAssetRepository,
  ProviderAssetRepositoryShape
>()("ProviderAssetRepository") {}
