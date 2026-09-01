/**
 * HistoricalAssetPriceRepository - Required daily historical quote storage.
 *
 * @module HistoricalAssetPriceRepository
 */

import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** One canonical on-chain asset day that still needs a CoinGecko EUR snapshot. */
export interface CoinGeckoDailyEurPriceNeed {
  readonly assetId: string
  readonly coingeckoCoinId: string
  readonly snapshotAt: Date
}

/** Required daily historical quote reads and writes. */
export interface HistoricalAssetPriceRepositoryShape {
  /** List distinct canonical on-chain asset days without a stored CoinGecko EUR snapshot. */
  readonly listMissingCoinGeckoDailyEurPriceNeeds: (params: {
    readonly principalId: PrincipalId
  }) => Effect.Effect<ReadonlyArray<CoinGeckoDailyEurPriceNeed>, PersistenceError>

  /** Idempotently store one CoinGecko EUR snapshot at its canonical UTC midnight. */
  readonly upsertCoinGeckoDailyEurPrice: (params: {
    readonly assetId: string
    readonly snapshotAt: Date
    readonly price: string
  }) => Effect.Effect<void, PersistenceError>
}

/** Repository for historical quote needs and durable daily snapshots. */
export class HistoricalAssetPriceRepository extends Context.Service<
  HistoricalAssetPriceRepository,
  HistoricalAssetPriceRepositoryShape
>()("@my/persistence/HistoricalAssetPriceRepository") {}
