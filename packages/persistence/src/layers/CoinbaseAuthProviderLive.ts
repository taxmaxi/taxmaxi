/**
 * CoinbaseAuthProviderLive - Coinbase OAuth implementation of AuthProvider
 *
 * Implements the AuthProvider interface for Coinbase OAuth2 authentication.
 * Uses Coinbase OAuth REST API directly with HttpClient (no SDK dependency).
 *
 * Coinbase OAuth2 Flow:
 * 1. Generate authorization URL with email/profile scopes
 * 2. User redirects to Coinbase and authenticates
 * 3. Coinbase redirects back with authorization code
 * 4. Exchange code for tokens via Coinbase OAuth token endpoint
 * 5. Fetch user profile from Coinbase API
 *
 * @module CoinbaseAuthProviderLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import {
  type AuthProvider,
  ProviderId,
  Email,
  AuthResult,
  OAuthCredentials,
} from "@my/core/authentication"
import { ProviderAuthFailedError } from "@my/core/authentication/errors"
import { withObservedOperation } from "@my/core/shared/observability/ObservedOperation"
import { CoinbaseAuthProvider } from "../services/CoinbaseAuthProvider.ts"
import { CoinbaseConfigTag } from "../services/CoinbaseConfig.ts"

// =============================================================================
// Coinbase OAuth2 URLs
// =============================================================================

const COINBASE_AUTH_URL = "https://www.coinbase.com/oauth/authorize"
const COINBASE_TOKEN_URL = "https://www.coinbase.com/oauth/token"
const COINBASE_USERINFO_URL = "https://api.coinbase.com/v2/user"

/**
 * Coinbase OAuth scopes for profile/email access
 */
const COINBASE_SCOPES = ["wallet:user:email", "wallet:accounts:read", "wallet:transactions:read"]

// =============================================================================
// Coinbase API Response Schemas
// =============================================================================

/**
 * Coinbase Token Response schema - Response from token exchange endpoint
 */
const CoinbaseTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
})

/**
 * Coinbase UserInfo schema - User profile returned by Coinbase userinfo endpoint
 */
const CoinbaseUserInfo = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
    avatar_url: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
    email_verified: Schema.optional(Schema.Boolean),
  }),
})

type CoinbaseUserInfo = typeof CoinbaseUserInfo.Type

// =============================================================================
// Implementation
// =============================================================================

/**
 * Implementation of AuthProvider for Coinbase OAuth authentication
 */
const make = Effect.gen(function* () {
  const config = yield* CoinbaseConfigTag
  const httpClient = yield* HttpClient.HttpClient

  const coinbaseAuthSpan = ({
    name,
    attributes,
  }: {
    readonly name: string
    readonly attributes?: Record<string, unknown>
  }) =>
    withObservedOperation({
      name: `persistence.coinbase-auth.${name}`,
      attributes: {
        provider: "coinbase",
        ...attributes,
      },
      kind: "client",
    })

  /**
   * Build the display name from Coinbase userinfo
   */
  const buildDisplayName = (userInfo: CoinbaseUserInfo): string => {
    // Prefer full name, then given + family, then email
    if (userInfo.data.name) {
      return userInfo.data.name
    }

    if (userInfo.data.username) {
      return userInfo.data.username
    }

    return userInfo.data.email ?? "Coinbase User"
  }

  /**
   * Map Coinbase userinfo to AuthResult
   */
  const mapToAuthResult = (
    userInfo: CoinbaseUserInfo,
    email: string,
    oauthTokens: OAuthCredentials
  ): AuthResult =>
    AuthResult.make({
      provider: "coinbase",
      providerId: ProviderId.make(userInfo.data.id),
      email: Email.make(email),
      displayName: buildDisplayName(userInfo),
      emailVerified: userInfo.data.email_verified ?? false,
      providerData: Option.some({
        profile: {
          name: userInfo.data.name,
          username: userInfo.data.username,
          avatar_url: userInfo.data.avatar_url,
          email: userInfo.data.email,
        },
      }),
      oauthCredentials: Option.some(oauthTokens),
    })

  const provider: AuthProvider = {
    /**
     * Provider type identifier
     */
    type: "coinbase",

    /**
     * Coinbase OAuth does NOT support registration - users are auto-provisioned on first login
     */
    supportsRegistration: false,

    /**
     * Authenticate a user with Coinbase credentials
     *
     * For Coinbase, authenticate() is not used directly - use the OAuth flow instead.
     * This method will always fail as Coinbase requires redirect-based flow.
     */
    authenticate: () =>
      Effect.fail(
        new ProviderAuthFailedError({
          provider: "coinbase",
          reason:
            "Coinbase requires OAuth redirect flow. Use getAuthorizationUrl() and handleCallback() instead.",
        })
      ),

    /**
     * Generate the Coinbase OAuth authorization URL
     *
     * Returns the URL to redirect users to for authentication.
     * The URL includes:
     * - client_id: Your Coinbase OAuth client ID
     * - redirect_uri: Where to redirect after auth
     * - response_type: Always "code" for OAuth authorization code flow
     * - scope: wallet:user:email
     * - state: CSRF protection token
     * @param state - CSRF protection state parameter
     * @param redirectUri - Optional custom redirect URI (defaults to config)
     */
    getAuthorizationUrl: (state: string, redirectUri?: string) => {
      const params = new URLSearchParams()
      params.set("client_id", config.clientId)
      params.set("redirect_uri", redirectUri ?? config.redirectUri)
      params.set("response_type", "code")
      params.set("scope", COINBASE_SCOPES.join(" "))
      params.set("state", state)
      return Option.some(`${COINBASE_AUTH_URL}?${params.toString()}`)
    },

    /**
     * Handle the OAuth callback from Coinbase
     *
     * Exchanges the authorization code for tokens via Coinbase OAuth API,
     * then fetches the user profile from the userinfo endpoint.
     *
     * @param code - The authorization code from Coinbase callback
     * @param redirectUri - The redirect URI to use for the callback
     */
    handleCallback: (code: string, redirectUri?: string) =>
      Effect.gen(function* () {
        const callbackRedirectUri = redirectUri ?? config.redirectUri

        yield* Effect.logInfo(
          {
            redirectUri: callbackRedirectUri,
          },
          "coinbase-auth:callback-started"
        )

        // Step 1: Exchange code for tokens
        const tokenRequest = HttpClientRequest.post(COINBASE_TOKEN_URL).pipe(
          HttpClientRequest.bodyText(
            new URLSearchParams({
              client_id: config.clientId,
              client_secret: Redacted.value(config.clientSecret),
              code,
              grant_type: "authorization_code",
              redirect_uri: callbackRedirectUri,
            }).toString()
          ),
          HttpClientRequest.setHeader("Content-Type", "application/x-www-form-urlencoded")
        )

        const tokenResponse = yield* httpClient.execute(tokenRequest).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `HTTP request to token endpoint failed: ${error.message}`,
              })
          ),
          coinbaseAuthSpan({
            name: "token-request",
          })
        )

        // Check for successful token response
        if (tokenResponse.status !== 200) {
          const errorBody = yield* tokenResponse.text.pipe(
            Effect.mapError(
              (readError) =>
                new ProviderAuthFailedError({
                  provider: "coinbase",
                  reason: `Token exchange failed (${tokenResponse.status}), error body unreadable: ${String(readError)}`,
                })
            )
          )
          return yield* Effect.fail(
            new ProviderAuthFailedError({
              provider: "coinbase",
              reason: `Token exchange failed (${tokenResponse.status}): ${errorBody}`,
            })
          )
        }

        // Parse the token response
        const tokenJson = yield* tokenResponse.json.pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `Failed to parse Coinbase token response: ${String(error)}`,
              })
          )
        )

        // Decode the token response using Schema
        const tokens = yield* Schema.decodeUnknown(CoinbaseTokenResponse)(tokenJson).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `Invalid Coinbase token response: ${error.message}`,
              })
          )
        )

        // Step 2: Fetch user profile from userinfo endpoint
        const userInfoRequest = HttpClientRequest.get(COINBASE_USERINFO_URL).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${tokens.access_token}`)
        )

        const userInfoResponse = yield* httpClient.execute(userInfoRequest).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `HTTP request to userinfo endpoint failed: ${error.message}`,
              })
          ),
          coinbaseAuthSpan({
            name: "userinfo-request",
          })
        )

        // Check for successful userinfo response
        if (userInfoResponse.status !== 200) {
          const errorBody = yield* userInfoResponse.text.pipe(
            Effect.mapError(
              (readError) =>
                new ProviderAuthFailedError({
                  provider: "coinbase",
                  reason: `Userinfo request failed (${userInfoResponse.status}), error body unreadable: ${String(readError)}`,
                })
            )
          )
          return yield* Effect.fail(
            new ProviderAuthFailedError({
              provider: "coinbase",
              reason: `Userinfo request failed (${userInfoResponse.status}): ${errorBody}`,
            })
          )
        }

        // Parse the userinfo response
        const userInfoJson = yield* userInfoResponse.json.pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `Failed to parse Coinbase userinfo response: ${String(error)}`,
              })
          )
        )

        // Decode the userinfo response using Schema
        const userInfo = yield* Schema.decodeUnknown(CoinbaseUserInfo)(userInfoJson).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAuthFailedError({
                provider: "coinbase",
                reason: `Invalid Coinbase userinfo response: ${error.message}`,
              })
          )
        )

        if (userInfo.data.email === undefined || userInfo.data.email.trim() === "") {
          return yield* Effect.fail(
            new ProviderAuthFailedError({
              provider: "coinbase",
              reason: "Coinbase profile did not include an email address",
            })
          )
        }

        const expiresAtEpochMillis = yield* Effect.map(
          Effect.clockWith((clock) => clock.currentTimeMillis),
          (currentTimeMillis) => Number(currentTimeMillis) + Math.max(0, tokens.expires_in) * 1000
        )

        yield* Effect.annotateCurrentSpan({
          providerId: userInfo.data.id,
          expiresInSeconds: tokens.expires_in,
        })

        yield* Effect.logInfo(
          {
            providerId: userInfo.data.id,
            expiresInSeconds: tokens.expires_in,
          },
          "coinbase-auth:callback-succeeded"
        )

        // Map to AuthResult
        return mapToAuthResult(
          userInfo,
          userInfo.data.email,
          OAuthCredentials.make({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresAtEpochMillis,
            scopes: tokens.scope ?? null,
          })
        )
      }).pipe(
        coinbaseAuthSpan({
          name: "handle-callback",
          attributes: {
            redirectUri: redirectUri ?? config.redirectUri,
          },
        })
      ),
  }

  return provider
})

/**
 * CoinbaseAuthProviderLive - Layer providing CoinbaseAuthProvider implementation
 *
 * Requires:
 * - CoinbaseConfigTag: Coinbase OAuth configuration (client ID, client secret, redirect URI)
 * - HttpClient: For making HTTP requests to Coinbase OAuth API
 */
export const CoinbaseAuthProviderLive: Layer.Layer<
  CoinbaseAuthProvider,
  never,
  CoinbaseConfigTag | HttpClient.HttpClient
> = Layer.effect(CoinbaseAuthProvider, make)
