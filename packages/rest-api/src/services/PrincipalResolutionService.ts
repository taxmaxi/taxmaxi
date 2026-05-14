/**
 * PrincipalResolutionService - Authenticated user to ownership principal resolution.
 *
 * @module PrincipalResolutionService
 */

import type { Principal } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { CurrentUser, User } from "../definitions/AuthMiddleware.ts"

/**
 * PrincipalResolutionError - Failed to resolve a user ownership principal.
 */
export class PrincipalResolutionError extends Schema.TaggedError<PrincipalResolutionError>()(
  "PrincipalResolutionError",
  {
    message: Schema.String,
  }
) {}

/**
 * CurrentUserPrincipal - Authenticated user with their ownership principal.
 */
export interface CurrentUserPrincipal {
  readonly currentUser: User
  readonly principal: Principal
}

/**
 * PrincipalResolutionServiceShape - Principal lookup operations for authenticated handlers.
 */
export interface PrincipalResolutionServiceShape {
  /**
   * Resolve the ownership principal for a known authenticated user.
   */
  readonly resolveUserPrincipal: (
    currentUser: User
  ) => Effect.Effect<Principal, PrincipalResolutionError>

  /**
   * Resolve the request's authenticated user and ownership principal.
   */
  readonly resolveCurrentUserPrincipal: Effect.Effect<
    CurrentUserPrincipal,
    PrincipalResolutionError,
    CurrentUser
  >
}

/**
 * PrincipalResolutionService - Context tag for principal resolution.
 */
export class PrincipalResolutionService extends Context.Tag(
  "@my/rest-api/PrincipalResolutionService"
)<PrincipalResolutionService, PrincipalResolutionServiceShape>() {}
