/**
 * OAuthStateStore - Repository interface for persisted OAuth state records
 *
 * Stores short-lived OAuth state metadata so callback handlers can validate
 * provider, intent, and user ownership deterministically.
 *
 * @module OAuthStateStore
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { AuthProviderType, AuthUserId } from "@my/core/authentication"
import type { Timestamp } from "@my/core/shared/values/Timestamp"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * OAuth intent for a persisted state token
 */
export type OAuthIntent = "login" | "link"

/**
 * Pollable OAuth session status derived from persisted state rows.
 */
export type OAuthSessionStatus = "pending" | "completed" | "failed"

/**
 * OAuthStateRecord - Persisted OAuth state row
 *
 * Represents a state token that can be consumed exactly once during callback.
 */
export interface OAuthStateRecord {
  /** One-time state token used for CSRF and flow correlation */
  readonly state: string
  /** Flow intent (public login callback vs protected link callback) */
  readonly intent: OAuthIntent
  /** Provider the flow was initiated for */
  readonly provider: AuthProviderType
  /** Authenticated user for link flows, None for login flows */
  readonly userId: Option.Option<AuthUserId>
  /** Redirect URI used during authorization */
  readonly redirectUri: string
  /** Absolute expiration timestamp for this state token */
  readonly expiresAt: Timestamp
  /** Pollable session status */
  readonly status: OAuthSessionStatus
  /** Session token created after successful callback completion */
  readonly sessionToken: Option.Option<string>
  /** Human-readable completion or error message */
  readonly statusMessage: Option.Option<string>
  /** Timestamp when callback flow reached terminal status */
  readonly completedAt: Option.Option<Timestamp>
  /** Timestamp when state was consumed for callback validation */
  readonly consumedAt: Option.Option<Timestamp>
}

/**
 * OAuthStateInsert - Input data required to create a state record
 */
export interface OAuthStateInsert {
  readonly state: string
  readonly intent: OAuthIntent
  readonly provider: AuthProviderType
  readonly userId: Option.Option<AuthUserId>
  readonly redirectUri: string
  readonly expiresAt: Timestamp
  readonly status: OAuthSessionStatus
  readonly sessionToken: Option.Option<string>
  readonly statusMessage: Option.Option<string>
  readonly completedAt: Option.Option<Timestamp>
  readonly consumedAt: Option.Option<Timestamp>
}

/**
 * Data used to mark a state record as successfully completed.
 */
export interface OAuthStateMarkCompleted {
  readonly state: string
  readonly sessionToken: string
  readonly userId: AuthUserId
  readonly statusMessage: Option.Option<string>
  readonly completedAt: Timestamp
}

/**
 * Data used to mark a state record as failed.
 */
export interface OAuthStateMarkFailed {
  readonly state: string
  readonly statusMessage: string
  readonly completedAt: Timestamp
}

/**
 * OAuthStateStoreService - CRUD operations for OAuth state persistence
 */
export interface OAuthStateStoreService {
  /**
   * Persist a new OAuth state record
   *
   * @param state - State metadata to persist
   * @returns Effect completing on success
   * @errors PersistenceError - Database/storage failure
   */
  readonly create: (state: OAuthStateInsert) => Effect.Effect<void, PersistenceError>

  /**
   * Atomically read-and-delete a state record by token
   *
   * Records should be consumed exactly once to prevent replay.
   * Implementations may return None for missing/expired states.
   *
   * @param state - Raw OAuth state token
   * @returns Effect containing Some(record) if valid, otherwise None
   * @errors PersistenceError - Database/storage failure
   */
  readonly consume: (
    state: string
  ) => Effect.Effect<Option.Option<OAuthStateRecord>, PersistenceError>

  /**
   * Read a state record without consuming it
   *
   * @param state - Raw OAuth state token
   * @returns Effect containing Some(record) if present, otherwise None
   * @errors PersistenceError - Database/storage failure
   */
  readonly get: (state: string) => Effect.Effect<Option.Option<OAuthStateRecord>, PersistenceError>

  /**
   * Mark a state record as completed and attach resulting session metadata
   *
   * @param input - Completion metadata
   * @returns Effect completing on success
   * @errors PersistenceError - Database/storage failure
   */
  readonly markCompleted: (input: OAuthStateMarkCompleted) => Effect.Effect<void, PersistenceError>

  /**
   * Mark a state record as failed with a human-readable error message
   *
   * @param input - Failure metadata
   * @returns Effect completing on success
   * @errors PersistenceError - Database/storage failure
   */
  readonly markFailed: (input: OAuthStateMarkFailed) => Effect.Effect<void, PersistenceError>

  /**
   * Delete all expired OAuth state records
   *
   * @returns Effect containing number of deleted rows
   * @errors PersistenceError - Database/storage failure
   */
  readonly deleteExpired: () => Effect.Effect<number, PersistenceError>
}

/**
 * OAuthStateStore - Context.Tag for dependency injection
 */
export class OAuthStateStore extends Context.Tag("OAuthStateStore")<
  OAuthStateStore,
  OAuthStateStoreService
>() {}
