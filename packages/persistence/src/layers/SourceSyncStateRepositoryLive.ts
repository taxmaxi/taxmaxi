/**
 * SourceSyncStateRepositoryLive - Durable sync checkpoint and failure state persistence.
 *
 * @module SourceSyncStateRepositoryLive
 */

import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  SourceSyncStateRepository,
  type SourceSyncStateRepositoryShape,
} from "@my/sync-engine/services"
import {
  highWatermarkToIso,
  nowDate,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const getExecutionState: SourceSyncStateRepositoryShape["getExecutionState"] = ({ sourceId }) =>
    Effect.gen(function* () {
      const [syncState] = yield* db
        .select({
          cursorPayload: schema.sourceSyncState.cursorPayload,
          highWatermark: schema.sourceSyncState.highWatermark,
          checkpointExternalId: schema.sourceSyncState.checkpointExternalId,
          checkpointRawRecordId: schema.sourceSyncState.checkpointRawRecordId,
        })
        .from(schema.sourceSyncState)
        .where(eq(schema.sourceSyncState.sourceId, sourceId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceSyncStateRepository.getExecutionState"))

      if (syncState === undefined) {
        return {
          importedRecords: 0,
          normalizedRecords: 0,
          failedRecords: 0,
          cursorPayload: null,
          highWatermark: null,
          checkpointExternalId: null,
          checkpointRawRecordId: null,
        }
      }

      return {
        importedRecords: 0,
        normalizedRecords: 0,
        failedRecords: 0,
        cursorPayload: syncState.cursorPayload,
        highWatermark: syncState.highWatermark,
        checkpointExternalId: syncState.checkpointExternalId,
        checkpointRawRecordId: syncState.checkpointRawRecordId,
      }
    })

  const persistProgress: SourceSyncStateRepositoryShape["persistProgress"] = ({
    sourceId,
    jobId,
    state,
    lastSyncedAt,
    lastErrorMessage,
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const progressDetails = {
        importedRecords: state.importedRecords,
        normalizedRecords: state.normalizedRecords,
        failedRecords: state.failedRecords,
        cursorPayload: state.cursorPayload,
        highWatermark: highWatermarkToIso(state.highWatermark),
      }

      yield* db
        .insert(schema.sourceSyncState)
        .values({
          sourceId,
          cursorPayload: state.cursorPayload,
          highWatermark: state.highWatermark,
          checkpointRawRecordId: state.checkpointRawRecordId,
          checkpointExternalId: state.checkpointExternalId,
          lastSyncedAt,
          lastErrorMessage,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.sourceSyncState.sourceId,
          set: {
            cursorPayload: state.cursorPayload,
            highWatermark: state.highWatermark,
            checkpointRawRecordId: state.checkpointRawRecordId,
            checkpointExternalId: state.checkpointExternalId,
            lastSyncedAt,
            lastErrorMessage,
            updatedAt: now,
          },
        })
        .pipe(wrapSyncEngineSqlError("sourceSyncStateRepository.persistProgress.state"))

      yield* db
        .update(schema.processingJobs)
        .set({
          progressDetails,
          checkpointExternalId: state.checkpointExternalId,
          checkpointPayload: state.cursorPayload,
          updatedAt: now,
        })
        .where(eq(schema.processingJobs.id, jobId))
        .pipe(wrapSyncEngineSqlError("sourceSyncStateRepository.persistProgress.job"))
    })

  const persistFailureMetadata: SourceSyncStateRepositoryShape["persistFailureMetadata"] = ({
    sourceId,
    lastErrorMessage,
  }) =>
    db
      .insert(schema.sourceSyncState)
      .values({
        sourceId,
        lastErrorMessage,
        updatedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: schema.sourceSyncState.sourceId,
        set: {
          lastErrorMessage,
          updatedAt: nowDate(),
        },
      })
      .pipe(wrapSyncEngineSqlError("sourceSyncStateRepository.persistFailureMetadata"))

  const clearReplayFailureMetadata: SourceSyncStateRepositoryShape["clearReplayFailureMetadata"] =
    ({ sourceId }) =>
      db
        .insert(schema.sourceSyncState)
        .values({
          sourceId,
          lastErrorMessage: null,
          updatedAt: nowDate(),
        })
        .onConflictDoUpdate({
          target: schema.sourceSyncState.sourceId,
          set: {
            lastErrorMessage: null,
            updatedAt: nowDate(),
          },
        })
        .pipe(wrapSyncEngineSqlError("sourceSyncStateRepository.clearReplayFailureMetadata"))

  return SourceSyncStateRepository.of({
    getExecutionState,
    persistProgress,
    persistFailureMetadata,
    clearReplayFailureMetadata,
  } satisfies SourceSyncStateRepositoryShape)
})

export const SourceSyncStateRepositoryLive = Layer.effect(SourceSyncStateRepository, make)
