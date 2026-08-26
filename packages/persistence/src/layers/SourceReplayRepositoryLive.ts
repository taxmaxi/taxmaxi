/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { sourceInventoryLockQuery } from "./SourceInventoryLock.ts"
import {
  SourceReplayDependencyCycleError,
  SourceReplayDependencyError,
  SourceReplayDependencyPendingError,
  SourceReplayRepository,
  type SourceReplayRepositoryShape,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

class ReplayInventoryOwnerSetChanged extends Schema.TaggedError<ReplayInventoryOwnerSetChanged>()(
  "ReplayInventoryOwnerSetChanged",
  {}
) {}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const resetSourceDerivedState: SourceReplayRepositoryShape["resetSourceDerivedState"] = ({
    sourceId,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const loadReferencedOwnerSourceIds = () =>
            Effect.gen(function* () {
              const allocationOwners = yield* tx
                .selectDistinct({ sourceId: schema.fifoLots.sourceId })
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
                    eq(schema.inventoryMovements.sourceId, sourceId),
                    ne(schema.fifoLots.sourceId, sourceId)
                  )
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceReplayRepository.resetSourceDerivedState.loadAllocationOwners"
                  )
                )
              const disposalMatchOwners = yield* tx
                .selectDistinct({ sourceId: schema.fifoLots.sourceId })
                .from(schema.disposalMatches)
                .innerJoin(
                  schema.transactionLegs,
                  eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
                )
                .innerJoin(
                  schema.fifoLots,
                  eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId)
                )
                .where(
                  and(
                    eq(schema.transactionLegs.sourceId, sourceId),
                    ne(schema.fifoLots.sourceId, sourceId)
                  )
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceReplayRepository.resetSourceDerivedState.loadDisposalMatchOwners"
                  )
                )

              return [
                ...new Set(
                  [...allocationOwners, ...disposalMatchOwners].map((row) => row.sourceId)
                ),
              ].sort()
            })

          const referencedOwnerSourceIds = yield* loadReferencedOwnerSourceIds()
          const lockedSourceIds = [...new Set([sourceId, ...referencedOwnerSourceIds])].sort()
          yield* tx
            .execute(sourceInventoryLockQuery(lockedSourceIds))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory"
              )
            )
          const lockedSources = yield* tx
            .select({ id: schema.sources.id, principalId: schema.sources.principalId })
            .from(schema.sources)
            .where(inArray(schema.sources.id, lockedSourceIds))
            .orderBy(asc(schema.sources.id))
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory"
              )
            )

          if (!lockedSources.some((source) => source.id === sourceId)) {
            return
          }
          const sourcePrincipalId = lockedSources.find(
            (source) => source.id === sourceId
          )?.principalId
          if (sourcePrincipalId === undefined) return

          const allocationDependencies = yield* tx
            .select({
              ownerSourceId: schema.fifoLots.sourceId,
              dependentSourceId: schema.inventoryMovements.sourceId,
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
                eq(schema.fifoLots.principalId, sourcePrincipalId),
                ne(schema.inventoryMovements.sourceId, schema.fifoLots.sourceId)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.loadAllocationDependencies"
              )
            )
          const disposalDependencies = yield* tx
            .select({
              ownerSourceId: schema.fifoLots.sourceId,
              dependentSourceId: schema.transactionLegs.sourceId,
            })
            .from(schema.disposalMatches)
            .innerJoin(
              schema.transactionLegs,
              eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
            )
            .innerJoin(schema.fifoLots, eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId))
            .where(
              and(
                eq(schema.fifoLots.principalId, sourcePrincipalId),
                ne(schema.transactionLegs.sourceId, schema.fifoLots.sourceId)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.loadDisposalDependencies"
              )
            )
          const dependentSourceIdsByOwner = new Map<string, Set<string>>()
          for (const { ownerSourceId, dependentSourceId } of [
            ...allocationDependencies,
            ...disposalDependencies,
          ]) {
            const dependentSourceIds =
              dependentSourceIdsByOwner.get(ownerSourceId) ?? new Set<string>()
            dependentSourceIds.add(dependentSourceId)
            dependentSourceIdsByOwner.set(ownerSourceId, dependentSourceIds)
          }
          const reachableSourceIds = [...(dependentSourceIdsByOwner.get(sourceId) ?? [])]
          const visitedSourceIds = new Set<string>()
          while (reachableSourceIds.length > 0) {
            const reachableSourceId = reachableSourceIds.pop()
            if (reachableSourceId === undefined) continue
            if (reachableSourceId === sourceId) {
              return yield* new SourceReplayDependencyCycleError({ sourceId })
            }
            if (visitedSourceIds.has(reachableSourceId)) continue
            visitedSourceIds.add(reachableSourceId)
            reachableSourceIds.push(...(dependentSourceIdsByOwner.get(reachableSourceId) ?? []))
          }

          const dependentApplications = yield* tx
            .select({
              overrideId: schema.principalAssetOverrideApplications.overrideId,
              dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
            })
            .from(schema.principalAssetOverrideApplications)
            .where(
              and(
                eq(schema.principalAssetOverrideApplications.sourceId, sourceId),
                isNull(schema.principalAssetOverrideApplications.supersededAt)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "sourceReplayRepository.resetSourceDerivedState.loadReplayDependencies"
              )
            )
          const durablePendingOwnerSourceIds = yield* Effect.reduce(
            dependentApplications,
            () => new Set<string>(),
            (pendingOwnerSourceIds, application) =>
              Effect.gen(function* () {
                for (const ownerSourceId of application.dependsOnSourceIds) {
                  const [ownerApplication] = yield* tx
                    .select({
                      successful: sql<boolean>`(
                        ${schema.processingJobs.status} = 'completed'
                        and ${schema.processingJobs.progressDetails} ->> 'failedRecords' = '0'
                      )`,
                    })
                    .from(schema.principalAssetOverrideApplications)
                    .leftJoin(
                      schema.processingJobs,
                      eq(
                        schema.processingJobs.id,
                        schema.principalAssetOverrideApplications.replayJobId
                      )
                    )
                    .where(
                      and(
                        eq(
                          schema.principalAssetOverrideApplications.overrideId,
                          application.overrideId
                        ),
                        eq(schema.principalAssetOverrideApplications.sourceId, ownerSourceId),
                        isNull(schema.principalAssetOverrideApplications.supersededAt)
                      )
                    )
                    .limit(1)
                    .pipe(
                      wrapSyncEngineSqlError(
                        "sourceReplayRepository.resetSourceDerivedState.loadReplayDependencyOwner"
                      )
                    )
                  if (ownerApplication?.successful !== true) {
                    pendingOwnerSourceIds.add(ownerSourceId)
                  }
                }
                return pendingOwnerSourceIds
              })
          )
          if (durablePendingOwnerSourceIds.size > 0) {
            return yield* new SourceReplayDependencyPendingError({
              sourceId,
              ownerSourceIds: [...durablePendingOwnerSourceIds].sort(),
            })
          }

          const revalidatedOwnerSourceIds = yield* loadReferencedOwnerSourceIds()
          if (
            revalidatedOwnerSourceIds.length !== referencedOwnerSourceIds.length ||
            revalidatedOwnerSourceIds.some(
              (ownerSourceId, index) => ownerSourceId !== referencedOwnerSourceIds[index]
            )
          ) {
            return yield* new ReplayInventoryOwnerSetChanged()
          }

          if (referencedOwnerSourceIds.length > 0) {
            const activeOwnerJobs = yield* tx
              .selectDistinct({ sourceId: schema.processingJobs.sourceId })
              .from(schema.processingJobs)
              .where(
                and(
                  inArray(schema.processingJobs.sourceId, referencedOwnerSourceIds),
                  inArray(schema.processingJobs.status, ["pending", "processing"])
                )
              )
              .orderBy(asc(schema.processingJobs.sourceId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayRepository.resetSourceDerivedState.loadActiveOwnerJobs"
                )
              )

            if (activeOwnerJobs.length > 0) {
              return yield* new SourceReplayDependencyPendingError({
                sourceId,
                ownerSourceIds: activeOwnerJobs.map(({ sourceId: ownerSourceId }) => ownerSourceId),
              })
            }
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

          const crossSourceDependencies = [...crossSourceAllocations, ...crossSourceDisposalMatches]

          const crossPrincipalDependencies = crossSourceDependencies.filter(
            ({ affectedPrincipalId }) => affectedPrincipalId !== sourcePrincipalId
          )
          if (crossPrincipalDependencies.length > 0) {
            return yield* new SourceReplayDependencyError({
              sourceId,
              dependentSourceIds: Array.from(
                new Set(crossPrincipalDependencies.map((row) => row.dependentSourceId))
              ).sort(),
              affectedPrincipalIds: Array.from(
                new Set(crossPrincipalDependencies.map((row) => row.affectedPrincipalId))
              ).sort(),
            })
          }

          const dependentSourceIds = Array.from(
            new Set(crossSourceDependencies.map((row) => row.dependentSourceId))
          ).sort()
          const replayRequestedAt = nowDate()
          yield* Effect.forEach(
            dependentSourceIds,
            (dependentSourceId) =>
              Effect.gen(function* () {
                const [active] = yield* tx
                  .update(schema.processingJobs)
                  .set({ followUpMode: "replay", updatedAt: replayRequestedAt })
                  .where(
                    and(
                      eq(schema.processingJobs.sourceId, dependentSourceId),
                      eq(schema.processingJobs.principalId, sourcePrincipalId),
                      inArray(schema.processingJobs.status, ["pending", "processing"])
                    )
                  )
                  .returning({ id: schema.processingJobs.id })

                if (active !== undefined) return

                const [created] = yield* tx
                  .insert(schema.processingJobs)
                  .values({
                    sourceId: dependentSourceId,
                    principalId: sourcePrincipalId,
                    mode: "replay",
                    status: "pending",
                    attemptCount: 0,
                    maxAttempts: 3,
                    progressDetails: { mode: "replay", reason: "fifo_dependency" },
                    createdAt: replayRequestedAt,
                    updatedAt: replayRequestedAt,
                  })
                  .onConflictDoNothing()
                  .returning({ id: schema.processingJobs.id })

                if (created === undefined) {
                  yield* tx
                    .update(schema.processingJobs)
                    .set({ followUpMode: "replay", updatedAt: replayRequestedAt })
                    .where(
                      and(
                        eq(schema.processingJobs.sourceId, dependentSourceId),
                        eq(schema.processingJobs.principalId, sourcePrincipalId),
                        inArray(schema.processingJobs.status, ["pending", "processing"])
                      )
                    )
                  return
                }

                yield* tx
                  .update(schema.principalAssetOverrideApplications)
                  .set({ replayJobId: created.id })
                  .where(
                    and(
                      eq(schema.principalAssetOverrideApplications.sourceId, dependentSourceId),
                      isNull(schema.principalAssetOverrideApplications.supersededAt)
                    )
                  )
              }),
            { concurrency: 1 }
          )

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
        Effect.retry({
          times: 2,
          while: (error) => error instanceof ReplayInventoryOwnerSetChanged,
        }),
        Effect.mapError((error) =>
          error instanceof SourceReplayDependencyCycleError ||
          error instanceof SourceReplayDependencyError ||
          error instanceof SourceReplayDependencyPendingError
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
