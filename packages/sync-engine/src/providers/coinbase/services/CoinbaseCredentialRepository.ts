/**
 * CoinbaseCredentialRepository - Durable credential storage contract for Coinbase sync.
 *
 * @module CoinbaseCredentialRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

/**
 * CoinbaseSourceCredentials - OAuth credentials required for Coinbase sync.
 */
export interface CoinbaseSourceCredentials {
  readonly cexAccountId: string
  readonly accessToken: string | null
  readonly refreshToken: string | null
  readonly expiresAt: Date | null
}

/**
 * UpdateCoinbaseSourceCredentialsParams - Refreshed credential values to persist.
 */
export interface UpdateCoinbaseSourceCredentialsParams {
  readonly cexAccountId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: Date
  readonly scopes: string | null
}

/**
 * CoinbaseCredentialRepositoryShape - Credential lookup/update operations used by sync.
 */
export interface CoinbaseCredentialRepositoryShape {
  readonly findSourceCredentials: (params: {
    readonly sourceId: string
  }) => Effect.Effect<CoinbaseSourceCredentials | null, SyncEngineStorageError>

  readonly updateSourceCredentials: (
    params: UpdateCoinbaseSourceCredentialsParams
  ) => Effect.Effect<void, SyncEngineStorageError>
}

/**
 * CoinbaseCredentialRepository - Context tag for Coinbase credential persistence.
 */
export class CoinbaseCredentialRepository extends Context.Tag("CoinbaseCredentialRepository")<
  CoinbaseCredentialRepository,
  CoinbaseCredentialRepositoryShape
>() {}
