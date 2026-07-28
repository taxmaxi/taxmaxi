/**
 * SourceSyncJobRequest - Transaction-compatible active sync job creation and reuse.
 *
 * @module SourceSyncJobRequest
 */

import {
  type CreateOrReuseSourceSyncJobResult,
  type SourceSyncJobMode,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { and, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { schema } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"
import { wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const ACTIVE_JOB_STATUSES = ["pending", "processing"] as const
const MAX_REQUEST_ATTEMPTS = 3

type SourceSyncJobRequestExecutor = Pick<
  Effect.Effect.Success<typeof drizzle>,
  "insert" | "select" | "update"
>

export type ActiveReplayPolicy = "reuse" | "request_follow_up_if_processing"

/**
 * Create a pending source sync job or reuse the active job that owns the source.
 *
 * Replay callers can require a follow-up when the active replay is already
 * processing. This is used when a mapping decision must be observed by work
 * that starts after the decision.
 */
export const requestSourceSyncJob = ({
  executor,
  sourceId,
  principalId,
  mode,
  maxAttempts,
  requestedAt,
  activeReplayPolicy,
}: {
  readonly executor: SourceSyncJobRequestExecutor
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly maxAttempts: number
  readonly requestedAt: Date
  readonly activeReplayPolicy: ActiveReplayPolicy
}): Effect.Effect<CreateOrReuseSourceSyncJobResult, SyncEngineStorageError> => {
  const attemptRequest = (
    attemptsRemaining: number
  ): Effect.Effect<CreateOrReuseSourceSyncJobResult, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const [insertedJob] = yield* executor
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode,
          status: "pending",
          attemptCount: 0,
          maxAttempts,
          progressDetails: { mode },
          createdAt: requestedAt,
          updatedAt: requestedAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRequest.insert"))

      if (insertedJob !== undefined) {
        return {
          _tag: "CreatedSourceSyncJob",
          id: insertedJob.id,
        } satisfies CreateOrReuseSourceSyncJobResult
      }

      const [activeJob] = yield* executor
        .select({
          id: schema.processingJobs.id,
          sourceId: schema.processingJobs.sourceId,
          principalId: schema.processingJobs.principalId,
          mode: schema.processingJobs.mode,
          status: schema.processingJobs.status,
          queueName: schema.processingJobs.queueName,
          queueJobId: schema.processingJobs.queueJobId,
        })
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.sourceId, sourceId),
            eq(schema.processingJobs.principalId, principalId),
            inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
          )
        )
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRequest.loadActiveJob"))

      const retryAfterCompletionRace = () =>
        attemptsRemaining > 1
          ? Effect.suspend(() => attemptRequest(attemptsRemaining - 1))
          : Effect.fail(
              new SyncEngineStorageError({
                operation: "sourceSyncJobRequest.loadActiveJob",
                cause: { sourceId, principalId },
              })
            )

      if (
        activeJob === undefined ||
        (activeJob.status !== "pending" && activeJob.status !== "processing")
      ) {
        return yield* retryAfterCompletionRace()
      }

      const requiresReplayFollowUp =
        mode === "replay" &&
        (activeJob.mode !== "replay" ||
          (activeReplayPolicy === "request_follow_up_if_processing" &&
            activeJob.status === "processing"))

      if (requiresReplayFollowUp) {
        const [updatedJob] = yield* executor
          .update(schema.processingJobs)
          .set({ followUpMode: "replay", updatedAt: requestedAt })
          .where(
            and(
              eq(schema.processingJobs.id, activeJob.id),
              inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
            )
          )
          .returning({ id: schema.processingJobs.id })
          .pipe(wrapSyncEngineSqlError("sourceSyncJobRequest.requestFollowUp"))

        if (updatedJob === undefined) {
          return yield* retryAfterCompletionRace()
        }
      }

      return {
        _tag: "ReusedSourceSyncJob",
        id: activeJob.id,
        sourceId: activeJob.sourceId,
        principalId: activeJob.principalId,
        mode: activeJob.mode,
        status: activeJob.status,
        queueName: activeJob.queueName,
        queueJobId: activeJob.queueJobId,
      } satisfies CreateOrReuseSourceSyncJobResult
    })

  return attemptRequest(MAX_REQUEST_ATTEMPTS)
}
