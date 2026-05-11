/**
 * SourceRawRecordRepositoryLive - Cached raw source record persistence for sync-engine.
 *
 * @module SourceRawRecordRepositoryLive
 */

import { and, asc, eq, lt, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  SourceRawRecordRepository,
  type SourceRawRecordRepositoryShape,
} from "@my/sync-engine/services"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectRawRecordFields = {
    id: schema.sourceRecordsRaw.id,
    sourceId: schema.sourceRecordsRaw.sourceId,
    provider: schema.sourceRecordsRaw.provider,
    recordType: schema.sourceRecordsRaw.recordType,
    externalAccountId: schema.sourceRecordsRaw.externalAccountId,
    externalRecordId: schema.sourceRecordsRaw.externalRecordId,
    externalParentId: schema.sourceRecordsRaw.externalParentId,
    occurredAt: schema.sourceRecordsRaw.occurredAt,
    payload: schema.sourceRecordsRaw.payload,
    importedAt: schema.sourceRecordsRaw.importedAt,
    normalizedAt: schema.sourceRecordsRaw.normalizedAt,
    normalizationError: schema.sourceRecordsRaw.normalizationError,
    createdAt: schema.sourceRecordsRaw.createdAt,
    updatedAt: schema.sourceRecordsRaw.updatedAt,
  } as const

  const upsertRawBatch: SourceRawRecordRepositoryShape["upsertRawBatch"] = ({
    sourceId,
    records,
  }) =>
    Effect.gen(function* () {
      if (records.length === 0) {
        return {
          checkpointExternalId: null,
          checkpointRawRecordId: null,
          rawRecords: [],
        }
      }

      const now = nowDate()
      const rawRecords = yield* db
        .insert(schema.sourceRecordsRaw)
        .values(
          records.map((record) => ({
            sourceId,
            provider: record.providerKey,
            recordType: record.recordType,
            externalAccountId: record.externalAccountId,
            externalRecordId: record.externalRecordId,
            externalParentId: record.externalParentId,
            occurredAt: record.occurredAt,
            payload: record.payload,
            importedAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [
            schema.sourceRecordsRaw.sourceId,
            schema.sourceRecordsRaw.recordType,
            schema.sourceRecordsRaw.externalRecordId,
          ],
          set: {
            externalAccountId: sql.raw("excluded.external_account_id"),
            externalParentId: sql.raw("excluded.external_parent_id"),
            occurredAt: sql.raw("excluded.occurred_at"),
            payload: sql.raw("excluded.payload"),
            importedAt: now,
            updatedAt: now,
          },
        })
        .returning(selectRawRecordFields)
        .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.upsertRawBatch"))

      const lastRecord = records[records.length - 1]
      const checkpointRow =
        lastRecord === undefined
          ? undefined
          : rawRecords.find(
              (row) =>
                row.recordType === lastRecord.recordType &&
                row.externalRecordId === lastRecord.externalRecordId
            )

      return {
        checkpointExternalId: lastRecord?.externalRecordId ?? null,
        checkpointRawRecordId: checkpointRow?.id ?? null,
        rawRecords,
      }
    })

  const listReplayCandidates: SourceRawRecordRepositoryShape["listReplayCandidates"] = ({
    sourceId,
    importedBefore,
  }) =>
    db
      .select(selectRawRecordFields)
      .from(schema.sourceRecordsRaw)
      .where(
        and(
          eq(schema.sourceRecordsRaw.sourceId, sourceId),
          sql`${schema.sourceRecordsRaw.normalizedAt} is null`,
          sql`${schema.sourceRecordsRaw.normalizationError} is not null`,
          lt(schema.sourceRecordsRaw.importedAt, importedBefore)
        )
      )
      .orderBy(asc(schema.sourceRecordsRaw.occurredAt), asc(schema.sourceRecordsRaw.createdAt))
      .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.listReplayCandidates"))

  const listAllRawRowsForReplay: SourceRawRecordRepositoryShape["listAllRawRowsForReplay"] = ({
    sourceId,
  }) =>
    db
      .select(selectRawRecordFields)
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
      .orderBy(asc(schema.sourceRecordsRaw.occurredAt), asc(schema.sourceRecordsRaw.createdAt))
      .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.listAllRawRowsForReplay"))

  const markRawRecordNormalized: SourceRawRecordRepositoryShape["markRawRecordNormalized"] = ({
    rawRecordId,
  }) =>
    db
      .update(schema.sourceRecordsRaw)
      .set({
        normalizedAt: nowDate(),
        normalizationError: null,
        updatedAt: nowDate(),
      })
      .where(eq(schema.sourceRecordsRaw.id, rawRecordId))
      .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.markRawRecordNormalized"))

  const markRawRecordFailed: SourceRawRecordRepositoryShape["markRawRecordFailed"] = ({
    rawRecordId,
    message,
  }) =>
    db
      .update(schema.sourceRecordsRaw)
      .set({
        normalizationError: message,
        updatedAt: nowDate(),
      })
      .where(eq(schema.sourceRecordsRaw.id, rawRecordId))
      .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.markRawRecordFailed"))

  const resetNormalizationStateForSource: SourceRawRecordRepositoryShape["resetNormalizationStateForSource"] =
    ({ sourceId }) =>
      db
        .update(schema.sourceRecordsRaw)
        .set({
          normalizedAt: null,
          normalizationError: null,
          updatedAt: nowDate(),
        })
        .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
        .pipe(wrapSyncEngineSqlError("sourceRawRecordRepository.resetNormalizationStateForSource"))

  return SourceRawRecordRepository.of({
    upsertRawBatch,
    listReplayCandidates,
    listAllRawRowsForReplay,
    markRawRecordNormalized,
    markRawRecordFailed,
    resetNormalizationStateForSource,
  } satisfies SourceRawRecordRepositoryShape)
})

export const SourceRawRecordRepositoryLive = Layer.effect(SourceRawRecordRepository, make)
