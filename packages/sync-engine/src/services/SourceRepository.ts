/**
 * SourceRepository - Source visibility and sync context lookup contract.
 *
 * @module SourceRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"
import type { SourceSyncSource } from "./SourceSyncModels.ts"

/**
 * FindOwnedSourceSyncContextParams - Input for loading a source visible to a user.
 */
export interface FindOwnedSourceSyncContextParams {
  readonly userId: string
  readonly sourceId: string
}

/**
 * ListUserSourceSyncContextsParams - Input for listing syncable user sources.
 */
export interface ListUserSourceSyncContextsParams {
  readonly userId: string
}

/**
 * SourceRepositoryShape - Source lookup operations needed by sync/replay entrypoints.
 */
export interface SourceRepositoryShape {
  /**
   * Find a source visible to the given user and return the sync context projection.
   */
  readonly findOwnedSourceSyncContext: (
    params: FindOwnedSourceSyncContextParams
  ) => Effect.Effect<Option.Option<SourceSyncSource>, SyncEngineStorageError>

  /**
   * List source sync contexts for all currently configured sources owned by a user.
   */
  readonly listUserSourceSyncContexts: (
    params: ListUserSourceSyncContextsParams
  ) => Effect.Effect<ReadonlyArray<SourceSyncSource>, SyncEngineStorageError>
}

/**
 * SourceRepository - Context tag for source lookup persistence.
 */
export class SourceRepository extends Context.Tag("@my/sync-engine/SourceRepository")<
  SourceRepository,
  SourceRepositoryShape
>() {}
