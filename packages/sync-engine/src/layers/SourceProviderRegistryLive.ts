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

interface CoinbaseAccountingAssetRequirement {
  readonly requiredForMainLeg: boolean
  readonly inclusionState: "blocked" | "excluded" | "included"
}

/** Decide whether Coinbase has the effective assets needed to derive its main accounting leg. */
export const shouldDeriveCoinbaseLegs = ({
  accountingAssetRequirements,
  canDeriveWithAssetOverrides,
  legDerivationStrategy,
  primaryAssetAvailable,
}: {
  readonly accountingAssetRequirements: ReadonlyArray<CoinbaseAccountingAssetRequirement>
  readonly canDeriveWithAssetOverrides: boolean
  readonly legDerivationStrategy: "derive" | "skip"
  readonly primaryAssetAvailable: boolean
}): boolean =>
  primaryAssetAvailable &&
  (legDerivationStrategy === "derive" || canDeriveWithAssetOverrides) &&
  accountingAssetRequirements.every(
    ({ inclusionState, requiredForMainLeg }) => !requiredForMainLeg || inclusionState === "included"
  )

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
                providerAssetRowIds: prepared.providerAssetRowIds,
                transaction: prepared.transaction,
                venueContext: prepared.venueContext,
                onchainContext: null,
                providerTransfers: prepared.providerTransfers,
                canonicalTransfers: prepared.canonicalTransfers,
                transactionReview: prepared.transactionReview,
                overrideMaterializationAllowed: false,
                resolvedTransactionType: prepared.resolvedTransactionType,
                deriveLegs: ({
                  transaction,
                  venueContext,
                  canonicalTransfers,
                  effectiveProviderAssets,
                }) => {
                  const effectivePrimaryAsset = effectiveProviderAssets.find(
                    ({ providerAssetRowId }) =>
                      providerAssetRowId === prepared.primaryProviderAssetId
                  )
                  const primaryAsset =
                    effectivePrimaryAsset === undefined
                      ? prepared.primaryAsset
                      : effectivePrimaryAsset.asset
                  const accountingAssetRequirements = effectiveProviderAssets.map(
                    ({ inclusionState, providerAssetRowId }) => ({
                      inclusionState,
                      requiredForMainLeg: providerAssetRowId === prepared.primaryProviderAssetId,
                    })
                  )
                  const canDerive = shouldDeriveCoinbaseLegs({
                    accountingAssetRequirements,
                    canDeriveWithAssetOverrides: prepared.canDeriveWithAssetOverrides,
                    legDerivationStrategy: prepared.legDerivationStrategy,
                    primaryAssetAvailable: primaryAsset !== null,
                  })

                  return canDerive
                    ? coinbaseSourceSyncProvider
                        .deriveLegs({
                          transaction,
                          venueContext,
                          primaryAsset,
                          canonicalTransfers,
                        })
                        .pipe(Effect.mapError(toCoinbaseRecoverableNormalizationError))
                    : Effect.succeed([])
                },
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
                providerAssetRowIds: prepared.providerAssetRowIds,
                transaction: prepared.transaction,
                venueContext: prepared.venueContext,
                onchainContext: prepared.onchainContext,
                providerTransfers: prepared.providerTransfers,
                canonicalTransfers: prepared.canonicalTransfers,
                transactionReview: prepared.transactionReview,
                overrideMaterializationAllowed:
                  prepared.transactionReview === null ||
                  prepared.transactionReview.matchedLayer === "solana_asset_mapping",
                resolvedTransactionType: prepared.resolvedTransactionType,
                deriveLegs:
                  prepared.legDerivationStrategy === "derive"
                    ? ({ transaction, venueContext, canonicalTransfers }) =>
                        heliusSolanaSourceSyncProvider
                          .deriveLegs({
                            transaction,
                            venueContext,
                            canonicalTransfers,
                            legPlans: prepared.legPlans,
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
