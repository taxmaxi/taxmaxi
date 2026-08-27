/**
 * SourceReplayRepository - Explicit replay reset contract.
 *
 * @module SourceReplayRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SourceReplayPlanJobNotFoundError - The replay plan refers to a missing processing job.
 */
export class SourceReplayPlanJobNotFoundError extends Schema.TaggedError<SourceReplayPlanJobNotFoundError>()(
  "SourceReplayPlanJobNotFoundError",
  {
    jobId: Schema.String,
  }
) {}

/**
 * SourceReplayPlanConflictError - The processing job cannot accept the requested replay plan.
 */
export class SourceReplayPlanConflictError extends Schema.TaggedError<SourceReplayPlanConflictError>()(
  "SourceReplayPlanConflictError",
  {
    jobId: Schema.String,
    reason: Schema.String,
  }
) {}

/** Durable prerequisites and accounting boundary for one replay job. */
export interface RecordSourceReplayPlanParams {
  readonly jobId: string
  readonly prerequisiteJobIds: ReadonlyArray<string>
  readonly rebuildFrom: Date
}

/** Stored replay prerequisites and earliest affected event. */
export interface SourceReplayPlan {
  readonly jobId: string
  readonly prerequisiteJobIds: ReadonlyArray<string>
  readonly rebuildFrom: Date
}

/** Persistence operations for a replay job's durable execution plan. */
export interface SourceReplayPlanRepositoryShape {
  /** Add prerequisite jobs and keep the earliest rebuild boundary for a pending replay. */
  readonly recordReplayPlan: (
    params: RecordSourceReplayPlanParams
  ) => Effect.Effect<
    SourceReplayPlan,
    SourceReplayPlanJobNotFoundError | SourceReplayPlanConflictError | SyncEngineStorageError
  >
}

/** Context tag for durable replay-plan persistence. */
export class SourceReplayPlanRepository extends Context.Service<
  SourceReplayPlanRepository,
  SourceReplayPlanRepositoryShape
>()("SourceReplayPlanRepository") {}

/**
 * SourceReplayDependencyError - A replay would invalidate inventory consumed by another source.
 */
export class SourceReplayDependencyError extends Schema.TaggedError<SourceReplayDependencyError>()(
  "SourceReplayDependencyError",
  {
    sourceId: Schema.String,
    dependentSourceIds: Schema.Array(Schema.String),
    affectedPrincipalIds: Schema.Array(Schema.String),
  }
) {
  override get message(): string {
    return `Cannot replay source ${this.sourceId}; inventory is consumed by sources ${this.dependentSourceIds.join(", ")} for principals ${this.affectedPrincipalIds.join(", ")}`
  }
}

/** A replay closure contains a FIFO dependency cycle and cannot be ordered safely. */
export class SourceReplayDependencyCycleError extends Schema.TaggedError<SourceReplayDependencyCycleError>()(
  "SourceReplayDependencyCycleError",
  { sourceId: Schema.String }
) {
  override get message(): string {
    return `Cannot replay source ${this.sourceId}; its FIFO dependencies form a cycle.`
  }
}

/** An active job for a dependent source must finish before replay planning retries. */
export class SourceReplaySchedulingPendingError extends Schema.TaggedError<SourceReplaySchedulingPendingError>()(
  "SourceReplaySchedulingPendingError",
  {
    sourceId: Schema.String,
    dependentSourceId: Schema.String,
  }
) {
  override get message(): string {
    return `Replay source ${this.sourceId} after the active job finishes for dependent source ${this.dependentSourceId}.`
  }
}

/** One downstream replay that must wait for its FIFO owner replays. */
export interface SourceReplayDependentPlan extends SourceReplayPlan {
  readonly sourceId: string
}

/** Result of resetting one source and durably planning its direct FIFO consumers. */
export interface SourceReplayResetResult {
  readonly dependentReplays: ReadonlyArray<SourceReplayDependentPlan>
}

/**
 * SourceReplayRepositoryShape - Replay reset semantics used by the sync engine.
 */
export interface SourceReplayRepositoryShape {
  /**
   * Clear canonical/source-derived rows for one source while preserving cached raw rows
   * and durable checkpoint state.
   */
  readonly resetSourceDerivedState: (params: {
    readonly jobId: string
    readonly sourceId: string
  }) => Effect.Effect<
    SourceReplayResetResult,
    | SourceReplayDependencyCycleError
    | SourceReplayDependencyError
    | SourceReplaySchedulingPendingError
    | SyncEngineStorageError
  >
}

/**
 * SourceReplayRepository - Context tag for replay reset persistence.
 */
export class SourceReplayRepository extends Context.Service<
  SourceReplayRepository,
  SourceReplayRepositoryShape
>()("SourceReplayRepository") {}
