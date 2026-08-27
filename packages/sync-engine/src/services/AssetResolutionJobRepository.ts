/**
 * AssetResolutionJobRepository - Durable resolution job lifecycle persistence contract.
 *
 * Owns the worker-facing lifecycle of `asset_resolution_jobs` rows: scheduling,
 * dispatch listing, claiming, heartbeats, failure release, and finishing.
 * Observation and mapping persistence stays on ProviderAssetRepository.
 *
 * @module AssetResolutionJobRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/** Result of scheduling one durable resolution job for an unresolved observation. */
export interface AssetResolutionJobScheduleResult {
  readonly created: boolean
  readonly providerAssetRowId: string
  readonly evidenceRevision: number
}

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
  | {
      /**
       * The job was scheduled for a different resolution policy revision than
       * the one the claiming worker runs. The job stays pending for a worker
       * running that revision, so a rolling deployment cannot burn a
       * new-revision job identity with an old-revision evaluation.
       */
      readonly _tag: "revision_mismatch"
      readonly jobPolicyRevision: string
    }

/** Terminal status a resolution job execution attempt can leave the job in. */
export type AssetResolutionJobFinishStatus = "completed" | "failed"

/** Input for claiming a durable resolution job for worker execution. */
export interface ClaimAssetResolutionJobParams {
  readonly jobId: string
  readonly workerId: string
  /** Resolution policy revision compiled into the claiming worker. */
  readonly policyRevision: string
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
 * AssetResolutionJobRepositoryShape - Durable resolution job lifecycle operations.
 */
export interface AssetResolutionJobRepositoryShape {
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
}

/**
 * AssetResolutionJobRepository - Context tag for durable resolution job persistence.
 */
export class AssetResolutionJobRepository extends Context.Service<
  AssetResolutionJobRepository,
  AssetResolutionJobRepositoryShape
>()("AssetResolutionJobRepository") {}
