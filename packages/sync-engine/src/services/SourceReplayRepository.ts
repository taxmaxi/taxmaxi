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

/**
 * SourceReplayDependencyPendingError - An inventory owner must replay before its consumer.
 */
export class SourceReplayDependencyPendingError extends Schema.TaggedError<SourceReplayDependencyPendingError>()(
  "SourceReplayDependencyPendingError",
  {
    sourceId: Schema.String,
    ownerSourceIds: Schema.Array(Schema.String),
  }
) {
  override get message(): string {
    return `Replay source ${this.sourceId} after inventory owners ${this.ownerSourceIds.join(", ")}`
  }
}

/** A dependent replay could not be scheduled because active job ownership kept changing. */
export class SourceReplaySchedulingPendingError extends Schema.TaggedError<SourceReplaySchedulingPendingError>()(
  "SourceReplaySchedulingPendingError",
  {
    sourceId: Schema.String,
    dependentSourceId: Schema.String,
  }
) {
  override get message(): string {
    return `Replay source ${this.sourceId} after scheduling settles for dependent source ${this.dependentSourceId}`
  }
}

/** A source belongs to a cross-source FIFO cycle that cannot be replayed one source at a time. */
export class SourceReplayDependencyCycleError extends Schema.TaggedError<SourceReplayDependencyCycleError>()(
  "SourceReplayDependencyCycleError",
  { sourceId: Schema.String }
) {
  override get message(): string {
    return `Cannot replay source ${this.sourceId}; its cross-source inventory dependencies form a cycle.`
  }
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
    readonly sourceId: string
  }) => Effect.Effect<
    void,
    | SourceReplayDependencyCycleError
    | SourceReplayDependencyError
    | SourceReplayDependencyPendingError
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
