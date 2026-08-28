/**
 * SourceSyncInlineExecution - Test helpers that run sync jobs inline.
 *
 * In production the API only writes the pending `processing_jobs` row and the
 * worker poll loop picks it up. Integration suites have no worker, so these
 * helpers run the executor directly on the created job to get the same end
 * state synchronously.
 *
 * @module SourceSyncInlineExecution
 */

import * as Effect from "effect/Effect"
import {
  SourceSyncJobExecutor,
  SourceSyncService,
  type SourceSyncJobSummary,
} from "../../src/services/index.ts"

/**
 * Run one already-created DB job through the executor.
 */
export const runSourceSyncJobInline = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const executor = yield* SourceSyncJobExecutor
    return yield* executor.execute({ jobId })
  })

const executeWhenQueued = (summary: SourceSyncJobSummary) =>
  summary.status === "queued"
    ? runSourceSyncJobInline({ jobId: summary.jobId })
    : Effect.succeed(summary)

/**
 * Start a sync through the service and execute the created job inline.
 */
export const startSourceSyncJobInline = (params: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const service = yield* SourceSyncService
    const summary = yield* service.startSourceSyncJob(params)
    return yield* executeWhenQueued(summary)
  })

/**
 * Request a replay through the service and execute the created job inline.
 */
export const replaySourceSyncJobInline = (params: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const service = yield* SourceSyncService
    const summary = yield* service.replaySourceSyncJob(params)
    return yield* executeWhenQueued(summary)
  })
