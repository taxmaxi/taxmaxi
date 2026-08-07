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
  type SourceReplayRepositoryShape,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const providerTransactionTable = aliasedTable(schema.transactions, "replay_provider_transaction")
  const canonicalTransactionTable = aliasedTable(
    schema.transactions,
    "replay_canonical_transaction"
  )
  const canonicalTransferTable = aliasedTable(schema.transfers, "replay_canonical_transfer")
  const INTERNAL_TRANSFER_REASON =
    "Deterministic provider transfer reconciled to a principal-owned onchain transfer."

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
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory"
              )
            )

          if (source === undefined) {
            return
          }

          yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(eq(schema.sources.principalId, source.principalId))
            .orderBy(asc(schema.sources.id))
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.lockPrincipalSources"
              )
            )

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

          const crossSourceDependencies = [...crossSourceAllocations, ...crossSourceDisposalMatches]

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

          const appliedReconciliations = yield* tx
            .select({
              reconciliationId: schema.transferReconciliations.id,
              providerTransferId: schema.transferReconciliations.providerTransferId,
              canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
              canonicalTransferExternalId: canonicalTransferTable.externalId,
              providerDirection: schema.providerTransfers.direction,
              providerTransactionId: schema.providerTransfers.transactionId,
              providerTransactionSourceId: providerTransactionTable.sourceId,
              canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
              canonicalTransactionSourceId: canonicalTransactionTable.sourceId,
            })
            .from(schema.transferReconciliations)
            .innerJoin(
              schema.providerTransfers,
              eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
            )
            .innerJoin(
              providerTransactionTable,
              eq(providerTransactionTable.id, schema.providerTransfers.transactionId)
            )
            .innerJoin(
              canonicalTransactionTable,
              eq(
                canonicalTransactionTable.id,
                schema.transferReconciliations.canonicalTransactionId
              )
            )
            .leftJoin(
              canonicalTransferTable,
              eq(canonicalTransferTable.id, schema.transferReconciliations.canonicalTransferId)
            )
            .where(
              and(
                eq(schema.transferReconciliations.status, "auto_applied"),
                or(
                  eq(providerTransactionTable.sourceId, sourceId),
                  eq(canonicalTransactionTable.sourceId, sourceId)
                )
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.loadAppliedReconciliations"
              )
            )

          for (const reconciliation of appliedReconciliations) {
            const providerTransactionId = reconciliation.providerTransactionId
            const canonicalTransactionId = reconciliation.canonicalTransactionId
            if (providerTransactionId === null || canonicalTransactionId === null) {
              continue
            }

            const originTransactionId =
              reconciliation.providerDirection === "outbound"
                ? providerTransactionId
                : canonicalTransactionId
            const destinationTransactionId =
              reconciliation.providerDirection === "outbound"
                ? canonicalTransactionId
                : providerTransactionId
            const transactionIds = [originTransactionId, destinationTransactionId]
            const internalLegs = yield* tx
              .select({
                id: schema.transactionLegs.id,
                transactionId: schema.transactionLegs.transactionId,
                derivationRule: schema.transactionLegs.derivationRule,
              })
              .from(schema.transactionLegs)
              .where(
                and(
                  inArray(schema.transactionLegs.transactionId, transactionIds),
                  inArray(schema.transactionLegs.derivationRule, [
                    "internal_transfer_out",
                    "internal_transfer_in",
                  ]),
                  sql`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId' = ${reconciliation.providerTransferId}`
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.loadInternalTransferLegs"
                )
              )

            const disposalLegIds = internalLegs
              .filter(({ derivationRule }) => derivationRule === "internal_transfer_out")
              .map(({ id }) => id)
            const acquisitionLegIds = internalLegs
              .filter(({ derivationRule }) => derivationRule === "internal_transfer_in")
              .map(({ id }) => id)
            const destinationLots =
              acquisitionLegIds.length === 0
                ? []
                : yield* tx
                    .select({
                      id: schema.fifoLots.id,
                      principalId: schema.fifoLots.principalId,
                    })
                    .from(schema.fifoLots)
                    .where(inArray(schema.fifoLots.sourceLegId, acquisitionLegIds))
            const destinationLotIds = destinationLots.map(({ id }) => id)

            if (destinationLotIds.length > 0) {
              const dependentDisposals = yield* tx
                .select({ dependentSourceId: schema.transactionLegs.sourceId })
                .from(schema.disposalMatches)
                .innerJoin(
                  schema.transactionLegs,
                  eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
                )
                .where(inArray(schema.disposalMatches.fifoLotId, destinationLotIds))
              const dependentAllocations = yield* tx
                .select({ dependentSourceId: schema.inventoryMovements.sourceId })
                .from(schema.inventoryMovementAllocations)
                .innerJoin(
                  schema.inventoryMovements,
                  eq(
                    schema.inventoryMovements.id,
                    schema.inventoryMovementAllocations.inventoryMovementId
                  )
                )
                .where(inArray(schema.inventoryMovementAllocations.fifoLotId, destinationLotIds))
              const dependentSourceIds = [...dependentDisposals, ...dependentAllocations].map(
                ({ dependentSourceId }) => dependentSourceId
              )

              if (dependentSourceIds.length > 0) {
                return yield* Effect.fail(
                  new SourceReplayDependencyError({
                    sourceId,
                    dependentSourceIds: [...new Set(dependentSourceIds)].sort(),
                    affectedPrincipalIds: [source.principalId],
                  })
                )
              }
            }

            const internalDisposalMatches =
              disposalLegIds.length === 0
                ? []
                : yield* tx
                    .select({
                      fifoLotId: schema.disposalMatches.fifoLotId,
                      matchedAmount: schema.disposalMatches.matchedAmount,
                    })
                    .from(schema.disposalMatches)
                    .where(inArray(schema.disposalMatches.disposalLegId, disposalLegIds))

            yield* Effect.forEach(
              internalDisposalMatches,
              ({ fifoLotId, matchedAmount }) =>
                tx
                  .update(schema.fifoLots)
                  .set({
                    remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${matchedAmount}`,
                    updatedAt: nowDate(),
                  })
                  .where(eq(schema.fifoLots.id, fifoLotId)),
              { discard: true }
            )

            if (internalLegs.length > 0) {
              yield* tx.delete(schema.transactionLegs).where(
                inArray(
                  schema.transactionLegs.id,
                  internalLegs.map(({ id }) => id)
                )
              )
            }

            const reviews = yield* tx
              .select({
                transactionId: schema.transactionReviews.transactionId,
                reviewStatus: schema.transactionReviews.reviewStatus,
                currentTypeKey: schema.transactionReviews.currentTypeKey,
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
              })
              .from(schema.transactionReviews)
              .where(inArray(schema.transactionReviews.transactionId, transactionIds))

            for (const review of reviews) {
              const layers = (review.matchedLayer ?? "")
                .split(",")
                .map((layer) => layer.trim())
                .filter((layer) => layer !== "" && layer !== "transfer_reconciliation")
              const wasReconciliationInternalTransfer =
                review.reviewStatus !== "approved" &&
                review.reviewStatus !== "changed" &&
                review.currentTypeKey === "internal_transfer"

              if (!wasReconciliationInternalTransfer) {
                continue
              }

              yield* tx
                .update(schema.transactions)
                .set({ transactionType: null, updatedAt: nowDate() })
                .where(eq(schema.transactions.id, review.transactionId))

              if (layers.length === 0) {
                yield* tx
                  .delete(schema.transactionReviews)
                  .where(eq(schema.transactionReviews.transactionId, review.transactionId))
                continue
              }

              const remainingReasons = (review.categorizationReason ?? "")
                .split("\n")
                .map((reason) => reason.trim())
                .filter((reason) => reason !== "" && reason !== INTERNAL_TRANSFER_REASON)

              yield* tx
                .update(schema.transactionReviews)
                .set({
                  reviewStatus: "needs_review",
                  originalTypeKey: null,
                  originalConfidence: null,
                  currentTypeKey: null,
                  categorizationReason:
                    remainingReasons.length === 0 ? null : remainingReasons.join("\n"),
                  matchedLayer: layers.join(","),
                  needsReview: true,
                  reviewedAt: null,
                  updatedAt: nowDate(),
                })
                .where(eq(schema.transactionReviews.transactionId, review.transactionId))
            }

            const matchedProviderTransferIds = [reconciliation.providerTransferId]
            if (
              reconciliation.providerDirection === "inbound" &&
              reconciliation.canonicalTransferExternalId !== null
            ) {
              const [custodyMovement] = yield* tx
                .select({ providerTransferId: schema.inventoryMovements.providerTransferId })
                .from(schema.inventoryMovements)
                .innerJoin(
                  schema.providerTransfers,
                  eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
                )
                .where(
                  and(
                    eq(schema.inventoryMovements.transactionId, originTransactionId),
                    sql`${schema.providerTransfers.metadata}->>'canonicalTransferExternalId' = ${reconciliation.canonicalTransferExternalId}`,
                    sql`${schema.inventoryMovements.providerTransferId} is not null`
                  )
                )
                .limit(1)

              if (
                custodyMovement?.providerTransferId !== null &&
                custodyMovement?.providerTransferId !== undefined &&
                custodyMovement.providerTransferId !== reconciliation.providerTransferId
              ) {
                matchedProviderTransferIds.push(custodyMovement.providerTransferId)
              }
            }

            yield* tx
              .update(schema.inventoryMovements)
              .set({
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                updatedAt: nowDate(),
              })
              .where(
                inArray(schema.inventoryMovements.providerTransferId, matchedProviderTransferIds)
              )

            yield* tx
              .delete(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.id, reconciliation.reconciliationId))
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
