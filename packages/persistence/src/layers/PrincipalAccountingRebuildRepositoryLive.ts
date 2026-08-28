/**
 * PrincipalAccountingRebuildRepositoryLive - Rebuild downstream principal accounting from stored artifacts.
 *
 * @module PrincipalAccountingRebuildRepositoryLive
 */

import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  PrincipalAccountingRebuildRepository,
  type PrincipalAccountingRebuildRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { schema } from "../schema/index.ts"
import {
  addFifoInventoryReview,
  buildFifoAllocations,
  compareDecimalQuantities,
  FIFO_INVENTORY_REVIEW_REASON_PREFIX,
  removeFifoInventoryReview,
  type FifoAllocation,
  type OpenFifoLot,
  toCostBasisPerToken,
} from "./FifoAccounting.ts"
import { drizzle } from "./PgClientLive.ts"
import { makeFixedPointErrorFactory } from "./SourceNormalizationFixedPoint.ts"
import {
  nowDate,
  toSyncEngineStorageError,
  type SyncEngineDbTransaction,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

interface RebuildLeg {
  readonly id: string
  readonly sourceId: string
  readonly transactionId: string | null
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly derivationRule: string | null
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
}

interface RebuildMovement {
  readonly id: string
  readonly sourceId: string
  readonly transactionId: string
  readonly providerTransferId: string | null
  readonly transactionLegId: string | null
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly amount: string
  readonly direction: "inbound" | "outbound"
  readonly purpose: "principal" | "fee" | "reward"
}

type OwnerSourceIdsByRecordId = Map<string, Set<string>>

type RebuildEvent =
  | {
      readonly type: "leg"
      readonly id: string
      readonly timestamp: Date
      readonly priority: number
      readonly leg: RebuildLeg
    }
  | {
      readonly type: "movement"
      readonly id: string
      readonly timestamp: Date
      readonly priority: number
      readonly movement: RebuildMovement
    }

interface RebuildEventSet {
  readonly events: ReadonlyArray<RebuildEvent>
  readonly transactionLegs: ReadonlyMap<string, ReadonlyArray<RebuildLeg>>
}

interface RebuildEventResult {
  readonly sourceIds: ReadonlyArray<string>
  readonly fifoLotsRebuilt: number
  readonly disposalMatchesRebuilt: number
  readonly inventoryAllocationsRebuilt: number
}

const fixedPointErrorFactory = makeFixedPointErrorFactory(({ kind, message }) =>
  toSyncEngineStorageError({
    operation: `principalAccountingRebuildRepository.fixedPoint.${kind}`,
    error: message,
  })
)

const appendOwnerSource = ({
  ownerSourceIdsByRecordId,
  recordId,
  ownerSourceId,
}: {
  readonly ownerSourceIdsByRecordId: Map<string, Set<string>>
  readonly recordId: string
  readonly ownerSourceId: string
}) => {
  const ownerSourceIds = ownerSourceIdsByRecordId.get(recordId) ?? new Set<string>()
  ownerSourceIds.add(ownerSourceId)
  ownerSourceIdsByRecordId.set(recordId, ownerSourceIds)
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const recordFifoInventoryReview = ({
    tx,
    principalId,
    transactionId,
    cause,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly transactionId: string
    readonly cause: unknown
  }) =>
    Effect.gen(function* () {
      const reason =
        `${FIFO_INVENTORY_REVIEW_REASON_PREFIX} Review required because the transaction moves ` +
        "more inventory out than the synced source FIFO lots currently cover. " +
        "This usually means an opening balance, transfer in, or historical acquisition is missing. " +
        String(cause)
      const [review] = yield* tx
        .select({
          reviewStatus: schema.transactionReviews.reviewStatus,
          categorizationReason: schema.transactionReviews.categorizationReason,
          matchedLayer: schema.transactionReviews.matchedLayer,
        })
        .from(schema.transactionReviews)
        .where(eq(schema.transactionReviews.transactionId, transactionId))
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.recordFifoInventoryReview.loadReview"
          )
        )
      const fifoReview = addFifoInventoryReview({ review, reason })

      if (review === undefined) {
        yield* tx
          .insert(schema.transactionReviews)
          .values({
            transactionId,
            principalId,
            reviewStatus: fifoReview.reviewStatus,
            categorizationReason: fifoReview.categorizationReason,
            matchedLayer: fifoReview.matchedLayer,
            needsReview: fifoReview.needsReview,
            createdAt: nowDate(),
            updatedAt: nowDate(),
          })
          .pipe(
            wrapSyncEngineSqlError(
              "principalAccountingRebuildRepository.recordFifoInventoryReview.insertReview"
            )
          )
        return
      }

      yield* tx
        .update(schema.transactionReviews)
        .set({
          reviewStatus: fifoReview.reviewStatus,
          categorizationReason: fifoReview.categorizationReason,
          matchedLayer: fifoReview.matchedLayer,
          needsReview: fifoReview.needsReview,
          updatedAt: nowDate(),
        })
        .where(eq(schema.transactionReviews.transactionId, transactionId))
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.recordFifoInventoryReview.updateReview"
          )
        )
    })

  const buildRebuildFifoAllocations = ({
    tx,
    principalId,
    transactionId,
    lots,
    amount,
    fiatAmount,
    operation,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly transactionId: string | null
    readonly lots: ReadonlyArray<OpenFifoLot>
    readonly amount: string
    readonly fiatAmount: string | null
    readonly operation:
      | "principalAccountingRebuildRepository.matchDisposal"
      | "principalAccountingRebuildRepository.allocateInventoryMovement"
  }) =>
    buildFifoAllocations({
      lots,
      amount,
      fiatAmount,
      errorFactory: fixedPointErrorFactory,
      insufficientInventoryError: (remainingAmount) =>
        new SyncEngineStorageError({
          operation,
          cause: `Insufficient FIFO inventory for outbound amount ${remainingAmount}`,
        }),
    }).pipe(
      Effect.catchTag("SyncEngineStorageError", (error) =>
        error.operation === operation && transactionId !== null
          ? recordFifoInventoryReview({
              tx,
              principalId,
              transactionId,
              cause: error.cause,
            }).pipe(Effect.as(null))
          : Effect.fail(error)
      )
    )

  const loadDisposalFifoCoverage = ({
    tx,
    transactionId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly transactionId: string
  }) =>
    Effect.gen(function* () {
      const disposalLegs = yield* tx
        .select({
          id: schema.transactionLegs.id,
          assetId: schema.transactionLegs.assetId,
          amount: schema.transactionLegs.amount,
        })
        .from(schema.transactionLegs)
        .where(
          and(
            eq(schema.transactionLegs.transactionId, transactionId),
            eq(schema.transactionLegs.kind, "disposal")
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.loadDisposalFifoCoverage.loadLegs"
          )
        )
      const matches =
        disposalLegs.length === 0
          ? []
          : yield* tx
              .select({
                disposalLegId: schema.disposalMatches.disposalLegId,
                matchedAmount: sql<string>`sum(${schema.disposalMatches.matchedAmount})`,
              })
              .from(schema.disposalMatches)
              .where(
                inArray(
                  schema.disposalMatches.disposalLegId,
                  disposalLegs.map(({ id }) => id)
                )
              )
              .groupBy(schema.disposalMatches.disposalLegId)
              .pipe(
                wrapSyncEngineSqlError(
                  "principalAccountingRebuildRepository.loadDisposalFifoCoverage.loadMatches"
                )
              )

      return {
        disposalLegs,
        matchedAmounts: new Map(
          matches.map(({ disposalLegId, matchedAmount }) => [disposalLegId, matchedAmount] as const)
        ),
      }
    })

  const loadMovementFifoCoverage = ({
    tx,
    transactionId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly transactionId: string
  }) =>
    Effect.gen(function* () {
      const movements = yield* tx
        .select({
          id: schema.inventoryMovements.id,
          providerTransferId: schema.inventoryMovements.providerTransferId,
          purpose: schema.inventoryMovements.purpose,
          reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
          assetId: schema.inventoryMovements.assetId,
          amount: schema.inventoryMovements.amount,
        })
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.transactionId, transactionId),
            eq(schema.inventoryMovements.direction, "outbound")
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.loadMovementFifoCoverage.loadMovements"
          )
        )
      const allocations =
        movements.length === 0
          ? []
          : yield* tx
              .select({
                inventoryMovementId: schema.inventoryMovementAllocations.inventoryMovementId,
                matchedAmount: sql<string>`sum(${schema.inventoryMovementAllocations.matchedAmount})`,
              })
              .from(schema.inventoryMovementAllocations)
              .where(
                inArray(
                  schema.inventoryMovementAllocations.inventoryMovementId,
                  movements.map(({ id }) => id)
                )
              )
              .groupBy(schema.inventoryMovementAllocations.inventoryMovementId)
              .pipe(
                wrapSyncEngineSqlError(
                  "principalAccountingRebuildRepository.loadMovementFifoCoverage.loadAllocations"
                )
              )

      return {
        movements,
        matchedAmounts: new Map(
          allocations.map(({ inventoryMovementId, matchedAmount }) => [
            inventoryMovementId,
            matchedAmount,
          ])
        ),
      }
    })

  const isFullyCovered = ({
    amount,
    matchedAmount,
  }: {
    readonly amount: string
    readonly matchedAmount: string | undefined
  }) =>
    compareDecimalQuantities({
      left: amount,
      right: matchedAmount ?? "0",
      errorFactory: fixedPointErrorFactory,
    }).pipe(Effect.map((comparison) => comparison === 0))

  const hasUnmatchedFifoEffects = ({
    tx,
    transactionId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly transactionId: string
  }) =>
    Effect.gen(function* () {
      const disposalCoverage = yield* loadDisposalFifoCoverage({ tx, transactionId })
      const matchedDisposalResults = yield* Effect.forEach(disposalCoverage.disposalLegs, (leg) =>
        isFullyCovered({
          amount: leg.amount,
          matchedAmount: disposalCoverage.matchedAmounts.get(leg.id),
        }).pipe(Effect.map((matched) => ({ leg, matched })))
      )
      if (matchedDisposalResults.some(({ matched }) => !matched)) return true

      const movementCoverage = yield* loadMovementFifoCoverage({ tx, transactionId })
      for (const movement of movementCoverage.movements) {
        if (movement.reconciliationStatus === "matched") continue
        if (
          yield* isFullyCovered({
            amount: movement.amount,
            matchedAmount: movementCoverage.matchedAmounts.get(movement.id),
          })
        ) {
          continue
        }

        if (movement.purpose === "principal" && movement.providerTransferId !== null) {
          const matchingDisposals = yield* Effect.forEach(
            matchedDisposalResults.filter(({ leg }) => leg.assetId === movement.assetId),
            ({ leg }) => isFullyCovered({ amount: leg.amount, matchedAmount: movement.amount })
          )
          if (matchingDisposals.some(Boolean)) continue
        }
        return true
      }

      return false
    })

  const clearResolvedFifoReview = ({
    tx,
    transactionId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly transactionId: string
  }) =>
    Effect.gen(function* () {
      if (yield* hasUnmatchedFifoEffects({ tx, transactionId })) return

      const [review] = yield* tx
        .select({
          reviewStatus: schema.transactionReviews.reviewStatus,
          categorizationReason: schema.transactionReviews.categorizationReason,
          matchedLayer: schema.transactionReviews.matchedLayer,
          userNotes: schema.transactionReviews.userNotes,
        })
        .from(schema.transactionReviews)
        .where(eq(schema.transactionReviews.transactionId, transactionId))
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.clearResolvedFifoReview.loadReview"
          )
        )
      if (review === undefined) return

      const fifoReview = removeFifoInventoryReview(review)

      if (fifoReview === null) {
        yield* tx
          .delete(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, transactionId))
          .pipe(
            wrapSyncEngineSqlError(
              "principalAccountingRebuildRepository.clearResolvedFifoReview.deleteReview"
            )
          )
        return
      }

      yield* tx
        .update(schema.transactionReviews)
        .set({
          categorizationReason: fifoReview.categorizationReason,
          matchedLayer: fifoReview.matchedLayer,
          needsReview: fifoReview.needsReview,
          updatedAt: nowDate(),
        })
        .where(eq(schema.transactionReviews.transactionId, transactionId))
        .pipe(
          wrapSyncEngineSqlError(
            "principalAccountingRebuildRepository.clearResolvedFifoReview.updateReview"
          )
        )
    })

  const loadOpenDisposalLots = ({
    tx,
    principalId,
    sourceIds,
    assetId,
    timestamp,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly sourceIds: ReadonlyArray<string>
    readonly assetId: string
    readonly timestamp: Date
  }): Effect.Effect<ReadonlyArray<OpenFifoLot>, SyncEngineStorageError> =>
    tx
      .select({
        id: schema.fifoLots.id,
        remainingAmount: schema.fifoLots.remainingAmount,
        costBasisPerToken: schema.fifoLots.costBasisPerToken,
      })
      .from(schema.fifoLots)
      .innerJoin(schema.transactionLegs, eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId))
      .where(
        and(
          eq(schema.fifoLots.principalId, principalId),
          inArray(schema.fifoLots.sourceId, sourceIds),
          eq(schema.fifoLots.assetId, assetId),
          sql`${schema.fifoLots.sourceLegId} is not null`,
          gt(schema.fifoLots.remainingAmount, "0"),
          lte(schema.fifoLots.acquiredAt, timestamp),
          lte(schema.transactionLegs.timestamp, timestamp)
        )
      )
      .orderBy(
        asc(schema.fifoLots.acquiredAt),
        asc(schema.fifoLots.createdAt),
        asc(schema.fifoLots.id)
      )
      .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadOpenDisposalLots"))

  const loadOpenMovementLots = ({
    tx,
    principalId,
    sourceIds,
    assetId,
    timestamp,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly sourceIds: ReadonlyArray<string>
    readonly assetId: string
    readonly timestamp: Date
  }): Effect.Effect<ReadonlyArray<OpenFifoLot>, SyncEngineStorageError> =>
    tx
      .select({
        id: schema.fifoLots.id,
        remainingAmount: schema.fifoLots.remainingAmount,
        costBasisPerToken: schema.fifoLots.costBasisPerToken,
      })
      .from(schema.fifoLots)
      .where(
        and(
          eq(schema.fifoLots.principalId, principalId),
          inArray(schema.fifoLots.sourceId, sourceIds),
          eq(schema.fifoLots.assetId, assetId),
          gt(schema.fifoLots.remainingAmount, "0"),
          lte(schema.fifoLots.acquiredAt, timestamp)
        )
      )
      .orderBy(
        asc(schema.fifoLots.acquiredAt),
        asc(schema.fifoLots.createdAt),
        asc(schema.fifoLots.id)
      )
      .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadOpenMovementLots"))

  const updateAllocatedLots = ({
    tx,
    allocations,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly allocations: ReadonlyArray<FifoAllocation>
  }) =>
    Effect.forEach(
      allocations,
      (allocation) =>
        tx
          .update(schema.fifoLots)
          .set({ remainingAmount: allocation.remainingAmount, updatedAt: nowDate() })
          .where(eq(schema.fifoLots.id, allocation.fifoLotId))
          .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.updateAllocatedLots")),
      { concurrency: 1, discard: true }
    )

  const createLegLot = ({
    tx,
    leg,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly leg: RebuildLeg
  }) =>
    Effect.gen(function* () {
      const costBasisPerToken = yield* toCostBasisPerToken({
        fiatAmount: leg.fiatAmount,
        quantityAmount: leg.amount,
        errorFactory: fixedPointErrorFactory,
      })
      const [lot] = yield* tx
        .insert(schema.fifoLots)
        .values({
          principalId: leg.principalId,
          sourceId: leg.sourceId,
          assetId: leg.assetId,
          assetRepresentationId: leg.assetRepresentationId,
          acquiredAt: leg.timestamp,
          originalAmount: leg.amount,
          remainingAmount: leg.amount,
          costBasisPerToken,
          costBasisCurrency: leg.fiatCurrency ?? "EUR",
          costBasisStatus:
            leg.fiatAmount === null || leg.fiatCurrency === null ? "pending_review" : "known",
          sourceLegId: leg.id,
          sourceLegSequence: 0,
          createdAt: nowDate(),
          updatedAt: nowDate(),
        })
        .returning({ id: schema.fifoLots.id })
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.createLegLot"))

      if (lot === undefined) {
        return yield* new SyncEngineStorageError({
          operation: "principalAccountingRebuildRepository.createLegLot",
          cause: `Failed to rebuild FIFO lot for leg ${leg.id}`,
        })
      }
    })

  const createProviderLot = ({
    tx,
    movement,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly movement: RebuildMovement
  }) =>
    Effect.gen(function* () {
      if (movement.providerTransferId === null) return false

      yield* tx
        .insert(schema.fifoLots)
        .values({
          principalId: movement.principalId,
          sourceId: movement.sourceId,
          assetId: movement.assetId,
          assetRepresentationId: movement.assetRepresentationId,
          acquiredAt: movement.timestamp,
          originalAmount: movement.amount,
          remainingAmount: movement.amount,
          costBasisPerToken: "0",
          costBasisCurrency: "EUR",
          costBasisStatus: "pending_review",
          sourceProviderTransferId: movement.providerTransferId,
          sourceLegSequence: 0,
          createdAt: nowDate(),
          updatedAt: nowDate(),
        })
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.createProviderLot"))

      return true
    })

  const lockAffectedAccounting = ({
    tx,
    principalId,
    assetIds,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly assetIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const sources = yield* tx
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(eq(schema.sources.principalId, principalId))
        .orderBy(asc(schema.sources.id))
        .for("update")
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.lockPrincipalSources"))

      yield* tx
        .select({ id: schema.fifoLots.id })
        .from(schema.fifoLots)
        .where(
          and(
            eq(schema.fifoLots.principalId, principalId),
            inArray(schema.fifoLots.assetId, assetIds)
          )
        )
        .orderBy(asc(schema.fifoLots.id))
        .for("update")
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.lockAffectedFifoLots"))

      return sources.map(({ id }) => id)
    })

  const restoreDisposalMatches = ({
    tx,
    principalId,
    assetIds,
    rebuildFrom,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly assetIds: ReadonlyArray<string>
    readonly rebuildFrom: Date
  }) =>
    Effect.gen(function* () {
      const matches = yield* tx
        .select({
          id: schema.disposalMatches.id,
          disposalLegId: schema.disposalMatches.disposalLegId,
          fifoLotId: schema.disposalMatches.fifoLotId,
          ownerSourceId: schema.fifoLots.sourceId,
          matchedAmount: schema.disposalMatches.matchedAmount,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
        )
        .innerJoin(schema.fifoLots, eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId))
        .where(
          and(
            eq(schema.transactionLegs.principalId, principalId),
            inArray(schema.transactionLegs.assetId, assetIds),
            gte(schema.transactionLegs.timestamp, rebuildFrom)
          )
        )
        .orderBy(asc(schema.disposalMatches.id))
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadDisposalMatches"))

      const ownerSourceIds = new Map<string, Set<string>>()
      for (const match of matches) {
        appendOwnerSource({
          ownerSourceIdsByRecordId: ownerSourceIds,
          recordId: match.disposalLegId,
          ownerSourceId: match.ownerSourceId,
        })
        yield* tx
          .update(schema.fifoLots)
          .set({
            remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${match.matchedAmount}`,
            updatedAt: nowDate(),
          })
          .where(eq(schema.fifoLots.id, match.fifoLotId))
          .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.restoreDisposalLot"))
      }

      if (matches.length > 0) {
        yield* tx
          .delete(schema.disposalMatches)
          .where(
            inArray(
              schema.disposalMatches.id,
              matches.map(({ id }) => id)
            )
          )
          .pipe(
            wrapSyncEngineSqlError("principalAccountingRebuildRepository.deleteDisposalMatches")
          )
      }

      return ownerSourceIds
    })

  const restoreInventoryAllocations = ({
    tx,
    principalId,
    assetIds,
    rebuildFrom,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly assetIds: ReadonlyArray<string>
    readonly rebuildFrom: Date
  }) =>
    Effect.gen(function* () {
      const allocations = yield* tx
        .select({
          id: schema.inventoryMovementAllocations.id,
          movementId: schema.inventoryMovementAllocations.inventoryMovementId,
          fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
          ownerSourceId: schema.fifoLots.sourceId,
          matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
        })
        .from(schema.inventoryMovementAllocations)
        .innerJoin(
          schema.inventoryMovements,
          eq(schema.inventoryMovements.id, schema.inventoryMovementAllocations.inventoryMovementId)
        )
        .innerJoin(
          schema.fifoLots,
          eq(schema.fifoLots.id, schema.inventoryMovementAllocations.fifoLotId)
        )
        .where(
          and(
            eq(schema.inventoryMovements.principalId, principalId),
            inArray(schema.inventoryMovements.assetId, assetIds),
            gte(schema.inventoryMovements.timestamp, rebuildFrom)
          )
        )
        .orderBy(asc(schema.inventoryMovementAllocations.id))
        .pipe(
          wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadInventoryAllocations")
        )

      const ownerSourceIds = new Map<string, Set<string>>()
      for (const allocation of allocations) {
        appendOwnerSource({
          ownerSourceIdsByRecordId: ownerSourceIds,
          recordId: allocation.movementId,
          ownerSourceId: allocation.ownerSourceId,
        })
        yield* tx
          .update(schema.fifoLots)
          .set({
            remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
            updatedAt: nowDate(),
          })
          .where(eq(schema.fifoLots.id, allocation.fifoLotId))
          .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.restoreInventoryLot"))
      }

      if (allocations.length > 0) {
        yield* tx
          .delete(schema.inventoryMovementAllocations)
          .where(
            inArray(
              schema.inventoryMovementAllocations.id,
              allocations.map(({ id }) => id)
            )
          )
          .pipe(
            wrapSyncEngineSqlError(
              "principalAccountingRebuildRepository.deleteInventoryAllocations"
            )
          )
      }

      return ownerSourceIds
    })

  const deletePostBoundaryLots = ({
    tx,
    principalId,
    assetIds,
    rebuildFrom,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly assetIds: ReadonlyArray<string>
    readonly rebuildFrom: Date
  }) =>
    Effect.gen(function* () {
      const lots = yield* tx
        .select({ id: schema.fifoLots.id })
        .from(schema.fifoLots)
        .leftJoin(
          schema.transactionLegs,
          eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
        )
        .where(
          and(
            eq(schema.fifoLots.principalId, principalId),
            inArray(schema.fifoLots.assetId, assetIds),
            gte(schema.fifoLots.acquiredAt, rebuildFrom),
            sql`${schema.transactionLegs.derivationRule} is distinct from 'internal_transfer_in'`
          )
        )
        .orderBy(asc(schema.fifoLots.id))
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadPostBoundaryLots"))

      if (lots.length === 0) return
      const lotIds = lots.map(({ id }) => id)
      const [usage] = yield* tx
        .select({
          disposalCount: sql<number>`count(distinct ${schema.disposalMatches.id})::integer`,
          movementCount: sql<number>`count(distinct ${schema.inventoryMovementAllocations.id})::integer`,
        })
        .from(schema.fifoLots)
        .leftJoin(schema.disposalMatches, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
        .leftJoin(
          schema.inventoryMovementAllocations,
          eq(schema.inventoryMovementAllocations.fifoLotId, schema.fifoLots.id)
        )
        .where(inArray(schema.fifoLots.id, lotIds))
        .pipe(
          wrapSyncEngineSqlError("principalAccountingRebuildRepository.checkPostBoundaryLotUsage")
        )

      if (usage !== undefined && (usage.disposalCount > 0 || usage.movementCount > 0)) {
        return yield* new SyncEngineStorageError({
          operation: "principalAccountingRebuildRepository.checkPostBoundaryLotUsage",
          cause:
            "Affected asset list does not cover every downstream use of a post-boundary FIFO lot",
        })
      }

      yield* tx
        .delete(schema.fifoLots)
        .where(inArray(schema.fifoLots.id, lotIds))
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.deletePostBoundaryLots"))
    })

  const loadRebuildEvents = ({
    tx,
    principalId,
    assetIds,
    rebuildFrom,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly assetIds: ReadonlyArray<string>
    readonly rebuildFrom: Date
  }): Effect.Effect<RebuildEventSet, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const legs = yield* tx
        .select({
          id: schema.transactionLegs.id,
          sourceId: schema.transactionLegs.sourceId,
          transactionId: schema.transactionLegs.transactionId,
          timestamp: schema.transactionLegs.timestamp,
          principalId: schema.transactionLegs.principalId,
          assetId: schema.transactionLegs.assetId,
          assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
        })
        .from(schema.transactionLegs)
        .where(
          and(
            eq(schema.transactionLegs.principalId, principalId),
            inArray(schema.transactionLegs.assetId, assetIds),
            gte(schema.transactionLegs.timestamp, rebuildFrom)
          )
        )
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadAffectedLegs"))
      const movements = yield* tx
        .select({
          id: schema.inventoryMovements.id,
          sourceId: schema.inventoryMovements.sourceId,
          transactionId: schema.inventoryMovements.transactionId,
          providerTransferId: schema.inventoryMovements.providerTransferId,
          transactionLegId: schema.inventoryMovements.transactionLegId,
          timestamp: schema.inventoryMovements.timestamp,
          principalId: schema.inventoryMovements.principalId,
          assetId: schema.inventoryMovements.assetId,
          assetRepresentationId: schema.inventoryMovements.assetRepresentationId,
          amount: schema.inventoryMovements.amount,
          direction: schema.inventoryMovements.direction,
          purpose: schema.inventoryMovements.purpose,
        })
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.principalId, principalId),
            inArray(schema.inventoryMovements.assetId, assetIds),
            gte(schema.inventoryMovements.timestamp, rebuildFrom)
          )
        )
        .orderBy(asc(schema.inventoryMovements.timestamp), asc(schema.inventoryMovements.id))
        .pipe(wrapSyncEngineSqlError("principalAccountingRebuildRepository.loadAffectedMovements"))

      const transactionLegs = new Map<string, Array<RebuildLeg>>()
      for (const leg of legs) {
        if (leg.transactionId === null) continue
        const stored = transactionLegs.get(leg.transactionId) ?? []
        stored.push(leg)
        transactionLegs.set(leg.transactionId, stored)
      }
      const events: Array<RebuildEvent> = [
        ...legs.map((leg) => ({
          type: "leg" as const,
          id: leg.id,
          timestamp: leg.timestamp,
          priority: leg.kind === "acquisition" || leg.kind === "income" ? 0 : 1,
          leg,
        })),
        ...movements.map((movement) => ({
          type: "movement" as const,
          id: movement.id,
          timestamp: movement.timestamp,
          priority: movement.direction === "inbound" ? 2 : 3,
          movement,
        })),
      ]
      events.sort(
        (left, right) =>
          left.timestamp.getTime() - right.timestamp.getTime() ||
          left.priority - right.priority ||
          left.id.localeCompare(right.id)
      )

      return { events, transactionLegs }
    })

  const rebuildLeg = ({
    tx,
    principalId,
    leg,
    ownerSourceIdsByLegId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly leg: RebuildLeg
    readonly ownerSourceIdsByLegId: OwnerSourceIdsByRecordId
  }): Effect.Effect<RebuildEventResult, SyncEngineStorageError> =>
    Effect.gen(function* () {
      if (leg.derivationRule === "internal_transfer_in") {
        return {
          sourceIds: [leg.sourceId],
          fifoLotsRebuilt: 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }
      if (leg.kind === "acquisition" || leg.kind === "income") {
        yield* createLegLot({ tx, leg })
        return {
          sourceIds: [leg.sourceId],
          fifoLotsRebuilt: 1,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }
      if (leg.kind !== "disposal") {
        return {
          sourceIds: [leg.sourceId],
          fifoLotsRebuilt: 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }

      const ownerSourceIds = [
        ...(ownerSourceIdsByLegId.get(leg.id) ?? new Set([leg.sourceId])),
      ].sort()
      const lots = yield* loadOpenDisposalLots({
        tx,
        principalId,
        sourceIds: ownerSourceIds,
        assetId: leg.assetId,
        timestamp: leg.timestamp,
      })
      const allocations = yield* buildRebuildFifoAllocations({
        tx,
        principalId,
        transactionId: leg.transactionId,
        lots,
        amount: leg.amount,
        fiatAmount: leg.fiatAmount,
        operation: "principalAccountingRebuildRepository.matchDisposal",
      })
      if (allocations === null) {
        return {
          sourceIds: ownerSourceIds,
          fifoLotsRebuilt: 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }
      yield* Effect.forEach(
        allocations,
        (allocation) =>
          tx
            .insert(schema.disposalMatches)
            .values({
              disposalLegId: leg.id,
              fifoLotId: allocation.fifoLotId,
              matchedAmount: allocation.matchedAmount,
              costBasis: allocation.costBasis,
              proceeds: allocation.proceeds,
              gainLoss: allocation.gainLoss,
              createdAt: nowDate(),
            })
            .pipe(
              wrapSyncEngineSqlError("principalAccountingRebuildRepository.insertDisposalMatch")
            ),
        { concurrency: 1, discard: true }
      )
      yield* updateAllocatedLots({ tx, allocations })
      if (leg.transactionId !== null) {
        yield* clearResolvedFifoReview({ tx, transactionId: leg.transactionId })
      }

      return {
        sourceIds: ownerSourceIds,
        fifoLotsRebuilt: 0,
        disposalMatchesRebuilt: allocations.length,
        inventoryAllocationsRebuilt: 0,
      }
    })

  const rebuildMovement = ({
    tx,
    principalId,
    movement,
    transactionLegs,
    ownerSourceIdsByMovementId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly movement: RebuildMovement
    readonly transactionLegs: ReadonlyMap<string, ReadonlyArray<RebuildLeg>>
    readonly ownerSourceIdsByMovementId: OwnerSourceIdsByRecordId
  }): Effect.Effect<RebuildEventResult, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const matchingLegKind = movement.purpose === "fee" ? "fee" : "disposal"
      const hasMatchingLeg = (transactionLegs.get(movement.transactionId) ?? []).some(
        (leg) =>
          leg.assetId === movement.assetId &&
          leg.amount === movement.amount &&
          (movement.direction === "inbound"
            ? leg.kind === "acquisition" || leg.kind === "income"
            : leg.kind === matchingLegKind)
      )
      if (movement.direction === "inbound") {
        const lotCreated = !hasMatchingLeg && (yield* createProviderLot({ tx, movement }))
        return {
          sourceIds: [movement.sourceId],
          fifoLotsRebuilt: lotCreated ? 1 : 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }
      if (movement.providerTransferId !== null && hasMatchingLeg) {
        return {
          sourceIds: [movement.sourceId],
          fifoLotsRebuilt: 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }

      const ownerSourceIds = [
        ...(ownerSourceIdsByMovementId.get(movement.id) ?? new Set([movement.sourceId])),
      ].sort()
      const lots = yield* loadOpenMovementLots({
        tx,
        principalId,
        sourceIds: ownerSourceIds,
        assetId: movement.assetId,
        timestamp: movement.timestamp,
      })
      const allocations = yield* buildRebuildFifoAllocations({
        tx,
        principalId,
        transactionId: movement.transactionId,
        lots,
        amount: movement.amount,
        fiatAmount: null,
        operation: "principalAccountingRebuildRepository.allocateInventoryMovement",
      })
      if (allocations === null) {
        return {
          sourceIds: ownerSourceIds,
          fifoLotsRebuilt: 0,
          disposalMatchesRebuilt: 0,
          inventoryAllocationsRebuilt: 0,
        }
      }
      yield* Effect.forEach(
        allocations,
        (allocation) =>
          tx
            .insert(schema.inventoryMovementAllocations)
            .values({
              inventoryMovementId: movement.id,
              fifoLotId: allocation.fifoLotId,
              matchedAmount: allocation.matchedAmount,
              createdAt: nowDate(),
            })
            .pipe(
              wrapSyncEngineSqlError(
                "principalAccountingRebuildRepository.insertInventoryAllocation"
              )
            ),
        { concurrency: 1, discard: true }
      )
      yield* updateAllocatedLots({ tx, allocations })
      yield* clearResolvedFifoReview({ tx, transactionId: movement.transactionId })

      return {
        sourceIds: ownerSourceIds,
        fifoLotsRebuilt: 0,
        disposalMatchesRebuilt: 0,
        inventoryAllocationsRebuilt: allocations.length,
      }
    })

  const rebuildEvents = ({
    tx,
    principalId,
    eventSet,
    disposalOwnerSourceIds,
    movementOwnerSourceIds,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
    readonly eventSet: RebuildEventSet
    readonly disposalOwnerSourceIds: OwnerSourceIdsByRecordId
    readonly movementOwnerSourceIds: OwnerSourceIdsByRecordId
  }) =>
    Effect.gen(function* () {
      const rebuiltSourceIds = new Set<string>()
      let fifoLotsRebuilt = 0
      let disposalMatchesRebuilt = 0
      let inventoryAllocationsRebuilt = 0

      for (const event of eventSet.events) {
        const result =
          event.type === "leg"
            ? yield* rebuildLeg({
                tx,
                principalId,
                leg: event.leg,
                ownerSourceIdsByLegId: disposalOwnerSourceIds,
              })
            : yield* rebuildMovement({
                tx,
                principalId,
                movement: event.movement,
                transactionLegs: eventSet.transactionLegs,
                ownerSourceIdsByMovementId: movementOwnerSourceIds,
              })
        for (const sourceId of result.sourceIds) rebuiltSourceIds.add(sourceId)
        fifoLotsRebuilt += result.fifoLotsRebuilt
        disposalMatchesRebuilt += result.disposalMatchesRebuilt
        inventoryAllocationsRebuilt += result.inventoryAllocationsRebuilt
      }

      return {
        rebuiltSourceIds: [...rebuiltSourceIds].sort(),
        fifoLotsRebuilt,
        disposalMatchesRebuilt,
        inventoryAllocationsRebuilt,
      }
    })

  const rebuildPrincipalAccounting: PrincipalAccountingRebuildRepositoryShape["rebuildPrincipalAccounting"] =
    ({ principalId, affectedAssetIds, rebuildFrom }) => {
      const uniqueAssetIds = [...new Set(affectedAssetIds)].sort()
      const emptyResult = {
        principalId,
        affectedAssetIds: uniqueAssetIds,
        rebuildFrom,
        rebuiltSourceIds: [],
        fifoLotsRebuilt: 0,
        disposalMatchesRebuilt: 0,
        inventoryAllocationsRebuilt: 0,
      } as const
      if (uniqueAssetIds.length === 0) return Effect.succeed(emptyResult)

      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            const sourceIds = yield* lockAffectedAccounting({
              tx,
              principalId,
              assetIds: uniqueAssetIds,
            })
            if (sourceIds.length === 0) return emptyResult

            const disposalOwnerSourceIds = yield* restoreDisposalMatches({
              tx,
              principalId,
              assetIds: uniqueAssetIds,
              rebuildFrom,
            })
            const movementOwnerSourceIds = yield* restoreInventoryAllocations({
              tx,
              principalId,
              assetIds: uniqueAssetIds,
              rebuildFrom,
            })
            yield* deletePostBoundaryLots({
              tx,
              principalId,
              assetIds: uniqueAssetIds,
              rebuildFrom,
            })
            const eventSet = yield* loadRebuildEvents({
              tx,
              principalId,
              assetIds: uniqueAssetIds,
              rebuildFrom,
            })
            const result = yield* rebuildEvents({
              tx,
              principalId,
              eventSet,
              disposalOwnerSourceIds,
              movementOwnerSourceIds,
            })

            return { principalId, affectedAssetIds: uniqueAssetIds, rebuildFrom, ...result }
          })
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof SyncEngineStorageError
              ? error
              : toSyncEngineStorageError({
                  operation: "principalAccountingRebuildRepository.transaction",
                  error,
                })
          )
        )
    }

  return PrincipalAccountingRebuildRepository.of({ rebuildPrincipalAccounting })
})

/** Live principal accounting rebuild persistence layer. */
export const PrincipalAccountingRebuildRepositoryLive = Layer.effect(
  PrincipalAccountingRebuildRepository,
  make
)
