/**
 * AuthProviderType - Literal union schema for authentication providers
 *
 * Defines the supported authentication provider types. The schema is extensible
 * by adding new literal values to support additional providers.
 *
 * @module AuthProviderType
 */

import * as Schema from "effect/Schema"

const LOCAL_AUTH_PROVIDER = "local" as const

/**
 * All OAuth-based provider types.
 */
export const OAUTH_PROVIDER_TYPES = ["google", "coinbase"] as const

/**
 * OAuthProviderType - Supported OAuth authentication providers
 */
export const OAuthProviderType = Schema.Literal(...OAUTH_PROVIDER_TYPES).annotations({
  identifier: "OAuthProviderType",
  title: "OAuth Provider Type",
  description: "The type of OAuth authentication provider used",
})

/**
 * The OAuthProviderType type
 */
export type OAuthProviderType = typeof OAuthProviderType.Type

/**
 * Type guard for OAuthProviderType using Schema.is
 */
export const isOAuthProviderType = Schema.is(OAuthProviderType)

/**
 * AuthProviderType - Supported authentication providers
 *
 * Current providers:
 * - 'local': Username/password authentication
 * - 'google': Google OAuth
 * - 'coinbase': Coinbase OAuth
 *
 * Additional providers can be added as needed.
 */
export const AuthProviderType = Schema.Literal(
  LOCAL_AUTH_PROVIDER,
  ...OAUTH_PROVIDER_TYPES
).annotations({
  identifier: "AuthProviderType",
  title: "Auth Provider Type",
  description: "The type of authentication provider used",
})

/**
 * The AuthProviderType type
 */
export type AuthProviderType = typeof AuthProviderType.Type

/**
 * Type guard for AuthProviderType using Schema.is
 */
export const isAuthProviderType = Schema.is(AuthProviderType)

/**
 * All supported auth provider types as an array
 */
export const AUTH_PROVIDER_TYPES: readonly AuthProviderType[] = [
  LOCAL_AUTH_PROVIDER,
  ...OAUTH_PROVIDER_TYPES,
] as const
