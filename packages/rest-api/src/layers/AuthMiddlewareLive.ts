/**
 * AuthMiddlewareLive - Live implementation of the authentication middleware
 *
 * Provides the actual token validation and middleware implementation.
 * This module contains implementations - definitions are in Definitions/.
 *
 * @module AuthMiddlewareLive
 */

import * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  Headers,
  HttpEffect,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { AuthUserId, SessionId, type UserRole } from "@my/core/authentication"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { SessionRepository, UserRepository } from "@my/persistence/services"
import { ForbiddenError, UnauthorizedError } from "../definitions/ApiErrors.ts"
import {
  AdminAuthMiddleware,
  AuthMiddleware,
  CurrentUser,
  OptionalCurrentUser,
  TokenValidator,
  User,
  type OptionalCurrentUserService,
  type TokenValidatorService,
} from "../definitions/AuthMiddleware.ts"

const SESSION_COOKIE_NAME = "taxmaxi_session"
const invalidSessionRequests = new WeakSet<object>()
const sessionCookieDomain = Config.option(Config.string("COOKIE_DOMAIN")).pipe(
  Config.map(Option.getOrUndefined)
)

const markInvalidSessionRequest = () =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.tap((request) => Effect.sync(() => invalidSessionRequests.add(request))),
    Effect.asVoid
  )

const markInvalidCookieOnUnauthorized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      Schema.is(UnauthorizedError)(error) ? markInvalidSessionRequest() : Effect.void
    )
  )

/**
 * Clears a submitted session cookie when the final response is unauthorized.
 *
 * This runs around the complete HTTP app so the cleanup survives API error encoding.
 */
export const invalidSessionCookieCleanup = HttpMiddleware.make(
  <E, R>(
    httpApp: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    >
  ) =>
    HttpEffect.withPreResponseHandler(httpApp, (request, response) => {
      if (response.status !== 401 || !invalidSessionRequests.has(request)) {
        return Effect.succeed(response)
      }

      return Effect.gen(function* () {
        const cookieDomain = yield* sessionCookieDomain
        const environment = yield* Config.string("ENVIRONMENT").pipe(
          Config.withDefault("development")
        )

        return yield* HttpServerResponse.setCookie(response, SESSION_COOKIE_NAME, "", {
          expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          ...(environment === "production" && cookieDomain !== undefined
            ? { domain: cookieDomain }
            : {}),
        })
      }).pipe(Effect.orDie)
    })
)

const extractBearerToken = (authorization: string): Option.Option<string> => {
  const [scheme, token] = authorization.split(" ", 2)
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.trim() === "") {
    return Option.none()
  }
  return Option.some(token)
}

const nonEmptyRedacted = (
  token: Redacted.Redacted<string>
): Option.Option<Redacted.Redacted<string>> =>
  Redacted.value(token).trim() === "" ? Option.none() : Option.some(token)

const readBearerTokenFromRequest = (): Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.map((request) =>
      Headers.get(request.headers, "authorization").pipe(
        Option.flatMap(extractBearerToken),
        Option.map(Redacted.make)
      )
    )
  )

const readCookieTokenFromRequest = (): Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.map((request) =>
      Option.fromNullishOr(request.cookies[SESSION_COOKIE_NAME]).pipe(Option.map(Redacted.make))
    )
  )

const requireAdminUser = (currentUser: User) => {
  if (currentUser.role === "admin") {
    return Effect.succeed(currentUser)
  }

  return Effect.fail(
    new ForbiddenError({
      message: "Admin role required.",
      resource: Option.some("admin"),
      action: Option.some("access"),
    })
  )
}

// =============================================================================
// Middleware Implementation
// =============================================================================

/**
 * AuthMiddlewareLive - Live implementation of the authentication middleware
 *
 * This layer:
 * 1. Receives the bearer token from the request Authorization header
 * 2. Falls back to checking the taxmaxi_session cookie
 * 3. Delegates validation to the TokenValidator service
 * 4. Returns the validated User or an UnauthorizedError
 *
 * Requires: TokenValidator
 */
export const AuthMiddlewareLive: Layer.Layer<AuthMiddleware, never, TokenValidator> = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const tokenValidator = yield* TokenValidator

    const validateTokenOrFallback = (
      token: Redacted.Redacted<string>,
      fallback: () => Effect.Effect<
        Option.Option<Redacted.Redacted<string>>,
        never,
        HttpServerRequest.HttpServerRequest
      >
    ) =>
      Effect.gen(function* () {
        const providedToken = nonEmptyRedacted(token)
        if (Option.isSome(providedToken)) {
          return yield* tokenValidator.validate(providedToken.value)
        }

        const fallbackToken = yield* fallback()
        if (Option.isSome(fallbackToken)) {
          return yield* tokenValidator.validate(fallbackToken.value)
        }

        return yield* tokenValidator.validate(token)
      })
    const bearer: AuthMiddleware["Service"]["bearer"] = (httpEffect, { credential }) =>
      validateTokenOrFallback(credential, readCookieTokenFromRequest).pipe(
        Effect.flatMap((user) => Effect.provideService(httpEffect, CurrentUser, user))
      )
    const cookie: AuthMiddleware["Service"]["cookie"] = (httpEffect, { credential }) =>
      markInvalidCookieOnUnauthorized(
        validateTokenOrFallback(credential, readBearerTokenFromRequest).pipe(
          Effect.flatMap((user) => Effect.provideService(httpEffect, CurrentUser, user))
        )
      )

    return AuthMiddleware.of({
      bearer,
      cookie,
    })
  })
)

/**
 * AdminAuthMiddlewareLive - Live implementation of admin-only authentication.
 *
 * Validates the request token and provides CurrentUser only when the caller has
 * the admin role.
 */
export const AdminAuthMiddlewareLive: Layer.Layer<AdminAuthMiddleware, never, TokenValidator> =
  Layer.effect(
    AdminAuthMiddleware,
    Effect.gen(function* () {
      const tokenValidator = yield* TokenValidator

      const validateAdminToken = (token: Redacted.Redacted<string>) =>
        tokenValidator.validate(token).pipe(Effect.flatMap(requireAdminUser))

      const validateAdminTokenOrFallback = (
        token: Redacted.Redacted<string>,
        fallback: () => Effect.Effect<
          Option.Option<Redacted.Redacted<string>>,
          never,
          HttpServerRequest.HttpServerRequest
        >
      ) =>
        Effect.gen(function* () {
          const providedToken = nonEmptyRedacted(token)
          if (Option.isSome(providedToken)) {
            return yield* validateAdminToken(providedToken.value)
          }

          const fallbackToken = yield* fallback()
          if (Option.isSome(fallbackToken)) {
            return yield* validateAdminToken(fallbackToken.value)
          }

          return yield* validateAdminToken(token)
        })
      const bearer: AdminAuthMiddleware["Service"]["bearer"] = (httpEffect, { credential }) =>
        validateAdminTokenOrFallback(credential, readCookieTokenFromRequest).pipe(
          Effect.flatMap((user) => Effect.provideService(httpEffect, CurrentUser, user))
        )
      const cookie: AdminAuthMiddleware["Service"]["cookie"] = (httpEffect, { credential }) =>
        markInvalidCookieOnUnauthorized(
          validateAdminTokenOrFallback(credential, readBearerTokenFromRequest).pipe(
            Effect.flatMap((user) => Effect.provideService(httpEffect, CurrentUser, user))
          )
        )

      return AdminAuthMiddleware.of({
        bearer,
        cookie,
      })
    })
  )

/**
 * OptionalCurrentUserLive - Resolves optional request authentication for public endpoints.
 *
 * Missing credentials resolve to Option.none. Invalid Authorization headers,
 * bearer tokens, or session cookies fail with UnauthorizedError.
 */
export const OptionalCurrentUserLive: Layer.Layer<OptionalCurrentUser, never, TokenValidator> =
  Layer.effect(
    OptionalCurrentUser,
    Effect.gen(function* () {
      const tokenValidator = yield* TokenValidator

      const resolve: OptionalCurrentUserService["resolve"] = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const maybeAuthorization = Headers.get(request.headers, "authorization")
        const maybeBearerToken = maybeAuthorization.pipe(Option.flatMap(extractBearerToken))
        const maybeSessionToken = Option.fromNullishOr(request.cookies[SESSION_COOKIE_NAME])

        if (Option.isSome(maybeAuthorization) && Option.isNone(maybeBearerToken)) {
          return yield* new UnauthorizedError({ message: "Invalid authorization header" })
        }

        if (Option.isSome(maybeBearerToken)) {
          const user = yield* tokenValidator.validate(Redacted.make(maybeBearerToken.value))
          return Option.some(user)
        }

        if (Option.isSome(maybeSessionToken)) {
          const user = yield* markInvalidCookieOnUnauthorized(
            tokenValidator.validate(Redacted.make(maybeSessionToken.value))
          )
          return Option.some(user)
        }

        return Option.none<User>()
      })

      return OptionalCurrentUser.of({ resolve })
    })
  )

// =============================================================================
// Token Validator Implementations
// =============================================================================

/**
 * SimpleTokenValidatorLive - Simple token validation for development/testing
 *
 * This implementation accepts tokens in the format: "user_<userId>_<role>"
 * For example: "user_123_admin" creates a user with userId="123" and role="admin"
 *
 * In production, replace this with JWT validation or session lookup.
 */
export const SimpleTokenValidatorLive: Layer.Layer<TokenValidator> = Layer.succeed(TokenValidator, {
  validate: (token) =>
    Effect.gen(function* () {
      const tokenValue = Redacted.value(token)

      // Check for valid token format
      if (!tokenValue || tokenValue.trim() === "") {
        return yield* new UnauthorizedError({ message: "Bearer token is required" })
      }

      // Simple token format: "user_<userId>_<role>"
      const parts = tokenValue.split("_")
      if (parts.length !== 3 || parts[0] !== "user") {
        return yield* new UnauthorizedError({ message: "Invalid token format" })
      }

      const [, userIdStr, roleStr] = parts
      if (!userIdStr || userIdStr.trim() === "") {
        return yield* new UnauthorizedError({ message: "Invalid token: missing user ID" })
      }

      // Decode the userId as AuthUserId (UUID format)
      const userId = yield* Schema.decodeEffect(AuthUserId)(userIdStr).pipe(
        Effect.mapError(
          () => new UnauthorizedError({ message: "Invalid token: user ID must be a valid UUID" })
        )
      )

      // Validate role
      if (roleStr === "admin" || roleStr === "user" || roleStr === "readonly") {
        return User.make({ userId, role: roleStr })
      }

      return yield* new UnauthorizedError({ message: `Invalid token: invalid role "${roleStr}"` })
    }),
} satisfies TokenValidatorService)

/**
 * AuthMiddlewareWithSimpleValidation - Convenience layer that combines
 * AuthMiddlewareLive with SimpleTokenValidatorLive
 *
 * Use this for development and testing. In production, provide a real
 * TokenValidator implementation.
 */
export const AuthMiddlewareWithSimpleValidation: Layer.Layer<AuthMiddleware> =
  AuthMiddlewareLive.pipe(Layer.provide(SimpleTokenValidatorLive))

// =============================================================================
// Session Token Validator (Database-backed)
// =============================================================================

/**
 * Map database UserRole to middleware User role
 *
 * The auth database uses a more granular role system (admin, owner, member, viewer)
 * while the middleware uses a simpler role system (admin, user, readonly).
 *
 * @param role - The database UserRole
 * @returns The middleware role
 */
const mapUserRole = (role: UserRole): "admin" | "user" | "readonly" => {
  switch (role) {
    case "admin":
      return "admin"
    case "owner":
    case "member":
      return "user"
    case "viewer":
      return "readonly"
  }
}

/**
 * SessionTokenValidator - Session-based token validation against the database
 *
 * This implementation:
 * 1. Validates the token exists as a session ID in the auth_sessions table
 * 2. Checks the session has not expired
 * 3. Loads the full user from the auth_users table
 * 4. Maps the database user to the CurrentUser service
 *
 * Use this in production for secure session-based authentication.
 *
 * Requires: SessionRepository, UserRepository
 */
const makeSessionTokenValidator = Effect.gen(function* () {
  const sessionRepo = yield* SessionRepository
  const userRepo = yield* UserRepository

  const validate: TokenValidatorService["validate"] = (token) =>
    Effect.gen(function* () {
      const tokenValue = Redacted.value(token)

      // Check for valid token
      if (!tokenValue || tokenValue.trim() === "") {
        return yield* new UnauthorizedError({ message: "Bearer token is required" })
      }

      // Validate and create a SessionId from the token
      // Using decodeUnknown to gracefully handle invalid token formats
      const sessionId = yield* Schema.decodeEffect(SessionId)(tokenValue).pipe(
        Effect.mapError(() => new UnauthorizedError({ message: "Invalid session token format" }))
      )

      // Look up the session in the database
      const maybeSession = yield* sessionRepo
        .findById(sessionId)
        .pipe(
          Effect.mapError(() => new UnauthorizedError({ message: "Session validation failed" }))
        )

      // Check if session exists
      if (Option.isNone(maybeSession)) {
        return yield* new UnauthorizedError({ message: "Invalid or expired session" })
      }

      const session = maybeSession.value

      // Check if session has expired
      const now = Timestamp.now()
      if (session.isExpired(now)) {
        return yield* new UnauthorizedError({ message: "Session has expired" })
      }

      // Load the full user from the database
      const maybeUser = yield* userRepo
        .findById(session.userId)
        .pipe(Effect.mapError(() => new UnauthorizedError({ message: "User validation failed" })))

      // Check if user exists
      if (Option.isNone(maybeUser)) {
        return yield* new UnauthorizedError({ message: "User not found" })
      }

      const authUser = maybeUser.value

      // Map database user to CurrentUser
      return User.make({
        userId: authUser.id,
        role: mapUserRole(authUser.role),
        provider: session.provider,
        sessionId: session.id,
      })
    })

  return { validate } satisfies TokenValidatorService
})

/**
 * SessionTokenValidatorLive - Layer providing SessionTokenValidator
 *
 * Requires: SessionRepository, UserRepository
 *
 * Usage:
 * ```typescript
 * const AuthMiddlewareWithSessionValidation = AuthMiddlewareLive.pipe(
 *   Layer.provide(SessionTokenValidatorLive),
 *   Layer.provide(SessionRepositoryLive),
 *   Layer.provide(UserRepositoryLive),
 *   Layer.provide(PgClient.layer(...))
 * )
 * ```
 */
export const SessionTokenValidatorLive: Layer.Layer<
  TokenValidator,
  never,
  SessionRepository | UserRepository
> = Layer.effect(TokenValidator, makeSessionTokenValidator)

/**
 * AuthMiddlewareWithSessionValidation - Convenience layer that combines
 * AuthMiddlewareLive with SessionTokenValidatorLive
 *
 * Requires: SessionRepository, UserRepository
 *
 * Use this in production for session-based authentication.
 */
export const AuthMiddlewareWithSessionValidation: Layer.Layer<
  AuthMiddleware,
  never,
  SessionRepository | UserRepository
> = AuthMiddlewareLive.pipe(Layer.provide(SessionTokenValidatorLive))
