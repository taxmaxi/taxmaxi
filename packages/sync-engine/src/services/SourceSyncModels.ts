/**
 * Shared sync-engine model types used across service and repository contracts.
 *
 * @module SourceSyncModels
 */

import * as Schema from "effect/Schema"

/**
 * SyncJobStatus - External sync status exposed to API clients.
 */
export type SyncJobStatus = "queued" | "running" | "completed" | "failed"

/**
 * SourceSyncJobStatus - Internal processing job status persisted by repositories.
 */
export type SourceSyncJobStatus = "pending" | "processing" | "completed" | "failed"
export type ActiveSourceSyncJobStatus = Extract<SourceSyncJobStatus, "pending" | "processing">

/**
 * SourceSyncPhase - Current user-visible phase of a running source job.
 */
export const SourceSyncPhaseSchema = Schema.Literal(
  "discovering",
  "classifying",
  "reconciling",
  "completed"
)

export type SourceSyncPhase = Schema.Schema.Type<typeof SourceSyncPhaseSchema>

/** Return determinate progress only for phases with a stable denominator. */
export const getSourceSyncProgressPercent = ({
  phase,
  processedRecords,
  totalRecords,
}: {
  readonly phase: SourceSyncPhase | null
  readonly processedRecords: number | null
  readonly totalRecords: number | null
}): number | null => {
  if (phase === "completed") {
    return 100
  }

  if (phase !== "classifying" || processedRecords === null || totalRecords === null) {
    return null
  }

  return totalRecords === 0 ? 100 : Math.min(100, (processedRecords / totalRecords) * 100)
}

/**
 * SourceSyncSource - Minimal source context required by the sync engine.
 */
export interface SourceSyncSource {
  readonly id: string
  readonly principalId: string
  readonly providerKey: string | null
  readonly cexAccountId: string | null
  readonly addressId: string | null
  readonly walletAddress: string | null
}

/**
 * SourceSyncExecutionState - Durable sync progress and replay checkpoint state.
 */
export interface SourceSyncExecutionState {
  readonly phase: SourceSyncPhase
  readonly processedRecords: number
  readonly totalRecords: number | null
  readonly importedRecords: number
  readonly normalizedRecords: number
  readonly failedRecords: number
  readonly cursorPayload: unknown
  readonly highWatermark: Date | null
  readonly checkpointExternalId: string | null
  readonly checkpointRawRecordId: string | null
}

/**
 * SourceSyncJobProgressSnapshot - Progress counters persisted on a processing job.
 */
export interface SourceSyncJobProgressSnapshot {
  readonly mode: SourceSyncJobMode | null
  readonly phase: SourceSyncPhase | null
  readonly processedRecords: number | null
  readonly totalRecords: number | null
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
  readonly cursorPayload: unknown
  readonly highWatermark: string | null
}

/**
 * SourceSyncJobMode - Execution path for one source job.
 */
export const SourceSyncJobModeSchema = Schema.Literal("sync", "replay")

export type SourceSyncJobMode = Schema.Schema.Type<typeof SourceSyncJobModeSchema>

/**
 * SourceSyncActiveJob - Minimal active processing job projection.
 */
export interface SourceSyncActiveJob {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly status: ActiveSourceSyncJobStatus
  readonly updatedAt: Date
  readonly queueName: string | null
  readonly queueJobId: string | null
}

/**
 * SourceSyncExecutionJob - Active DB job projection needed by worker-side execution.
 */
export interface SourceSyncExecutionJob {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly status: ActiveSourceSyncJobStatus
}

/**
 * SourceSyncStaleActiveJob - Active job projection selected for stale-job repair.
 */
export interface SourceSyncStaleActiveJob {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly status: ActiveSourceSyncJobStatus
  readonly startedAt: Date | null
  readonly heartbeatAt: Date | null
  readonly updatedAt: Date
  readonly workerId: string | null
}

/**
 * SourceSyncRepairableActiveJob - Active job projection used by startup recovery.
 */
export interface SourceSyncRepairableActiveJob {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly status: ActiveSourceSyncJobStatus
  readonly startedAt: Date | null
  readonly heartbeatAt: Date | null
  readonly updatedAt: Date
  readonly workerId: string | null
  readonly queueName: string | null
  readonly queueJobId: string | null
}

/**
 * SourceSyncPendingDispatchJob - Pending DB job that must be present in the source-sync queue.
 */
export interface SourceSyncPendingDispatchJob extends SourceSyncRepairableActiveJob {
  readonly status: "pending"
}

/**
 * SourceSyncJobSummary - Public sync job creation/reuse result.
 */
export interface SourceSyncJobSummary {
  readonly sourceId: string
  readonly jobId: string
  readonly status: SyncJobStatus
  readonly message: string | null
}

/**
 * SourceSyncJobDetails - Public sync job status view with counters.
 */
export interface SourceSyncJobDetails extends SourceSyncJobSummary {
  readonly phase: SourceSyncPhase | null
  readonly processedRecords: number | null
  readonly totalRecords: number | null
  readonly progressPercent: number | null
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
}

/**
 * CreatedSourceSyncJob - Fresh processing job created by the repository.
 */
export interface CreatedSourceSyncJob {
  readonly _tag: "CreatedSourceSyncJob"
  readonly id: string
}

/**
 * ReusedSourceSyncJob - Existing active processing job reused by the repository.
 */
export interface ReusedSourceSyncJob {
  readonly _tag: "ReusedSourceSyncJob"
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncJobMode
  readonly status: ActiveSourceSyncJobStatus
  readonly queueName: string | null
  readonly queueJobId: string | null
}

/**
 * CreateOrReuseSourceSyncJobResult - Result of creating a job or returning the concurrent winner.
 */
export type CreateOrReuseSourceSyncJobResult = CreatedSourceSyncJob | ReusedSourceSyncJob

/**
 * SourceRawRecord - Durable cached raw provider payload used for normalization and replay.
 */
export interface SourceRawRecord {
  readonly id: string
  readonly sourceId: string
  readonly provider: string
  readonly recordType: string
  readonly externalAccountId: string | null
  readonly externalRecordId: string
  readonly externalParentId: string | null
  readonly occurredAt: Date
  readonly payload: unknown
  readonly importedAt: Date
  readonly normalizedAt: Date | null
  readonly normalizationError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * SourceSyncCheckpoint - Checkpoint identifiers for one committed raw batch.
 */
export interface SourceSyncCheckpoint {
  readonly checkpointExternalId: string | null
  readonly checkpointRawRecordId: string | null
}
