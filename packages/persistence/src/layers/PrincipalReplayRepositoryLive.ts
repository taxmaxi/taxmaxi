/**
 * PrincipalReplayRepositoryLive - Durable principal replay orchestration persistence.
 *
 * @module PrincipalReplayRepositoryLive
 */

import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm"
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
import { schema } from "../schema/index.ts"
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
          if (orderedSourceIds.length > 0) {
            const busyJobs = yield* tx
              .select({ sourceId: schema.processingJobs.sourceId })
              .from(schema.processingJobs)
              .where(
                and(
                  eq(schema.processingJobs.principalId, principalId),
                  inArray(schema.processingJobs.sourceId, orderedSourceIds),
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
          }

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

  const claimPlan: PrincipalReplayRepositoryShape["claimPlan"] = ({ runId, workerId, startedAt }) =>
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
                eq(schema.processingJobs.status, "pending")
              )
            )
            .returning({ id: schema.processingJobs.id })
            .pipe(wrapSyncEngineSqlError("principalReplayRepository.claimPlan.updateJobs"))

          if (claimed.length !== jobIds.length) {
            return yield* Effect.fail(
              new SyncEngineStorageError({
                operation: "principalReplayRepository.claimPlan",
                cause: `Replay run ${runId} contains a source job that is not pending.`,
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
    Effect.gen(function* () {
      const jobIds = yield* db
        .select({ id: schema.syncRunItems.processingJobId })
        .from(schema.syncRunItems)
        .where(eq(schema.syncRunItems.runId, runId))
        .pipe(wrapSyncEngineSqlError("principalReplayRepository.heartbeatPlan.selectJobs"))
      const ids = jobIds.flatMap((job) => (job.id === null ? [] : [job.id]))
      if (ids.length === 0) return

      yield* db
        .update(schema.processingJobs)
        .set({ heartbeatAt, updatedAt: heartbeatAt })
        .where(
          and(
            inArray(schema.processingJobs.id, ids),
            eq(schema.processingJobs.status, "processing"),
            eq(schema.processingJobs.workerId, workerId)
          )
        )
        .pipe(wrapSyncEngineSqlError("principalReplayRepository.heartbeatPlan.updateJobs"))
    })

  const recordRetryableFailure: PrincipalReplayRepositoryShape["recordRetryableFailure"] = ({
    runId,
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
            yield* tx
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
              .where(inArray(schema.processingJobs.id, ids))
              .pipe(
                wrapSyncEngineSqlError(
                  "principalReplayRepository.recordRetryableFailure.updateJobs"
                )
              )
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

  const failPlan: PrincipalReplayRepositoryShape["failPlan"] = ({ runId, message, completedAt }) =>
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
            yield* tx
              .update(schema.processingJobs)
              .set({ status: "failed", errorMessage: message, completedAt, updatedAt: completedAt })
              .where(inArray(schema.processingJobs.id, ids))
              .pipe(wrapSyncEngineSqlError("principalReplayRepository.failPlan.updateJobs"))
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
    sourceResults,
    completedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* Effect.forEach(sourceResults, ({ sourceId, jobId, state }) =>
            Effect.gen(function* () {
              yield* tx
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
                    eq(schema.processingJobs.status, "processing")
                  )
                )
                .pipe(wrapSyncEngineSqlError("principalReplayRepository.completePlan.updateJob"))
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

          const [existingSnapshot] = yield* tx
            .select({ id: schema.principalReplayReviewSnapshots.id })
            .from(schema.principalReplayReviewSnapshots)
            .where(eq(schema.principalReplayReviewSnapshots.runId, runId))
            .limit(1)
            .pipe(
              wrapSyncEngineSqlError(
                "principalReplayRepository.preparePrincipalReplay.selectSnapshot"
              )
            )

          if (existingSnapshot === undefined) {
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
                .pipe(
                  wrapSyncEngineSqlError(
                    "principalReplayRepository.preparePrincipalReplay.insertSnapshots"
                  )
                )
            }
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
        .select()
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
        return db
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
            ),
            Effect.asVoid
          )
      })

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
