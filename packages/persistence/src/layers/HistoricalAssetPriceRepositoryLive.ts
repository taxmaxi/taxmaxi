/**
 * HistoricalAssetPriceRepositoryLive - PostgreSQL daily historical quote storage.
 *
 * @module HistoricalAssetPriceRepositoryLive
 */

import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  HistoricalAssetPriceRepository,
  type HistoricalAssetPriceRepositoryShape,
} from "../services/HistoricalAssetPriceRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const COINGECKO_SOURCE = "coingecko"
const EUR_CURRENCY = "EUR"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const listMissingCoinGeckoDailyEurPriceNeeds: HistoricalAssetPriceRepositoryShape["listMissingCoinGeckoDailyEurPriceNeeds"] =
    ({ principalId }) => {
      const snapshotAt = sql<Date>`date_trunc('day', ${schema.transactionLegs.timestamp})`
      const snapshotDate = sql<string>`to_char(${snapshotAt}, 'YYYY-MM-DD')`

      return db
        .selectDistinct({
          assetId: schema.transactionLegs.assetId,
          coingeckoCoinId: sql<string>`${schema.assets.coingeckoCoinId}`,
          snapshotDate,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.transactionLegs.sourceId))
        .innerJoin(schema.assets, eq(schema.assets.id, schema.transactionLegs.assetId))
        .leftJoin(
          schema.assetPrices,
          and(
            eq(schema.assetPrices.assetId, schema.transactionLegs.assetId),
            eq(schema.assetPrices.timestamp, snapshotAt),
            eq(schema.assetPrices.currency, EUR_CURRENCY)
          )
        )
        .where(
          and(
            eq(schema.transactionLegs.principalId, principalId),
            eq(schema.sources.sourceableType, "onchain"),
            inArray(schema.transactionLegs.kind, ["acquisition", "income", "disposal", "fee"]),
            isNotNull(schema.assets.coingeckoCoinId),
            ne(schema.assets.coingeckoCoinId, ""),
            isNull(schema.assetPrices.id)
          )
        )
        .orderBy(snapshotDate, schema.transactionLegs.assetId)
        .pipe(
          Effect.map((rows) =>
            rows.map(({ assetId, coingeckoCoinId, snapshotDate }) => ({
              assetId,
              coingeckoCoinId,
              snapshotAt: DateTime.toDateUtc(DateTime.makeUnsafe(`${snapshotDate}T00:00:00.000Z`)),
            }))
          ),
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: "historicalAssetPriceRepository.listMissingCoinGeckoDailyEurPriceNeeds",
                cause,
              })
          )
        )
    }

  const upsertCoinGeckoDailyEurPrice: HistoricalAssetPriceRepositoryShape["upsertCoinGeckoDailyEurPrice"] =
    ({ assetId, snapshotAt, price }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.nowAsDate

        yield* db
          .insert(schema.assetPrices)
          .values({
            assetId,
            timestamp: snapshotAt,
            price,
            currency: EUR_CURRENCY,
            source: COINGECKO_SOURCE,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.assetPrices.assetId,
              schema.assetPrices.timestamp,
              schema.assetPrices.currency,
            ],
            set: {
              price,
              source: COINGECKO_SOURCE,
              updatedAt: now,
            },
            setWhere: eq(schema.assetPrices.source, COINGECKO_SOURCE),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PersistenceError({
                  operation: "historicalAssetPriceRepository.upsertCoinGeckoDailyEurPrice",
                  cause,
                })
            )
          )
      })

  return HistoricalAssetPriceRepository.of({
    listMissingCoinGeckoDailyEurPriceNeeds,
    upsertCoinGeckoDailyEurPrice,
  })
})

/** Live PostgreSQL historical asset-price repository. */
export const HistoricalAssetPriceRepositoryLive = Layer.effect(HistoricalAssetPriceRepository, make)
