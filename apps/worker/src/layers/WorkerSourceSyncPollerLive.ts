/**
 * WorkerSourceSyncPollerLive - Postgres poll loop for source sync jobs.
 *
 * The `processing_jobs` row is the source of truth. A dispatch loop lists
 * claimable pending jobs and hands each id to the executor, which claims the
 * row with `FOR UPDATE SKIP LOCKED`; losing a claim race is a logged no-op,
 * so any number of worker processes can poll the same table. A second loop
 * sweeps stale processing jobs (crashed workers) and fails them through the
 * same recovery path the startup repair used, including follow-up
 * materialization and dependent cascade.
 *
 * @module WorkerSourceSyncPollerLive
 */

import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import {
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
  type SourceSyncClaimableJob,
  type SourceSyncStaleActiveJob,
} from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"
import { forkJobPoller, runJobPollerTick } from "./WorkerJobPoller.ts"

const DEFAULT_SYNC_WORKER_CONCURRENCY = 1
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_DISPATCH_BATCH_SIZE = 100
const DEFAULT_STALE_AFTER_MS = 120_000
const DEFAULT_STALE_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000
const PROCESS_WORKER_ID = `worker-${randomUUID()}`

/**
 * WorkerSourceSyncPollerConfig - Runtime configuration for the poll loops.
 */
export interface WorkerSourceSyncPollerConfig {
  readonly concurrency: number
  readonly pollIntervalMs: number
  readonly dispatchBatchSize: number
  readonly staleAfterMs: number
  readonly staleSweepIntervalMs: number
  readonly drainTimeoutMs: number
  readonly workerId: string
}

const loadConfig = Effect.gen(function* () {
  return {
    concurrency: yield* positiveIntConfig({
      name: "SYNC_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_SYNC_WORKER_CONCURRENCY,
    }),
    pollIntervalMs: yield* positiveIntConfig({
      name: "SOURCE_SYNC_POLL_INTERVAL_MS",
      defaultValue: DEFAULT_POLL_INTERVAL_MS,
    }),
    dispatchBatchSize: yield* positiveIntConfig({
      name: "SOURCE_SYNC_DISPATCH_BATCH_SIZE",
      defaultValue: DEFAULT_DISPATCH_BATCH_SIZE,
    }),
    staleAfterMs: yield* positiveIntConfig({
      name: "SOURCE_SYNC_STALE_AFTER_MS",
      defaultValue: DEFAULT_STALE_AFTER_MS,
    }),
    staleSweepIntervalMs: yield* positiveIntConfig({
      name: "SOURCE_SYNC_STALE_SWEEP_INTERVAL_MS",
      defaultValue: DEFAULT_STALE_SWEEP_INTERVAL_MS,
    }),
    drainTimeoutMs: yield* positiveIntConfig({
      name: "WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS",
      defaultValue: DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
    }),
    workerId: yield* Config.schema(
      Schema.Trimmed.check(Schema.isNonEmpty({ message: "WORKER_ID must not be empty" })),
      "WORKER_ID"
    ).pipe(Config.withDefault(PROCESS_WORKER_ID)),
  } satisfies WorkerSourceSyncPollerConfig
})

export const WorkerSourceSyncPollerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* loadConfig
    const repository = yield* SourceSyncJobRepository
    const executor = yield* SourceSyncJobExecutor

    const runClaimableJob = Effect.fn("worker.source-sync.process", { kind: "consumer" })(
      function* (job: SourceSyncClaimableJob) {
        yield* Effect.logInfo(
          {
            workerId: config.workerId,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            mode: job.mode,
          },
          "source-sync-worker:job-started"
        )

        const summary = yield* executor.execute({ jobId: job.id, workerId: config.workerId })

        const logPayload = {
          workerId: config.workerId,
          jobId: job.id,
          sourceId: summary.sourceId,
          mode: job.mode,
          status: summary.status,
        }

        if (summary.status === "failed") {
          yield* Effect.logError(logPayload, "source-sync-worker:job-failed")
        } else if (summary.status === "credit_required") {
          yield* Effect.logWarning(logPayload, "source-sync-worker:job-credit-required")
        } else {
          yield* Effect.logInfo(logPayload, "source-sync-worker:job-finished")
        }
      }
    )

    const runJob = (job: SourceSyncClaimableJob) =>
      runClaimableJob(job).pipe(
        // Losing the claim race to another worker is expected; everything
        // else is already persisted as a job outcome by the executor, so
        // the loop only records it.
        Effect.catchTag("SourceSyncJobExecutionConflictError", (error) =>
          Effect.logDebug(
            { workerId: config.workerId, jobId: error.jobId, reason: error.reason },
            "source-sync-worker:claim-conflict"
          )
        ),
        Effect.catch((error) =>
          Effect.logError(
            { workerId: config.workerId, jobId: job.id, error },
            "source-sync-worker:job-errored"
          )
        )
      )

    const listClaimableJobs = Effect.gen(function* () {
      const dueBefore = DateTime.toDateUtc(yield* DateTime.now)
      return yield* repository.listClaimableJobs({ dueBefore, limit: config.dispatchBatchSize })
    })

    const staleCutoff = Effect.gen(function* () {
      const nowDateTime = yield* DateTime.now
      return {
        now: DateTime.toDateUtc(nowDateTime),
        staleBefore: DateTime.toDateUtc(
          DateTime.subtractDuration(nowDateTime, config.staleAfterMs)
        ),
      }
    })

    // Only processing rows are recovered here: a stuck pending job is simply
    // claimed by the dispatch loop once it is listed again.
    const listStaleProcessingJobs = Effect.gen(function* () {
      const { staleBefore } = yield* staleCutoff
      const staleJobs = yield* repository.listStaleActiveJobs({
        staleBefore,
        limit: config.dispatchBatchSize,
      })
      return staleJobs.filter((job) => job.status === "processing")
    })

    const recoverStaleJob = (job: SourceSyncStaleActiveJob) =>
      Effect.gen(function* () {
        const { now, staleBefore } = yield* staleCutoff
        yield* repository.recoverStaleActiveJob({
          sourceId: job.sourceId,
          jobId: job.id,
          staleBefore,
          message: "Stale-job sweep failed a processing source sync job without a heartbeat.",
          completedAt: now,
        })
        yield* Effect.logWarning(
          {
            workerId: config.workerId,
            jobId: job.id,
            sourceId: job.sourceId,
            staleWorkerId: job.workerId,
            heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
          },
          "source-sync-worker:stale-job-recovered"
        )
      }).pipe(
        // The job finished or was recovered by another worker between the
        // list and the recovery - nothing left to do.
        Effect.catchTags({
          SourceSyncJobExecutionRecordNotFoundError: () => Effect.void,
          SourceSyncJobExecutionRecordConflictError: () => Effect.void,
        }),
        Effect.catch((error) =>
          Effect.logError(
            { workerId: config.workerId, jobId: job.id, error },
            "source-sync-stale-sweep:recovery-failed"
          )
        )
      )

    const dispatchLoop = {
      name: "source-sync-poller",
      pollIntervalMs: config.pollIntervalMs,
      concurrency: config.concurrency,
      drainTimeoutMs: config.drainTimeoutMs,
      listJobs: listClaimableJobs.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning({ cause }, "source-sync-poller:list-failed").pipe(
            Effect.as([] as ReadonlyArray<SourceSyncClaimableJob>)
          )
        )
      ),
      runJob,
    }

    const sweepLoop = {
      name: "source-sync-stale-sweep",
      pollIntervalMs: config.staleSweepIntervalMs,
      concurrency: 1,
      drainTimeoutMs: config.drainTimeoutMs,
      listJobs: listStaleProcessingJobs.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning({ cause }, "source-sync-stale-sweep:list-failed").pipe(
            Effect.as([] as ReadonlyArray<SourceSyncStaleActiveJob>)
          )
        )
      ),
      runJob: recoverStaleJob,
    }

    // Recover crashed jobs once before dispatching, mirroring the old
    // repair-before-consume startup ordering.
    yield* runJobPollerTick(sweepLoop)
    yield* forkJobPoller(sweepLoop)
    yield* forkJobPoller(dispatchLoop)

    yield* Effect.logInfo(
      {
        workerId: config.workerId,
        concurrency: config.concurrency,
        pollIntervalMs: config.pollIntervalMs,
        dispatchBatchSize: config.dispatchBatchSize,
        staleAfterMs: config.staleAfterMs,
        staleSweepIntervalMs: config.staleSweepIntervalMs,
        drainTimeoutMs: config.drainTimeoutMs,
      },
      "source-sync-worker:started"
    )
  })
)
