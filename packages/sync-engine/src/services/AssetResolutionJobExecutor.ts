/**
 * AssetResolutionJobExecutor - Runs one durable asset resolution job to completion.
 *
 * @module AssetResolutionJobExecutor
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { AssetResolutionCoinGeckoRetryableError } from "./AssetResolutionCoinGeckoClient.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * AssetResolutionJobOutcome - What happened when a resolution job was executed.
 *
 * - already_claimed: the job was not pending, so this call made no changes.
 * - stale: the provider observation's evidence changed since the job was
 *   scheduled; the job completed without a decision.
 * - attached: the policy attached a new representation to an existing
 *   economic asset and durably scheduled a replay of every affected source.
 * - created: the policy created a standalone economic asset owning the new
 *   representation and durably scheduled a replay of every affected source.
 * - pending / fail_closed: the policy decided not to attach or create;
 *   the decision is recorded as audit history.
 */
export type AssetResolutionJobOutcome =
  | "already_claimed"
  | "stale"
  | "attached"
  | "created"
  | "pending"
  | "fail_closed"

/** Result of executing one durable resolution job. */
export interface AssetResolutionJobExecutionResult {
  readonly outcome: AssetResolutionJobOutcome
  readonly providerAssetRowId: string | null
  readonly evidenceRevision: number | null
}

/**
 * AssetResolutionJobExecutorError - Failure of one resolution job execution
 * attempt. Storage failures and transient evidence-fetch failures both
 * release the job for a later attempt before being raised.
 */
export type AssetResolutionJobExecutorError =
  | SyncEngineStorageError
  | AssetResolutionCoinGeckoRetryableError

/**
 * AssetResolutionJobExecutorShape - Execute one already-scheduled resolution job.
 */
export interface AssetResolutionJobExecutorShape {
  /**
   * Claim, decide, and record an automatic resolution decision for one job.
   * On any execution failure the job is released back to pending for retry
   * and the failure is raised to the caller.
   */
  readonly executeJob: (params: {
    readonly jobId: string
    readonly workerId?: string
  }) => Effect.Effect<AssetResolutionJobExecutionResult, AssetResolutionJobExecutorError>
}

/**
 * AssetResolutionJobExecutor - Context tag for resolution job execution.
 */
export class AssetResolutionJobExecutor extends Context.Service<
  AssetResolutionJobExecutor,
  AssetResolutionJobExecutorShape
>()("AssetResolutionJobExecutor") {}
