/**
 * SyncEngineStorageError - Generic infrastructure failure exposed by sync-engine contracts.
 *
 * @module SyncEngineStorageError
 */

import * as Schema from "effect/Schema"

/** Operation used when a registered user has no transaction credits left. */
export const TRANSACTION_CREDIT_EXHAUSTED_OPERATION =
  "sourceNormalizationRepository.consumeTransactionCredit.exhausted"

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

    if (operation === TRANSACTION_CREDIT_EXHAUSTED_OPERATION) {
      return "Transaction credit balance is exhausted"
    }

    return typeof operation === "string"
      ? `Sync engine storage error during ${operation}`
      : "Sync engine storage error"
  }
}
