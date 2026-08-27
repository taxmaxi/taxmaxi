/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  SourceReplayDependencyCycleError,
  SourceReplayDependencyError,
  SourceReplayPlanConflictError,
  SourceReplayPlanJobNotFoundError,
  SourceReplayPlanRepository,
  SourceReplaySchedulingPendingError,
  type SourceReplayPlanRepositoryShape,
  SourceReplayRepository,
  type SourceReplayRepositoryShape,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  type SyncEngineDbTransaction,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

class ReplayDependencySetChanged extends Schema.TaggedError<ReplayDependencySetChanged>()(
  "ReplayDependencySetChanged",
  {}
) {}

interface CrossSourceReplayDependency {
  readonly ownerSourceId: string
  readonly dependentSourceId: string
  readonly affectedPrincipalId: string
  readonly ownerAcquiredAt: Date
  readonly dependentTimestamp: Date
}

interface ReplayClosurePlan {
  readonly dependentBoundaries: ReadonlyMap<string, Date>
  readonly dependentSourceIds: ReadonlyArray<string>
  readonly inventorySourceIds: ReadonlyArray<string>
  readonly prerequisiteSourceIds: ReadonlyMap<string, ReadonlySet<string>>
}

const planReplayClosure = ({
  sourceId,
  principalId,
  dependencies,
}: {
  readonly sourceId: string
  readonly principalId: string
  readonly dependencies: ReadonlyArray<CrossSourceReplayDependency>
}): Effect.Effect<
  ReplayClosurePlan,
  SourceReplayDependencyCycleError | SourceReplayDependencyError
> =>
  Effect.gen(function* () {
    const outgoingDependencies = new Map<string, Array<CrossSourceReplayDependency>>()
    for (const dependency of dependencies) {
      const outgoing = outgoingDependencies.get(dependency.ownerSourceId) ?? []
      outgoing.push(dependency)
      outgoingDependencies.set(dependency.ownerSourceId, outgoing)
    }

    const reachableSourceIds = new Set([sourceId])
    const pendingSourceIds = [sourceId]
    while (pendingSourceIds.length > 0) {
      const ownerSourceId = pendingSourceIds.shift()
      if (ownerSourceId === undefined) continue

      for (const dependency of outgoingDependencies.get(ownerSourceId) ?? []) {
        if (reachableSourceIds.has(dependency.dependentSourceId)) continue
        reachableSourceIds.add(dependency.dependentSourceId)
        pendingSourceIds.push(dependency.dependentSourceId)
      }
    }

    const replayDependencies = dependencies.filter(
      ({ ownerSourceId, dependentSourceId }) =>
        reachableSourceIds.has(ownerSourceId) && reachableSourceIds.has(dependentSourceId)
    )
    const crossPrincipalDependencies = replayDependencies.filter(
      ({ affectedPrincipalId }) => affectedPrincipalId !== principalId
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

    const dependentBoundaries = new Map<string, Date>()
    const prerequisiteSourceIds = new Map<string, Set<string>>()
    const incomingDependencyCounts = new Map<string, number>()
    for (const reachableSourceId of reachableSourceIds) {
      incomingDependencyCounts.set(reachableSourceId, 0)
    }
    for (const dependency of replayDependencies) {
      const rebuildFrom =
        dependency.ownerAcquiredAt.getTime() <= dependency.dependentTimestamp.getTime()
          ? dependency.ownerAcquiredAt
          : dependency.dependentTimestamp
      const currentBoundary = dependentBoundaries.get(dependency.dependentSourceId)
      if (currentBoundary === undefined || rebuildFrom.getTime() < currentBoundary.getTime()) {
        dependentBoundaries.set(dependency.dependentSourceId, rebuildFrom)
      }

      const prerequisites =
        prerequisiteSourceIds.get(dependency.dependentSourceId) ?? new Set<string>()
      if (!prerequisites.has(dependency.ownerSourceId)) {
        prerequisites.add(dependency.ownerSourceId)
        prerequisiteSourceIds.set(dependency.dependentSourceId, prerequisites)
        incomingDependencyCounts.set(
          dependency.dependentSourceId,
          (incomingDependencyCounts.get(dependency.dependentSourceId) ?? 0) + 1
        )
      }
    }

    const readySourceIds = [...reachableSourceIds]
      .filter((reachableSourceId) => incomingDependencyCounts.get(reachableSourceId) === 0)
      .sort()
    const replayOrder: Array<string> = []
    while (readySourceIds.length > 0) {
      const readySourceId = readySourceIds.shift()
      if (readySourceId === undefined) continue
      replayOrder.push(readySourceId)

      const consumers = [
        ...new Set(
          (outgoingDependencies.get(readySourceId) ?? [])
            .map(({ dependentSourceId }) => dependentSourceId)
            .filter((dependentSourceId) => reachableSourceIds.has(dependentSourceId))
        ),
      ].sort()
      for (const consumerSourceId of consumers) {
        const remainingDependencies = (incomingDependencyCounts.get(consumerSourceId) ?? 0) - 1
        incomingDependencyCounts.set(consumerSourceId, remainingDependencies)
        if (remainingDependencies === 0) {
          readySourceIds.push(consumerSourceId)
          readySourceIds.sort()
        }
      }
    }

    if (replayOrder.length !== reachableSourceIds.size || replayOrder[0] !== sourceId) {
      return yield* new SourceReplayDependencyCycleError({ sourceId })
    }

    const dependentSourceIds = replayOrder.slice(1)
    const ownerSourceIds = dependencies
      .filter(({ dependentSourceId }) => reachableSourceIds.has(dependentSourceId))
      .map(({ ownerSourceId }) => ownerSourceId)

    return {
      dependentBoundaries,
      dependentSourceIds,
      inventorySourceIds: [...new Set([sourceId, ...dependentSourceIds, ...ownerSourceIds])].sort(),
      prerequisiteSourceIds,
    }
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const loadCrossSourceDependencies = ({
    tx,
    principalId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly principalId: string
  }): Effect.Effect<
    ReadonlyArray<CrossSourceReplayDependency>,
    ReturnType<typeof toSyncEngineStorageError>
  > =>
    Effect.gen(function* () {
      const allocations = yield* tx
        .select({
          ownerSourceId: schema.fifoLots.sourceId,
          dependentSourceId: schema.inventoryMovements.sourceId,
          affectedPrincipalId: schema.sources.principalId,
          ownerAcquiredAt: schema.fifoLots.acquiredAt,
          dependentTimestamp: schema.inventoryMovements.timestamp,
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
        .innerJoin(schema.sources, eq(schema.sources.id, schema.inventoryMovements.sourceId))
        .where(
          and(
            eq(schema.fifoLots.principalId, principalId),
            ne(schema.inventoryMovements.sourceId, schema.fifoLots.sourceId)
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.selectCrossSourceAllocation"
          )
        )

      const disposalMatches = yield* tx
        .select({
          ownerSourceId: schema.fifoLots.sourceId,
          dependentSourceId: schema.transactionLegs.sourceId,
          affectedPrincipalId: schema.sources.principalId,
          ownerAcquiredAt: schema.fifoLots.acquiredAt,
          dependentTimestamp: schema.transactionLegs.timestamp,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
        )
        .innerJoin(schema.fifoLots, eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId))
        .innerJoin(schema.sources, eq(schema.sources.id, schema.transactionLegs.sourceId))
        .where(
          and(
            eq(schema.fifoLots.principalId, principalId),
            ne(schema.transactionLegs.sourceId, schema.fifoLots.sourceId)
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.selectCrossSourceDisposalMatch"
          )
        )

      return [...allocations, ...disposalMatches]
    })

  const dependencyFingerprint = ({
    dependencies,
    inventorySourceIds,
  }: {
    readonly dependencies: ReadonlyArray<CrossSourceReplayDependency>
    readonly inventorySourceIds: ReadonlyArray<string>
  }): ReadonlyArray<string> => {
    const inventorySourceIdSet = new Set(inventorySourceIds)
    return dependencies
      .filter(
        ({ ownerSourceId, dependentSourceId }) =>
          inventorySourceIdSet.has(ownerSourceId) || inventorySourceIdSet.has(dependentSourceId)
      )
      .map(
        ({
          ownerSourceId,
          dependentSourceId,
          affectedPrincipalId,
          ownerAcquiredAt,
          dependentTimestamp,
        }) =>
          [
            ownerSourceId,
            dependentSourceId,
            affectedPrincipalId,
            ownerAcquiredAt.toISOString(),
            dependentTimestamp.toISOString(),
          ].join(":")
      )
      .sort()
  }

  const lockReplayInventory = ({
    tx,
    sourceId,
    principalId,
    dependentSourceIds,
    inventorySourceIds,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly sourceId: string
    readonly principalId: string
    readonly dependentSourceIds: ReadonlyArray<string>
    readonly inventorySourceIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const lockedSources = yield* tx
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.principalId, principalId),
            inArray(schema.sources.id, inventorySourceIds)
          )
        )
        .orderBy(asc(schema.sources.id))
        .for("update")
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.lockSourceInventory"
          )
        )

      if (lockedSources.length !== inventorySourceIds.length) {
        return yield* new SourceReplayDependencyError({
          sourceId,
          dependentSourceIds: [...dependentSourceIds],
          affectedPrincipalIds: [principalId],
        })
      }

      yield* tx
        .select({ id: schema.fifoLots.id })
        .from(schema.fifoLots)
        .where(inArray(schema.fifoLots.sourceId, inventorySourceIds))
        .orderBy(asc(schema.fifoLots.id))
        .for("update")
        .pipe(wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.lockFifoLots"))
    })

  const createOrLoadPendingReplayJob = ({
    tx,
    sourceId,
    dependentSourceId,
    principalId,
    rebuildFrom,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly sourceId: string
    readonly dependentSourceId: string
    readonly principalId: string
    readonly rebuildFrom: Date
  }) =>
    Effect.gen(function* () {
      const [createdJob] = yield* tx
        .insert(schema.processingJobs)
        .values({
          sourceId: dependentSourceId,
          principalId,
          mode: "replay",
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
          progressDetails: { mode: "replay", reason: "fifo_dependency" },
          rebuildFrom,
        })
        .onConflictDoNothing()
        .returning({ id: schema.processingJobs.id })
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.createDependentReplay"
          )
        )

      const dependentJobId =
        createdJob?.id ??
        (yield* tx
          .select({ id: schema.processingJobs.id })
          .from(schema.processingJobs)
          .where(
            and(
              eq(schema.processingJobs.sourceId, dependentSourceId),
              eq(schema.processingJobs.principalId, principalId),
              eq(schema.processingJobs.mode, "replay"),
              eq(schema.processingJobs.status, "pending")
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "sourceReplayRepository.resetSourceDerivedState.loadDependentReplay"
            ),
            Effect.map(([activeJob]) => activeJob?.id)
          ))

      if (dependentJobId === undefined) {
        return yield* new SourceReplaySchedulingPendingError({ sourceId, dependentSourceId })
      }

      const [updatedJob] = yield* tx
        .update(schema.processingJobs)
        .set({
          rebuildFrom: sql<Date>`least(
            coalesce(${schema.processingJobs.rebuildFrom}, ${rebuildFrom}),
            ${rebuildFrom}
          )`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(schema.processingJobs.id, dependentJobId),
            eq(schema.processingJobs.status, "pending")
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.updateDependentReplay"
          )
        )

      if (updatedJob === undefined) {
        return yield* new SourceReplaySchedulingPendingError({ sourceId, dependentSourceId })
      }

      return dependentJobId
    })

  const recordReplayPrerequisites = ({
    tx,
    dependentJobId,
    dependentSourceId,
    jobIdBySourceId,
    prerequisiteSourceIds,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly dependentJobId: string
    readonly dependentSourceId: string
    readonly jobIdBySourceId: ReadonlyMap<string, string>
    readonly prerequisiteSourceIds: ReadonlyMap<string, ReadonlySet<string>>
  }) =>
    Effect.gen(function* () {
      const prerequisiteJobIds = [...(prerequisiteSourceIds.get(dependentSourceId) ?? [])]
        .map((prerequisiteSourceId) => jobIdBySourceId.get(prerequisiteSourceId))
        .filter((prerequisiteJobId): prerequisiteJobId is string => prerequisiteJobId !== undefined)
        .sort()

      if (prerequisiteJobIds.length === 0) {
        return yield* toSyncEngineStorageError({
          error: { dependentSourceId, reason: "Missing prerequisite replay jobs." },
          operation: "sourceReplayRepository.resetSourceDerivedState.planDependentReplay",
        })
      }

      yield* tx
        .insert(schema.processingJobDependencies)
        .values(
          prerequisiteJobIds.map((prerequisiteJobId) => ({
            jobId: dependentJobId,
            prerequisiteJobId,
          }))
        )
        .onConflictDoNothing()
        .pipe(
          wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.recordDependency")
        )

      return prerequisiteJobIds
    })

  const scheduleDependentReplays = ({
    tx,
    jobId,
    sourceId,
    principalId,
    dependentBoundaries,
    dependentSourceIds,
    prerequisiteSourceIds,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly jobId: string
    readonly sourceId: string
    readonly principalId: string
    readonly dependentBoundaries: ReadonlyMap<string, Date>
    readonly dependentSourceIds: ReadonlyArray<string>
    readonly prerequisiteSourceIds: ReadonlyMap<string, ReadonlySet<string>>
  }) => {
    const jobIdBySourceId = new Map([[sourceId, jobId]])

    return Effect.forEach(
      dependentSourceIds,
      (dependentSourceId) =>
        Effect.gen(function* () {
          const rebuildFrom = dependentBoundaries.get(dependentSourceId)
          if (rebuildFrom === undefined) {
            return yield* toSyncEngineStorageError({
              error: { dependentSourceId, reason: "Missing replay rebuild boundary." },
              operation: "sourceReplayRepository.resetSourceDerivedState.planDependentReplay",
            })
          }

          const dependentJobId = yield* createOrLoadPendingReplayJob({
            tx,
            sourceId,
            dependentSourceId,
            principalId,
            rebuildFrom,
          })
          const prerequisiteJobIds = yield* recordReplayPrerequisites({
            tx,
            dependentJobId,
            dependentSourceId,
            jobIdBySourceId,
            prerequisiteSourceIds,
          })

          jobIdBySourceId.set(dependentSourceId, dependentJobId)

          return {
            jobId: dependentJobId,
            sourceId: dependentSourceId,
            prerequisiteJobIds,
            rebuildFrom,
          }
        }),
      { concurrency: 1 }
    )
  }

  const restoreInventoryAndClearSource = ({
    tx,
    sourceId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly sourceId: string
  }) =>
    Effect.gen(function* () {
      const inventoryMovementAllocations = yield* tx
        .select({
          fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
          matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
        })
        .from(schema.inventoryMovementAllocations)
        .innerJoin(
          schema.inventoryMovements,
          eq(schema.inventoryMovements.id, schema.inventoryMovementAllocations.inventoryMovementId)
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
        .pipe(wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.deleteLegs"))

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
          wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.deleteTransfers")
        )

      yield* tx
        .update(schema.sourceRecordsRaw)
        .set({ normalizedAt: null, normalizationError: null, updatedAt: nowDate() })
        .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
        .pipe(wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.resetRawRows"))
    })

  const resetSourceDerivedState: SourceReplayRepositoryShape["resetSourceDerivedState"] = ({
    jobId,
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
            return { dependentReplays: [] }
          }

          const crossSourceDependencies = yield* loadCrossSourceDependencies({
            tx,
            principalId: source.principalId,
          })
          const replayPlan = yield* planReplayClosure({
            sourceId,
            principalId: source.principalId,
            dependencies: crossSourceDependencies,
          })
          const {
            dependentBoundaries,
            dependentSourceIds,
            inventorySourceIds,
            prerequisiteSourceIds,
          } = replayPlan

          yield* lockReplayInventory({
            tx,
            sourceId,
            principalId: source.principalId,
            dependentSourceIds,
            inventorySourceIds,
          })

          const dependenciesAfterLock = yield* loadCrossSourceDependencies({
            tx,
            principalId: source.principalId,
          })
          const beforeLockFingerprint = dependencyFingerprint({
            dependencies: crossSourceDependencies,
            inventorySourceIds,
          })
          const afterLockFingerprint = dependencyFingerprint({
            dependencies: dependenciesAfterLock,
            inventorySourceIds,
          })
          if (
            beforeLockFingerprint.length !== afterLockFingerprint.length ||
            beforeLockFingerprint.some(
              (dependency, index) => dependency !== afterLockFingerprint[index]
            )
          ) {
            return yield* new ReplayDependencySetChanged()
          }

          const dependentReplays = yield* scheduleDependentReplays({
            tx,
            jobId,
            sourceId,
            principalId: source.principalId,
            dependentBoundaries,
            dependentSourceIds,
            prerequisiteSourceIds,
          })

          yield* restoreInventoryAndClearSource({ tx, sourceId })

          return { dependentReplays }
        })
      )
      .pipe(
        Effect.retry({
          times: 2,
          while: (error) => error instanceof ReplayDependencySetChanged,
        }),
        Effect.mapError((error) =>
          error instanceof SourceReplayDependencyCycleError ||
          error instanceof SourceReplayDependencyError ||
          error instanceof SourceReplaySchedulingPendingError
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

const SourceReplayResetRepositoryLive = Layer.effect(SourceReplayRepository, make)

const makeReplayPlanRepository = Effect.gen(function* () {
  const db = yield* drizzle

  const recordReplayPlan: SourceReplayPlanRepositoryShape["recordReplayPlan"] = ({
    jobId,
    prerequisiteJobIds,
    rebuildFrom,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const uniquePrerequisiteJobIds = [...new Set(prerequisiteJobIds)].sort()
          if (uniquePrerequisiteJobIds.includes(jobId)) {
            return yield* new SourceReplayPlanConflictError({
              jobId,
              reason: "A replay job cannot depend on itself.",
            })
          }

          if (uniquePrerequisiteJobIds.length > 0) {
            const prerequisiteJobs = yield* tx
              .select({ id: schema.processingJobs.id })
              .from(schema.processingJobs)
              .where(inArray(schema.processingJobs.id, uniquePrerequisiteJobIds))
              .orderBy(asc(schema.processingJobs.id))
              .for("key share")
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceReplayPlanRepository.recordReplayPlan.lockPrerequisites"
                )
              )
            const foundPrerequisiteJobIds = new Set(prerequisiteJobs.map(({ id }) => id))
            const missingPrerequisiteJobId = uniquePrerequisiteJobIds.find(
              (prerequisiteJobId) => !foundPrerequisiteJobIds.has(prerequisiteJobId)
            )

            if (missingPrerequisiteJobId !== undefined) {
              return yield* new SourceReplayPlanJobNotFoundError({
                jobId: missingPrerequisiteJobId,
              })
            }
          }

          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              rebuildFrom: sql<Date>`least(
                coalesce(${schema.processingJobs.rebuildFrom}, ${rebuildFrom}),
                ${rebuildFrom}
              )`,
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.mode, "replay"),
                eq(schema.processingJobs.status, "pending")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              rebuildFrom: schema.processingJobs.rebuildFrom,
            })
            .pipe(wrapSyncEngineSqlError("sourceReplayPlanRepository.recordReplayPlan.update"))

          if (job === undefined) {
            const [existingJob] = yield* tx
              .select({
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.id, jobId))
              .limit(1)
              .pipe(wrapSyncEngineSqlError("sourceReplayPlanRepository.recordReplayPlan.select"))

            if (existingJob === undefined) {
              return yield* new SourceReplayPlanJobNotFoundError({ jobId })
            }

            return yield* new SourceReplayPlanConflictError({
              jobId,
              reason: `Only pending replay jobs accept a replay plan; found ${existingJob.mode} job with ${existingJob.status} status.`,
            })
          }

          if (job.rebuildFrom === null) {
            return yield* toSyncEngineStorageError({
              error: { jobId, reason: "Replay rebuild boundary was not stored." },
              operation: "sourceReplayPlanRepository.recordReplayPlan.update",
            })
          }

          if (uniquePrerequisiteJobIds.length > 0) {
            yield* tx
              .insert(schema.processingJobDependencies)
              .values(
                uniquePrerequisiteJobIds.map((prerequisiteJobId) => ({
                  jobId,
                  prerequisiteJobId,
                }))
              )
              .onConflictDoNothing()
              .pipe(
                wrapSyncEngineSqlError("sourceReplayPlanRepository.recordReplayPlan.dependencies")
              )
          }

          const dependencies = yield* tx
            .select({ prerequisiteJobId: schema.processingJobDependencies.prerequisiteJobId })
            .from(schema.processingJobDependencies)
            .where(eq(schema.processingJobDependencies.jobId, jobId))
            .orderBy(asc(schema.processingJobDependencies.prerequisiteJobId))
            .pipe(wrapSyncEngineSqlError("sourceReplayPlanRepository.recordReplayPlan.load"))

          return {
            jobId: job.id,
            prerequisiteJobIds: dependencies.map(({ prerequisiteJobId }) => prerequisiteJobId),
            rebuildFrom: job.rebuildFrom,
          }
        })
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SourceReplayPlanJobNotFoundError ||
          error instanceof SourceReplayPlanConflictError
            ? error
            : toSyncEngineStorageError({
                error,
                operation: "sourceReplayPlanRepository.recordReplayPlan.transaction",
              })
        )
      )

  return SourceReplayPlanRepository.of({
    recordReplayPlan,
  } satisfies SourceReplayPlanRepositoryShape)
})

const SourceReplayPlanPersistenceLive = Layer.effect(
  SourceReplayPlanRepository,
  makeReplayPlanRepository
)

/** Live persistence for replay resets, prerequisites, and rebuild boundaries. */
export const SourceReplayRepositoryLive = Layer.merge(
  SourceReplayResetRepositoryLive,
  SourceReplayPlanPersistenceLive
)
