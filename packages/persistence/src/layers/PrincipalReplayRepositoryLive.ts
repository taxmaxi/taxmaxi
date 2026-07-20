/**
 * PrincipalReplayRepositoryLive - Durable principal replay orchestration persistence.
 *
 * @module PrincipalReplayRepositoryLive
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  PrincipalReplayRepository,
  SyncEngineStorageError,
  type PrincipalReplayDispatch,
  type PrincipalReplayPlan,
  type PrincipalReplayRepositoryShape,
} from "@my/sync-engine/services"
import { schema, type TransferType } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  highWatermarkToIso,
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const ACTIVE_JOB_STATUSES = ["pending", "processing"] as const
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const

const mapTransactionError = (operation: string) =>
  Effect.mapError((error: unknown) =>
    error instanceof SyncEngineStorageError ? error : toSyncEngineStorageError({ operation, error })
  )

const transactionIdentity = ({
  externalId,
  sourceRawRecordId,
}: {
  readonly externalId: string | null
  readonly sourceRawRecordId: string | null
}): Effect.Effect<string, SyncEngineStorageError> => {
  if (externalId !== null) {
    return Effect.succeed(`external:${externalId}`)
  }

  if (sourceRawRecordId !== null) {
    return Effect.succeed(`raw:${sourceRawRecordId}`)
  }

  return Effect.fail(
    new SyncEngineStorageError({
      operation: "principalReplayRepository.transactionIdentity",
      cause: "Canonical transaction has no replay-stable identity.",
    })
  )
}

const providerTransferIdentity = ({
  externalId,
  sourceRawRecordId,
  sourceRecordPosition,
}: {
  readonly externalId: string | null
  readonly sourceRawRecordId: string | null
  readonly sourceRecordPosition: number
}): Effect.Effect<string, SyncEngineStorageError> => {
  if (externalId !== null) {
    return Effect.succeed(`external:${externalId}`)
  }

  if (sourceRawRecordId !== null) {
    return Effect.succeed(`raw:${sourceRawRecordId}:position:${sourceRecordPosition}`)
  }

  return Effect.fail(
    new SyncEngineStorageError({
      operation: "principalReplayRepository.providerTransferIdentity",
      cause: "Provider transfer has no replay-stable identity.",
    })
  )
}

const canonicalTransferIdentity = ({
  externalId,
  txHash,
  addressId,
  type,
  fromAddress,
  toAddress,
  assetId,
}: {
  readonly externalId: string | null
  readonly txHash: string | null
  readonly addressId: string | null
  readonly type: TransferType | null
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly assetId: string | null
}): Effect.Effect<string, SyncEngineStorageError> => {
  if (externalId !== null) {
    return Effect.succeed(`external:${externalId}`)
  }

  if (txHash !== null && type !== null && assetId !== null) {
    return Effect.succeed(
      `network:${JSON.stringify([txHash, addressId, type, fromAddress, toAddress, assetId])}`
    )
  }

  return Effect.fail(
    new SyncEngineStorageError({
      operation: "principalReplayRepository.canonicalTransferIdentity",
      cause: "Canonical transfer has no replay-stable identity.",
    })
  )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const createOrReuseReplayRun: PrincipalReplayRepositoryShape["createOrReuseReplayRun"] = ({
    principalId,
    sourceIds,
    maxAttempts,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .select({ id: schema.principals.id })
            .from(schema.principals)
            .where(eq(schema.principals.id, principalId))
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.createOrReuseReplayRun.lockPrincipal"
              )
            )

          const [existing] = yield* tx
            .select({
              runId: schema.syncRuns.id,
              coordinatorJobId: schema.syncRunItems.processingJobId,
              coordinatorSourceId: schema.syncRunItems.sourceId,
            })
            .from(schema.syncRuns)
            .leftJoin(
              schema.syncRunItems,
              and(
                eq(schema.syncRunItems.runId, schema.syncRuns.id),
                eq(schema.syncRunItems.isCoordinator, true)
              )
            )
            .where(
              and(
                eq(schema.syncRuns.principalId, principalId),
                eq(schema.syncRuns.mode, "replay"),
                inArray(schema.syncRuns.status, ACTIVE_RUN_STATUSES)
              )
            )
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.createOrReuseReplayRun.findActiveReplay"
              )
            )

          if (existing !== undefined) {
            return existing
          }

          const orderedSourceIds = Array.from(new Set(sourceIds)).sort()
          const busyJobs = yield* tx
            .select({ sourceId: schema.processingJobs.sourceId })
            .from(schema.processingJobs)
            .where(
              and(
                eq(schema.processingJobs.principalId, principalId),
                inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.createOrReuseReplayRun.selectBusyJobs"
              )
            )

          if (busyJobs.length > 0) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.createOrReuseReplayRun.busySources",
                cause: `Sources already have active jobs: ${busyJobs
                  .map((job) => job.sourceId)
                  .sort()
                  .join(", ")}`,
              })
            )
          }

          const [previousReplay] = yield* tx
            .select({
              id: schema.syncRuns.id,
              status: schema.syncRuns.status,
              reviewSnapshotInitializedAt: schema.syncRuns.reviewSnapshotInitializedAt,
            })
            .from(schema.syncRuns)
            .where(
              and(eq(schema.syncRuns.principalId, principalId), eq(schema.syncRuns.mode, "replay"))
            )
            .orderBy(desc(schema.syncRuns.createdAt), desc(schema.syncRuns.id))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.createOrReuseReplayRun.selectPreviousReplay"
              )
            )

          const now = nowDate()
          const [run] = yield* tx
            .insert(schema.syncRuns)
            .values({
              principalId,
              mode: "replay",
              status: orderedSourceIds.length === 0 ? "completed" : "queued",
              requestedSourceCount: orderedSourceIds.length,
              startedAt: orderedSourceIds.length === 0 ? now : null,
              completedAt: orderedSourceIds.length === 0 ? now : null,
              message: orderedSourceIds.length === 0 ? "No sources to replay." : null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: schema.syncRuns.id })
            .pipe(
              wrapSyncEngineSqlError("principalReplayRepository.createOrReuseReplayRun.insertRun")
            )

          if (run === undefined) {
            return yield* Effect.dieMessage("Failed to create principal replay run")
          }

          if (
            previousReplay !== undefined &&
            previousReplay.reviewSnapshotInitializedAt !== null &&
            (previousReplay.status === "failed" || previousReplay.status === "partially_failed")
          ) {
            const reviewSnapshots = yield* tx
              .select({
                principalId: schema.principalReplayReviewSnapshots.principalId,
                sourceId: schema.principalReplayReviewSnapshots.sourceId,
                transactionIdentity: schema.principalReplayReviewSnapshots.transactionIdentity,
                reviewStatus: schema.principalReplayReviewSnapshots.reviewStatus,
                originalTypeKey: schema.principalReplayReviewSnapshots.originalTypeKey,
                originalConfidence: schema.principalReplayReviewSnapshots.originalConfidence,
                currentTypeKey: schema.principalReplayReviewSnapshots.currentTypeKey,
                legalRuleSetVersion: schema.principalReplayReviewSnapshots.legalRuleSetVersion,
                categorizationReason: schema.principalReplayReviewSnapshots.categorizationReason,
                matchedLayer: schema.principalReplayReviewSnapshots.matchedLayer,
                needsReview: schema.principalReplayReviewSnapshots.needsReview,
                userNotes: schema.principalReplayReviewSnapshots.userNotes,
                reviewedAt: schema.principalReplayReviewSnapshots.reviewedAt,
              })
              .from(schema.principalReplayReviewSnapshots)
              .where(eq(schema.principalReplayReviewSnapshots.runId, previousReplay.id))
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.createOrReuseReplayRun.selectPreviousReviewSnapshots"
                )
              )

            if (reviewSnapshots.length > 0) {
              yield* tx
                .insert(schema.principalReplayReviewSnapshots)
                .values(reviewSnapshots.map((snapshot) => ({ ...snapshot, runId: run.id })))
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.createOrReuseReplayRun.copyPreviousReviewSnapshots"
                  )
                )
            }

            const transferSnapshots = yield* tx
              .select({
                principalId: schema.principalReplayTransferReconciliationSnapshots.principalId,
                providerSourceId:
                  schema.principalReplayTransferReconciliationSnapshots.providerSourceId,
                providerTransferIdentity:
                  schema.principalReplayTransferReconciliationSnapshots.providerTransferIdentity,
                canonicalTransferSourceId:
                  schema.principalReplayTransferReconciliationSnapshots.canonicalTransferSourceId,
                canonicalTransferIdentity:
                  schema.principalReplayTransferReconciliationSnapshots.canonicalTransferIdentity,
                canonicalTransactionSourceId:
                  schema.principalReplayTransferReconciliationSnapshots
                    .canonicalTransactionSourceId,
                canonicalTransactionIdentity:
                  schema.principalReplayTransferReconciliationSnapshots
                    .canonicalTransactionIdentity,
                status: schema.principalReplayTransferReconciliationSnapshots.status,
                matchReason: schema.principalReplayTransferReconciliationSnapshots.matchReason,
                confidence: schema.principalReplayTransferReconciliationSnapshots.confidence,
                deterministic: schema.principalReplayTransferReconciliationSnapshots.deterministic,
                reviewMetadata:
                  schema.principalReplayTransferReconciliationSnapshots.reviewMetadata,
              })
              .from(schema.principalReplayTransferReconciliationSnapshots)
              .where(
                eq(schema.principalReplayTransferReconciliationSnapshots.runId, previousReplay.id)
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.createOrReuseReplayRun.selectPreviousTransferSnapshots"
                )
              )

            if (transferSnapshots.length > 0) {
              yield* tx
                .insert(schema.principalReplayTransferReconciliationSnapshots)
                .values(transferSnapshots.map((snapshot) => ({ ...snapshot, runId: run.id })))
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.createOrReuseReplayRun.copyPreviousTransferSnapshots"
                  )
                )
            }
          }

          const sourceJobs = yield* Effect.forEach(orderedSourceIds, (sourceId, index) =>
            Effect.gen(function* () {
              const [job] = yield* tx
                .insert(schema.processingJobs)
                .values({
                  sourceId,
                  principalId,
                  mode: "replay",
                  status: "pending",
                  attemptCount: 0,
                  maxAttempts,
                  progressDetails: { mode: "replay" },
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: schema.processingJobs.id })
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.createOrReuseReplayRun.insertJob"
                  )
                )

              if (job === undefined) {
                return yield* Effect.dieMessage("Failed to create principal replay source job")
              }

              if (index > 0) {
                yield* tx
                  .update(schema.processingJobs)
                  .set({
                    queueName: "principal-replay-child",
                    queueJobId: `${run.id}:${job.id}`,
                    queuedAt: now,
                  })
                  .where(eq(schema.processingJobs.id, job.id))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "principalReplayRepository.createOrReuseReplayRun.reserveChildJob"
                    )
                  )
              }

              yield* tx
                .insert(schema.syncRunItems)
                .values({
                  runId: run.id,
                  sourceId,
                  processingJobId: job.id,
                  isCoordinator: index === 0,
                  status: "queued",
                  createdAt: now,
                  updatedAt: now,
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.createOrReuseReplayRun.insertItem"
                  )
                )

              return { sourceId, jobId: job.id, isCoordinator: index === 0 }
            })
          )
          const coordinator = sourceJobs.find((job) => job.isCoordinator)

          return {
            runId: run.id,
            coordinatorJobId: coordinator?.jobId ?? null,
            coordinatorSourceId: coordinator?.sourceId ?? null,
          } satisfies PrincipalReplayDispatch
        })
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SyncEngineStorageError
            ? error
            : toSyncEngineStorageError({
                operation: "principalReplayRepository.createOrReuseReplayRun.transaction",
                error,
              })
        )
      )

  const findPlanByCoordinatorJobId: PrincipalReplayRepositoryShape["findPlanByCoordinatorJobId"] =
    ({ jobId }) =>
      Effect.gen(function* () {
        const [coordinator] = yield* db
          .select({ runId: schema.syncRuns.id, principalId: schema.syncRuns.principalId })
          .from(schema.syncRunItems)
          .innerJoin(schema.syncRuns, eq(schema.syncRuns.id, schema.syncRunItems.runId))
          .where(
            and(
              eq(schema.syncRunItems.processingJobId, jobId),
              eq(schema.syncRunItems.isCoordinator, true),
              eq(schema.syncRuns.mode, "replay")
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "principalReplayRepository.findPlanByCoordinatorJobId.selectCoordinator"
            )
          )

        if (coordinator === undefined) {
          return Option.none<PrincipalReplayPlan>()
        }

        const jobs = yield* db
          .select({
            sourceId: schema.syncRunItems.sourceId,
            jobId: schema.syncRunItems.processingJobId,
            isCoordinator: schema.syncRunItems.isCoordinator,
          })
          .from(schema.syncRunItems)
          .where(eq(schema.syncRunItems.runId, coordinator.runId))
          .orderBy(asc(schema.syncRunItems.sourceId))
          .pipe(
            wrapSyncEngineSqlError(
              "principalReplayRepository.findPlanByCoordinatorJobId.selectJobs"
            )
          )

        const sourceJobs = jobs.flatMap((job) =>
          job.jobId === null
            ? []
            : [{ sourceId: job.sourceId, jobId: job.jobId, isCoordinator: job.isCoordinator }]
        )

        return Option.some({
          runId: coordinator.runId,
          principalId: coordinator.principalId,
          sourceJobs,
        } satisfies PrincipalReplayPlan)
      })

  const claimPlan: PrincipalReplayRepositoryShape["claimPlan"] = ({
    runId,
    workerId,
    startedAt,
    staleBefore,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const jobs = yield* tx
            .select({ id: schema.syncRunItems.processingJobId })
            .from(schema.syncRunItems)
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.claimPlan.selectJobs"))
          const jobIds = jobs.flatMap((job) => (job.id === null ? [] : [job.id]))

          if (jobIds.length === 0) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.claimPlan",
                cause: `Replay run ${runId} has no source jobs.`,
              })
            )
          }

          const claimed = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "processing",
              workerId,
              startedAt,
              heartbeatAt: startedAt,
              completedAt: null,
              nextRetryAt: null,
              errorMessage: null,
              updatedAt: startedAt,
            })
            .where(
              and(
                inArray(schema.processingJobs.id, jobIds),
                or(
                  eq(schema.processingJobs.status, "pending"),
                  and(
                    eq(schema.processingJobs.status, "processing"),
                    or(
                      lt(schema.processingJobs.heartbeatAt, staleBefore),
                      and(
                        isNull(schema.processingJobs.heartbeatAt),
                        lt(schema.processingJobs.updatedAt, staleBefore)
                      )
                    )
                  )
                )
              )
            )
            .returning({ id: schema.processingJobs.id })
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.claimPlan.updateJobs"))

          if (claimed.length !== jobIds.length) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.claimPlan",
                cause: `Replay run ${runId} contains a source job that is not active.`,
              })
            )
          }

          yield* tx
            .update(schema.syncRunItems)
            .set({ status: "running", updatedAt: startedAt })
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.claimPlan.updateItems"))
          yield* tx
            .update(schema.syncRuns)
            .set({
              status: "running",
              startedAt,
              runningSourceCount: jobIds.length,
              queuedSourceCount: 0,
              message: null,
              updatedAt: startedAt,
            })
            .where(eq(schema.syncRuns.id, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.claimPlan.updateRun"))
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.claimPlan.transaction"))

  const heartbeatPlan: PrincipalReplayRepositoryShape["heartbeatPlan"] = ({
    runId,
    workerId,
    heartbeatAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const jobIds = yield* tx
            .select({ id: schema.syncRunItems.processingJobId })
            .from(schema.syncRunItems)
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.heartbeatPlan.selectJobs"))
          const ids = jobIds.flatMap((job) => (job.id === null ? [] : [job.id]))
          if (ids.length === 0) return

          const heartbeated = yield* tx
            .update(schema.processingJobs)
            .set({ heartbeatAt, updatedAt: heartbeatAt })
            .where(
              and(
                inArray(schema.processingJobs.id, ids),
                eq(schema.processingJobs.status, "processing"),
                eq(schema.processingJobs.workerId, workerId)
              )
            )
            .returning({ id: schema.processingJobs.id })
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.heartbeatPlan.updateJobs"))

          if (heartbeated.length !== ids.length) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.heartbeatPlan.ownership",
                cause: `Worker ${workerId} no longer owns replay run ${runId}.`,
              })
            )
          }
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.heartbeatPlan.transaction"))

  const recordRetryableFailure: PrincipalReplayRepositoryShape["recordRetryableFailure"] = ({
    runId,
    workerId,
    message,
    attemptCount,
    nextRetryAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const now = nowDate()
          const jobIds = yield* tx
            .select({ id: schema.syncRunItems.processingJobId })
            .from(schema.syncRunItems)
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(
              wrapSyncEngineSqlError("principalReplayRepository.recordRetryableFailure.selectJobs")
            )
          const ids = jobIds.flatMap((job) => (job.id === null ? [] : [job.id]))

          if (ids.length > 0) {
            const released = yield* tx
              .update(schema.processingJobs)
              .set({
                status: "pending",
                attemptCount,
                startedAt: null,
                heartbeatAt: null,
                nextRetryAt,
                errorMessage: message,
                workerId: null,
                updatedAt: now,
              })
              .where(
                and(
                  inArray(schema.processingJobs.id, ids),
                  eq(schema.processingJobs.status, "processing"),
                  eq(schema.processingJobs.workerId, workerId)
                )
              )
              .returning({ id: schema.processingJobs.id })
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.recordRetryableFailure.updateJobs"
                )
              )

            if (released.length !== ids.length) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation: "principalReplayRepository.recordRetryableFailure.ownership",
                  cause: `Worker ${workerId} no longer owns replay run ${runId}.`,
                })
              )
            }
          }

          yield* tx
            .update(schema.syncRunItems)
            .set({ status: "queued", message, updatedAt: now })
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(
              wrapSyncEngineSqlError("principalReplayRepository.recordRetryableFailure.updateItems")
            )
          yield* tx
            .update(schema.syncRuns)
            .set({
              status: "queued",
              queuedSourceCount: ids.length,
              runningSourceCount: 0,
              message,
              updatedAt: now,
            })
            .where(eq(schema.syncRuns.id, runId))
            .pipe(
              wrapSyncEngineSqlError("principalReplayRepository.recordRetryableFailure.updateRun")
            )
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.recordRetryableFailure.transaction"))

  const failPlan: PrincipalReplayRepositoryShape["failPlan"] = ({
    runId,
    workerId,
    message,
    completedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const jobIds = yield* tx
            .select({ id: schema.syncRunItems.processingJobId })
            .from(schema.syncRunItems)
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.failPlan.selectJobs"))
          const ids = jobIds.flatMap((job) => (job.id === null ? [] : [job.id]))
          if (ids.length > 0) {
            const failed = yield* tx
              .update(schema.processingJobs)
              .set({ status: "failed", errorMessage: message, completedAt, updatedAt: completedAt })
              .where(
                and(
                  inArray(schema.processingJobs.id, ids),
                  eq(schema.processingJobs.status, "processing"),
                  eq(schema.processingJobs.workerId, workerId)
                )
              )
              .returning({ id: schema.processingJobs.id })
              .pipe(wrapSyncEngineSqlError("principalReplayRepository.failPlan.updateJobs"))

            if (failed.length !== ids.length) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation: "principalReplayRepository.failPlan.ownership",
                  cause: `Worker ${workerId} no longer owns replay run ${runId}.`,
                })
              )
            }
          }
          yield* tx
            .update(schema.syncRunItems)
            .set({ status: "failed", message, updatedAt: completedAt })
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.failPlan.updateItems"))
          yield* tx
            .update(schema.syncRuns)
            .set({
              status: "failed",
              queuedSourceCount: 0,
              runningSourceCount: 0,
              failedSourceCount: ids.length,
              message,
              completedAt,
              updatedAt: completedAt,
            })
            .where(eq(schema.syncRuns.id, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.failPlan.updateRun"))
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.failPlan.transaction"))

  const completePlan: PrincipalReplayRepositoryShape["completePlan"] = ({
    runId,
    workerId,
    sourceResults,
    completedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* Effect.forEach(sourceResults, ({ sourceId, jobId, state }) =>
            Effect.gen(function* () {
              const [completed] = yield* tx
                .update(schema.processingJobs)
                .set({
                  status: "completed",
                  completedAt,
                  errorMessage: null,
                  progressDetails: {
                    phase: state.phase,
                    processedRecords: state.processedRecords,
                    totalRecords: state.totalRecords,
                    importedRecords: state.importedRecords,
                    normalizedRecords: state.normalizedRecords,
                    failedRecords: state.failedRecords,
                    cursorPayload: state.cursorPayload,
                    highWatermark: highWatermarkToIso(state.highWatermark),
                  },
                  checkpointExternalId: state.checkpointExternalId,
                  checkpointPayload: state.cursorPayload,
                  updatedAt: completedAt,
                })
                .where(
                  and(
                    eq(schema.processingJobs.id, jobId),
                    eq(schema.processingJobs.status, "processing"),
                    eq(schema.processingJobs.workerId, workerId)
                  )
                )
                .returning({ id: schema.processingJobs.id })
                .pipe(wrapSyncEngineSqlError("principalReplayRepository.completePlan.updateJob"))

              if (completed === undefined) {
                return yield* Effect.fail(
                  new SyncEngineStorageError({
                    operation: "principalReplayRepository.completePlan.ownership",
                    cause: `Worker ${workerId} no longer owns replay job ${jobId}.`,
                  })
                )
              }

              yield* tx
                .update(schema.syncRunItems)
                .set({ status: "completed", message: null, updatedAt: completedAt })
                .where(
                  and(
                    eq(schema.syncRunItems.runId, runId),
                    eq(schema.syncRunItems.sourceId, sourceId),
                    eq(schema.syncRunItems.processingJobId, jobId)
                  )
                )
                .pipe(wrapSyncEngineSqlError("principalReplayRepository.completePlan.updateItem"))
            })
          )
          yield* tx
            .update(schema.syncRuns)
            .set({
              status: "completed",
              queuedSourceCount: 0,
              runningSourceCount: 0,
              completedSourceCount: sourceResults.length,
              failedSourceCount: 0,
              message: null,
              completedAt,
              updatedAt: completedAt,
            })
            .where(eq(schema.syncRuns.id, runId))
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.completePlan.updateRun"))
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.completePlan.transaction"))

  const preparePrincipalReplay: PrincipalReplayRepositoryShape["preparePrincipalReplay"] = ({
    runId,
    principalId,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .select({ id: schema.principals.id })
            .from(schema.principals)
            .where(eq(schema.principals.id, principalId))
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.lockPrincipal"
              )
            )

          const [run] = yield* tx
            .select({
              reviewSnapshotInitializedAt: schema.syncRuns.reviewSnapshotInitializedAt,
            })
            .from(schema.syncRuns)
            .where(and(eq(schema.syncRuns.id, runId), eq(schema.syncRuns.principalId, principalId)))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError("principalReplayRepository.preparePrincipalReplay.selectRun")
            )

          if (run === undefined) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.preparePrincipalReplay.selectRun",
                cause: `Replay run ${runId} does not belong to principal ${principalId}.`,
              })
            )
          }

          if (run.reviewSnapshotInitializedAt === null) {
            const reviews = yield* tx
              .select({
                sourceId: schema.transactions.sourceId,
                externalId: schema.transactions.externalId,
                sourceRawRecordId: schema.transactions.sourceRawRecordId,
                reviewStatus: schema.transactionReviews.reviewStatus,
                originalTypeKey: schema.transactionReviews.originalTypeKey,
                originalConfidence: schema.transactionReviews.originalConfidence,
                currentTypeKey: schema.transactionReviews.currentTypeKey,
                legalRuleSetVersion: schema.transactionReviews.legalRuleSetVersion,
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
                needsReview: schema.transactionReviews.needsReview,
                userNotes: schema.transactionReviews.userNotes,
                reviewedAt: schema.transactionReviews.reviewedAt,
              })
              .from(schema.transactionReviews)
              .innerJoin(
                schema.transactions,
                eq(schema.transactions.id, schema.transactionReviews.transactionId)
              )
              .where(
                and(
                  eq(schema.transactionReviews.principalId, principalId),
                  or(
                    inArray(schema.transactionReviews.reviewStatus, ["approved", "changed"]),
                    isNotNull(schema.transactionReviews.userNotes)
                  )
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.preparePrincipalReplay.selectReviews"
                )
              )

            const snapshots = yield* Effect.forEach(reviews, (review) =>
              transactionIdentity(review).pipe(
                Effect.map((identity) => ({
                  runId,
                  principalId,
                  sourceId: review.sourceId,
                  transactionIdentity: identity,
                  reviewStatus: review.reviewStatus,
                  originalTypeKey: review.originalTypeKey,
                  originalConfidence: review.originalConfidence,
                  currentTypeKey: review.currentTypeKey,
                  legalRuleSetVersion: review.legalRuleSetVersion,
                  categorizationReason: review.categorizationReason,
                  matchedLayer: review.matchedLayer,
                  needsReview: review.needsReview,
                  userNotes: review.userNotes,
                  reviewedAt: review.reviewedAt,
                }))
              )
            )

            if (snapshots.length > 0) {
              yield* tx
                .insert(schema.principalReplayReviewSnapshots)
                .values(snapshots)
                .onConflictDoUpdate({
                  target: [
                    schema.principalReplayReviewSnapshots.runId,
                    schema.principalReplayReviewSnapshots.sourceId,
                    schema.principalReplayReviewSnapshots.transactionIdentity,
                  ],
                  set: {
                    reviewStatus: sql.raw("excluded.review_status"),
                    originalTypeKey: sql.raw("excluded.original_type_key"),
                    originalConfidence: sql.raw("excluded.original_confidence"),
                    currentTypeKey: sql.raw("excluded.current_type_key"),
                    legalRuleSetVersion: sql.raw("excluded.legal_rule_set_version"),
                    categorizationReason: sql.raw("excluded.categorization_reason"),
                    matchedLayer: sql.raw("excluded.matched_layer"),
                    needsReview: sql.raw("excluded.needs_review"),
                    userNotes: sql.raw("excluded.user_notes"),
                    reviewedAt: sql.raw("excluded.reviewed_at"),
                  },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.preparePrincipalReplay.insertSnapshots"
                  )
                )
            }

            const reviewedReconciliations = yield* tx
              .select({
                providerSourceId: schema.providerTransfers.sourceId,
                providerExternalId: schema.providerTransfers.externalId,
                providerSourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
                providerSourceRecordPosition: schema.providerTransfers.sourceRecordPosition,
                canonicalTransferId: schema.transfers.id,
                canonicalTransferSourceId: schema.transfers.sourceId,
                canonicalTransferExternalId: schema.transfers.externalId,
                canonicalTransferTxHash: schema.transfers.txHash,
                canonicalTransferAddressId: schema.transfers.addressId,
                canonicalTransferType: schema.transfers.type,
                canonicalTransferFromAddress: schema.transfers.fromAddress,
                canonicalTransferToAddress: schema.transfers.toAddress,
                canonicalTransferAssetId: schema.transfers.assetId,
                canonicalTransactionId: schema.transactions.id,
                canonicalTransactionSourceId: schema.transactions.sourceId,
                canonicalTransactionExternalId: schema.transactions.externalId,
                canonicalTransactionSourceRawRecordId: schema.transactions.sourceRawRecordId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                confidence: schema.transferReconciliations.confidence,
                deterministic: schema.transferReconciliations.deterministic,
                reviewMetadata: schema.transferReconciliations.reviewMetadata,
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
                schema.transactions,
                eq(schema.transactions.id, schema.transferReconciliations.canonicalTransactionId)
              )
              .where(
                and(
                  eq(schema.transferReconciliations.principalId, principalId),
                  inArray(schema.transferReconciliations.status, ["approved", "rejected"])
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.preparePrincipalReplay.selectTransferReconciliations"
                )
              )

            const reconciliationSnapshots = yield* Effect.forEach(
              reviewedReconciliations,
              (reconciliation) =>
                Effect.gen(function* () {
                  const providerIdentity = yield* providerTransferIdentity({
                    externalId: reconciliation.providerExternalId,
                    sourceRawRecordId: reconciliation.providerSourceRawRecordId,
                    sourceRecordPosition: reconciliation.providerSourceRecordPosition,
                  })
                  const canonicalTransferIdentityValue =
                    reconciliation.canonicalTransferId === null
                      ? null
                      : yield* canonicalTransferIdentity({
                          externalId: reconciliation.canonicalTransferExternalId,
                          txHash: reconciliation.canonicalTransferTxHash,
                          addressId: reconciliation.canonicalTransferAddressId,
                          type: reconciliation.canonicalTransferType,
                          fromAddress: reconciliation.canonicalTransferFromAddress,
                          toAddress: reconciliation.canonicalTransferToAddress,
                          assetId: reconciliation.canonicalTransferAssetId,
                        })
                  const canonicalTransactionIdentityValue =
                    reconciliation.canonicalTransactionId === null
                      ? null
                      : yield* transactionIdentity({
                          externalId: reconciliation.canonicalTransactionExternalId,
                          sourceRawRecordId: reconciliation.canonicalTransactionSourceRawRecordId,
                        })

                  return {
                    runId,
                    principalId,
                    providerSourceId: reconciliation.providerSourceId,
                    providerTransferIdentity: providerIdentity,
                    canonicalTransferSourceId: reconciliation.canonicalTransferSourceId,
                    canonicalTransferIdentity: canonicalTransferIdentityValue,
                    canonicalTransactionSourceId: reconciliation.canonicalTransactionSourceId,
                    canonicalTransactionIdentity: canonicalTransactionIdentityValue,
                    status: reconciliation.status,
                    matchReason: reconciliation.matchReason,
                    confidence: reconciliation.confidence,
                    deterministic: reconciliation.deterministic,
                    reviewMetadata: reconciliation.reviewMetadata,
                  }
                })
            )

            if (reconciliationSnapshots.length > 0) {
              yield* tx
                .insert(schema.principalReplayTransferReconciliationSnapshots)
                .values(reconciliationSnapshots)
                .onConflictDoUpdate({
                  target: [
                    schema.principalReplayTransferReconciliationSnapshots.runId,
                    schema.principalReplayTransferReconciliationSnapshots.providerSourceId,
                    schema.principalReplayTransferReconciliationSnapshots.providerTransferIdentity,
                  ],
                  set: {
                    canonicalTransferSourceId: sql.raw("excluded.canonical_transfer_source_id"),
                    canonicalTransferIdentity: sql.raw("excluded.canonical_transfer_identity"),
                    canonicalTransactionSourceId: sql.raw(
                      "excluded.canonical_transaction_source_id"
                    ),
                    canonicalTransactionIdentity: sql.raw(
                      "excluded.canonical_transaction_identity"
                    ),
                    status: sql.raw("excluded.status"),
                    matchReason: sql.raw("excluded.match_reason"),
                    confidence: sql.raw("excluded.confidence"),
                    deterministic: sql.raw("excluded.deterministic"),
                    reviewMetadata: sql.raw("excluded.review_metadata"),
                  },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.preparePrincipalReplay.insertTransferReconciliationSnapshots"
                  )
                )
            }

            yield* tx
              .update(schema.syncRuns)
              .set({ reviewSnapshotInitializedAt: nowDate(), updatedAt: nowDate() })
              .where(eq(schema.syncRuns.id, runId))
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.preparePrincipalReplay.markSnapshotInitialized"
                )
              )
          }

          const sourceRows = yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(eq(schema.sources.principalId, principalId))
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.selectSources"
              )
            )
          const sourceIds = sourceRows.map((source) => source.id)

          yield* tx
            .delete(schema.transferReconciliations)
            .where(eq(schema.transferReconciliations.principalId, principalId))
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.deleteReconciliations"
              )
            )
          yield* tx
            .delete(schema.transactionLegs)
            .where(eq(schema.transactionLegs.principalId, principalId))
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.deleteTransactionLegs"
              )
            )
          yield* tx
            .delete(schema.transfers)
            .where(eq(schema.transfers.principalId, principalId))
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.deleteTransfers"
              )
            )
          yield* tx
            .delete(schema.transactions)
            .where(eq(schema.transactions.principalId, principalId))
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.deleteTransactions"
              )
            )

          if (sourceIds.length > 0) {
            yield* tx
              .update(schema.sourceRecordsRaw)
              .set({ normalizedAt: null, normalizationError: null, updatedAt: nowDate() })
              .where(inArray(schema.sourceRecordsRaw.sourceId, sourceIds))
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.preparePrincipalReplay.resetRawRows"
                )
              )
          }
        })
      )
      .pipe(mapTransactionError("principalReplayRepository.preparePrincipalReplay.transaction"))

  const restorePrincipalReviews: PrincipalReplayRepositoryShape["restorePrincipalReviews"] = ({
    runId,
    principalId,
  }) =>
    Effect.gen(function* () {
      const snapshots = yield* db
        .select({
          sourceId: schema.principalReplayReviewSnapshots.sourceId,
          transactionIdentity: schema.principalReplayReviewSnapshots.transactionIdentity,
          reviewStatus: schema.principalReplayReviewSnapshots.reviewStatus,
          originalTypeKey: schema.principalReplayReviewSnapshots.originalTypeKey,
          originalConfidence: schema.principalReplayReviewSnapshots.originalConfidence,
          currentTypeKey: schema.principalReplayReviewSnapshots.currentTypeKey,
          legalRuleSetVersion: schema.principalReplayReviewSnapshots.legalRuleSetVersion,
          categorizationReason: schema.principalReplayReviewSnapshots.categorizationReason,
          matchedLayer: schema.principalReplayReviewSnapshots.matchedLayer,
          needsReview: schema.principalReplayReviewSnapshots.needsReview,
          userNotes: schema.principalReplayReviewSnapshots.userNotes,
          reviewedAt: schema.principalReplayReviewSnapshots.reviewedAt,
        })
        .from(schema.principalReplayReviewSnapshots)
        .where(
          and(
            eq(schema.principalReplayReviewSnapshots.runId, runId),
            eq(schema.principalReplayReviewSnapshots.principalId, principalId)
          )
        )
        .orderBy(
          asc(schema.principalReplayReviewSnapshots.sourceId),
          asc(schema.principalReplayReviewSnapshots.transactionIdentity)
        )
        .pipe(
          wrapSyncEngineSqlError(
            "principalReplayRepository.restorePrincipalReviews.selectSnapshots"
          )
        )
      const reconciliationSnapshots = yield* db
        .select({
          providerSourceId: schema.principalReplayTransferReconciliationSnapshots.providerSourceId,
          providerTransferIdentity:
            schema.principalReplayTransferReconciliationSnapshots.providerTransferIdentity,
          canonicalTransferSourceId:
            schema.principalReplayTransferReconciliationSnapshots.canonicalTransferSourceId,
          canonicalTransferIdentity:
            schema.principalReplayTransferReconciliationSnapshots.canonicalTransferIdentity,
          canonicalTransactionSourceId:
            schema.principalReplayTransferReconciliationSnapshots.canonicalTransactionSourceId,
          canonicalTransactionIdentity:
            schema.principalReplayTransferReconciliationSnapshots.canonicalTransactionIdentity,
          status: schema.principalReplayTransferReconciliationSnapshots.status,
          matchReason: schema.principalReplayTransferReconciliationSnapshots.matchReason,
          confidence: schema.principalReplayTransferReconciliationSnapshots.confidence,
          deterministic: schema.principalReplayTransferReconciliationSnapshots.deterministic,
          reviewMetadata: schema.principalReplayTransferReconciliationSnapshots.reviewMetadata,
        })
        .from(schema.principalReplayTransferReconciliationSnapshots)
        .where(
          and(
            eq(schema.principalReplayTransferReconciliationSnapshots.runId, runId),
            eq(schema.principalReplayTransferReconciliationSnapshots.principalId, principalId)
          )
        )
        .orderBy(
          asc(schema.principalReplayTransferReconciliationSnapshots.providerSourceId),
          asc(schema.principalReplayTransferReconciliationSnapshots.providerTransferIdentity)
        )
        .pipe(
          wrapSyncEngineSqlError(
            "principalReplayRepository.restorePrincipalReviews.selectTransferReconciliationSnapshots"
          )
        )
      const transactions = yield* db
        .select({
          id: schema.transactions.id,
          sourceId: schema.transactions.sourceId,
          externalId: schema.transactions.externalId,
          sourceRawRecordId: schema.transactions.sourceRawRecordId,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.principalId, principalId))
        .pipe(
          wrapSyncEngineSqlError(
            "principalReplayRepository.restorePrincipalReviews.selectTransactions"
          )
        )
      const transactionEntries = yield* Effect.forEach(transactions, (transaction) =>
        transactionIdentity(transaction).pipe(
          Effect.map((identity) => [`${transaction.sourceId}:${identity}`, transaction.id] as const)
        )
      )
      const transactionByIdentity: ReadonlyMap<string, string> = new Map(transactionEntries)
      const providerTransfers = yield* db
        .select({
          id: schema.providerTransfers.id,
          sourceId: schema.providerTransfers.sourceId,
          externalId: schema.providerTransfers.externalId,
          sourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
          sourceRecordPosition: schema.providerTransfers.sourceRecordPosition,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.transactions,
          eq(schema.transactions.id, schema.providerTransfers.transactionId)
        )
        .where(eq(schema.transactions.principalId, principalId))
        .pipe(
          wrapSyncEngineSqlError(
            "principalReplayRepository.restorePrincipalReviews.selectProviderTransfers"
          )
        )
      const providerTransferEntries = yield* Effect.forEach(providerTransfers, (providerTransfer) =>
        providerTransferIdentity(providerTransfer).pipe(
          Effect.map(
            (identity) => [`${providerTransfer.sourceId}:${identity}`, providerTransfer.id] as const
          )
        )
      )
      const providerTransferByIdentity: ReadonlyMap<string, string> = new Map(
        providerTransferEntries
      )
      const canonicalTransfers = yield* db
        .select({
          id: schema.transfers.id,
          sourceId: schema.transfers.sourceId,
          externalId: schema.transfers.externalId,
          txHash: schema.transfers.txHash,
          addressId: schema.transfers.addressId,
          type: schema.transfers.type,
          fromAddress: schema.transfers.fromAddress,
          toAddress: schema.transfers.toAddress,
          assetId: schema.transfers.assetId,
        })
        .from(schema.transfers)
        .where(eq(schema.transfers.principalId, principalId))
        .pipe(
          wrapSyncEngineSqlError(
            "principalReplayRepository.restorePrincipalReviews.selectCanonicalTransfers"
          )
        )
      const canonicalTransferEntries = yield* Effect.forEach(
        canonicalTransfers,
        (canonicalTransfer) =>
          canonicalTransferIdentity(canonicalTransfer).pipe(
            Effect.map(
              (identity) =>
                [`${canonicalTransfer.sourceId}:${identity}`, canonicalTransfer.id] as const
            )
          )
      )
      const canonicalTransferByIdentity: ReadonlyMap<string, string> = new Map(
        canonicalTransferEntries
      )
      const unmatchedTransactionIdentities: Array<string> = []
      let restoredCount = 0

      yield* Effect.forEach(snapshots, (snapshot) => {
        const identity = `${snapshot.sourceId}:${snapshot.transactionIdentity}`
        const transactionId = transactionByIdentity.get(identity)
        if (transactionId === undefined) {
          unmatchedTransactionIdentities.push(identity)
          return Effect.void
        }

        restoredCount += 1
        const now = nowDate()
        return Effect.gen(function* () {
          if (
            (snapshot.reviewStatus === "approved" || snapshot.reviewStatus === "changed") &&
            snapshot.currentTypeKey !== null
          ) {
            yield* db
              .update(schema.transactions)
              .set({ transactionType: snapshot.currentTypeKey, updatedAt: now })
              .where(
                and(
                  eq(schema.transactions.id, transactionId),
                  eq(schema.transactions.principalId, principalId)
                )
              )
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.restorePrincipalReviews.updateTransactionType"
                )
              )
          }

          yield* db
            .insert(schema.transactionReviews)
            .values({
              transactionId,
              principalId,
              reviewStatus: snapshot.reviewStatus,
              originalTypeKey: snapshot.originalTypeKey,
              originalConfidence: snapshot.originalConfidence,
              currentTypeKey: snapshot.currentTypeKey,
              legalRuleSetVersion: snapshot.legalRuleSetVersion,
              categorizationReason: snapshot.categorizationReason,
              matchedLayer: snapshot.matchedLayer,
              needsReview: snapshot.needsReview,
              userNotes: snapshot.userNotes,
              reviewedAt: snapshot.reviewedAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transactionReviews.transactionId,
              set: {
                reviewStatus: snapshot.reviewStatus,
                originalTypeKey: snapshot.originalTypeKey,
                originalConfidence: snapshot.originalConfidence,
                currentTypeKey: snapshot.currentTypeKey,
                legalRuleSetVersion: snapshot.legalRuleSetVersion,
                categorizationReason: snapshot.categorizationReason,
                matchedLayer: snapshot.matchedLayer,
                needsReview: snapshot.needsReview,
                userNotes: snapshot.userNotes,
                reviewedAt: snapshot.reviewedAt,
                updatedAt: now,
              },
            })
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.restorePrincipalReviews.upsertReview"
              )
            )
        })
      })

      yield* Effect.forEach(reconciliationSnapshots, (snapshot) =>
        Effect.gen(function* () {
          if (snapshot.status !== "approved" && snapshot.status !== "rejected") {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation:
                  "principalReplayRepository.restorePrincipalReviews.validateTransferReconciliationStatus",
                cause: `Replay transfer reconciliation snapshot has non-reviewed status ${snapshot.status}.`,
              })
            )
          }

          const providerKey = `${snapshot.providerSourceId}:${snapshot.providerTransferIdentity}`
          const providerTransferId = providerTransferByIdentity.get(providerKey)
          if (providerTransferId === undefined) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation:
                  "principalReplayRepository.restorePrincipalReviews.resolveProviderTransfer",
                cause: `Reviewed provider transfer was not rebuilt: ${providerKey}.`,
              })
            )
          }

          let canonicalTransferId: string | null = null
          if (
            snapshot.canonicalTransferSourceId !== null &&
            snapshot.canonicalTransferIdentity !== null
          ) {
            const canonicalTransferKey = `${snapshot.canonicalTransferSourceId}:${snapshot.canonicalTransferIdentity}`
            const rebuiltCanonicalTransferId = canonicalTransferByIdentity.get(canonicalTransferKey)
            if (rebuiltCanonicalTransferId === undefined) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation:
                    "principalReplayRepository.restorePrincipalReviews.resolveCanonicalTransfer",
                  cause: `Reviewed canonical transfer was not rebuilt: ${canonicalTransferKey}.`,
                })
              )
            }
            canonicalTransferId = rebuiltCanonicalTransferId
          } else if (
            snapshot.canonicalTransferSourceId !== null ||
            snapshot.canonicalTransferIdentity !== null
          ) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation:
                  "principalReplayRepository.restorePrincipalReviews.validateCanonicalTransferIdentity",
                cause: `Reviewed provider transfer has an incomplete canonical transfer identity: ${providerKey}.`,
              })
            )
          }

          let canonicalTransactionId: string | null = null
          if (
            snapshot.canonicalTransactionSourceId !== null &&
            snapshot.canonicalTransactionIdentity !== null
          ) {
            const canonicalTransactionKey = `${snapshot.canonicalTransactionSourceId}:${snapshot.canonicalTransactionIdentity}`
            const rebuiltCanonicalTransactionId = transactionByIdentity.get(canonicalTransactionKey)
            if (rebuiltCanonicalTransactionId === undefined) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation:
                    "principalReplayRepository.restorePrincipalReviews.resolveCanonicalTransaction",
                  cause: `Reviewed canonical transaction was not rebuilt: ${canonicalTransactionKey}.`,
                })
              )
            }
            canonicalTransactionId = rebuiltCanonicalTransactionId
          } else if (
            snapshot.canonicalTransactionSourceId !== null ||
            snapshot.canonicalTransactionIdentity !== null
          ) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation:
                  "principalReplayRepository.restorePrincipalReviews.validateCanonicalTransactionIdentity",
                cause: `Reviewed provider transfer has an incomplete canonical transaction identity: ${providerKey}.`,
              })
            )
          }

          const now = nowDate()
          yield* db
            .insert(schema.transferReconciliations)
            .values({
              principalId,
              providerTransferId,
              canonicalTransferId,
              canonicalTransactionId,
              status: snapshot.status,
              matchReason: snapshot.matchReason,
              confidence: snapshot.confidence,
              deterministic: snapshot.deterministic,
              reviewMetadata: snapshot.reviewMetadata,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transferReconciliations.providerTransferId,
              set: {
                principalId,
                canonicalTransferId,
                canonicalTransactionId,
                status: snapshot.status,
                matchReason: snapshot.matchReason,
                confidence: snapshot.confidence,
                deterministic: snapshot.deterministic,
                reviewMetadata: snapshot.reviewMetadata,
                updatedAt: now,
              },
            })
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.restorePrincipalReviews.upsertTransferReconciliation"
              )
            )
        })
      )

      return { restoredCount, unmatchedTransactionIdentities }
    })

  return PrincipalReplayRepository.of({
    createOrReuseReplayRun,
    findPlanByCoordinatorJobId,
    claimPlan,
    heartbeatPlan,
    recordRetryableFailure,
    failPlan,
    completePlan,
    preparePrincipalReplay,
    restorePrincipalReviews,
  } satisfies PrincipalReplayRepositoryShape)
})

/** Live principal replay persistence layer. */
export const PrincipalReplayRepositoryLive = Layer.effect(PrincipalReplayRepository, make)
