/**
 * CoinbaseReferenceDataServiceLive - Live Coinbase reference-data refresh implementation.
 *
 * @module CoinbaseReferenceDataServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ProviderAssetRepository } from "../../../services/ProviderAssetRepository.ts"
import {
  COINBASE_TRANSACTION_TYPE_SNAPSHOT_RETRIEVED_AT,
  COINBASE_TRANSACTION_TYPE_SOURCE_URL,
  coinbaseObservedExtraTransactionTypes,
  coinbaseTransactionTypeCatalogSnapshot,
} from "../reference-data/CoinbaseTransactionTypeCatalogSnapshot.ts"
import { ProviderReferenceRepository } from "../../../services/ProviderReferenceRepository.ts"
import { CoinbaseSyncClient } from "../services/CoinbaseSyncClient.ts"
import {
  CoinbaseReferenceDataError,
  CoinbaseReferenceDataService,
  type CoinbaseReferenceDataServiceShape,
} from "../services/CoinbaseReferenceDataService.ts"
import { CoinbaseReferenceMappingService } from "../services/CoinbaseReferenceMappingService.ts"

const COINBASE_PROVIDER = "coinbase"

const deriveCoinbaseNaturalKey = ({
  currencyCode,
  providerAssetId,
}: {
  readonly currencyCode: string
  readonly providerAssetId: string | null
}) => (providerAssetId === null ? `currency_code:${currencyCode.toUpperCase()}` : null)

const make = Effect.gen(function* () {
  const providerAssetRepository = yield* ProviderAssetRepository
  const providerReferenceRepository = yield* ProviderReferenceRepository
  const coinbaseSyncClient = yield* CoinbaseSyncClient
  const coinbaseReferenceMappingService = yield* CoinbaseReferenceMappingService

  const buildFiatProviderAssetRows = ({
    currencies,
  }: {
    currencies: ReadonlyArray<{
      readonly currencyCode: string
      readonly name: string | null
      readonly payload: unknown
    }>
  }) =>
    currencies.map((currency) => ({
      providerKey: COINBASE_PROVIDER,
      naturalKey: deriveCoinbaseNaturalKey({
        currencyCode: currency.currencyCode,
        providerAssetId: null,
      }),
      currencyCode: currency.currencyCode.toUpperCase(),
      name: currency.name,
      providerAssetId: null,
      exponent: null,
      providerType: "fiat" as const,
      payload: currency.payload,
    }))

  const buildCryptoProviderAssetRows = ({
    currencies,
  }: {
    currencies: ReadonlyArray<{
      readonly currencyCode: string
      readonly name: string | null
      readonly providerAssetId: string | null
      readonly exponent: number | null
      readonly providerType: string | null
      readonly payload: unknown
    }>
  }) =>
    currencies.map((currency) => ({
      providerKey: COINBASE_PROVIDER,
      naturalKey: deriveCoinbaseNaturalKey({
        currencyCode: currency.currencyCode,
        providerAssetId: currency.providerAssetId,
      }),
      currencyCode: currency.currencyCode.toUpperCase(),
      name: currency.name,
      providerAssetId: currency.providerAssetId,
      exponent: currency.exponent,
      providerType: currency.providerType,
      payload: currency.payload,
    }))

  const fetchCoinbaseFiatCurrencies = () =>
    coinbaseSyncClient.fetchFiatCurrencies().pipe(
      Effect.mapError(
        (cause) =>
          new CoinbaseReferenceDataError({
            message: "Failed to fetch Coinbase fiat currencies",
            cause,
          })
      )
    )

  const fetchCoinbaseCryptoCurrencies = () =>
    coinbaseSyncClient.fetchCryptoCurrencies().pipe(
      Effect.mapError(
        (cause) =>
          new CoinbaseReferenceDataError({
            message: "Failed to fetch Coinbase crypto currencies",
            cause,
          })
      )
    )

  /** Upsert the checked-in Coinbase transaction-type catalog snapshot. */
  const syncTransactionTypeCatalog = () =>
    Effect.gen(function* () {
      const retrievedAt = new Date(COINBASE_TRANSACTION_TYPE_SNAPSHOT_RETRIEVED_AT)

      const docEntries = coinbaseTransactionTypeCatalogSnapshot.map((entry) => ({
        providerKey: COINBASE_PROVIDER,
        providerTransactionType: entry.providerTransactionType,
        displayName: entry.description,
        payload: {
          source: "coinbase_docs_snapshot",
          sourceUrl: COINBASE_TRANSACTION_TYPE_SOURCE_URL,
          retrievedAt: retrievedAt.toISOString(),
          providerTransactionType: entry.providerTransactionType,
          description: entry.description,
        },
      }))

      const observedEntries = coinbaseObservedExtraTransactionTypes.map((entry) => ({
        providerKey: COINBASE_PROVIDER,
        providerTransactionType: entry.providerTransactionType,
        displayName: entry.description,
        payload: {
          source: "coinbase_observed_live_type",
          sourceUrl: null,
          retrievedAt: new Date().toISOString(),
          providerTransactionType: entry.providerTransactionType,
          description: entry.description,
        },
      }))

      return yield* providerReferenceRepository
        .upsertTransactionTypeCatalog({
          providerKey: COINBASE_PROVIDER,
          entries: [...docEntries, ...observedEntries],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CoinbaseReferenceDataError({
                message: "Failed to persist Coinbase transaction-type catalog",
                cause,
              })
          )
        )
    })

  /** Upsert Coinbase fiat + crypto provider asset facts. */
  const syncProviderAssetCatalog = () =>
    Effect.gen(function* () {
      const fiatCurrencies = yield* fetchCoinbaseFiatCurrencies()
      const cryptoCurrencies = yield* fetchCoinbaseCryptoCurrencies()

      const rows = [
        ...buildFiatProviderAssetRows({ currencies: fiatCurrencies }),
        ...buildCryptoProviderAssetRows({ currencies: cryptoCurrencies }),
      ]

      return yield* providerAssetRepository
        .upsertProviderAssets({
          providerKey: COINBASE_PROVIDER,
          entries: rows.map((row) => ({
            providerAssetId: row.providerAssetId,
            naturalKey: row.naturalKey,
            currencyCode: row.currencyCode,
            name: row.name,
            exponent: row.exponent,
            providerType: row.providerType,
            payload: row.payload,
          })),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CoinbaseReferenceDataError({
                message: "Failed to persist Coinbase provider asset catalog",
                cause,
              })
          )
        )
    })

  const refreshReferenceData: CoinbaseReferenceDataServiceShape["refreshReferenceData"] = () =>
    Effect.gen(function* () {
      const transactionTypeCatalogCount = yield* syncTransactionTypeCatalog()
      const providerAssetCatalogCount = yield* syncProviderAssetCatalog()
      const ensuredMappings = yield* coinbaseReferenceMappingService.ensureDefaultMappings().pipe(
        Effect.mapError(
          (cause) =>
            new CoinbaseReferenceDataError({
              message: "Failed to ensure Coinbase default mappings",
              cause,
            })
        )
      )

      return {
        transactionTypeCatalogCount,
        providerAssetCatalogCount,
        defaultTransactionMappingCount: ensuredMappings.transactionTypeMappingCount,
        defaultProviderAssetMappingCount: ensuredMappings.providerAssetMappingCount,
      } as const
    })

  return CoinbaseReferenceDataService.of({
    refreshReferenceData,
  } satisfies CoinbaseReferenceDataServiceShape)
})

/**
 * CoinbaseReferenceDataServiceLive - Live layer for Coinbase reference-data refresh.
 */
export const CoinbaseReferenceDataServiceLive = Layer.effect(CoinbaseReferenceDataService, make)
