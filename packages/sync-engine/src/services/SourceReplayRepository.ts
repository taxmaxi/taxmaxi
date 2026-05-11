/**
 * SourceReplayRepository - Explicit replay reset contract.
 *
 * @module SourceReplayRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

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
  }) => Effect.Effect<void, SyncEngineStorageError>
}

/**
 * SourceReplayRepository - Context tag for replay reset persistence.
 */
export class SourceReplayRepository extends Context.Tag("SourceReplayRepository")<
  SourceReplayRepository,
  SourceReplayRepositoryShape
>() {}
