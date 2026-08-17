/**
 * SyncEngineTransaction - Shared transaction boundary for repository orchestration.
 *
 * @module SyncEngineTransaction
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/** Runs a repository workflow in one database transaction. */
export interface SyncEngineTransactionShape {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SyncEngineStorageError, R>
}

/** Transaction boundary used when one decision spans multiple repositories. */
export class SyncEngineTransaction extends Context.Service<
  SyncEngineTransaction,
  SyncEngineTransactionShape
>()("SyncEngineTransaction") {}
