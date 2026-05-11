/**
 * CoinbaseReferenceDataService - Durable Coinbase reference-data refresh contract.
 *
 * @module CoinbaseReferenceDataService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

/**
 * CoinbaseReferenceDataError - Coinbase reference data refresh failed.
 */
export class CoinbaseReferenceDataError extends Schema.TaggedError<CoinbaseReferenceDataError>()(
  "CoinbaseReferenceDataError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * RefreshCoinbaseReferenceDataResult - Row counts returned after refreshing Coinbase reference datasets.
 */
export interface RefreshCoinbaseReferenceDataResult {
  readonly transactionTypeCatalogCount: number
  readonly providerAssetCatalogCount: number
  readonly defaultTransactionMappingCount: number
  readonly defaultProviderAssetMappingCount: number
}

/**
 * CoinbaseReferenceDataServiceError - Union of Coinbase reference refresh failures.
 */
export type CoinbaseReferenceDataServiceError = CoinbaseReferenceDataError | SyncEngineStorageError

/**
 * CoinbaseReferenceDataServiceShape - Refresh Coinbase transaction and currency references.
 */
export interface CoinbaseReferenceDataServiceShape {
  readonly refreshReferenceData: () => Effect.Effect<
    RefreshCoinbaseReferenceDataResult,
    CoinbaseReferenceDataServiceError
  >
}

/**
 * CoinbaseReferenceDataService - Context tag for Coinbase reference-data refresh.
 */
export class CoinbaseReferenceDataService extends Context.Tag("CoinbaseReferenceDataService")<
  CoinbaseReferenceDataService,
  CoinbaseReferenceDataServiceShape
>() {}
