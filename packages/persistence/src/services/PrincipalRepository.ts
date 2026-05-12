/**
 * PrincipalRepository - Ownership principal persistence contract.
 *
 * @module PrincipalRepository
 */

import type { AuthUserId } from "@my/core/authentication"
import type { PrincipalId, PrincipalKind } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * Principal - Durable sync/tax owner.
 */
export interface Principal {
  readonly id: PrincipalId
  readonly kind: PrincipalKind
  readonly userId: AuthUserId | null
}

/**
 * PrincipalRepositoryService - Ownership principal operations.
 */
export interface PrincipalRepositoryService {
  /**
   * Find the user ownership principal for an authentication user.
   */
  readonly findUserPrincipal: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<Principal>, PersistenceError>

  /**
   * Create the user ownership principal for an authentication user.
   */
  readonly createUserPrincipal: (userId: AuthUserId) => Effect.Effect<Principal, PersistenceError>

  /**
   * Create an anonymous wallet ownership principal.
   */
  readonly createAnonymousWalletPrincipal: () => Effect.Effect<Principal, PersistenceError>
}

/**
 * PrincipalRepository - Context tag for ownership principal persistence.
 */
export class PrincipalRepository extends Context.Tag("@my/persistence/PrincipalRepository")<
  PrincipalRepository,
  PrincipalRepositoryService
>() {}
