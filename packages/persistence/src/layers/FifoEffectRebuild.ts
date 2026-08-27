/**
 * FifoEffectRebuild - Shared FIFO suffix rebuild operations.
 *
 * @module FifoEffectRebuild
 */

import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm"
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { SyncEngineStorageError } from "@my/sync-engine/services"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

export type FifoEffectRebuildExecutor = Pick<
  EffectPgDatabase,
  "delete" | "insert" | "select" | "update"
>

export interface RebuildableFifoEffect {
  readonly id: string
  readonly kind: "disposal" | "movement"
  readonly transactionId: string | null
  readonly sourceId: string
  readonly principalId: string
  readonly assetId: string
  readonly amount: unknown
  readonly fiatAmount: unknown
  readonly timestamp: Date
  readonly sourceOrder: Date
  readonly sourceOrderId: string
  readonly createdAt: Date
}

const decodeBigDecimal = ({
  value,
  operation,
}: {
  readonly value: string
  readonly operation: string
}) =>
  Option.match(BigDecimal.fromString(value.trim()), {
    onNone: () =>
      Effect.fail(
        new SyncEngineStorageError({
          operation,
          cause: `Invalid decimal value: ${value}`,
        })
      ),
    onSome: Effect.succeed,
  })

const formatDecimal = ({
  value,
  operation,
}: {
  readonly value: unknown
  readonly operation: string
}) =>
  Schema.decodeUnknownEffect(Schema.Union([Schema.String, Schema.Number]))(value).pipe(
    Effect.map(String),
    Effect.mapError(
      () =>
        new SyncEngineStorageError({
          operation,
          cause: `Invalid numeric value: ${String(value)}`,
        })
    )
  )

const inventoryKeyForEffect = (effect: RebuildableFifoEffect) =>
  `${effect.sourceId}:${effect.principalId}:${effect.assetId}`

const isLotAvailableForEffect = ({
  lot,
  effect,
}: {
  readonly lot: {
    readonly acquiredAt: Date
    readonly availableAt: Date
    readonly sourceOrder: Date
    readonly sourceOrderId: string
  }
  readonly effect: RebuildableFifoEffect
}) => {
  if (lot.acquiredAt > effect.timestamp || lot.availableAt > effect.timestamp) {
    return false
  }
  if (lot.availableAt < effect.timestamp) {
    return true
  }

  const sourceOrderDifference = lot.sourceOrder.getTime() - effect.sourceOrder.getTime()
  return (
    sourceOrderDifference < 0 ||
    (sourceOrderDifference === 0 && lot.sourceOrderId.localeCompare(effect.sourceOrderId) <= 0)
  )
}

/**
 * Restore and rebuild a FIFO effect suffix in deterministic timestamp order.
 *
 * The preflight phase matches the existing reconciliation behavior: it restores
 * current allocations virtually, detects shortages before mutating rows, then
 * rebuilds only safe inventory keys.
 */
export const rebuildFifoEffects = ({
  executor,
  effects: unsortedEffects,
  shortageMode,
  operationPrefix,
}: {
  readonly executor: FifoEffectRebuildExecutor
  readonly effects: ReadonlyArray<RebuildableFifoEffect>
  readonly shortageMode: "clear" | "preserve"
  readonly operationPrefix: string
}) =>
  Effect.gen(function* () {
    const effects = [...unsortedEffects].sort(
      (left, right) =>
        left.timestamp.getTime() - right.timestamp.getTime() ||
        left.sourceOrder.getTime() - right.sourceOrder.getTime() ||
        left.sourceOrderId.localeCompare(right.sourceOrderId) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id)
    )
    const disposals = effects.filter((effect) => effect.kind === "disposal")
    const movements = effects.filter((effect) => effect.kind === "movement")
    const disposalIds = disposals.map(({ id }) => id)
    const movementIds = movements.map(({ id }) => id)
    const disposalMatches =
      disposalIds.length === 0
        ? []
        : yield* executor
            .select({
              id: schema.disposalMatches.id,
              effectId: schema.disposalMatches.disposalLegId,
              fifoLotId: schema.disposalMatches.fifoLotId,
              matchedAmount: schema.disposalMatches.matchedAmount,
            })
            .from(schema.disposalMatches)
            .where(inArray(schema.disposalMatches.disposalLegId, disposalIds))
            .pipe(wrapSyncEngineSqlError(`${operationPrefix}.loadDisposalMatches`))
    const movementAllocations =
      movementIds.length === 0
        ? []
        : yield* executor
            .select({
              id: schema.inventoryMovementAllocations.id,
              effectId: schema.inventoryMovementAllocations.inventoryMovementId,
              fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
              matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
            })
            .from(schema.inventoryMovementAllocations)
            .where(inArray(schema.inventoryMovementAllocations.inventoryMovementId, movementIds))
            .pipe(wrapSyncEngineSqlError(`${operationPrefix}.loadMovementAllocations`))
    const effectById = new Map(effects.map((effect) => [effect.id, effect] as const))
    const allocations = [...disposalMatches, ...movementAllocations]
    const restoredAmountByLotId = new Map<string, BigDecimal.BigDecimal>()

    for (const allocation of allocations) {
      const matchedAmount = yield* decodeBigDecimal({
        value: yield* formatDecimal({
          value: allocation.matchedAmount,
          operation: `${operationPrefix}.preflightMatchedAmount`,
        }),
        operation: `${operationPrefix}.preflightMatchedAmount`,
      })
      const restoredAmount = restoredAmountByLotId.get(allocation.fifoLotId)
      restoredAmountByLotId.set(
        allocation.fifoLotId,
        restoredAmount === undefined ? matchedAmount : BigDecimal.sum(restoredAmount, matchedAmount)
      )
    }

    const windows = [
      ...new Map(
        effects.map((effect) => [
          inventoryKeyForEffect(effect),
          {
            sourceId: effect.sourceId,
            principalId: effect.principalId,
            assetId: effect.assetId,
          },
        ])
      ).values(),
    ]
    const candidateLots =
      windows.length === 0
        ? []
        : yield* executor
            .select({
              id: schema.fifoLots.id,
              sourceId: schema.fifoLots.sourceId,
              principalId: schema.fifoLots.principalId,
              assetId: schema.fifoLots.assetId,
              acquiredAt: schema.fifoLots.acquiredAt,
              availableAt: schema.transactionLegs.timestamp,
              remainingAmount: schema.fifoLots.remainingAmount,
              costBasisPerToken: schema.fifoLots.costBasisPerToken,
              sourceOrder: sql<Date>`coalesce(
                ${schema.sourceRecordsRaw.createdAt},
                ${schema.fifoLots.createdAt}
              )`.mapWith(schema.sourceRecordsRaw.createdAt),
              sourceOrderId: sql<string>`coalesce(
                ${schema.sourceRecordsRaw.id}::text,
                ${schema.fifoLots.id}::text
              )`,
              createdAt: schema.fifoLots.createdAt,
            })
            .from(schema.fifoLots)
            .innerJoin(
              schema.transactionLegs,
              eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
            )
            .leftJoin(
              schema.sourceRecordsRaw,
              eq(schema.sourceRecordsRaw.id, schema.transactionLegs.sourceRawRecordId)
            )
            .where(
              or(
                ...windows.map((window) =>
                  and(
                    eq(schema.fifoLots.sourceId, window.sourceId),
                    eq(schema.fifoLots.principalId, window.principalId),
                    eq(schema.fifoLots.assetId, window.assetId)
                  )
                )
              )
            )
            .orderBy(
              asc(schema.fifoLots.acquiredAt),
              asc(
                sql`coalesce(${schema.sourceRecordsRaw.createdAt}, ${schema.fifoLots.createdAt})`
              ),
              asc(sql`coalesce(${schema.sourceRecordsRaw.id}::text, ${schema.fifoLots.id}::text)`),
              asc(schema.fifoLots.id)
            )
            .pipe(wrapSyncEngineSqlError(`${operationPrefix}.loadCandidateLots`))
    const virtualRemainingByLotId = new Map<string, BigDecimal.BigDecimal>()

    for (const lot of candidateLots) {
      const remainingAmount = yield* decodeBigDecimal({
        value: yield* formatDecimal({
          value: lot.remainingAmount,
          operation: `${operationPrefix}.preflightLotRemaining`,
        }),
        operation: `${operationPrefix}.preflightLotRemaining`,
      })
      virtualRemainingByLotId.set(
        lot.id,
        BigDecimal.sum(
          remainingAmount,
          restoredAmountByLotId.get(lot.id) ?? BigDecimal.fromBigInt(0n)
        )
      )
    }

    const blockedInventoryKeys = new Set<string>()
    const blockedEffectIds = new Set<string>()

    for (const effect of effects) {
      const inventoryKey = inventoryKeyForEffect(effect)
      if (blockedInventoryKeys.has(inventoryKey)) {
        blockedEffectIds.add(effect.id)
        continue
      }

      let remainingAmount = yield* decodeBigDecimal({
        value: yield* formatDecimal({
          value: effect.amount,
          operation: `${operationPrefix}.preflightEffectAmount`,
        }),
        operation: `${operationPrefix}.preflightEffectAmount`,
      })

      for (const lot of candidateLots) {
        if (
          lot.sourceId !== effect.sourceId ||
          lot.principalId !== effect.principalId ||
          lot.assetId !== effect.assetId ||
          !isLotAvailableForEffect({ lot, effect })
        ) {
          continue
        }

        const lotRemaining = virtualRemainingByLotId.get(lot.id) ?? BigDecimal.fromBigInt(0n)
        if (!BigDecimal.isGreaterThan(lotRemaining, BigDecimal.fromBigInt(0n))) {
          continue
        }

        const matchedAmount = BigDecimal.isLessThanOrEqualTo(remainingAmount, lotRemaining)
          ? remainingAmount
          : lotRemaining
        virtualRemainingByLotId.set(lot.id, BigDecimal.subtract(lotRemaining, matchedAmount))
        remainingAmount = BigDecimal.subtract(remainingAmount, matchedAmount)
        if (!BigDecimal.isGreaterThan(remainingAmount, BigDecimal.fromBigInt(0n))) {
          break
        }
      }

      if (BigDecimal.isGreaterThan(remainingAmount, BigDecimal.fromBigInt(0n))) {
        blockedInventoryKeys.add(inventoryKey)
        blockedEffectIds.add(effect.id)
      }
    }

    if (shortageMode === "preserve") {
      for (const effect of effects) {
        if (blockedInventoryKeys.has(inventoryKeyForEffect(effect))) {
          blockedEffectIds.add(effect.id)
        }
      }
    }

    const shouldRemoveAllocation = (effectId: string) => {
      const effect = effectById.get(effectId)
      return effect !== undefined && (shortageMode === "clear" || !blockedEffectIds.has(effect.id))
    }
    const disposalMatchesToRebuild = disposalMatches.filter(({ effectId }) =>
      shouldRemoveAllocation(effectId)
    )
    const movementAllocationsToRebuild = movementAllocations.filter(({ effectId }) =>
      shouldRemoveAllocation(effectId)
    )

    yield* Effect.forEach(
      [...disposalMatchesToRebuild, ...movementAllocationsToRebuild],
      (allocation) =>
        executor
          .update(schema.fifoLots)
          .set({
            remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
            updatedAt: nowDate(),
          })
          .where(eq(schema.fifoLots.id, allocation.fifoLotId))
          .pipe(wrapSyncEngineSqlError(`${operationPrefix}.restoreLot`)),
      { concurrency: 1, discard: true }
    )

    if (disposalMatchesToRebuild.length > 0) {
      yield* executor
        .delete(schema.disposalMatches)
        .where(
          inArray(
            schema.disposalMatches.id,
            disposalMatchesToRebuild.map(({ id }) => id)
          )
        )
        .pipe(wrapSyncEngineSqlError(`${operationPrefix}.deleteDisposalMatches`))
    }
    if (movementAllocationsToRebuild.length > 0) {
      yield* executor
        .delete(schema.inventoryMovementAllocations)
        .where(
          inArray(
            schema.inventoryMovementAllocations.id,
            movementAllocationsToRebuild.map(({ id }) => id)
          )
        )
        .pipe(wrapSyncEngineSqlError(`${operationPrefix}.deleteMovementAllocations`))
    }

    for (const effect of effects) {
      if (blockedEffectIds.has(effect.id)) {
        continue
      }

      const effectAmount = yield* decodeBigDecimal({
        value: yield* formatDecimal({
          value: effect.amount,
          operation: `${operationPrefix}.effectAmount`,
        }),
        operation: `${operationPrefix}.effectAmount`,
      })
      const availableLots = yield* executor
        .select({
          id: schema.fifoLots.id,
          acquiredAt: schema.fifoLots.acquiredAt,
          availableAt: schema.transactionLegs.timestamp,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
          sourceOrder: sql<Date>`coalesce(
            ${schema.sourceRecordsRaw.createdAt},
            ${schema.fifoLots.createdAt}
          )`.mapWith(schema.sourceRecordsRaw.createdAt),
          sourceOrderId: sql<string>`coalesce(
            ${schema.sourceRecordsRaw.id}::text,
            ${schema.fifoLots.id}::text
          )`,
        })
        .from(schema.fifoLots)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
        )
        .leftJoin(
          schema.sourceRecordsRaw,
          eq(schema.sourceRecordsRaw.id, schema.transactionLegs.sourceRawRecordId)
        )
        .where(
          and(
            eq(schema.fifoLots.sourceId, effect.sourceId),
            eq(schema.fifoLots.principalId, effect.principalId),
            eq(schema.fifoLots.assetId, effect.assetId),
            lte(schema.fifoLots.acquiredAt, effect.timestamp),
            lte(schema.transactionLegs.timestamp, effect.timestamp),
            gt(schema.fifoLots.remainingAmount, "0")
          )
        )
        .orderBy(
          asc(schema.fifoLots.acquiredAt),
          asc(sql`coalesce(${schema.sourceRecordsRaw.createdAt}, ${schema.fifoLots.createdAt})`),
          asc(sql`coalesce(${schema.sourceRecordsRaw.id}::text, ${schema.fifoLots.id}::text)`),
          asc(schema.fifoLots.id)
        )
        .pipe(wrapSyncEngineSqlError(`${operationPrefix}.loadOpenLots`))
      let remainingAmount = effectAmount
      const nextAllocations = []

      for (const lot of availableLots) {
        if (!BigDecimal.isGreaterThan(remainingAmount, BigDecimal.fromBigInt(0n))) {
          break
        }
        if (!isLotAvailableForEffect({ lot, effect })) {
          continue
        }
        const lotRemaining = yield* decodeBigDecimal({
          value: yield* formatDecimal({
            value: lot.remainingAmount,
            operation: `${operationPrefix}.lotRemaining`,
          }),
          operation: `${operationPrefix}.lotRemaining`,
        })
        const matchedAmount = BigDecimal.isLessThanOrEqualTo(remainingAmount, lotRemaining)
          ? remainingAmount
          : lotRemaining
        nextAllocations.push({
          fifoLotId: lot.id,
          matchedAmount,
          nextRemaining: BigDecimal.subtract(lotRemaining, matchedAmount),
          costBasisPerToken: yield* decodeBigDecimal({
            value: yield* formatDecimal({
              value: lot.costBasisPerToken,
              operation: `${operationPrefix}.costBasisPerToken`,
            }),
            operation: `${operationPrefix}.costBasisPerToken`,
          }),
        })
        remainingAmount = BigDecimal.subtract(remainingAmount, matchedAmount)
      }

      const totalProceeds =
        effect.fiatAmount === null
          ? BigDecimal.fromBigInt(0n)
          : yield* decodeBigDecimal({
              value: yield* formatDecimal({
                value: effect.fiatAmount,
                operation: `${operationPrefix}.fiatAmount`,
              }),
              operation: `${operationPrefix}.fiatAmount`,
            })

      for (const allocation of nextAllocations) {
        if (effect.kind === "disposal") {
          const costBasis = BigDecimal.round(
            BigDecimal.multiply(allocation.matchedAmount, allocation.costBasisPerToken),
            { scale: 8 }
          )
          const proceedsRatio = Option.getOrElse(
            BigDecimal.divide(allocation.matchedAmount, effectAmount),
            () => BigDecimal.fromBigInt(0n)
          )
          const proceeds = BigDecimal.round(BigDecimal.multiply(totalProceeds, proceedsRatio), {
            scale: 8,
          })
          yield* executor.insert(schema.disposalMatches).values({
            disposalLegId: effect.id,
            fifoLotId: allocation.fifoLotId,
            matchedAmount: BigDecimal.format(allocation.matchedAmount),
            costBasis: BigDecimal.format(costBasis),
            proceeds: BigDecimal.format(proceeds),
            gainLoss: BigDecimal.format(BigDecimal.subtract(proceeds, costBasis)),
            createdAt: nowDate(),
          })
        } else {
          yield* executor.insert(schema.inventoryMovementAllocations).values({
            inventoryMovementId: effect.id,
            fifoLotId: allocation.fifoLotId,
            matchedAmount: BigDecimal.format(allocation.matchedAmount),
            createdAt: nowDate(),
          })
        }
        yield* executor
          .update(schema.fifoLots)
          .set({
            remainingAmount: BigDecimal.format(allocation.nextRemaining),
            updatedAt: nowDate(),
          })
          .where(eq(schema.fifoLots.id, allocation.fifoLotId))
      }
    }

    return { blockedEffectIds, blockedInventoryKeys }
  })
