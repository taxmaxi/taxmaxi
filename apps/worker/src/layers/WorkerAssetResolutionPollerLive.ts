/**
 * WorkerAssetResolutionPollerLive - Postgres poll loop for asset resolution jobs.
 *
 * The `asset_resolution_jobs` row is the source of truth: the executor claims,
 * releases, and finishes jobs there, and retry timing lives in `next_retry_at`.
 * This loop lists dispatchable jobs (pending and due, or processing with a
 * stale heartbeat) and hands each id to the executor. Duplicate dispatches are
 * safe because a claim on an already claimed job is a no-op.
 *
 * @module WorkerAssetResolutionPollerLive
 */

import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { AssetResolutionJobExecutor, AssetResolutionJobRepository } from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"
import { forkJobPoller } from "./WorkerJobPoller.ts"

const DEFAULT_RESOLUTION_WORKER_CONCURRENCY = 1
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const DEFAULT_DISPATCH_BATCH_SIZE = 100
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000
const PROCESS_WORKER_ID = `worker-${randomUUID()}`

/**
 * WorkerAssetResolutionPollerConfig - Runtime configuration for the poll loop.
 */
export interface WorkerAssetResolutionPollerConfig {
  readonly concurrency: number
  readonly pollIntervalMs: number
  readonly staleAfterMs: number
  readonly dispatchBatchSize: number
  readonly drainTimeoutMs: number
  readonly workerId: string
}

const loadConfig = Effect.gen(function* () {
  return {
    concurrency: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_RESOLUTION_WORKER_CONCURRENCY,
    }),
    pollIntervalMs: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_POLL_INTERVAL_MS",
      defaultValue: DEFAULT_POLL_INTERVAL_MS,
    }),
    staleAfterMs: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_STALE_AFTER_MS",
      defaultValue: DEFAULT_STALE_AFTER_MS,
    }),
    dispatchBatchSize: yield* positiveIntConfig({
      name: "ASSET_RESOLUTION_DISPATCH_BATCH_SIZE",
      defaultValue: DEFAULT_DISPATCH_BATCH_SIZE,
    }),
    drainTimeoutMs: yield* positiveIntConfig({
      name: "WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS",
      defaultValue: DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    }),
    workerId: yield* Config.schema(
      Schema.Trimmed.check(Schema.isNonEmpty({ message: "WORKER_ID must not be empty" })),
      "WORKER_ID"
    ).pipe(Config.withDefault(PROCESS_WORKER_ID)),
  } satisfies WorkerAssetResolutionPollerConfig
})

export const WorkerAssetResolutionPollerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* loadConfig
    const repository = yield* AssetResolutionJobRepository
    const executor = yield* AssetResolutionJobExecutor

    const runResolutionJob = Effect.fn("worker.asset-resolution.process", { kind: "consumer" })(
      function* ({ jobId }: { readonly jobId: string }) {
        const result = yield* executor.executeJob({ jobId, workerId: config.workerId })

        yield* Effect.logInfo(
          {
            workerId: config.workerId,
            jobId,
            outcome: result.outcome,
            providerAssetRowId: result.providerAssetRowId,
            evidenceRevision: result.evidenceRevision,
          },
          "asset-resolution-worker:job-finished"
        )
      }
    )

    const runJob = (job: { readonly jobId: string }) =>
      runResolutionJob(job).pipe(
        // The executor already released the job with a retry delay or failed
        // it at the attempt cap, so the database owns the retry.
        Effect.catch((error) =>
          Effect.logError(
            { workerId: config.workerId, jobId: job.jobId, error },
            "asset-resolution-worker:job-failed"
          )
        )
      )

    const listDispatchableJobs = Effect.gen(function* () {
      const nowDateTime = yield* DateTime.now
      return yield* repository.listDispatchableResolutionJobs({
        now: DateTime.toDateUtc(nowDateTime),
        staleBefore: DateTime.toDateUtc(
          DateTime.subtractDuration(nowDateTime, config.staleAfterMs)
        ),
        limit: config.dispatchBatchSize,
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning({ cause }, "asset-resolution-poller:list-failed").pipe(
          Effect.as([] as ReadonlyArray<{ readonly jobId: string }>)
        )
      )
    )

    yield* forkJobPoller({
      name: "asset-resolution-poller",
      pollIntervalMs: config.pollIntervalMs,
      concurrency: config.concurrency,
      drainTimeoutMs: config.drainTimeoutMs,
      listJobs: listDispatchableJobs,
      runJob,
    })

    yield* Effect.logInfo(
      {
        workerId: config.workerId,
        concurrency: config.concurrency,
        pollIntervalMs: config.pollIntervalMs,
        staleAfterMs: config.staleAfterMs,
        dispatchBatchSize: config.dispatchBatchSize,
        drainTimeoutMs: config.drainTimeoutMs,
      },
      "asset-resolution-worker:started"
    )
  })
)
