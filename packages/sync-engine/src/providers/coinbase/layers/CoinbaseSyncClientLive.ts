/**
 * CoinbaseSyncClientLive - Live Coinbase page retrieval implementation.
 *
 * Handles OAuth token lifecycle (refresh, expiry skew), paginated list
 * requests against the Coinbase V2 API, and automatic retry on transient
 * provider failures.
 *
 * Dependencies: HttpClient (provided via FetchHttpClient), CoinbaseCredentialRepository.
 *
 * @module CoinbaseSyncClientLive
 */

import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
  CoinbaseSyncAuthError,
  CoinbaseSyncClient,
  CoinbaseSyncPayloadDecodeError,
  CoinbaseSyncProviderError,
  type CoinbaseAccountPageRecord,
  type CoinbaseCryptoCurrencyRecord,
  type CoinbaseFiatCurrencyRecord,
  type CoinbasePageResult,
  type CoinbaseSyncClientShape,
  type CoinbaseSyncCursor,
  type CoinbaseTransactionPageRecord,
} from "../services/CoinbaseSyncClient.ts"
import { CoinbaseCredentialRepository } from "../services/CoinbaseCredentialRepository.ts"

// =============================================================================
// Constants
// =============================================================================

const COINBASE_API_BASE_URL = "https://api.coinbase.com/v2"
const COINBASE_TOKEN_URL = "https://www.coinbase.com/oauth/token"
const EXPIRY_SKEW_MILLIS = 30_000
const COINBASE_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

// =============================================================================
// Schemas
// =============================================================================

const CoinbaseTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
})

const CoinbaseOAuthClientConfig = Config.all({
  clientId: Config.string("AUTH_COINBASE_CLIENT_ID"),
  clientSecret: Config.redacted("AUTH_COINBASE_CLIENT_SECRET"),
})

const CoinbasePaginationSchema = Schema.Struct({
  next_uri: Schema.NullOr(Schema.String),
  next_starting_after: Schema.optional(Schema.NullOr(Schema.String)),
})

const CoinbaseEnvelopeSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  pagination: CoinbasePaginationSchema,
})

const CoinbaseFiatCurrencyEnvelopeSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      min_size: Schema.optional(Schema.NullOr(Schema.String)),
    })
  ),
})

const CoinbaseCryptoCurrencySchema = Schema.Struct({
  code: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  exponent: Schema.optional(Schema.NullOr(Schema.Number)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  asset_id: Schema.optional(Schema.NullOr(Schema.String)),
})

const CoinbaseCryptoCurrencyEnvelopeSchema = Schema.Struct({
  data: Schema.Array(CoinbaseCryptoCurrencySchema),
})

const CoinbaseAccountSchema = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.String),
})

const CoinbaseTransactionSchema = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  idem: Schema.optional(Schema.String),
  advanced_trade_fill: Schema.optional(
    Schema.Struct({
      order_id: Schema.String,
    })
  ),
})

type CoinbaseCryptoCurrency = Schema.Schema.Type<typeof CoinbaseCryptoCurrencySchema>
type CoinbaseCryptoCurrencyEnvelope = Schema.Schema.Type<
  typeof CoinbaseCryptoCurrencyEnvelopeSchema
>

const toCryptoCurrencyArray = (
  envelope: ReadonlyArray<CoinbaseCryptoCurrency> | CoinbaseCryptoCurrencyEnvelope
): ReadonlyArray<CoinbaseCryptoCurrency> => ("data" in envelope ? envelope.data : envelope)

const toTokenRefreshFailure = ({
  sourceId,
  status,
  bodyText,
}: {
  readonly sourceId: string
  readonly status: number
  readonly bodyText: string
}): CoinbaseSyncAuthError | CoinbaseSyncProviderError => {
  const message = `Coinbase token refresh failed (${status}): ${bodyText}`

  if (COINBASE_RETRYABLE_STATUS_CODES.has(status)) {
    return new CoinbaseSyncProviderError({
      message,
      statusCode: status,
      retryable: true,
    })
  }

  if (status === 400 || status === 401 || status === 403) {
    return new CoinbaseSyncAuthError({
      sourceId,
      message: `${message} Reconnect Coinbase.`,
    })
  }

  return new CoinbaseSyncProviderError({
    message,
    statusCode: status,
    retryable: false,
  })
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse a Coinbase date string into a JS Date, failing with a decode error
 * when the string is not a valid ISO timestamp.
 */
const parseOccurredAt = ({ value, endpoint }: { value: string; endpoint: string }) =>
  Timestamp.fromString(value).pipe(
    Effect.map((timestamp) => timestamp.toDate()),
    Effect.mapError(
      () =>
        new CoinbaseSyncPayloadDecodeError({
          endpoint,
          message: `Invalid occurredAt timestamp: ${value}`,
        })
    )
  )

/**
 * Derive the next pagination cursor from a Coinbase list response.
 * Prefers `next_starting_after` when present, otherwise parses the
 * `starting_after` query parameter from `next_uri`.
 */
const toNextCursor = (
  nextUri: string | null,
  nextStartingAfter?: string | null
): CoinbaseSyncCursor => {
  if (typeof nextStartingAfter === "string" && nextStartingAfter.trim() !== "") {
    return nextStartingAfter
  }

  if (typeof nextUri !== "string" || nextUri.trim() === "") {
    return null
  }

  const parsedUrl = new URL(nextUri, COINBASE_API_BASE_URL)
  const startingAfter = parsedUrl.searchParams.get("starting_after")
  if (startingAfter === null || startingAfter.trim() === "") {
    return null
  }

  return startingAfter
}

// =============================================================================
// Implementation
// =============================================================================

const make = Effect.gen(function* () {
  const credentialRepository = yield* CoinbaseCredentialRepository
  const httpClient = yield* HttpClient.HttpClient

  // ---------------------------------------------------------------------------
  // OAuth credential management
  // ---------------------------------------------------------------------------

  /** Resolve the Coinbase OAuth client ID and secret from environment. */
  const loadOAuthClientConfig = ({ sourceId }: { sourceId: string }) =>
    CoinbaseOAuthClientConfig.pipe(
      Effect.map((config) => ({
        clientId: config.clientId,
        clientSecret: Redacted.value(config.clientSecret),
      })),
      Effect.mapError(
        () =>
          new CoinbaseSyncAuthError({
            sourceId,
            message: "Coinbase OAuth client credentials are not configured",
          })
      )
    )

  /** Load persisted OAuth tokens for a Coinbase source. */
  const loadSourceCredentials = ({ sourceId }: { sourceId: string }) =>
    Effect.gen(function* () {
      const sourceCredentials = yield* credentialRepository.findSourceCredentials({
        sourceId,
      })

      if (sourceCredentials === null) {
        return yield* Effect.fail(
          new CoinbaseSyncAuthError({
            sourceId,
            message: "Coinbase source not found for sync",
          })
        )
      }

      return sourceCredentials
    })

  /**
   * Exchange a refresh token for a new access token and persist
   * the updated credentials in `cex_account`.
   */
  const refreshAccessToken = ({
    sourceId,
    cexAccountId,
    refreshToken,
  }: {
    sourceId: string
    cexAccountId: string
    refreshToken: string
  }) =>
    Effect.gen(function* () {
      const oauthConfig = yield* loadOAuthClientConfig({ sourceId })

      const refreshRequest = HttpClientRequest.post(COINBASE_TOKEN_URL).pipe(
        HttpClientRequest.bodyText(
          new URLSearchParams({
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }).toString()
        ),
        HttpClientRequest.setHeader("Content-Type", "application/x-www-form-urlencoded")
      )

      const refreshResponse = yield* httpClient.execute(refreshRequest).pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncProviderError({
              message: `Coinbase token refresh request failed: ${error.message}`,
              statusCode: null,
              retryable: true,
            })
        )
      )

      if (refreshResponse.status !== 200) {
        const bodyText = yield* refreshResponse.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(
          toTokenRefreshFailure({
            sourceId,
            status: refreshResponse.status,
            bodyText,
          })
        )
      }

      const refreshJson = yield* refreshResponse.json.pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint: "/oauth/token",
              message: `Failed to parse Coinbase token refresh response: ${String(error)}`,
            })
        )
      )

      const refreshedToken = yield* Schema.decodeUnknown(CoinbaseTokenResponseSchema)(
        refreshJson
      ).pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint: "/oauth/token",
              message: error.message,
            })
        )
      )

      const now = Timestamp.now()
      const expiresAt = Timestamp.addSeconds(now, Math.max(0, refreshedToken.expires_in))

      yield* credentialRepository.updateSourceCredentials({
        cexAccountId,
        accessToken: refreshedToken.access_token,
        refreshToken: refreshedToken.refresh_token ?? refreshToken,
        expiresAt: expiresAt.toDate(),
        scopes: refreshedToken.scope ?? null,
      })

      return refreshedToken.access_token
    })

  /**
   * Return a valid access token for the source, refreshing first when the
   * token is expired, missing, or when `forceRefresh` is set.
   */
  const getSourceAccessToken = ({
    sourceId,
    forceRefresh,
  }: {
    sourceId: string
    forceRefresh: boolean
  }) =>
    Effect.gen(function* () {
      const sourceCredentials = yield* loadSourceCredentials({ sourceId })
      const nowWithSkew = Timestamp.addMillis(Timestamp.now(), EXPIRY_SKEW_MILLIS)
      const isExpired =
        sourceCredentials.expiresAt !== null &&
        Timestamp.fromDate(sourceCredentials.expiresAt).epochMillis <= nowWithSkew.epochMillis

      const mustRefresh =
        forceRefresh ||
        isExpired ||
        sourceCredentials.accessToken === null ||
        sourceCredentials.accessToken.trim() === ""

      if (mustRefresh) {
        const refreshToken = sourceCredentials.refreshToken
        if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
          return yield* Effect.fail(
            new CoinbaseSyncAuthError({
              sourceId,
              message: "Coinbase OAuth credentials cannot be refreshed. Reconnect Coinbase.",
            })
          )
        }

        return yield* refreshAccessToken({
          sourceId,
          cexAccountId: sourceCredentials.cexAccountId,
          refreshToken,
        })
      }

      if (sourceCredentials.accessToken === null || sourceCredentials.accessToken.trim() === "") {
        return yield* Effect.fail(
          new CoinbaseSyncAuthError({
            sourceId,
            message: "Coinbase OAuth credentials missing access token",
          })
        )
      }

      return sourceCredentials.accessToken
    })

  // ---------------------------------------------------------------------------
  // HTTP request execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single GET request with the given access token and return
   * the raw HttpClientResponse.
   */
  const executeRequest = (url: URL, accessToken: string) =>
    httpClient
      .execute(
        HttpClientRequest.get(url.toString()).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`)
        )
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncProviderError({
              message: `Provider request failed: ${error.message}`,
              statusCode: null,
              retryable: true,
            })
        )
      )

  /** Execute a public GET request that does not require OAuth credentials. */
  const executePublicRequest = (url: URL) =>
    httpClient.execute(HttpClientRequest.get(url.toString())).pipe(
      Effect.mapError(
        (error) =>
          new CoinbaseSyncProviderError({
            message: `Provider request failed: ${error.message}`,
            statusCode: null,
            retryable: true,
          })
      )
    )

  /**
   * Execute a GET request, automatically refreshing the access token on
   * 401/403 before retrying once.
   */
  const executeRequestWithTokenRefresh = ({ sourceId, url }: { sourceId: string; url: URL }) =>
    Effect.gen(function* () {
      const accessToken = yield* getSourceAccessToken({ sourceId, forceRefresh: false })
      const response = yield* executeRequest(url, accessToken)

      if (response.status === 401 || response.status === 403) {
        const refreshedToken = yield* getSourceAccessToken({ sourceId, forceRefresh: true })
        return yield* executeRequest(url, refreshedToken)
      }

      return response
    })

  /**
   * Build a paginated URL, execute the request with auth, validate the
   * status, and parse the JSON body.
   *
   * Retries up to 2 times on transient provider errors.
   */
  const executeGetJson = ({
    sourceId,
    endpoint,
    cursor,
    pageSize,
  }: {
    sourceId: string
    endpoint: string
    cursor: CoinbaseSyncCursor
    pageSize: number
  }) =>
    Effect.gen(function* () {
      const url = new URL(`${COINBASE_API_BASE_URL}${endpoint}`)
      url.searchParams.set("limit", String(pageSize))
      if (typeof cursor === "string" && cursor.trim() !== "") {
        url.searchParams.set("starting_after", cursor)
      }

      const response = yield* executeRequestWithTokenRefresh({ sourceId, url })

      if (response.status < 200 || response.status >= 300) {
        const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))

        const unauthorizedMessage =
          response.status === 401 || response.status === 403
            ? " Reconnect Coinbase and grant account/transaction read permissions."
            : ""

        return yield* Effect.fail(
          new CoinbaseSyncProviderError({
            message:
              `Coinbase request failed (${response.status}) ${endpoint}: ${bodyText}` +
              unauthorizedMessage,
            statusCode: response.status,
            retryable: COINBASE_RETRYABLE_STATUS_CODES.has(response.status),
          })
        )
      }

      return yield* response.json.pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint,
              message: `Failed to parse Coinbase JSON payload: ${String(error)}`,
            })
        )
      )
    }).pipe(
      Effect.retry(
        Schedule.recurs(2).pipe(
          Schedule.whileInput(
            (error) => error instanceof CoinbaseSyncProviderError && error.retryable
          )
        )
      )
    )

  /** Execute a public Coinbase reference-data request and parse the JSON body. */
  const executePublicGetJson = ({ endpoint }: { endpoint: string }) =>
    Effect.gen(function* () {
      const url = new URL(`${COINBASE_API_BASE_URL}${endpoint}`)
      const response = yield* executePublicRequest(url)

      if (response.status < 200 || response.status >= 300) {
        const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(
          new CoinbaseSyncProviderError({
            message: `Coinbase request failed (${response.status}) ${endpoint}: ${bodyText}`,
            statusCode: response.status,
            retryable: COINBASE_RETRYABLE_STATUS_CODES.has(response.status),
          })
        )
      }

      return yield* response.json.pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint,
              message: `Failed to parse Coinbase JSON payload: ${String(error)}`,
            })
        )
      )
    }).pipe(
      Effect.retry(
        Schedule.recurs(2).pipe(
          Schedule.whileInput(
            (error) => error instanceof CoinbaseSyncProviderError && error.retryable
          )
        )
      )
    )

  // ---------------------------------------------------------------------------
  // Page fetchers
  // ---------------------------------------------------------------------------

  /** Decode a Coinbase envelope and extract the pagination cursor. */
  const decodeEnvelope = (json: unknown, endpoint: string) =>
    Schema.decodeUnknown(CoinbaseEnvelopeSchema)(json).pipe(
      Effect.mapError(
        (error) =>
          new CoinbaseSyncPayloadDecodeError({
            endpoint,
            message: error.message,
          })
      )
    )

  const fetchAccountsPage: CoinbaseSyncClientShape["fetchAccountsPage"] = ({
    sourceId,
    cursor,
    pageSize,
  }) =>
    Effect.gen(function* () {
      const endpoint = "/accounts"
      const json = yield* executeGetJson({ sourceId, endpoint, cursor, pageSize })
      const envelope = yield* decodeEnvelope(json, endpoint)

      const records = yield* Effect.forEach(envelope.data, (accountPayload) =>
        Effect.gen(function* () {
          const account = yield* Schema.decodeUnknown(CoinbaseAccountSchema)(accountPayload).pipe(
            Effect.mapError(
              (error) =>
                new CoinbaseSyncPayloadDecodeError({
                  endpoint,
                  message: error.message,
                })
            )
          )

          const occurredAt = yield* parseOccurredAt({
            value: account.updated_at ?? account.created_at,
            endpoint,
          })

          return {
            id: account.id,
            occurredAt,
            payload: accountPayload,
          } satisfies CoinbaseAccountPageRecord
        })
      )

      return {
        records,
        nextCursor: toNextCursor(
          envelope.pagination.next_uri,
          envelope.pagination.next_starting_after
        ),
      } satisfies CoinbasePageResult<CoinbaseAccountPageRecord>
    })

  const fetchTransactionsPage: CoinbaseSyncClientShape["fetchTransactionsPage"] = ({
    sourceId,
    accountId,
    cursor,
    pageSize,
  }) =>
    Effect.gen(function* () {
      const endpoint = `/accounts/${accountId}/transactions`
      const json = yield* executeGetJson({ sourceId, endpoint, cursor, pageSize })
      const envelope = yield* decodeEnvelope(json, endpoint)

      const records = yield* Effect.forEach(envelope.data, (transactionPayload) =>
        Effect.gen(function* () {
          const transaction = yield* Schema.decodeUnknown(CoinbaseTransactionSchema)(
            transactionPayload
          ).pipe(
            Effect.mapError(
              (error) =>
                new CoinbaseSyncPayloadDecodeError({
                  endpoint,
                  message: error.message,
                })
            )
          )

          const occurredAt = yield* parseOccurredAt({ value: transaction.created_at, endpoint })

          return {
            id: transaction.id,
            accountId,
            parentId: transaction.advanced_trade_fill?.order_id ?? transaction.idem ?? null,
            occurredAt,
            payload: transactionPayload,
          } satisfies CoinbaseTransactionPageRecord
        })
      )

      return {
        records,
        nextCursor: toNextCursor(
          envelope.pagination.next_uri,
          envelope.pagination.next_starting_after
        ),
      } satisfies CoinbasePageResult<CoinbaseTransactionPageRecord>
    })

  const fetchFiatCurrencies: CoinbaseSyncClientShape["fetchFiatCurrencies"] = () =>
    Effect.gen(function* () {
      const endpoint = "/currencies"
      const json = yield* executePublicGetJson({ endpoint })
      const envelope = yield* Schema.decodeUnknown(CoinbaseFiatCurrencyEnvelopeSchema)(json).pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint,
              message: error.message,
            })
        )
      )

      return envelope.data.map(
        (currency): CoinbaseFiatCurrencyRecord => ({
          currencyCode: currency.id,
          name: currency.name ?? null,
          minSize: currency.min_size ?? null,
          payload: currency,
        })
      )
    })

  const fetchCryptoCurrencies: CoinbaseSyncClientShape["fetchCryptoCurrencies"] = () =>
    Effect.gen(function* () {
      const endpoint = "/currencies/crypto"
      const json = yield* executePublicGetJson({ endpoint })
      const envelope = yield* Schema.decodeUnknown(
        Schema.Union(
          CoinbaseCryptoCurrencyEnvelopeSchema,
          Schema.Array(CoinbaseCryptoCurrencySchema)
        )
      )(json).pipe(
        Effect.mapError(
          (error) =>
            new CoinbaseSyncPayloadDecodeError({
              endpoint,
              message: error.message,
            })
        )
      )
      const currencies = toCryptoCurrencyArray(envelope)

      return currencies.map(
        (currency: CoinbaseCryptoCurrency): CoinbaseCryptoCurrencyRecord => ({
          currencyCode: currency.code,
          name: currency.name ?? null,
          providerAssetId: currency.asset_id ?? null,
          exponent: currency.exponent ?? null,
          providerType: currency.type ?? null,
          payload: currency,
        })
      )
    })

  return CoinbaseSyncClient.of({
    fetchAccountsPage,
    fetchTransactionsPage,
    fetchFiatCurrencies,
    fetchCryptoCurrencies,
  })
})

/**
 * CoinbaseSyncClientLive - Live layer for Coinbase page retrieval.
 *
 * Requires Coinbase OAuth env vars (`AUTH_COINBASE_CLIENT_ID`,
 * `AUTH_COINBASE_CLIENT_SECRET`) and Coinbase credential persistence.
 */
export const CoinbaseSyncClientLive = Layer.effect(CoinbaseSyncClient, make).pipe(
  Layer.provide(FetchHttpClient.layer)
)
