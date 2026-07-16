/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { and, eq, ne, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { SourceReplayRepository, type SourceReplayRepositoryShape } from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const resetSourceDerivedState: SourceReplayRepositoryShape["resetSourceDerivedState"] = ({
    sourceId,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [crossSourceAllocation] = yield* tx
            .select({ id: schema.inventoryMovementAllocations.id })
            .from(schema.inventoryMovementAllocations)
            .innerJoin(
              schema.inventoryMovements,
              eq(
                schema.inventoryMovements.id,
                schema.inventoryMovementAllocations.inventoryMovementId
              )
            )
            .innerJoin(
              schema.fifoLots,
              eq(schema.fifoLots.id, schema.inventoryMovementAllocations.fifoLotId)
            )
            .where(
              and(
                eq(schema.fifoLots.sourceId, sourceId),
                ne(schema.inventoryMovements.sourceId, sourceId)
              )
            )
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.selectCrossSourceAllocation"
              )
            )

          if (crossSourceAllocation !== undefined) {
            return yield* Effect.fail(
              toSyncEngineStorageError({
                operation: "sourceReplayRepository.resetSourceDerivedState.crossSourceAllocation",
                error:
                  "Cannot replay a source while another source has an inventory movement allocated to its FIFO lots",
              })
            )
          }

          const inventoryMovementAllocations = yield* tx
            .select({
              fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
              matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
            })
            .from(schema.inventoryMovementAllocations)
            .innerJoin(
              schema.inventoryMovements,
              eq(
                schema.inventoryMovements.id,
                schema.inventoryMovementAllocations.inventoryMovementId
              )
            )
            .where(eq(schema.inventoryMovements.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.selectInventoryMovementAllocations"
              )
            )

          yield* Effect.forEach(inventoryMovementAllocations, (allocation) =>
            tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, allocation.fifoLotId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.restoreInventoryMovementLots"
                )
              )
          )

          const disposalMatches = yield* tx
            .select({
              fifoLotId: schema.disposalMatches.fifoLotId,
              matchedAmount: schema.disposalMatches.matchedAmount,
            })
            .from(schema.disposalMatches)
            .innerJoin(
              schema.transactionLegs,
              eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
            )
            .where(eq(schema.transactionLegs.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.selectDisposalMatches"
              )
            )

          yield* Effect.forEach(disposalMatches, (match) =>
            tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${match.matchedAmount}`,
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, match.fifoLotId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.restoreMatchedLots"
                )
              )
          )

          yield* tx
            .delete(schema.transactionLegs)
            .where(eq(schema.transactionLegs.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.deleteLegs")
            )

          yield* tx
            .delete(schema.transactions)
            .where(eq(schema.transactions.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.deleteTransactions"
              )
            )

          yield* tx
            .delete(schema.transfers)
            .where(eq(schema.transfers.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.deleteTransfers"
              )
            )

          yield* tx
            .update(schema.sourceRecordsRaw)
            .set({
              normalizedAt: null,
              normalizationError: null,
              updatedAt: nowDate(),
            })
            .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
            .pipe(
              wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.resetRawRows")
            )
        })
      )
      .pipe(
        wrapSyncEngineStorageError("sourceReplayRepository.resetSourceDerivedState.transaction")
      )

  return SourceReplayRepository.of({
    resetSourceDerivedState,
  } satisfies SourceReplayRepositoryShape)
})

export const SourceReplayRepositoryLive = Layer.effect(SourceReplayRepository, make)
