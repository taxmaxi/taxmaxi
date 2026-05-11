/**
 * SourceSyncQueue - Durable queue contract for source sync execution.
 *
 * @module SourceSyncQueue
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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
  userId: Schema.String,
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
export class SourceSyncQueue extends Context.Tag("SourceSyncQueue")<
  SourceSyncQueue,
  SourceSyncQueueShape
>() {}
