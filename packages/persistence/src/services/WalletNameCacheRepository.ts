/**
 * WalletNameCacheRepository - Durable storage for wallet name resolutions.
 *
 * Stores resolved wallet names per name-service namespace (ENS, SNS).
 * The repository only stores and reads entries; resolution logic and the
 * cache lifetime policy live with the caller.
 *
 * @module WalletNameCacheRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { NameServiceNamespace } from "@my/core/source"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * WalletNameCacheKey - Identifies one cached wallet name.
 */
export interface WalletNameCacheKey {
  /** Name service the name belongs to */
  readonly namespace: NameServiceNamespace
  /** Lowercased and trimmed wallet name */
  readonly name: string
}

/**
 * WalletNameCacheUpsert - A resolution to store or refresh.
 */
export interface WalletNameCacheUpsert extends WalletNameCacheKey {
  /** Address the name resolves to */
  readonly resolvedAddress: string
  /** Moment after which the entry no longer counts as fresh */
  readonly expiresAt: Date
}

/**
 * WalletNameCacheRepositoryShape - Durable cache operations.
 */
export interface WalletNameCacheRepositoryShape {
  /**
   * Read the cached address for a name, or null when the entry is missing
   * or expired.
   *
   * @errors PersistenceError - Cache read failure
   */
  readonly get: (key: WalletNameCacheKey) => Effect.Effect<string | null, PersistenceError>

  /**
   * Store or refresh a resolution.
   *
   * @errors PersistenceError - Cache write failure
   */
  readonly upsert: (entry: WalletNameCacheUpsert) => Effect.Effect<void, PersistenceError>
}

/**
 * WalletNameCacheRepository - Context.Tag for dependency injection
 */
export class WalletNameCacheRepository extends Context.Service<
  WalletNameCacheRepository,
  WalletNameCacheRepositoryShape
>()("WalletNameCacheRepository") {}
