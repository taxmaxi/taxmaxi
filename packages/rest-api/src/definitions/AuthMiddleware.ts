/**
 * AuthMiddleware - Authentication middleware definitions for the HTTP API
 *
 * Defines the authentication middleware tag, CurrentUser service, and User schema.
 * This module contains only the definitions - implementations are in Layers/.
 *
 * @module AuthMiddleware
 */

import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { AuthUserId, SessionId } from "@my/core/authentication"
import { ForbiddenError, UnauthorizedError } from "./ApiErrors.ts"

// =============================================================================
// CurrentUser Service
// =============================================================================

/**
 * User - Represents the authenticated user
 *
 * Contains minimal user information extracted from the bearer token.
 * For session-based auth, also includes the session ID for logout/refresh.
 *
 * Uses proper branded types for userId and sessionId to ensure type safety
 * throughout the codebase. This eliminates the need for runtime conversions
 * with .make() or Schema.decodeUnknown() at usage sites.
 */
export class User extends Schema.Class<User>("User")({
  userId: AuthUserId,
  role: Schema.Literal("admin", "user", "readonly"),
  /**
   * Session ID for session-based authentication.
   * Used by logout and refresh handlers to invalidate/renew the session.
   * Optional to support both token-based and session-based auth.
   */
  sessionId: Schema.optional(SessionId),
}) {}

/**
 * CurrentUser - Service tag for accessing the authenticated user in handlers
 *
 * Usage in handlers:
 * ```ts
 * .handle("myEndpoint", (_) =>
 *   Effect.gen(function* () {
 *     const user = yield* CurrentUser
 *     // user.userId, user.role available
 *   })
 * )
 * ```
 */
export class CurrentUser extends Context.Tag("@my/rest-api/AuthMiddleware/CurrentUser")<
  CurrentUser,
  User
>() {}

/**
 * OptionalCurrentUserService - Resolves an optional authenticated user for public endpoints.
 *
 * Missing credentials return Option.none. Present but invalid credentials fail
 * with UnauthorizedError so public endpoints do not silently fall back to
 * anonymous behavior when a caller sends a bad token.
 */
export interface OptionalCurrentUserService {
  readonly resolve: () => Effect.Effect<
    Option.Option<User>,
    UnauthorizedError,
    HttpServerRequest.HttpServerRequest
  >
}

/**
 * OptionalCurrentUser - Service tag for optional-auth endpoint handlers.
 */
export class OptionalCurrentUser extends Context.Tag(
  "@my/rest-api/AuthMiddleware/OptionalCurrentUser"
)<OptionalCurrentUser, OptionalCurrentUserService>() {}

// =============================================================================
// Authentication Middleware
// =============================================================================

/**
 * AuthMiddleware - Authentication middleware supporting both bearer tokens and session cookies
 *
 * This middleware:
 * 1. Extracts tokens from either:
 *    - Authorization: Bearer <token> header
 *    - taxmaxi_session cookie
 * 2. Validates the token
 * 3. Provides a CurrentUser service to downstream handlers
 * 4. Returns UnauthorizedError (401) for invalid/missing tokens
 *
 * Apply to protected API groups using `.middleware(AuthMiddleware)`
 */
// @effect-diagnostics-next-line leakingRequirements:off
export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()("AuthMiddleware", {
  failure: UnauthorizedError,
  provides: CurrentUser,
  security: {
    bearer: HttpApiSecurity.bearer,
    cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "taxmaxi_session" }),
  },
}) {}

/**
 * AdminAuthMiddleware - Authentication middleware for admin-only API groups.
 *
 * This middleware validates the caller like AuthMiddleware, then requires
 * CurrentUser.role to be "admin" before downstream handlers run.
 */
// @effect-diagnostics-next-line leakingRequirements:off
export class AdminAuthMiddleware extends HttpApiMiddleware.Tag<AdminAuthMiddleware>()(
  "AdminAuthMiddleware",
  {
    failure: Schema.Union(UnauthorizedError, ForbiddenError),
    provides: CurrentUser,
    security: {
      bearer: HttpApiSecurity.bearer,
      cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "taxmaxi_session" }),
    },
  }
) {}

// =============================================================================
// Token Validation Service
// =============================================================================

/**
 * TokenValidatorService - Service interface for validating bearer tokens
 *
 * This abstraction allows for different token validation strategies:
 * - JWT validation
 * - Session token lookup
 * - API key validation
 * - Mock validation for testing
 */
export interface TokenValidatorService {
  readonly validate: (token: Redacted.Redacted<string>) => Effect.Effect<User, UnauthorizedError>
}

/**
 * TokenValidator - Service tag for token validation
 */
export class TokenValidator extends Context.Tag("TokenValidator")<
  TokenValidator,
  TokenValidatorService
>() {}
