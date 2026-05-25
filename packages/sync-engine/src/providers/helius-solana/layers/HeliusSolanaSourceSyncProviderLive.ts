/**
 * HeliusSolanaSourceSyncProviderLive - Helius Solana provider stub.
 *
 * @module HeliusSolanaSourceSyncProviderLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { SourceSyncProviderFailureError } from "../../../shared/SourceProviderRawBatch.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HeliusSolanaNormalizationNotImplementedError,
  HeliusSolanaSourceSyncProvider,
  type HeliusSolanaNormalizationLookups,
  type HeliusSolanaReferenceDataRefreshResult,
  type HeliusSolanaSourceSyncProviderShape,
} from "../services/HeliusSolanaSourceSyncProvider.ts"

const HELIUS_SOLANA_STUB_MESSAGE = "Helius Solana ingestion is not implemented yet."

const emptyReferenceDataRefresh = {
  transactionTypeCatalogCount: 0,
  providerAssetCatalogCount: 0,
  defaultTransactionMappingCount: 0,
  defaultProviderAssetMappingCount: 0,
} satisfies HeliusSolanaReferenceDataRefreshResult

const normalizationLookups = {
  providerKey: HELIUS_SOLANA_PROVIDER_KEY,
} satisfies HeliusSolanaNormalizationLookups

const normalizationNotImplemented = (cause: unknown) =>
  new HeliusSolanaNormalizationNotImplementedError({
    message: HELIUS_SOLANA_STUB_MESSAGE,
    cause,
  })

const make = Effect.succeed(
  HeliusSolanaSourceSyncProvider.of({
    fetchRawBatch: () =>
      Effect.fail(
        new SourceSyncProviderFailureError({
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
          message: HELIUS_SOLANA_STUB_MESSAGE,
          retryable: false,
        })
      ),
    refreshReferenceData: () => Effect.succeed(emptyReferenceDataRefresh),
    loadNormalizationLookups: () => Effect.succeed(normalizationLookups),
    prepareNormalization: ({ source, sourceRecord, lookups }) =>
      Effect.fail(
        normalizationNotImplemented({
          sourceId: source.id,
          providerKey: lookups.providerKey,
          recordType: sourceRecord.recordType,
          externalRecordId: sourceRecord.externalRecordId,
        })
      ),
    deriveLegs: ({ transaction }) =>
      Effect.fail(
        normalizationNotImplemented({
          transactionId: transaction.id,
          externalId: transaction.externalId,
        })
      ),
  } satisfies HeliusSolanaSourceSyncProviderShape)
)

/**
 * HeliusSolanaSourceSyncProviderLive - Helius Solana provider stub layer.
 */
export const HeliusSolanaSourceSyncProviderLive = Layer.effect(HeliusSolanaSourceSyncProvider, make)
