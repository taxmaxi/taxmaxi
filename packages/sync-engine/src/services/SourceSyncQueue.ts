/**
 * SourceSyncQueue - Durable queue contract for source sync execution.
 *
 * @module SourceSyncQueue
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PrincipalId } from "@my/core/ownership"
import { SourceSyncJobModeSchema, type SourceSyncJobMode } from "./SourceSyncModels.ts"

/**
 * Stable BullMQ queue name for source sync execution jobs.
 */
export const SOURCE_SYNC_QUEUE_NAME = "source-sync"

/**
 * Stable BullMQ job name for executing one source sync DB job.
 */
export const SOURCE_SYNC_JOB_NAME = "source-sync.execute"

export type SourceSyncQueueMode = SourceSyncJobMode

/**
 * SourceSyncQueuePayload - Transport payload used by API producers and worker consumers.
 */
export class SourceSyncQueuePayload extends Schema.Class<SourceSyncQueuePayload>(
  "SourceSyncQueuePayload"
)({
  jobId: Schema.String,
  sourceId: Schema.String,
  principalId: Schema.String,
  mode: SourceSyncJobModeSchema,
}) {}

/**
 * SourceSyncQueueError - Queue enqueue failure.
 */
export class SourceSyncQueueError extends Schema.TaggedError<SourceSyncQueueError>()(
  "SourceSyncQueueError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

/**
 * SourceSyncQueueShape - Source sync queue producer contract.
 */
export interface SourceSyncQueueShape {
  /**
   * Enqueue one source sync job payload for asynchronous execution.
   */
  readonly enqueueSourceSyncJob: (
    payload: SourceSyncQueuePayload
  ) => Effect.Effect<void, SourceSyncQueueError>
}

/**
 * SourceSyncQueue - Context tag for source sync queue producers.
 */
export class SourceSyncQueue extends Context.Service<SourceSyncQueue, SourceSyncQueueShape>()(
  "SourceSyncQueue"
) {}

/** Stable BullMQ queue name for principal-wide accounting recomputations. */
export const CALCULATION_RECOMPUTE_QUEUE_NAME = "calculation-recompute"

/** Stable BullMQ job name for one principal-wide accounting recomputation. */
export const CALCULATION_RECOMPUTE_JOB_NAME = "calculation.recompute"

/** Transport payload for one principal-wide calculation request. */
export class CalculationRecomputeQueuePayload extends Schema.Class<CalculationRecomputeQueuePayload>(
  "CalculationRecomputeQueuePayload"
)({
  principalId: PrincipalId,
}) {}

/** Failure to enqueue a calculation request. */
export class CalculationRecomputeQueueError extends Schema.TaggedError<CalculationRecomputeQueueError>()(
  "CalculationRecomputeQueueError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

/** Queue producer used after a source job commits its completed state. */
export interface CalculationRecomputeQueueShape {
  readonly enqueuePrincipalRecompute: (
    principalId: string
  ) => Effect.Effect<void, CalculationRecomputeQueueError>
}

/** Context tag for principal calculation requests. */
export class CalculationRecomputeQueue extends Context.Service<
  CalculationRecomputeQueue,
  CalculationRecomputeQueueShape
>()("CalculationRecomputeQueue") {}
