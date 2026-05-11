/**
 * CoinbaseSyncClient - Service contract for paginated Coinbase retrieval.
 *
 * @module CoinbaseSyncClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

/**
 * CoinbaseSyncAuthError - Coinbase credentials are missing or invalid.
 */
export class CoinbaseSyncAuthError extends Schema.TaggedError<CoinbaseSyncAuthError>()(
  "CoinbaseSyncAuthError",
  {
    sourceId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbaseSyncProviderError - Coinbase provider request failed.
 */
export class CoinbaseSyncProviderError extends Schema.TaggedError<CoinbaseSyncProviderError>()(
  "CoinbaseSyncProviderError",
  {
    message: Schema.String,
    statusCode: Schema.NullOr(Schema.Number),
    retryable: Schema.Boolean,
  }
) {}

/**
 * CoinbaseSyncPayloadDecodeError - Coinbase payload did not match the expected shape.
 */
export class CoinbaseSyncPayloadDecodeError extends Schema.TaggedError<CoinbaseSyncPayloadDecodeError>()(
  "CoinbaseSyncPayloadDecodeError",
  {
    endpoint: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbaseSyncClientError - Union of Coinbase sync client failures.
 */
export type CoinbaseSyncClientError =
  | CoinbaseSyncAuthError
  | CoinbaseSyncProviderError
  | CoinbaseSyncPayloadDecodeError
  | SyncEngineStorageError

/**
 * CoinbaseSyncCursor - Pagination cursor used by Coinbase list endpoints.
 */
export type CoinbaseSyncCursor = string | null

/**
 * CoinbaseAccountPageRecord - Minimal account record needed for ingestion.
 */
export interface CoinbaseAccountPageRecord {
  readonly id: string
  readonly occurredAt: Date
  readonly payload: unknown
}

/**
 * CoinbaseTransactionPageRecord - Minimal transaction record needed for ingestion.
 */
export interface CoinbaseTransactionPageRecord {
  readonly id: string
  readonly accountId: string
  readonly parentId: string | null
  readonly occurredAt: Date
  readonly payload: unknown
}

/**
 * CoinbasePageResult - Generic paginated response shape.
 */
export interface CoinbasePageResult<TRecord> {
  readonly records: ReadonlyArray<TRecord>
  readonly nextCursor: CoinbaseSyncCursor
}

/**
 * CoinbaseFiatCurrencyRecord - Minimal fiat currency reference metadata.
 */
export interface CoinbaseFiatCurrencyRecord {
  readonly currencyCode: string
  readonly name: string | null
  readonly minSize: string | null
  readonly payload: unknown
}

/**
 * CoinbaseCryptoCurrencyRecord - Minimal crypto currency reference metadata.
 */
export interface CoinbaseCryptoCurrencyRecord {
  readonly currencyCode: string
  readonly name: string | null
  readonly providerAssetId: string | null
  readonly exponent: number | null
  readonly providerType: string | null
  readonly payload: unknown
}

/**
 * FetchCoinbaseAccountsPageParams - Input for fetching one Coinbase accounts page.
 */
export interface FetchCoinbaseAccountsPageParams {
  readonly sourceId: string
  readonly cursor: CoinbaseSyncCursor
  readonly pageSize: number
}

/**
 * FetchCoinbaseTransactionsPageParams - Input for fetching one Coinbase transactions page.
 */
export interface FetchCoinbaseTransactionsPageParams {
  readonly sourceId: string
  readonly accountId: string
  readonly cursor: CoinbaseSyncCursor
  readonly pageSize: number
}

/**
 * CoinbaseSyncClientShape - Coinbase retrieval contract used by provider adapters.
 */
export interface CoinbaseSyncClientShape {
  readonly fetchAccountsPage: (
    params: FetchCoinbaseAccountsPageParams
  ) => Effect.Effect<CoinbasePageResult<CoinbaseAccountPageRecord>, CoinbaseSyncClientError>

  readonly fetchTransactionsPage: (
    params: FetchCoinbaseTransactionsPageParams
  ) => Effect.Effect<CoinbasePageResult<CoinbaseTransactionPageRecord>, CoinbaseSyncClientError>

  readonly fetchFiatCurrencies: () => Effect.Effect<
    ReadonlyArray<CoinbaseFiatCurrencyRecord>,
    CoinbaseSyncClientError
  >

  readonly fetchCryptoCurrencies: () => Effect.Effect<
    ReadonlyArray<CoinbaseCryptoCurrencyRecord>,
    CoinbaseSyncClientError
  >
}

/**
 * CoinbaseSyncClient - Context tag for Coinbase sync retrieval.
 */
export class CoinbaseSyncClient extends Context.Tag("CoinbaseSyncClient")<
  CoinbaseSyncClient,
  CoinbaseSyncClientShape
>() {}
