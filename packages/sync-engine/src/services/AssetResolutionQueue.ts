/**
 * AssetResolutionQueue - Durable queue contract for asset resolution job dispatch.
 *
 * The database row in `asset_resolution_jobs` is the source of truth for job
 * state, attempts, and retry timing. The queue only transports a job id from
 * the worker's pending-dispatch poller to a consumer; claiming, releasing,
 * and finishing all happen against the database.
 *
 * @module AssetResolutionQueue
 */

import * as Schema from "effect/Schema"

/**
 * Stable BullMQ queue name for asset resolution execution jobs.
 */
export const ASSET_RESOLUTION_QUEUE_NAME = "asset-resolution"

/**
 * Stable BullMQ job name for executing one asset resolution DB job.
 */
export const ASSET_RESOLUTION_JOB_NAME = "asset-resolution.execute"

/**
 * AssetResolutionQueuePayload - Transport payload carrying one resolution job id.
 */
export class AssetResolutionQueuePayload extends Schema.Class<AssetResolutionQueuePayload>(
  "AssetResolutionQueuePayload"
)({
  jobId: Schema.String,
}) {}
