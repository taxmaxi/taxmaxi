/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { SourceReplayRepository, type SourceReplayRepositoryShape } from "@my/sync-engine/services"
import {
  nowDate,
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
