/**
 * HeliusSolanaSyncClient - Helius raw transaction history retrieval boundary.
 *
 * @module HeliusSolanaSyncClient
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * HeliusSolanaTransactionsForAddressConfig - Full-history Helius request options.
 */
export interface HeliusSolanaTransactionsForAddressConfig {
  readonly limit: number
  readonly paginationToken: string | null
  readonly transactionDetails: "full"
  readonly sortOrder: "desc"
  readonly filters: {
    readonly status: "any"
    readonly tokenAccounts: "balanceChanged"
  }
}

/**
 * FetchHeliusSolanaTransactionsForAddressParams - One Helius wallet-history request.
 */
export interface FetchHeliusSolanaTransactionsForAddressParams {
  readonly walletAddress: string
  readonly config: HeliusSolanaTransactionsForAddressConfig
}

/**
 * HeliusSolanaAuthError - Helius credentials are missing or rejected.
 */
export class HeliusSolanaAuthError extends Schema.TaggedError<HeliusSolanaAuthError>()(
  "HeliusSolanaAuthError",
  {
    message: Schema.String,
  }
) {}

/**
 * HeliusSolanaProviderError - Helius request failed before payload decoding.
 */
export class HeliusSolanaProviderError extends Schema.TaggedError<HeliusSolanaProviderError>()(
  "HeliusSolanaProviderError",
  {
    message: Schema.String,
    statusCode: Schema.NullOr(Schema.Number),
    retryable: Schema.Boolean,
  }
) {}

/**
 * HeliusSolanaSyncClientError - Helius client failures surfaced to the provider adapter.
 */
export type HeliusSolanaSyncClientError = HeliusSolanaAuthError | HeliusSolanaProviderError

/**
 * HeliusSolanaSyncClientShape - Mockable Helius read API used by the provider.
 */
export interface HeliusSolanaSyncClientShape {
  readonly fetchTransactionsForAddress: (
    params: FetchHeliusSolanaTransactionsForAddressParams
  ) => Effect.Effect<unknown, HeliusSolanaSyncClientError>
}

/**
 * HeliusSolanaSyncClient - Context tag for Helius raw-history retrieval.
 */
export class HeliusSolanaSyncClient extends Context.Tag("HeliusSolanaSyncClient")<
  HeliusSolanaSyncClient,
  HeliusSolanaSyncClientShape
>() {}
