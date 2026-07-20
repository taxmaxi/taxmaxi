/**
 * PrincipalReplayRepository - Durable principal replay orchestration and reset contract.
 *
 * @module PrincipalReplayRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SourceSyncExecutionState } from "./SourceSyncModels.ts"

/** One source-level child job coordinated by a principal replay. */
export interface PrincipalReplaySourceJob {
  readonly sourceId: string
  readonly jobId: string
  readonly isCoordinator: boolean
}

/** Durable principal replay plan resolved from its coordinator job. */
export interface PrincipalReplayPlan {
  readonly runId: string
  readonly principalId: string
  readonly sourceJobs: ReadonlyArray<PrincipalReplaySourceJob>
}

/** Result of creating or finding the active principal replay. */
export interface PrincipalReplayDispatch {
  readonly runId: string
  readonly coordinatorJobId: string | null
  readonly coordinatorSourceId: string | null
}

/** User-review restoration result after canonical transactions are rebuilt. */
export interface PrincipalReplayReviewRestoreResult {
  readonly restoredCount: number
  readonly unmatchedTransactionIdentities: ReadonlyArray<string>
}

/** Persistence operations required by principal replay orchestration. */
export interface PrincipalReplayRepositoryShape {
  /** Atomically create one replay run and one reserved source job per principal source. */
  readonly createOrReuseReplayRun: (params: {
    readonly principalId: string
    readonly sourceIds: ReadonlyArray<string>
    readonly maxAttempts: number
  }) => Effect.Effect<PrincipalReplayDispatch, SyncEngineStorageError>

  /** Resolve a replay plan only when the supplied job is its coordinator. */
  readonly findPlanByCoordinatorJobId: (params: {
    readonly jobId: string
  }) => Effect.Effect<Option.Option<PrincipalReplayPlan>, SyncEngineStorageError>

  /** Atomically claim every reserved source job in a replay plan. */
  readonly claimPlan: (params: {
    readonly runId: string
    readonly workerId: string
    readonly startedAt: Date
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Heartbeat every child job owned by the principal replay worker. */
  readonly heartbeatPlan: (params: {
    readonly runId: string
    readonly workerId: string
    readonly heartbeatAt: Date
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Return every child job to pending before BullMQ retries the coordinator. */
  readonly recordRetryableFailure: (params: {
    readonly runId: string
    readonly message: string
    readonly attemptCount: number
    readonly nextRetryAt: Date
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Mark all child jobs and the aggregate run terminally failed. */
  readonly failPlan: (params: {
    readonly runId: string
    readonly message: string
    readonly completedAt: Date
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Complete every source child job and the aggregate replay run atomically. */
  readonly completePlan: (params: {
    readonly runId: string
    readonly sourceResults: ReadonlyArray<{
      readonly sourceId: string
      readonly jobId: string
      readonly state: SourceSyncExecutionState
    }>
    readonly completedAt: Date
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Snapshot reviewed decisions once, then clear all principal-derived canonical state. */
  readonly preparePrincipalReplay: (params: {
    readonly runId: string
    readonly principalId: string
  }) => Effect.Effect<void, SyncEngineStorageError>

  /** Restore reviewed decisions onto transactions that retained stable provider identity. */
  readonly restorePrincipalReviews: (params: {
    readonly runId: string
    readonly principalId: string
  }) => Effect.Effect<PrincipalReplayReviewRestoreResult, SyncEngineStorageError>
}

/** Context tag for principal replay persistence. */
export class PrincipalReplayRepository extends Context.Tag("PrincipalReplayRepository")<
  PrincipalReplayRepository,
  PrincipalReplayRepositoryShape
>() {}
