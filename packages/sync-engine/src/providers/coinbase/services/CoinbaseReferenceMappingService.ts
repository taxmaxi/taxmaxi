/**
 * CoinbaseReferenceMappingService - Deterministic Coinbase mapping contract.
 *
 * @module CoinbaseReferenceMappingService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type {
  ProviderMappingStatus,
  ResolvedProviderTransactionTypeMapping,
} from "../../../services/ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

/**
 * CoinbasePendingTransactionTypeMappingError - A Coinbase transaction type still requires review.
 */
export class CoinbasePendingTransactionTypeMappingError extends Schema.TaggedError<CoinbasePendingTransactionTypeMappingError>()(
  "CoinbasePendingTransactionTypeMappingError",
  {
    providerTransactionType: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbaseProviderAssetMappingNotFoundError - Coinbase provider asset has no mapping row yet.
 */
export class CoinbaseProviderAssetMappingNotFoundError extends Schema.TaggedError<CoinbaseProviderAssetMappingNotFoundError>()(
  "CoinbaseProviderAssetMappingNotFoundError",
  {
    currencyCode: Schema.String,
    providerAssetRowId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbasePendingProviderAssetMappingError - Coinbase provider asset mapping is pending review.
 */
export class CoinbasePendingProviderAssetMappingError extends Schema.TaggedError<CoinbasePendingProviderAssetMappingError>()(
  "CoinbasePendingProviderAssetMappingError",
  {
    currencyCode: Schema.String,
    providerAssetRowId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbaseBrokenApprovedProviderAssetMappingError - Approved provider asset mapping points at
 * a broken or missing canonical target.
 */
export class CoinbaseBrokenApprovedProviderAssetMappingError extends Schema.TaggedError<CoinbaseBrokenApprovedProviderAssetMappingError>()(
  "CoinbaseBrokenApprovedProviderAssetMappingError",
  {
    currencyCode: Schema.String,
    providerAssetRowId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * CoinbaseReferenceMappingServiceError - Union of deterministic Coinbase mapping failures.
 */
export type CoinbaseReferenceMappingServiceError =
  | CoinbasePendingTransactionTypeMappingError
  | CoinbaseProviderAssetMappingNotFoundError
  | CoinbasePendingProviderAssetMappingError
  | CoinbaseBrokenApprovedProviderAssetMappingError
  | SyncEngineStorageError

/**
 * CoinbaseTransactionTypeMappingServiceError - Deterministic Coinbase transaction-type mapping failures.
 */
export type CoinbaseTransactionTypeMappingServiceError =
  | CoinbasePendingTransactionTypeMappingError
  | SyncEngineStorageError

export interface CoinbaseResolvedTransactionTypeMapping extends ResolvedProviderTransactionTypeMapping {}

/**
 * EnsureCoinbaseReferenceMappingsResult - Counts returned after ensuring default mappings.
 */
export interface EnsureCoinbaseReferenceMappingsResult {
  readonly transactionTypeMappingCount: number
  readonly providerAssetMappingCount: number
}

/**
 * CoinbaseResolvedCurrencyMapping - Deterministic Coinbase currency mapping result.
 */
export interface CoinbaseResolvedCurrencyMapping {
  readonly providerAssetRowId: string
  readonly currencyCode: string
  readonly mappingStatus: ProviderMappingStatus
  readonly mappingKind: "asset" | "fiat"
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
}

/**
 * ResolveCoinbaseTransactionTypeParams - Context required to resolve one Coinbase transaction type.
 */
export interface ResolveCoinbaseTransactionTypeParams {
  readonly providerTransactionType: string
  readonly venueSide: string | null
  readonly nativeCurrency: string | null
  readonly rawSourcePayload: unknown
}

/**
 * ResolveCoinbaseCurrencyParams - Context required to resolve one Coinbase currency.
 */
export interface ResolveCoinbaseCurrencyParams {
  readonly currencyCode: string
  readonly rawSourcePayload?: unknown
}

/**
 * CoinbaseReferenceMappingServiceShape - Coinbase mapping lifecycle and deterministic resolution.
 */
export interface CoinbaseReferenceMappingServiceShape {
  readonly ensureDefaultMappings: () => Effect.Effect<
    EnsureCoinbaseReferenceMappingsResult,
    SyncEngineStorageError
  >

  readonly resolveTransactionType: (
    params: ResolveCoinbaseTransactionTypeParams
  ) => Effect.Effect<
    CoinbaseResolvedTransactionTypeMapping,
    CoinbaseTransactionTypeMappingServiceError
  >

  readonly resolveCurrency: (
    params: ResolveCoinbaseCurrencyParams
  ) => Effect.Effect<CoinbaseResolvedCurrencyMapping, CoinbaseReferenceMappingServiceError>

  readonly resolveAssetId: (
    params: ResolveCoinbaseCurrencyParams
  ) => Effect.Effect<string, CoinbaseReferenceMappingServiceError>
}

/**
 * CoinbaseReferenceMappingService - Context tag for Coinbase mapping resolution.
 */
export class CoinbaseReferenceMappingService extends Context.Tag("CoinbaseReferenceMappingService")<
  CoinbaseReferenceMappingService,
  CoinbaseReferenceMappingServiceShape
>() {}
