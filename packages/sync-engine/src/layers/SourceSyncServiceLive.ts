/**
 * SourceSyncServiceLive - API-facing source sync orchestration.
 *
 * Writing the pending `processing_jobs` row is the whole hand-off: the worker
 * poll loop claims ready rows straight from Postgres, so there is no queue to
 * feed and nothing to keep in step with the database.
 *
 * @module SourceSyncServiceLive
 */

import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  SourceNotFoundError,
  SourceRepository,
  type SourceSyncJobMode,
  SourceSyncJobNotFoundError,
  SourceSyncJobRepository,
  SourceSyncService,
  SyncEngineStorageError,
  makePlainSourceSyncJobSummary,
  toPublicSourceSyncJobStatus,
  UnsupportedProviderError,
  type SourceSyncJobSummary,
  type SourceSyncServiceShape,
  type SourceSyncSource,
} from "../services/index.ts"
import {
  nowDate,
  recordSourceSyncJobOutcome,
  sourceSyncSpan,
} from "./internal/SourceSyncTelemetry.ts"

const ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS = 30_000
const DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS = 3

const SOURCE_SYNC_MAX_ATTEMPTS_CONFIG = Config.int("SOURCE_SYNC_MAX_ATTEMPTS").pipe(
  Config.map((configuredMaxAttempts) =>
    configuredMaxAttempts > 0 ? configuredMaxAttempts : DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS
  ),
  Config.orElse(() => Config.succeed(DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS))
)

const isStaleActiveProcessingJob = ({
  updatedAt,
  now,
}: {
  readonly updatedAt: Date
  readonly now: Date
}): boolean => now.getTime() - updatedAt.getTime() >= ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS

const make = Effect.gen(function* () {
  const sourceRepository = yield* SourceRepository
  const sourceSyncJobRepository = yield* SourceSyncJobRepository
  const maxAttempts = yield* SOURCE_SYNC_MAX_ATTEMPTS_CONFIG

  const loadSource = ({
    principalId,
    sourceId,
  }: {
    readonly principalId: string
    readonly sourceId: string
  }): Effect.Effect<SourceSyncSource, SourceNotFoundError | SyncEngineStorageError> =>
    sourceRepository.findOwnedSourceSyncContext({ principalId, sourceId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new SourceNotFoundError({ sourceId })),
          onSome: Effect.succeed,
        })
      ),
      sourceSyncSpan({
        name: "source-sync.load-source",
        attributes: { principalId, sourceId },
        kind: "client",
      })
    )

  const recoverStaleActiveJob = ({
    sourceId,
    jobId,
    updatedAt,
  }: {
    readonly sourceId: string
    readonly jobId: string
    readonly updatedAt: Date
  }) =>
    Effect.gen(function* () {
      const message = "Recovered stale source sync job after a previous execution stopped."
      const completedAt = nowDate()
      const staleBefore = DateTime.toDateUtc(
        DateTime.subtractDuration(
          DateTime.makeUnsafe(completedAt),
          ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS
        )
      )

      yield* Effect.logWarning(
        {
          sourceId,
          jobId,
          updatedAt: updatedAt.toISOString(),
          staleAfterMs: ACTIVE_SYNC_JOB_STALE_AFTER_MILLIS,
        },
        "source-sync:recovering-stale-job"
      )

      yield* sourceSyncJobRepository
        .recoverStaleActiveJob({
          sourceId,
          jobId,
          staleBefore,
          message,
          completedAt,
        })
        .pipe(
          Effect.catchTags({
            SourceSyncJobExecutionRecordNotFoundError: (error) =>
              Effect.logWarning({ sourceId, jobId, error }, "source-sync:stale-job-not-found"),
            SourceSyncJobExecutionRecordConflictError: (error) =>
              Effect.logWarning({ sourceId, jobId, error }, "source-sync:stale-job-not-active"),
          })
        )
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.recover-stale-job",
        attributes: { sourceId, jobId, updatedAt: updatedAt.toISOString() },
        kind: "client",
      })
    )

  const runSourceJob = ({
    principalId,
    sourceId,
    mode,
  }: {
    readonly principalId: string
    readonly sourceId: string
    readonly mode: SourceSyncJobMode
  }): Effect.Effect<
    SourceSyncJobSummary,
    UnsupportedProviderError | SourceNotFoundError | SyncEngineStorageError
  > =>
    Effect.gen(function* () {
      const source = yield* loadSource({ principalId, sourceId })
      const provider = source.providerKey ?? "unknown"

      yield* Effect.annotateCurrentSpan({ principalId, sourceId: source.id, provider, mode })

      if (source.providerKey === null) {
        return yield* new UnsupportedProviderError({ provider: "unknown" })
      }

      const [activeJob] = yield* sourceSyncJobRepository.findActiveJob({
        sourceId: source.id,
        principalId,
      })

      if (activeJob !== undefined) {
        if (
          activeJob.status === "processing" &&
          isStaleActiveProcessingJob({ updatedAt: activeJob.updatedAt, now: nowDate() })
        ) {
          yield* recoverStaleActiveJob({
            sourceId: source.id,
            jobId: activeJob.id,
            updatedAt: activeJob.updatedAt,
          })

          yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "recovered-stale-job" })
        } else {
          // A replay needs follow-up handling only behind a non-replay job.
          // An active replay already satisfies the request and can be reused as-is.
          // If the active job still exists, the repository reuses it and records
          // the replay as follow-up work instead of losing the replay request.
          const replayRequest =
            mode === "replay" && activeJob.mode !== "replay"
              ? yield* sourceSyncJobRepository.createOrReuseJob({
                  sourceId: source.id,
                  principalId,
                  mode,
                  maxAttempts,
                })
              : undefined

          if (replayRequest?._tag === "CreatedSourceSyncJob") {
            // The active job finished after findActiveJob, so the repository
            // created the replay directly. The pending row is already visible
            // to the worker poll loop.
            yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "queued" })

            return makePlainSourceSyncJobSummary({
              sourceId: source.id,
              jobId: replayRequest.id,
              status: "queued",
            })
          }

          // A different active job may have replaced the initial snapshot while
          // createOrReuseJob was recording the replay. Return that current owner.
          const jobToReuse =
            replayRequest?._tag === "ReusedSourceSyncJob" ? replayRequest : activeJob

          yield* recordSourceSyncJobOutcome({
            provider,
            mode,
            outcome: jobToReuse.status === "pending" ? "already-queued" : "already-running",
          })

          return makePlainSourceSyncJobSummary({
            sourceId: source.id,
            jobId: jobToReuse.id,
            status: toPublicSourceSyncJobStatus(jobToReuse.status),
          })
        }
      }

      const job = yield* sourceSyncJobRepository.createOrReuseJob({
        sourceId: source.id,
        principalId,
        mode,
        maxAttempts,
      })

      if (job._tag === "ReusedSourceSyncJob") {
        yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "reused-job" })

        return makePlainSourceSyncJobSummary({
          sourceId: source.id,
          jobId: job.id,
          status: toPublicSourceSyncJobStatus(job.status),
        })
      }

      yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "queued" })

      return makePlainSourceSyncJobSummary({
        sourceId: source.id,
        jobId: job.id,
        status: "queued",
      })
    }).pipe(
      sourceSyncSpan({ name: "source-sync.job", attributes: { principalId, sourceId, mode } })
    )

  const getSourceSyncJob: SourceSyncServiceShape["getSourceSyncJob"] = ({
    principalId,
    sourceId,
    jobId,
  }) =>
    sourceSyncJobRepository
      .getJob({ principalId, sourceId, jobId })
      .pipe(
        Effect.catchTag("SourceSyncJobRecordNotVisibleError", () =>
          Effect.fail(new SourceSyncJobNotFoundError({ sourceId, jobId }))
        )
      )

  const startSourceSyncJob: SourceSyncServiceShape["startSourceSyncJob"] = ({
    principalId,
    sourceId,
  }) => runSourceJob({ principalId, sourceId, mode: "sync" })

  const replaySourceSyncJob: SourceSyncServiceShape["replaySourceSyncJob"] = ({
    principalId,
    sourceId,
  }) => runSourceJob({ principalId, sourceId, mode: "replay" })

  return SourceSyncService.of({
    startSourceSyncJob,
    replaySourceSyncJob,
    getSourceSyncJob,
  } satisfies SourceSyncServiceShape)
})

/**
 * SourceSyncServiceLive - Live API-facing source sync layer.
 */
export const SourceSyncServiceLive = Layer.effect(SourceSyncService, make)
