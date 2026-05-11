/**
 * CoinbaseConfig - Configuration schema for Coinbase OAuth integration
 *
 * Defines the environment configuration required to connect to Coinbase
 * for OAuth2 authentication.
 *
 * @module CoinbaseConfig
 */

import * as Context from "effect/Context"
import * as Schema from "effect/Schema"

/**
 * CoinbaseConfig - Configuration for Coinbase OAuth provider
 *
 * All values are typically loaded from environment variables:
 * - AUTH_COINBASE_CLIENT_ID: The Coinbase OAuth client ID
 * - AUTH_COINBASE_CLIENT_SECRET: The Coinbase OAuth client secret
 * - AUTH_COINBASE_REDIRECT_URI: The callback URL for OAuth flow
 */
export class CoinbaseConfig extends Schema.Class<CoinbaseConfig>("CoinbaseConfig")({
  /**
   * Coinbase OAuth Client ID
   *
   * Used to identify your application in OAuth flows.
   */
  clientId: Schema.NonEmptyTrimmedString.annotations({
    title: "Client ID",
    description: "Coinbase OAuth client ID",
  }),

  /**
   * Coinbase OAuth Client Secret
   *
   * Used for server-side token exchange.
   * Must be kept confidential.
   */
  clientSecret: Schema.Redacted(Schema.NonEmptyTrimmedString).annotations({
    title: "Client Secret",
    description: "Coinbase OAuth client secret for server-side authentication",
  }),

  /**
   * OAuth redirect URI
   *
   * The URL where Coinbase redirects after authentication.
   * Must be registered in your Coinbase OAuth app settings.
   */
  redirectUri: Schema.NonEmptyTrimmedString.annotations({
    title: "Redirect URI",
    description: "OAuth callback URL registered in Coinbase OAuth app settings",
  }),
}) {}

/**
 * CoinbaseConfigTag - Context.Tag for dependency injection
 */
export class CoinbaseConfigTag extends Context.Tag("CoinbaseConfig")<
  CoinbaseConfigTag,
  CoinbaseConfig
>() {}
