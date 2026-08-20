/**
 * SyncEngineStorageError - Generic infrastructure failure exposed by sync-engine contracts.
 *
 * @module SyncEngineStorageError
 */

import * as Schema from "effect/Schema"

/**
 * SyncEngineStorageError - Wraps lower-level persistence/integration failures without
 * coupling sync-engine contracts to persistence package types.
 */
export class SyncEngineStorageError extends Schema.TaggedError<SyncEngineStorageError>()(
  "SyncEngineStorageError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {
  override get message(): string {
    const operation: unknown = this.operation

    return typeof operation === "string"
      ? `Sync engine storage error during ${operation}`
      : "Sync engine storage error"
  }
}
