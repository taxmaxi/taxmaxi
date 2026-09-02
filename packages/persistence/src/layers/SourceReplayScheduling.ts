/**
 * SourceReplayScheduling - Durable replay selection inside persistence transactions.
 *
 * @module SourceReplayScheduling
 */

import { and, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "@my/sync-engine/services"
import {
  type SyncEngineDbTransaction,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

/** One source whose stored facts need to be replayed. */
export type SourceReplayTarget = {
  readonly sourceId: string
  readonly principalId: string
}

/** The durable processing job selected for one source replay. */
export type ScheduledSourceReplay = SourceReplayTarget & {
  readonly processingJobId: string
}

type ReplayProgressDetails = {
  readonly mode: "replay"
  readonly reason: string
  readonly [key: string]: unknown
}

type PendingReplayPolicy = "reuse" | "request_follow_up"
type ReplaySchedulingStep =
  | "reusePendingReplay"
  | "requestActiveReplay"
  | "createReplay"
  | "requestReplay"

const requestReplay = ({
  tx,
  source,
  now,
  progressDetails,
  errorOperation,
  pendingReplayPolicy,
  attemptsRemaining,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly source: SourceReplayTarget
  readonly now: Date
  readonly progressDetails: ReplayProgressDetails
  readonly errorOperation: (step: ReplaySchedulingStep) => string
  readonly pendingReplayPolicy: PendingReplayPolicy
  readonly attemptsRemaining: number
}): Effect.Effect<string, SyncEngineStorageError> =>
  Effect.gen(function* () {
    if (pendingReplayPolicy === "reuse") {
      // Some callers know an unstarted replay includes their newly committed
      // facts. Updating the row locks it against a concurrent worker claim.
      const [pendingReplay] = yield* tx
        .update(schema.processingJobs)
        .set({ updatedAt: now })
        .where(
          and(
            eq(schema.processingJobs.sourceId, source.sourceId),
            eq(schema.processingJobs.principalId, source.principalId),
            eq(schema.processingJobs.mode, "replay"),
            eq(schema.processingJobs.status, "pending")
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError(errorOperation("reusePendingReplay")))
      if (pendingReplay !== undefined) {
        return pendingReplay.id
      }
    }

    // Work that may already have passed the changed facts needs one replay
    // after it finishes. Repeated requests keep the same single follow-up.
    const [activeJob] = yield* tx
      .update(schema.processingJobs)
      .set({ followUpMode: "replay", updatedAt: now })
      .where(
        and(
          eq(schema.processingJobs.sourceId, source.sourceId),
          eq(schema.processingJobs.principalId, source.principalId),
          inArray(schema.processingJobs.status, ["pending", "processing"])
        )
      )
      .returning({ id: schema.processingJobs.id })
      .pipe(wrapSyncEngineSqlError(errorOperation("requestActiveReplay")))
    if (activeJob !== undefined) {
      return activeJob.id
    }

    const [createdJob] = yield* tx
      .insert(schema.processingJobs)
      .values({
        sourceId: source.sourceId,
        principalId: source.principalId,
        mode: "replay",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 3,
        progressDetails,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.processingJobs.id })
      .pipe(wrapSyncEngineSqlError(errorOperation("createReplay")))
    if (createdJob !== undefined) {
      return createdJob.id
    }

    if (attemptsRemaining > 1) {
      return yield* Effect.suspend(() =>
        requestReplay({
          tx,
          source,
          now,
          progressDetails,
          errorOperation,
          pendingReplayPolicy,
          attemptsRemaining: attemptsRemaining - 1,
        })
      )
    }

    return yield* new SyncEngineStorageError({
      operation: errorOperation("requestReplay"),
      cause: {
        principalId: source.principalId,
        sourceId: source.sourceId,
        message: "Active replay owner changed repeatedly.",
      },
    })
  })

/**
 * Select durable replay work for each source inside the caller's transaction.
 * Sources are handled in ID order so concurrent callers take job locks in the
 * same order. This function stores no calculation work; replay completion owns
 * the coalesced principal recompute.
 */
export const scheduleSourceReplays = ({
  tx,
  sources,
  now,
  progressDetails,
  errorOperation,
  pendingReplayPolicy,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly sources: ReadonlyArray<SourceReplayTarget>
  readonly now: Date
  readonly progressDetails: ReplayProgressDetails
  readonly errorOperation: (step: ReplaySchedulingStep) => string
  readonly pendingReplayPolicy: PendingReplayPolicy
}): Effect.Effect<ReadonlyArray<ScheduledSourceReplay>, SyncEngineStorageError> =>
  Effect.forEach(
    [...sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    (source) =>
      requestReplay({
        tx,
        source,
        now,
        progressDetails,
        errorOperation,
        pendingReplayPolicy,
        attemptsRemaining: 3,
      }).pipe(
        Effect.map((processingJobId) => ({
          ...source,
          processingJobId,
        }))
      )
  )
