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
import {
  type HeliusSolanaRecoverableNormalizationError,
  HELIUS_SOLANA_PROVIDER_KEY,
  HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
  HeliusSolanaSourceSyncProvider,
  type HeliusSolanaSourceSyncProviderShape,
} from "../providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
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

const toCoinbaseRecoverableNormalizationError = (
  error: CoinbaseRecoverableNormalizationError | SyncEngineStorageError
): SourceProviderRecoverableNormalizationError | SyncEngineStorageError =>
  error._tag === "SyncEngineStorageError"
    ? error
    : new SourceProviderRecoverableNormalizationError({
        providerKey: COINBASE_PROVIDER_KEY,
        message: error.message,
        cause: error,
      })

const toHeliusSolanaRecoverableNormalizationError = (
  error: HeliusSolanaRecoverableNormalizationError | SyncEngineStorageError
): SourceProviderRecoverableNormalizationError | SyncEngineStorageError =>
  error._tag === "SyncEngineStorageError"
    ? error
    : new SourceProviderRecoverableNormalizationError({
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
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
                .pipe(Effect.mapError(toCoinbaseRecoverableNormalizationError))

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
                          .pipe(Effect.mapError(toCoinbaseRecoverableNormalizationError))
                    : () => Effect.succeed([]),
              } as const
            })
      )
    ),
})

const makeHeliusSolanaProviderModule = (
  heliusSolanaSourceSyncProvider: HeliusSolanaSourceSyncProviderShape
): SourceProviderModuleShape => ({
  fetchRawBatch: heliusSolanaSourceSyncProvider.fetchRawBatch,
  refreshReferenceData: heliusSolanaSourceSyncProvider.refreshReferenceData,
  makeRawRecordNormalizer: () =>
    heliusSolanaSourceSyncProvider.loadNormalizationLookups().pipe(
      Effect.map(
        (lookups): SourceProviderRawRecordNormalizer =>
          ({ source, sourceRecord }) =>
            Effect.gen(function* () {
              if (sourceRecord.recordType !== HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL) {
                return { kind: "skipped" } as const
              }

              const prepared = yield* heliusSolanaSourceSyncProvider
                .prepareNormalization({
                  source,
                  sourceRecord,
                  lookups,
                })
                .pipe(Effect.mapError(toHeliusSolanaRecoverableNormalizationError))

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
                        heliusSolanaSourceSyncProvider
                          .deriveLegs({
                            transaction,
                            venueContext,
                            feeTransfers,
                          })
                          .pipe(Effect.mapError(toHeliusSolanaRecoverableNormalizationError))
                    : () => Effect.succeed([]),
              } as const
            })
      )
    ),
})

const make = Effect.gen(function* () {
  const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider
  const heliusSolanaSourceSyncProvider = yield* HeliusSolanaSourceSyncProvider

  return SourceProviderRegistry.of({
    resolveProviderModule: ({ providerKey }) => {
      switch (providerKey) {
        case COINBASE_PROVIDER_KEY:
          return Effect.succeed(makeCoinbaseProviderModule(coinbaseSourceSyncProvider))
        case HELIUS_SOLANA_PROVIDER_KEY:
          return Effect.succeed(makeHeliusSolanaProviderModule(heliusSolanaSourceSyncProvider))
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
