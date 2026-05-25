/**
 * SourceProviderRegistryLive - Live provider-key registry for sync-engine modules.
 *
 * @module SourceProviderRegistryLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CoinbaseSourceSyncProvider,
  type CoinbaseRecoverableNormalizationError,
  type CoinbaseSourceSyncProviderShape,
} from "../providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import type { CoinbaseReferenceDataServiceError } from "../providers/coinbase/services/CoinbaseReferenceDataService.ts"
import {
  SourceProviderRecoverableNormalizationError,
  SourceProviderReferenceDataError,
  SourceProviderRegistry,
  type SourceProviderModuleError,
  type SourceProviderModuleShape,
  type SourceProviderRawRecordNormalizer,
} from "../services/SourceProviderRegistry.ts"
import { UnsupportedSyncProviderError } from "../shared/SourceProviderRawBatch.ts"
import { SyncEngineStorageError } from "../services/SyncEngineStorageError.ts"

const COINBASE_PROVIDER_KEY = "coinbase"
const COINBASE_TRANSACTION_RECORD_TYPE = "coinbase_transaction"

const toReferenceDataError = (
  error: CoinbaseReferenceDataServiceError
): SourceProviderModuleError =>
  error._tag === "SyncEngineStorageError"
    ? error
    : new SourceProviderReferenceDataError({
        providerKey: COINBASE_PROVIDER_KEY,
        message: error.message,
        cause: error,
      })

const toRecoverableNormalizationError = (
  error: CoinbaseRecoverableNormalizationError | SyncEngineStorageError
): SourceProviderRecoverableNormalizationError | SyncEngineStorageError =>
  error._tag === "SyncEngineStorageError"
    ? error
    : new SourceProviderRecoverableNormalizationError({
        providerKey: COINBASE_PROVIDER_KEY,
        message: error.message,
        cause: error,
      })

const makeCoinbaseProviderModule = (
  coinbaseSourceSyncProvider: CoinbaseSourceSyncProviderShape
): SourceProviderModuleShape => ({
  fetchRawBatch: coinbaseSourceSyncProvider.fetchRawBatch,
  refreshReferenceData: () =>
    coinbaseSourceSyncProvider.refreshReferenceData().pipe(Effect.mapError(toReferenceDataError)),
  makeRawRecordNormalizer: () =>
    coinbaseSourceSyncProvider.loadNormalizationLookups().pipe(
      Effect.map(
        (lookups): SourceProviderRawRecordNormalizer =>
          ({ source, sourceRecord }) =>
            Effect.gen(function* () {
              if (sourceRecord.recordType !== COINBASE_TRANSACTION_RECORD_TYPE) {
                return { kind: "skipped" } as const
              }

              const prepared = yield* coinbaseSourceSyncProvider
                .prepareNormalization({
                  source,
                  sourceRecord,
                  lookups,
                })
                .pipe(Effect.mapError(toRecoverableNormalizationError))

              return {
                kind: "prepared",
                transaction: prepared.transaction,
                venueContext: prepared.venueContext,
                providerTransfers: prepared.providerTransfers,
                feeTransfers: prepared.feeTransfers,
                transactionReview: prepared.transactionReview,
                resolvedTransactionType: prepared.resolvedTransactionType,
                deriveLegs:
                  prepared.legDerivationStrategy === "derive"
                    ? ({ transaction, venueContext, feeTransfers }) =>
                        coinbaseSourceSyncProvider
                          .deriveLegs({
                            transaction,
                            venueContext,
                            primaryAsset: prepared.primaryAsset,
                            feeTransfers,
                          })
                          .pipe(Effect.mapError(toRecoverableNormalizationError))
                    : () => Effect.succeed([]),
              } as const
            })
      )
    ),
})

const make = Effect.gen(function* () {
  const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider

  return SourceProviderRegistry.of({
    resolveProviderModule: ({ providerKey }) => {
      switch (providerKey) {
        case COINBASE_PROVIDER_KEY:
          return Effect.succeed(makeCoinbaseProviderModule(coinbaseSourceSyncProvider))
        default:
          return Effect.fail(new UnsupportedSyncProviderError({ providerKey }))
      }
    },
  })
})

/**
 * SourceProviderRegistryLive - Live provider-key registry for sync-engine modules.
 */
export const SourceProviderRegistryLive = Layer.effect(SourceProviderRegistry, make)
