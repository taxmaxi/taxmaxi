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
 * SourceReplayRepositoryShape - Replay reset semantics used by the sync engine.
 */
export interface SourceReplayRepositoryShape {
  /**
   * Clear canonical/source-derived rows for one source while preserving cached raw rows
   * and durable checkpoint state.
   */
  readonly resetSourceDerivedState: (params: {
    readonly sourceId: string
  }) => Effect.Effect<void, SourceReplayDependencyError | SyncEngineStorageError>
}

/**
 * SourceReplayRepository - Context tag for replay reset persistence.
 */
export class SourceReplayRepository extends Context.Tag("SourceReplayRepository")<
  SourceReplayRepository,
  SourceReplayRepositoryShape
>() {}
