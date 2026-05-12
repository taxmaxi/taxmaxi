/**
 * SourceSyncRunRepositoryLive - User-wide sync run aggregation persistence.
 *
 * @module SourceSyncRunRepositoryLive
 */

import { and, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { schema } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  decodeSourceSyncJobProgressSnapshot,
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"
import {
  SourceSyncRunRecordNotFoundError,
  SourceSyncRunRepository,
  SyncEngineStorageError,
  type SourceSyncRunRepositoryShape,
  type SourceSyncJobStatus,
  type SyncRunItemRecord,
  type SyncRunItemStatus,
  type SyncRunRecord,
  type SyncRunStatus,
} from "@my/sync-engine/services"

interface RunCounters {
  readonly queuedSourceCount: number
  readonly runningSourceCount: number
  readonly completedSourceCount: number
  readonly failedSourceCount: number
}

const NO_SOURCES_TO_SYNC_MESSAGE = "No sources to sync."

const toRunItemStatus = (status: SourceSyncJobStatus): SyncRunItemStatus => {
  switch (status) {
    case "pending":
      return "queued"
    case "processing":
      return "running"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
  }
}

const toRunStatus = ({
  requestedSourceCount,
  queuedSourceCount,
  runningSourceCount,
  completedSourceCount,
  failedSourceCount,
}: {
  readonly requestedSourceCount: number
} & RunCounters): SyncRunStatus => {
  if (requestedSourceCount === 0) {
    return "completed"
  }

  const terminalCount = completedSourceCount + failedSourceCount

  if (terminalCount >= requestedSourceCount) {
    if (failedSourceCount === requestedSourceCount) {
      return "failed"
    }

    if (failedSourceCount > 0) {
      return "partially_failed"
    }

    return "completed"
  }

  if (runningSourceCount > 0) {
    return "running"
  }

  if (queuedSourceCount > 0) {
    return "queued"
  }

  // An orphaned non-empty run with no child rows should stay pollable while
  // the dispatch path records the missing source item failure.
  return "queued"
}

const isTerminalRunStatus = (status: SyncRunStatus): boolean =>
  status === "completed" || status === "failed" || status === "partially_failed"

const zeroCounters: RunCounters = {
  queuedSourceCount: 0,
  runningSourceCount: 0,
  completedSourceCount: 0,
  failedSourceCount: 0,
}

const countItems = (items: ReadonlyArray<{ readonly status: SyncRunItemStatus }>): RunCounters =>
  items.reduce(
    (counts, item) => {
      switch (item.status) {
        case "queued":
          return { ...counts, queuedSourceCount: counts.queuedSourceCount + 1 }
        case "running":
          return { ...counts, runningSourceCount: counts.runningSourceCount + 1 }
        case "completed":
          return { ...counts, completedSourceCount: counts.completedSourceCount + 1 }
        case "failed":
          return { ...counts, failedSourceCount: counts.failedSourceCount + 1 }
      }
    },
    { ...zeroCounters }
  )

const rowToRun = (row: {
  readonly id: string
  readonly principalId: string
  readonly status: SyncRunStatus
  readonly requestedSourceCount: number
  readonly queuedSourceCount: number
  readonly runningSourceCount: number
  readonly completedSourceCount: number
  readonly failedSourceCount: number
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly message: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): SyncRunRecord => ({
  id: row.id,
  principalId: row.principalId,
  status: row.status,
  requestedSourceCount: row.requestedSourceCount,
  queuedSourceCount: row.queuedSourceCount,
  runningSourceCount: row.runningSourceCount,
  completedSourceCount: row.completedSourceCount,
  failedSourceCount: row.failedSourceCount,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  message: row.message,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const rowToRunItem = (item: {
  readonly id: string
  readonly runId: string
  readonly sourceId: string
  readonly processingJobId: string | null
  readonly provider: string | null
  readonly status: SyncRunItemStatus
  readonly progressDetails: unknown
  readonly itemMessage: string | null
  readonly jobMessage: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): Effect.Effect<SyncRunItemRecord> =>
  Effect.gen(function* () {
    const progress = yield* decodeSourceSyncJobProgressSnapshot(item.progressDetails)

    return {
      id: item.id,
      runId: item.runId,
      sourceId: item.sourceId,
      processingJobId: item.processingJobId,
      provider: item.provider,
      status: item.status,
      importedRecords: progress?.importedRecords ?? null,
      normalizedRecords: progress?.normalizedRecords ?? null,
      failedRecords: progress?.failedRecords ?? null,
      message: item.itemMessage ?? item.jobMessage,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectRunFields = {
    id: schema.syncRuns.id,
    principalId: schema.syncRuns.principalId,
    status: schema.syncRuns.status,
    requestedSourceCount: schema.syncRuns.requestedSourceCount,
    queuedSourceCount: schema.syncRuns.queuedSourceCount,
    runningSourceCount: schema.syncRuns.runningSourceCount,
    completedSourceCount: schema.syncRuns.completedSourceCount,
    failedSourceCount: schema.syncRuns.failedSourceCount,
    startedAt: schema.syncRuns.startedAt,
    completedAt: schema.syncRuns.completedAt,
    message: schema.syncRuns.message,
    createdAt: schema.syncRuns.createdAt,
    updatedAt: schema.syncRuns.updatedAt,
  } as const

  const selectItemFields = {
    id: schema.syncRunItems.id,
    runId: schema.syncRunItems.runId,
    sourceId: schema.syncRunItems.sourceId,
    processingJobId: schema.syncRunItems.processingJobId,
    provider: schema.sources.providerKey,
    status: schema.syncRunItems.status,
    progressDetails: schema.processingJobs.progressDetails,
    itemMessage: schema.syncRunItems.message,
    jobMessage: schema.processingJobs.errorMessage,
    createdAt: schema.syncRunItems.createdAt,
    updatedAt: schema.syncRunItems.updatedAt,
  } as const

  const loadRunById = ({
    runId,
    operation,
  }: {
    readonly runId: string
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const [run] = yield* db
        .select(selectRunFields)
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, runId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError(operation))

      return Option.fromNullable(run).pipe(Option.map(rowToRun))
    })

  const loadRunItem = ({
    runId,
    sourceId,
    operation,
  }: {
    readonly runId: string
    readonly sourceId: string
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const [item] = yield* db
        .select(selectItemFields)
        .from(schema.syncRunItems)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.syncRunItems.sourceId))
        .leftJoin(
          schema.processingJobs,
          eq(schema.processingJobs.id, schema.syncRunItems.processingJobId)
        )
        .where(
          and(eq(schema.syncRunItems.runId, runId), eq(schema.syncRunItems.sourceId, sourceId))
        )
        .limit(1)
        .pipe(wrapSyncEngineSqlError(operation))

      if (item === undefined) {
        return yield* Effect.fail(
          new SyncEngineStorageError({
            operation,
            cause: `Missing sync run item for run ${runId} and source ${sourceId}.`,
          })
        )
      }

      return yield* rowToRunItem(item)
    })

  const createRun: SourceSyncRunRepositoryShape["createRun"] = ({
    principalId,
    requestedSourceCount,
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const status = requestedSourceCount === 0 ? "completed" : "queued"
      const [run] = yield* db
        .insert(schema.syncRuns)
        .values({
          principalId,
          status,
          requestedSourceCount,
          startedAt: now,
          completedAt: requestedSourceCount === 0 ? now : null,
          message: requestedSourceCount === 0 ? NO_SOURCES_TO_SYNC_MESSAGE : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(selectRunFields)
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.createRun.insert"))

      if (run === undefined) {
        return yield* Effect.dieMessage("Failed to create sync run.")
      }

      return rowToRun(run)
    })

  const attachRunItem: SourceSyncRunRepositoryShape["attachRunItem"] = ({
    runId,
    sourceId,
    processingJobId,
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select({ status: schema.processingJobs.status })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, processingJobId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.attachRunItem.selectJob"))

      if (job === undefined) {
        return yield* Effect.fail(
          new SyncEngineStorageError({
            operation: "sourceSyncRunRepository.attachRunItem.selectJob",
            cause: `Missing processing job ${processingJobId} for sync run ${runId}.`,
          })
        )
      }

      const now = nowDate()

      yield* db
        .insert(schema.syncRunItems)
        .values({
          runId,
          sourceId,
          processingJobId,
          status: toRunItemStatus(job.status),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [schema.syncRunItems.runId, schema.syncRunItems.sourceId],
        })
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.attachRunItem.insert"))

      return yield* loadRunItem({
        runId,
        sourceId,
        operation: "sourceSyncRunRepository.attachRunItem.select",
      })
    })

  const recordRunItemFailure: SourceSyncRunRepositoryShape["recordRunItemFailure"] = ({
    runId,
    sourceId,
    message,
  }) =>
    Effect.gen(function* () {
      const now = nowDate()

      yield* db
        .insert(schema.syncRunItems)
        .values({
          runId,
          sourceId,
          processingJobId: null,
          status: "failed",
          message,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.syncRunItems.runId, schema.syncRunItems.sourceId],
          set: {
            processingJobId: null,
            status: "failed",
            message,
            updatedAt: now,
          },
        })
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.recordRunItemFailure.upsert"))

      return yield* loadRunItem({
        runId,
        sourceId,
        operation: "sourceSyncRunRepository.recordRunItemFailure.select",
      })
    })

  const getRun: SourceSyncRunRepositoryShape["getRun"] = ({ runId }) =>
    loadRunById({ runId, operation: "sourceSyncRunRepository.getRun.select" })

  const getVisibleRun: SourceSyncRunRepositoryShape["getVisibleRun"] = ({ principalId, runId }) =>
    Effect.gen(function* () {
      const [run] = yield* db
        .select(selectRunFields)
        .from(schema.syncRuns)
        .where(and(eq(schema.syncRuns.id, runId), eq(schema.syncRuns.principalId, principalId)))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.getVisibleRun.select"))

      return Option.fromNullable(run).pipe(Option.map(rowToRun))
    })

  const listRunItems: SourceSyncRunRepositoryShape["listRunItems"] = ({ runId }) =>
    Effect.gen(function* () {
      const items = yield* db
        .select(selectItemFields)
        .from(schema.syncRunItems)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.syncRunItems.sourceId))
        .leftJoin(
          schema.processingJobs,
          eq(schema.processingJobs.id, schema.syncRunItems.processingJobId)
        )
        .where(eq(schema.syncRunItems.runId, runId))
        .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.listRunItems.select"))

      return yield* Effect.forEach(items, rowToRunItem)
    })

  const refreshRunStatus: SourceSyncRunRepositoryShape["refreshRunStatus"] = ({
    runId,
    principalId,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const runWhere =
            principalId === undefined
              ? eq(schema.syncRuns.id, runId)
              : and(eq(schema.syncRuns.id, runId), eq(schema.syncRuns.principalId, principalId))

          const [lockedRun] = yield* tx
            .select(selectRunFields)
            .from(schema.syncRuns)
            .where(runWhere)
            .limit(1)
            .for("update")
            .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.refreshRunStatus.selectRun"))

          if (lockedRun === undefined) {
            return yield* Effect.fail(new SourceSyncRunRecordNotFoundError({ runId }))
          }

          const run = rowToRun(lockedRun)
          const now = nowDate()

          yield* tx
            .update(schema.syncRunItems)
            .set({
              status: sql<SyncRunItemStatus>`
                case ${schema.processingJobs.status}
                  when 'pending' then 'queued'::sync_run_item_status
                  when 'processing' then 'running'::sync_run_item_status
                  when 'completed' then 'completed'::sync_run_item_status
                  when 'failed' then 'failed'::sync_run_item_status
                end
              `,
              updatedAt: now,
            })
            .from(schema.processingJobs)
            .where(
              and(
                eq(schema.syncRunItems.runId, runId),
                eq(schema.processingJobs.id, schema.syncRunItems.processingJobId)
              )
            )
            .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.refreshRunStatus.updateItems"))

          const items = yield* tx
            .select({ status: schema.syncRunItems.status })
            .from(schema.syncRunItems)
            .where(eq(schema.syncRunItems.runId, runId))
            .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.refreshRunStatus.selectItems"))

          const counters = countItems(items)
          const nextStatus = toRunStatus({
            requestedSourceCount: run.requestedSourceCount,
            ...counters,
          })
          const nextCompletedAt = isTerminalRunStatus(nextStatus) ? (run.completedAt ?? now) : null
          const nextMessage =
            run.requestedSourceCount === 0 ? NO_SOURCES_TO_SYNC_MESSAGE : run.message

          const [updatedRun] = yield* tx
            .update(schema.syncRuns)
            .set({
              status: nextStatus,
              queuedSourceCount: counters.queuedSourceCount,
              runningSourceCount: counters.runningSourceCount,
              completedSourceCount: counters.completedSourceCount,
              failedSourceCount: counters.failedSourceCount,
              completedAt: nextCompletedAt,
              message: nextMessage,
              updatedAt: now,
            })
            .where(runWhere)
            .returning(selectRunFields)
            .pipe(wrapSyncEngineSqlError("sourceSyncRunRepository.refreshRunStatus.updateRun"))

          if (updatedRun === undefined) {
            return yield* Effect.fail(new SourceSyncRunRecordNotFoundError({ runId }))
          }

          return rowToRun(updatedRun)
        })
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SourceSyncRunRecordNotFoundError
            ? error
            : toSyncEngineStorageError({
                error,
                operation: "sourceSyncRunRepository.refreshRunStatus.transaction",
              })
        )
      )

  return SourceSyncRunRepository.of({
    createRun,
    attachRunItem,
    recordRunItemFailure,
    getRun,
    getVisibleRun,
    listRunItems,
    refreshRunStatus,
  } satisfies SourceSyncRunRepositoryShape)
})

/**
 * SourceSyncRunRepositoryLive - Live source owner-wide sync run repository layer.
 */
export const SourceSyncRunRepositoryLive = Layer.effect(SourceSyncRunRepository, make)
