/**
 * PortfolioRepositoryLive - Drizzle-backed user portfolio projections.
 *
 * @module PortfolioRepositoryLive
 */

import { and, asc, eq, gt, isNull, or } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PortfolioRepository,
  PortfolioSourceNotFoundError,
  type PortfolioAssetPosition,
  type PortfolioRepositoryShape,
} from "../services/PortfolioRepository.ts"
import { drizzle } from "./PgClientLive.ts"

interface PositionAccumulator {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly logoUrl: string | null
  readonly coingeckoCoinId: string | null
  amount: BigDecimal.BigDecimal
  costBasis: BigDecimal.BigDecimal
  costBasisCurrency: string | null
  hasPendingCostBasis: boolean
}

const decodeDecimal = (value: string, operation: string) =>
  Effect.try({
    try: () => BigDecimal.fromStringUnsafe(value),
    catch: (cause) => ({ operation, cause }),
  })

const mergeCurrency = (current: string | null, next: string): string | null => {
  if (current === null) return next
  return current === next ? current : "mixed"
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const listAssetPositions: PortfolioRepositoryShape["listAssetPositions"] = (scope) =>
    Effect.gen(function* () {
      if (scope.sourceId !== null) {
        const [ownedSource] = yield* db
          .select({ id: schema.sources.id })
          .from(schema.sources)
          .where(
            and(
              eq(schema.sources.id, scope.sourceId),
              eq(schema.sources.principalId, scope.principalId)
            )
          )
          .limit(1)
          .pipe(wrapSqlError("portfolioRepository.listAssetPositions.source"))

        if (ownedSource === undefined) {
          return yield* new PortfolioSourceNotFoundError({ sourceId: scope.sourceId })
        }
      }

      const rows = yield* db
        .select({
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          logoUrl: schema.assets.logoUrl,
          coingeckoCoinId: schema.assets.coingeckoCoinId,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
          costBasisCurrency: schema.fifoLots.costBasisCurrency,
          costBasisStatus: schema.fifoLots.costBasisStatus,
        })
        .from(schema.fifoLots)
        .innerJoin(schema.assets, eq(schema.fifoLots.assetId, schema.assets.id))
        .leftJoin(
          schema.assetRepresentations,
          eq(schema.fifoLots.assetRepresentationId, schema.assetRepresentations.id)
        )
        .where(
          and(
            eq(schema.fifoLots.principalId, scope.principalId),
            gt(schema.fifoLots.remainingAmount, "0"),
            or(
              isNull(schema.fifoLots.assetRepresentationId),
              eq(schema.assetRepresentations.isSpam, false)
            ),
            scope.sourceId === null ? undefined : eq(schema.fifoLots.sourceId, scope.sourceId)
          )
        )
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.id))
        .pipe(wrapSqlError("portfolioRepository.listAssetPositions.lots"))

      const positions = new Map<string, PositionAccumulator>()

      for (const row of rows) {
        const amount = yield* decodeDecimal(
          row.remainingAmount,
          "portfolioRepository.listAssetPositions.remainingAmount"
        ).pipe(wrapSqlError("portfolioRepository.listAssetPositions.remainingAmount"))

        const existing = positions.get(row.assetId) ?? {
          assetId: row.assetId,
          symbol: row.symbol,
          name: row.name,
          logoUrl: row.logoUrl,
          coingeckoCoinId: row.coingeckoCoinId,
          amount: BigDecimal.fromBigInt(0n),
          costBasis: BigDecimal.fromBigInt(0n),
          costBasisCurrency: null,
          hasPendingCostBasis: false,
        }

        existing.amount = BigDecimal.sum(existing.amount, amount)

        if (row.costBasisStatus === "pending_review") {
          existing.hasPendingCostBasis = true
        } else {
          const costBasisPerToken = yield* decodeDecimal(
            row.costBasisPerToken,
            "portfolioRepository.listAssetPositions.costBasisPerToken"
          ).pipe(wrapSqlError("portfolioRepository.listAssetPositions.costBasisPerToken"))

          existing.costBasis = BigDecimal.sum(
            existing.costBasis,
            BigDecimal.multiply(amount, costBasisPerToken)
          )

          existing.costBasisCurrency = mergeCurrency(
            existing.costBasisCurrency,
            row.costBasisCurrency
          )
        }

        positions.set(row.assetId, existing)
      }

      return Array.from(positions.values()).map(
        (position): PortfolioAssetPosition => ({
          ...position,
          amount: BigDecimal.format(position.amount),
          costBasis: position.hasPendingCostBasis
            ? null
            : BigDecimal.format(BigDecimal.round(position.costBasis, { scale: 8 })),
          costBasisCurrency: position.hasPendingCostBasis ? null : position.costBasisCurrency,
          costBasisStatus: position.hasPendingCostBasis ? "pending_review" : "known",
        })
      )
    })

  return PortfolioRepository.of({ listAssetPositions })
})

/** Live portfolio repository layer. */
export const PortfolioRepositoryLive = Layer.effect(PortfolioRepository, make)
