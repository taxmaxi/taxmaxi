/**
 * AuthRequest - Request types for authentication operations
 *
 * Defines the various authentication request types for different providers.
 * Uses a discriminated union pattern to support multiple auth methods.
 *
 * @module AuthRequest
 */

import * as Schema from "effect/Schema"
import { Email } from "./Email.ts"
import { RedactedPassword } from "./LocalCredentials.ts"

// =============================================================================
// Local Authentication Request
// =============================================================================

/**
 * LocalAuthRequest - Request for local (email/password) authentication
 *
 * Used with the 'local' provider for username/password authentication.
 */
export class LocalAuthRequest extends Schema.TaggedClass<LocalAuthRequest>()("LocalAuthRequest", {
  /**
   * User's email address
   */
  email: Email,

  /**
   * User's password wrapped in Redacted for secure handling
   */
  password: RedactedPassword,
}) {}

/**
 * Type guard for LocalAuthRequest
 */
export const isLocalAuthRequest = Schema.is(LocalAuthRequest)

// =============================================================================
// OAuth Authentication Request
// =============================================================================

/**
 * OAuthAuthRequest - Request for OAuth-based authentication
 *
 * Used with OAuth providers (Google, GitHub) to authenticate using
 * the authorization code received from the OAuth callback.
 */
export class OAuthAuthRequest extends Schema.TaggedClass<OAuthAuthRequest>()("OAuthAuthRequest", {
  /**
   * The authorization code received from the OAuth provider
   */
  code: Schema.NonEmptyTrimmedString.annotations({
    title: "Authorization Code",
    description: "The OAuth authorization code from the callback",
  }),

  /**
   * The state parameter for CSRF protection
   */
  state: Schema.NonEmptyTrimmedString.annotations({
    title: "State",
    description: "The OAuth state parameter for CSRF protection",
  }),

  /**
   * Optional redirect URI used in the OAuth flow
   */
  redirectUri: Schema.optional(Schema.String),
}) {}

/**
 * Type guard for OAuthAuthRequest
 */
export const isOAuthAuthRequest = Schema.is(OAuthAuthRequest)

// =============================================================================
// Union Type
// =============================================================================

/**
 * AuthRequest - Union of all authentication request types
 *
 * Each request type is tagged, allowing discrimination based on _tag:
 * - LocalAuthRequest: email/password authentication
 * - OAuthAuthRequest: OAuth providers (Google, GitHub)
 */
export type AuthRequest = LocalAuthRequest | OAuthAuthRequest

/**
 * AuthRequestSchema - Schema for discriminated union of all auth request types
 */
export const AuthRequestSchema = Schema.Union(LocalAuthRequest, OAuthAuthRequest).annotations({
  identifier: "AuthRequest",
  title: "Authentication Request",
  description: "A request for authentication with any supported provider",
})
