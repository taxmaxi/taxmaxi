/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { aliasedTable, and, asc, eq, inArray, ne, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  SourceReplayDependencyError,
  SourceReplayRepository,
  SyncEngineStorageError,
  type SourceReplayRepositoryShape,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const INTERNAL_TRANSFER_REASON =
    "Deterministic provider transfer reconciled to a principal-owned onchain transfer."
  const replayCanonicalTransaction = aliasedTable(
    schema.transactions,
    "replay_canonical_transaction"
  )
  const replayDependentLeg = aliasedTable(schema.transactionLegs, "replay_dependent_leg")

  const resetSourceDerivedState: SourceReplayRepositoryShape["resetSourceDerivedState"] = ({
    sourceId,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [source] = yield* tx
            .select({ principalId: schema.sources.principalId })
            .from(schema.sources)
            .where(eq(schema.sources.id, sourceId))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.loadSource")
            )

          if (source === undefined) {
            return
          }

          const loadAffectedReconciliationLegs = () =>
            tx
              .select({
                reconciliationId: schema.transferReconciliations.id,
                providerTransferId: schema.providerTransfers.id,
                legId: replayDependentLeg.id,
                legSourceId: replayDependentLeg.sourceId,
                legKind: replayDependentLeg.kind,
                transactionId: replayDependentLeg.transactionId,
                affectedPrincipalId: schema.transferReconciliations.principalId,
              })
              .from(schema.transferReconciliations)
              .innerJoin(
                schema.providerTransfers,
                eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
              )
              .leftJoin(
                schema.transfers,
                eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId)
              )
              .leftJoin(
                replayCanonicalTransaction,
                eq(
                  replayCanonicalTransaction.id,
                  schema.transferReconciliations.canonicalTransactionId
                )
              )
              .innerJoin(
                replayDependentLeg,
                and(
                  sql`${replayDependentLeg.metadata} #>> '{reconciliation,providerTransferId}' = ${schema.providerTransfers.id}::text`,
                  sql`${replayDependentLeg.derivationRule} in ('internal_transfer_in', 'internal_transfer_out')`
                )
              )
              .where(
                and(
                  eq(schema.transferReconciliations.principalId, source.principalId),
                  or(
                    eq(schema.providerTransfers.sourceId, sourceId),
                    eq(schema.transfers.sourceId, sourceId),
                    eq(replayCanonicalTransaction.sourceId, sourceId)
                  )
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.loadAffectedReconciliationLegs"
                )
              )

          const discoveredReconciliationLegs = yield* loadAffectedReconciliationLegs()
          const sourceIdsToLock = [
            ...new Set([sourceId, ...discoveredReconciliationLegs.map((row) => row.legSourceId)]),
          ].sort()
          const lockedSources = yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(inArray(schema.sources.id, sourceIdsToLock))
            .orderBy(asc(schema.sources.id))
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory"
              )
            )
          const affectedReconciliationLegs = yield* loadAffectedReconciliationLegs()
          const lockedSourceIds = new Set(lockedSources.map((row) => row.id))

          if (affectedReconciliationLegs.some((row) => !lockedSourceIds.has(row.legSourceId))) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory",
                cause: "Transfer reconciliation state changed while source locks were acquired",
              })
            )
          }

          const crossSourceAllocations = yield* tx
            .select({
              dependentSourceId: schema.inventoryMovements.sourceId,
              affectedPrincipalId: schema.fifoLots.principalId,
            })
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
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.selectCrossSourceAllocation"
              )
            )

          const crossSourceDisposalMatches = yield* tx
            .select({
              dependentSourceId: schema.transactionLegs.sourceId,
              affectedPrincipalId: schema.fifoLots.principalId,
            })
            .from(schema.disposalMatches)
            .innerJoin(
              schema.transactionLegs,
              eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
            )
            .innerJoin(schema.fifoLots, eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId))
            .where(
              and(
                eq(schema.fifoLots.sourceId, sourceId),
                ne(schema.transactionLegs.sourceId, sourceId)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.selectCrossSourceDisposalMatch"
              )
            )

          const reconciliationAcquisitionLegIds = affectedReconciliationLegs
            .filter((row) => row.legKind === "acquisition" || row.legKind === "income")
            .map((row) => row.legId)
          const reconciliationLotDisposals =
            reconciliationAcquisitionLegIds.length === 0
              ? []
              : yield* tx
                  .select({
                    dependentSourceId: schema.transactionLegs.sourceId,
                    affectedPrincipalId: schema.fifoLots.principalId,
                  })
                  .from(schema.disposalMatches)
                  .innerJoin(
                    schema.fifoLots,
                    eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId)
                  )
                  .innerJoin(
                    schema.transactionLegs,
                    eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
                  )
                  .where(
                    and(
                      inArray(schema.fifoLots.sourceLegId, reconciliationAcquisitionLegIds),
                      ne(schema.transactionLegs.sourceId, sourceId)
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "sourceReplayRepository.resetSourceDerivedState.selectReconciliationLotDisposals"
                    )
                  )
          const reconciliationLotAllocations =
            reconciliationAcquisitionLegIds.length === 0
              ? []
              : yield* tx
                  .select({
                    dependentSourceId: schema.inventoryMovements.sourceId,
                    affectedPrincipalId: schema.fifoLots.principalId,
                  })
                  .from(schema.inventoryMovementAllocations)
                  .innerJoin(
                    schema.fifoLots,
                    eq(schema.fifoLots.id, schema.inventoryMovementAllocations.fifoLotId)
                  )
                  .innerJoin(
                    schema.inventoryMovements,
                    eq(
                      schema.inventoryMovements.id,
                      schema.inventoryMovementAllocations.inventoryMovementId
                    )
                  )
                  .where(
                    and(
                      inArray(schema.fifoLots.sourceLegId, reconciliationAcquisitionLegIds),
                      ne(schema.inventoryMovements.sourceId, sourceId)
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "sourceReplayRepository.resetSourceDerivedState.selectReconciliationLotAllocations"
                    )
                  )

          const crossSourceDependencies = [
            ...crossSourceAllocations,
            ...crossSourceDisposalMatches,
            ...reconciliationLotDisposals,
            ...reconciliationLotAllocations,
          ]

          if (crossSourceDependencies.length > 0) {
            return yield* Effect.fail(
              new SourceReplayDependencyError({
                sourceId,
                dependentSourceIds: Array.from(
                  new Set(crossSourceDependencies.map((row) => row.dependentSourceId))
                ).sort(),
                affectedPrincipalIds: Array.from(
                  new Set(crossSourceDependencies.map((row) => row.affectedPrincipalId))
                ).sort(),
              })
            )
          }

          const reconciliationDisposalLegIds = affectedReconciliationLegs
            .filter((row) => row.legKind === "disposal")
            .map((row) => row.legId)
          const reconciliationDisposalMatches =
            reconciliationDisposalLegIds.length === 0
              ? []
              : yield* tx
                  .select({
                    fifoLotId: schema.disposalMatches.fifoLotId,
                    matchedAmount: schema.disposalMatches.matchedAmount,
                  })
                  .from(schema.disposalMatches)
                  .where(
                    inArray(schema.disposalMatches.disposalLegId, reconciliationDisposalLegIds)
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "sourceReplayRepository.resetSourceDerivedState.selectReconciliationDisposalMatches"
                    )
                  )

          yield* Effect.forEach(reconciliationDisposalMatches, (match) =>
            tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${match.matchedAmount}`,
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, match.fifoLotId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.restoreReconciliationLots"
                )
              )
          )

          const affectedReconciliationLegIds = affectedReconciliationLegs.map((row) => row.legId)
          if (affectedReconciliationLegIds.length > 0) {
            yield* tx
              .delete(schema.transactionLegs)
              .where(inArray(schema.transactionLegs.id, affectedReconciliationLegIds))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.deleteReconciliationLegs"
                )
              )
          }

          const affectedReconciliationIds = [
            ...new Set(affectedReconciliationLegs.map((row) => row.reconciliationId)),
          ]
          if (affectedReconciliationIds.length > 0) {
            yield* tx
              .delete(schema.transferReconciliations)
              .where(inArray(schema.transferReconciliations.id, affectedReconciliationIds))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.deleteReconciliations"
                )
              )
          }

          const survivingReconciliationTransactionIds = [
            ...new Set(
              affectedReconciliationLegs.flatMap((row) =>
                row.legSourceId !== sourceId && row.transactionId !== null
                  ? [row.transactionId]
                  : []
              )
            ),
          ]
          if (survivingReconciliationTransactionIds.length > 0) {
            yield* tx
              .update(schema.transactions)
              .set({
                transactionType: sql`case
                  when exists (
                    select 1
                    from ${schema.transactionReviews}
                    where ${schema.transactionReviews.transactionId} = ${schema.transactions.id}
                      and ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      and ${schema.transactionReviews.currentTypeKey} is not null
                  )
                    then (
                      select ${schema.transactionReviews.currentTypeKey}
                      from ${schema.transactionReviews}
                      where ${schema.transactionReviews.transactionId} = ${schema.transactions.id}
                    )
                  else null
                end`,
                updatedAt: nowDate(),
              })
              .where(inArray(schema.transactions.id, survivingReconciliationTransactionIds))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.invalidateReconciliationTransactions"
                )
              )

            yield* tx
              .delete(schema.transactionReviews)
              .where(
                and(
                  inArray(
                    schema.transactionReviews.transactionId,
                    survivingReconciliationTransactionIds
                  ),
                  sql`${schema.transactionReviews.reviewStatus} not in ('approved', 'changed')`,
                  sql`not exists (
                    select 1
                    from unnest(
                      string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ',')
                    ) as review_layers(layer)
                    where btrim(review_layers.layer) not in ('', 'transfer_reconciliation')
                  )`
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.invalidateReconciliationReviews"
                )
              )

            yield* tx
              .update(schema.transactionReviews)
              .set({
                reviewStatus: sql`case
                  when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                    then ${schema.transactionReviews.reviewStatus}
                  else 'needs_review'
                end`,
                originalTypeKey: null,
                originalConfidence: null,
                currentTypeKey: sql`case
                  when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                    then ${schema.transactionReviews.currentTypeKey}
                  else null
                end`,
                categorizationReason: sql`nullif(
                  btrim(
                    replace(
                      coalesce(${schema.transactionReviews.categorizationReason}, ''),
                      cast(${INTERNAL_TRANSFER_REASON} as text),
                      ''
                    ),
                    E'\n '
                  ),
                  ''
                )`,
                matchedLayer: sql`nullif(
                  array_to_string(
                    array_remove(
                      string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ','),
                      'transfer_reconciliation'
                    ),
                    ','
                  ),
                  ''
                )`,
                needsReview: sql`case
                  when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                    then ${schema.transactionReviews.needsReview}
                  else true
                end`,
                updatedAt: nowDate(),
              })
              .where(
                inArray(
                  schema.transactionReviews.transactionId,
                  survivingReconciliationTransactionIds
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.preserveOtherReviewState"
                )
              )
          }

          const affectedProviderTransferIds = [
            ...new Set(affectedReconciliationLegs.map((row) => row.providerTransferId)),
          ]
          if (
            survivingReconciliationTransactionIds.length > 0 ||
            affectedProviderTransferIds.length > 0
          ) {
            const survivingMovementFilter =
              survivingReconciliationTransactionIds.length === 0
                ? inArray(schema.inventoryMovements.providerTransferId, affectedProviderTransferIds)
                : affectedProviderTransferIds.length === 0
                  ? inArray(
                      schema.inventoryMovements.transactionId,
                      survivingReconciliationTransactionIds
                    )
                  : or(
                      inArray(
                        schema.inventoryMovements.transactionId,
                        survivingReconciliationTransactionIds
                      ),
                      inArray(
                        schema.inventoryMovements.providerTransferId,
                        affectedProviderTransferIds
                      )
                    )

            yield* tx
              .update(schema.inventoryMovements)
              .set({
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                updatedAt: nowDate(),
              })
              .where(survivingMovementFilter)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.invalidateReconciliationMovements"
                )
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

          yield* tx
            .update(schema.sources)
            .set({ updatedAt: nowDate() })
            .where(eq(schema.sources.id, sourceId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.invalidateReadCursors"
              )
            )
        })
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SourceReplayDependencyError
            ? error
            : toSyncEngineStorageError({
                error,
                operation: "sourceReplayRepository.resetSourceDerivedState.transaction",
              })
        )
      )

  return SourceReplayRepository.of({
    resetSourceDerivedState,
  } satisfies SourceReplayRepositoryShape)
})

export const SourceReplayRepositoryLive = Layer.effect(SourceReplayRepository, make)
