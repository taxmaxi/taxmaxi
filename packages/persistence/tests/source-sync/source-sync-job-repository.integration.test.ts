import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  SourceSyncJobRepository,
  type SourceSyncExecutionState,
  type SourceSyncJobMode,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_sync_job_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncJobRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncJobRepositoryLive }))

const completedState: SourceSyncExecutionState = {
  phase: "completed",
  processedRecords: 4,
  totalRecords: 4,
  fetchedRecords: 4,
  normalizedRecords: 3,
  failedRecords: 1,
  cursorPayload: { page: "done" },
  highWatermark: new Date("2025-01-03T00:00:00.000Z"),
  checkpointExternalId: "tx-4",
  checkpointRawRecordId: "00000000-0000-0000-0000-000000000999",
}

const successfulCompletedState: SourceSyncExecutionState = {
  ...completedState,
  failedRecords: 0,
}

const createJob = ({
  mode = "sync",
  maxAttempts = 3,
  sourceId = TEST_SOURCE_ID,
  principalId = TEST_PRINCIPAL_ID,
}: {
  readonly mode?: SourceSyncJobMode
  readonly maxAttempts?: number
  readonly sourceId?: string
  readonly principalId?: string
} = {}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.createOrReuseJob({
        sourceId,
        principalId,
        mode,
        maxAttempts,
      })
    )
  )

const seedSourceFixture = ({
  sourceId,
  principalId,
}: {
  readonly sourceId: string
  readonly principalId: string
}) => runPg(seedSyncEngineRepositoryFixture({ sourceId, userId: sourceId, principalId }))

const selectProcessingJob = ({ jobId }: { readonly jobId: string }) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [job] = yield* db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId))
        .limit(1)

      if (job === undefined) {
        return yield* Effect.die(`Missing processing job ${jobId}`)
      }

      return job
    })
  )

const claimJob = ({
  jobId,
  workerId = "worker-1",
}: {
  readonly jobId: string
  readonly workerId?: string
}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.claimJob({
        jobId,
        workerId,
        startedAt: new Date("2025-01-02T00:00:00.000Z"),
      })
    )
  )

const updateProcessingJobStaleTimestamps = ({
  jobId,
  heartbeatAt,
  updatedAt,
}: {
  readonly jobId: string
  readonly heartbeatAt: Date | null
  readonly updatedAt: Date
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db
        .update(schema.processingJobs)
        .set({ heartbeatAt, updatedAt })
        .where(eq(schema.processingJobs.id, jobId))
    })
  )

const attachQueueMetadata = ({
  jobId,
  queueJobId,
  queuedAt,
}: {
  readonly jobId: string
  readonly queueJobId: string
  readonly queuedAt: Date
}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.attachQueueMetadata({
        jobId,
        queueName: "source-sync",
        queueJobId,
        queuedAt,
      })
    )
  )

describe("SourceSyncJobRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  it("creates a sync job as pending with sync mode", async () => {
    const created = await createJob({ mode: "sync" })

    expect(created._tag).toBe("CreatedSourceSyncJob")

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.mode).toBe("sync")
    expect(job.status).toBe("pending")
    expect(job.attemptCount).toBe(0)
    expect(job.maxAttempts).toBe(3)
  })

  it("creates a replay job as pending with replay mode", async () => {
    const created = await createJob({ mode: "replay", maxAttempts: 5 })

    expect(created._tag).toBe("CreatedSourceSyncJob")

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.mode).toBe("replay")
    expect(job.status).toBe("pending")
    expect(job.maxAttempts).toBe(5)
  })

  it("reuses the active job for a second create on the same source", async () => {
    const created = await createJob({ mode: "sync" })
    const reused = await createJob({ mode: "sync" })

    expect(reused).toEqual({
      _tag: "ReusedSourceSyncJob",
      id: created.id,
      sourceId: TEST_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      mode: "sync",
      status: "pending",
      queueName: null,
      queueJobId: null,
    })
  })

  it("does not create a second active row when replay is requested while sync is active", async () => {
    const created = await createJob({ mode: "sync" })
    const replay = await createJob({ mode: "replay" })

    expect(replay).toEqual({
      _tag: "ReusedSourceSyncJob",
      id: created.id,
      sourceId: TEST_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      mode: "sync",
      status: "pending",
      queueName: null,
      queueJobId: null,
    })

    const activeJobs = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.findActiveJob({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
        })
      )
    )

    expect(activeJobs).toHaveLength(1)
    expect(activeJobs[0]?.id).toBe(created.id)
    expect(activeJobs[0]?.mode).toBe("sync")

    const activeJob = await selectProcessingJob({ jobId: created.id })
    expect(activeJob.followUpMode).toBe("replay")
  })

  it("retries replay intent when the active-row update loses a completion race", async () => {
    const created = await createJob({ mode: "sync" })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.execute(sql.raw("CREATE SEQUENCE test_follow_up_update_attempt_seq"))
        yield* db.execute(
          sql.raw(`
            CREATE FUNCTION test_skip_first_follow_up_update()
            RETURNS trigger AS $$
            BEGIN
              IF nextval('test_follow_up_update_attempt_seq') = 1 THEN
                RETURN NULL;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
          `)
        )
        yield* db.execute(
          sql.raw(`
            CREATE TRIGGER test_skip_first_follow_up_update
            BEFORE UPDATE OF follow_up_mode ON processing_jobs
            FOR EACH ROW
            EXECUTE FUNCTION test_skip_first_follow_up_update()
          `)
        )
      })
    )

    try {
      const replay = await createJob({ mode: "replay" })

      expect(replay).toMatchObject({
        _tag: "ReusedSourceSyncJob",
        id: created.id,
      })

      const activeJob = await selectProcessingJob({ jobId: created.id })
      expect(activeJob.followUpMode).toBe("replay")
    } finally {
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle

          yield* db.execute(
            sql.raw("DROP TRIGGER IF EXISTS test_skip_first_follow_up_update ON processing_jobs")
          )
          yield* db.execute(sql.raw("DROP FUNCTION IF EXISTS test_skip_first_follow_up_update()"))
          yield* db.execute(sql.raw("DROP SEQUENCE IF EXISTS test_follow_up_update_attempt_seq"))
        })
      )
    }
  })

  it("attaches queue metadata to a pending job", async () => {
    const created = await createJob()
    const queuedAt = new Date("2025-01-02T00:00:00.000Z")

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.attachQueueMetadata({
          jobId: created.id,
          queueName: "source-sync",
          queueJobId: "bull-job-1",
          queuedAt,
        })
      )
    )

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.queueName).toBe("source-sync")
    expect(job.queueJobId).toBe("bull-job-1")
    expect(job.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
  })

  it("attaches queue metadata after a worker has claimed the job", async () => {
    const created = await createJob()
    const queuedAt = new Date("2025-01-02T00:00:01.000Z")
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.attachQueueMetadata({
          jobId: created.id,
          queueName: "source-sync",
          queueJobId: "bull-job-1",
          queuedAt,
        })
      )
    )

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("processing")
    expect(job.queueName).toBe("source-sync")
    expect(job.queueJobId).toBe("bull-job-1")
    expect(job.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
  })

  it("claims a pending job for worker execution", async () => {
    const created = await createJob()
    const claimed = await claimJob({ jobId: created.id, workerId: "worker-1" })

    expect(claimed).toMatchObject({
      id: created.id,
      sourceId: TEST_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      mode: "sync",
      status: "processing",
    })

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("processing")
    expect(job.workerId).toBe("worker-1")
    expect(job.startedAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
    expect(job.heartbeatAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
  })

  it("returns a typed conflict when a second worker claims the same job", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    const secondClaim = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository
          .claimJob({
            jobId: created.id,
            workerId: "worker-2",
            startedAt: new Date("2025-01-02T00:01:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(secondClaim._tag).toBe("Failure")
    if (secondClaim._tag === "Failure") {
      expect(secondClaim.failure._tag).toBe("SourceSyncJobExecutionRecordConflictError")
    }
  })

  it("heartbeats only when the worker id matches", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    const rejectedHeartbeat = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository
          .heartbeatJob({
            jobId: created.id,
            workerId: "worker-2",
            heartbeatAt: new Date("2025-01-02T00:02:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(rejectedHeartbeat._tag).toBe("Failure")

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.heartbeatJob({
          jobId: created.id,
          workerId: "worker-1",
          heartbeatAt: new Date("2025-01-02T00:03:00.000Z"),
        })
      )
    )

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.heartbeatAt?.toISOString()).toBe("2025-01-02T00:03:00.000Z")
  })

  it("records retryable failure metadata without terminally failing the job", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    const nextRetryAt = new Date("2025-01-02T00:05:00.000Z")

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recordRetryableFailure({
          jobId: created.id,
          message: "Coinbase API timeout",
          attemptCount: 1,
          nextRetryAt,
        })
      )
    )

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("pending")
    expect(job.attemptCount).toBe(1)
    expect(job.errorMessage).toBe("Coinbase API timeout")
    expect(job.nextRetryAt?.toISOString()).toBe(nextRetryAt.toISOString())
    expect(job.workerId).toBeNull()
  })

  it("reclaims the same job after a retryable failure and preserves attempts", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recordRetryableFailure({
          jobId: created.id,
          message: "Retry after provider timeout",
          attemptCount: 1,
          nextRetryAt: new Date("2025-01-02T00:05:00.000Z"),
        })
      )
    )

    const reclaimed = await claimJob({ jobId: created.id, workerId: "worker-2" })
    const job = await selectProcessingJob({ jobId: created.id })

    expect(reclaimed).toMatchObject({
      id: created.id,
      status: "processing",
    })
    expect(job.attemptCount).toBe(1)
    expect(job.workerId).toBe("worker-2")
    expect(job.status).toBe("processing")
  })

  it("terminally fails a processing job", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId: created.id,
          message: "Final failure",
          completedAt: new Date("2025-01-02T00:10:00.000Z"),
        })
      )
    )

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("failed")
    expect(job.errorMessage).toBe("Final failure")
    expect(job.completedAt?.toISOString()).toBe("2025-01-02T00:10:00.000Z")
  })

  it("completes a processing job with final counters and checkpoint payload", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({
          jobId: created.id,
          state: completedState,
        })
      )
    )

    const job = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: created.id,
        })
      )
    )
    const persisted = await selectProcessingJob({ jobId: created.id })

    expect(job).toEqual({
      sourceId: TEST_SOURCE_ID,
      jobId: created.id,
      status: "completed",
      phase: "completed",
      processedRecords: 4,
      totalRecords: 4,
      progressPercent: 100,
      fetchedRecords: 4,
      normalizedRecords: 3,
      failedRecords: 1,
      message: null,
      resumable: false,
      creditOutcome: null,
    })
    expect(persisted.checkpointExternalId).toBe("tx-4")
    expect(persisted.checkpointPayload).toEqual({ page: "done" })
  })

  it("lists stale active jobs by old heartbeat or old updated timestamp", async () => {
    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const oldTimestamp = new Date("2025-01-02T00:00:00.000Z")
    const recentTimestamp = new Date("2025-01-02T00:20:00.000Z")

    const heartbeatJob = await createJob()
    await claimJob({ jobId: heartbeatJob.id, workerId: "worker-1" })
    await updateProcessingJobStaleTimestamps({
      jobId: heartbeatJob.id,
      heartbeatAt: oldTimestamp,
      updatedAt: recentTimestamp,
    })

    const staleByHeartbeat = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listStaleActiveJobs({ staleBefore, limit: 10 })
      )
    )

    expect(staleByHeartbeat.map((job) => job.id)).toContain(heartbeatJob.id)

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recoverStaleActiveJob({
          sourceId: TEST_SOURCE_ID,
          jobId: heartbeatJob.id,
          staleBefore,
          message: "Recovered stale heartbeat",
          completedAt: new Date("2025-01-02T00:30:00.000Z"),
        })
      )
    )

    const pendingJob = await createJob()
    await updateProcessingJobStaleTimestamps({
      jobId: pendingJob.id,
      heartbeatAt: null,
      updatedAt: oldTimestamp,
    })

    const staleByUpdatedAt = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listStaleActiveJobs({ staleBefore, limit: 10 })
      )
    )

    expect(staleByUpdatedAt.map((job) => job.id)).toContain(pendingJob.id)
  })

  it("does not recover a processing job that heartbeated after stale selection", async () => {
    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const staleHeartbeatAt = new Date("2025-01-02T00:00:00.000Z")
    const freshHeartbeatAt = new Date("2025-01-02T00:20:00.000Z")
    const created = await createJob()

    await claimJob({ jobId: created.id, workerId: "worker-1" })
    await updateProcessingJobStaleTimestamps({
      jobId: created.id,
      heartbeatAt: staleHeartbeatAt,
      updatedAt: staleHeartbeatAt,
    })

    const selected = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listStaleActiveJobs({ staleBefore, limit: 10 })
      )
    )
    expect(selected.map((job) => job.id)).toContain(created.id)

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.heartbeatJob({
          jobId: created.id,
          workerId: "worker-1",
          heartbeatAt: freshHeartbeatAt,
        })
      )
    )

    const recovery = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository
          .recoverStaleActiveJob({
            sourceId: TEST_SOURCE_ID,
            jobId: created.id,
            staleBefore,
            message: "Recovered stale source sync job after timeout.",
            completedAt: new Date("2025-01-02T00:30:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(recovery._tag).toBe("Failure")
    if (recovery._tag === "Failure") {
      expect(recovery.failure._tag).toBe("SourceSyncJobExecutionRecordConflictError")
    }
    expect(await selectProcessingJob({ jobId: created.id })).toMatchObject({
      status: "processing",
      heartbeatAt: freshHeartbeatAt,
      workerId: "worker-1",
    })
  })

  it("releases replay credits owned by a recovered stale job", async () => {
    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const staleAt = new Date("2025-01-02T00:00:00.000Z")
    const created = await createJob({ mode: "replay" })

    await claimJob({ jobId: created.id, workerId: "worker-1" })
    await updateProcessingJobStaleTimestamps({
      jobId: created.id,
      heartbeatAt: staleAt,
      updatedAt: staleAt,
    })
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.creditLedger).values([
          {
            userId: TEST_USER_ID,
            delta: -1,
            kind: "transaction_usage",
            reference: "test:stale-replay-owned",
            paymentReference: null,
            replayReservationId: created.id,
            expiresAt: null,
          },
          {
            userId: TEST_USER_ID,
            delta: -1,
            kind: "transaction_usage",
            reference: "test:stale-replay-adopted",
            paymentReference: null,
            replayReservationId: "successor-job",
            expiresAt: null,
          },
        ])
      })
    )

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recoverStaleActiveJob({
          sourceId: TEST_SOURCE_ID,
          jobId: created.id,
          staleBefore,
          message: "Recovered stale replay job.",
          completedAt: new Date("2025-01-02T00:30:00.000Z"),
        })
      )
    )

    const usage = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            reference: schema.creditLedger.reference,
            replayReservationId: schema.creditLedger.replayReservationId,
          })
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.kind, "transaction_usage"))
      })
    )

    expect(usage).toEqual([
      {
        reference: "test:stale-replay-adopted",
        replayReservationId: "successor-job",
      },
    ])
  })

  it("lists repairable active jobs by queue metadata and stale execution predicates", async () => {
    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const oldTimestamp = new Date("2025-01-02T00:00:00.000Z")
    const recentTimestamp = new Date("2025-01-02T00:20:00.000Z")
    const fixtures = {
      freshPending: {
        sourceId: "00000000-0000-0000-0000-000000000291",
        principalId: "00000000-0000-0000-0000-000000000191",
      },
      stalePending: {
        sourceId: "00000000-0000-0000-0000-000000000292",
        principalId: "00000000-0000-0000-0000-000000000192",
      },
      staleHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000293",
        principalId: "00000000-0000-0000-0000-000000000193",
      },
      recentHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000294",
        principalId: "00000000-0000-0000-0000-000000000194",
      },
      nullHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000295",
        principalId: "00000000-0000-0000-0000-000000000195",
      },
      completed: {
        sourceId: "00000000-0000-0000-0000-000000000296",
        principalId: "00000000-0000-0000-0000-000000000196",
      },
      failed: {
        sourceId: "00000000-0000-0000-0000-000000000297",
        principalId: "00000000-0000-0000-0000-000000000197",
      },
    } as const

    await Promise.all(Object.values(fixtures).map(seedSourceFixture))

    const pendingMissingMetadata = await createJob()
    const freshPending = await createJob(fixtures.freshPending)
    await attachQueueMetadata({
      jobId: freshPending.id,
      queueJobId: "fresh-pending",
      queuedAt: recentTimestamp,
    })

    const stalePending = await createJob(fixtures.stalePending)
    await attachQueueMetadata({
      jobId: stalePending.id,
      queueJobId: "stale-pending",
      queuedAt: oldTimestamp,
    })

    const staleHeartbeat = await createJob(fixtures.staleHeartbeat)
    await claimJob({ jobId: staleHeartbeat.id, workerId: "worker-stale" })
    await updateProcessingJobStaleTimestamps({
      jobId: staleHeartbeat.id,
      heartbeatAt: oldTimestamp,
      updatedAt: recentTimestamp,
    })

    const recentHeartbeat = await createJob(fixtures.recentHeartbeat)
    await claimJob({ jobId: recentHeartbeat.id, workerId: "worker-recent" })
    await updateProcessingJobStaleTimestamps({
      jobId: recentHeartbeat.id,
      heartbeatAt: recentTimestamp,
      updatedAt: oldTimestamp,
    })

    const nullHeartbeat = await createJob(fixtures.nullHeartbeat)
    await claimJob({ jobId: nullHeartbeat.id, workerId: "worker-null-heartbeat" })
    await updateProcessingJobStaleTimestamps({
      jobId: nullHeartbeat.id,
      heartbeatAt: null,
      updatedAt: oldTimestamp,
    })

    const completed = await createJob(fixtures.completed)
    await claimJob({ jobId: completed.id, workerId: "worker-completed" })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: completed.id, state: completedState })
      )
    )

    const failed = await createJob(fixtures.failed)
    await claimJob({ jobId: failed.id, workerId: "worker-failed" })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId: failed.id,
          message: "Failed terminally",
          completedAt: recentTimestamp,
        })
      )
    )

    const repairableJobs = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listRepairableActiveJobs({
          pendingStaleBefore: staleBefore,
          processingStaleBefore: staleBefore,
          limit: 20,
        })
      )
    )
    const repairableJobIds = repairableJobs.map((job) => job.id)

    expect(repairableJobIds).toContain(pendingMissingMetadata.id)
    expect(repairableJobIds).toContain(stalePending.id)
    expect(repairableJobIds).toContain(staleHeartbeat.id)
    expect(repairableJobIds).toContain(nullHeartbeat.id)
    expect(repairableJobIds).not.toContain(freshPending.id)
    expect(repairableJobIds).not.toContain(recentHeartbeat.id)
    expect(repairableJobIds).not.toContain(completed.id)
    expect(repairableJobIds).not.toContain(failed.id)

    const pendingJobsNeedingDispatch = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listPendingJobsNeedingDispatch({ staleBefore, limit: 20 })
      )
    )
    const pendingJobIds = pendingJobsNeedingDispatch.map((job) => job.id)

    expect(pendingJobIds).toContain(pendingMissingMetadata.id)
    expect(pendingJobIds).toContain(stalePending.id)
    expect(pendingJobIds).not.toContain(freshPending.id)
    expect(pendingJobIds).not.toContain(staleHeartbeat.id)
    expect(pendingJobIds).not.toContain(nullHeartbeat.id)
  })

  it("dispatches dependent override replays only after every owner replay succeeds", async () => {
    const dependentSourceId = "00000000-0000-0000-0000-000000000298"
    const staleBefore = new Date("2025-01-03T00:00:00.000Z")
    const { overrideId } = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [coinbase] = yield* db
          .select({ id: schema.cex.id })
          .from(schema.cex)
          .where(eq(schema.cex.name, "coinbase"))
          .limit(1)
        const [blockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
          .limit(1)

        if (coinbase === undefined || blockchain === undefined) {
          return yield* Effect.die("Missing override replay dependency fixtures")
        }

        const [account] = yield* db
          .insert(schema.cexAccount)
          .values({
            cexId: coinbase.id,
            principalId: TEST_PRINCIPAL_ID,
            providerUserId: "dispatch-dependent-user",
            providerAccountId: "dispatch-dependent-account",
            accessToken: "dispatch-dependent-access-token",
            refreshToken: "dispatch-dependent-refresh-token",
            expiresAt: new Date("2026-01-01T00:00:00.000Z"),
            scopes: "wallet:accounts:read wallet:transactions:read",
          })
          .returning({ id: schema.cexAccount.id })

        if (account === undefined) return yield* Effect.die("Failed to seed dependent account")

        yield* db.insert(schema.sources).values({
          id: dependentSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Dependent Coinbase Source",
          providerKey: "coinbase",
          sourceableType: "cex",
          cexAccountId: account.id,
          addressId: null,
        })

        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "inclusion",
            targetKind: "representation",
            blockchainId: blockchain.id,
            representationType: "token",
            contractAddress: "0x0000000000000000000000000000000000000298",
            action: "set",
            inspectedSystemRevision: "dispatch-dependency-test",
            inspectedInclusionState: "excluded",
            inspectedInclusionReason: "taxmaxi_policy",
            replacementInclusionState: "included",
            actorId: TEST_USER_ID,
            reason: "Test replay dispatch dependencies",
          })
          .returning({ id: schema.principalAssetOverrides.id })

        if (override === undefined) return yield* Effect.die("Failed to seed replay override")

        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: TEST_SOURCE_ID,
          blockchainId: blockchain.id,
          representationType: "token",
          contractAddress: "0x0000000000000000000000000000000000000298",
        })

        return { overrideId: override.id }
      })
    )
    const ownerJob = await createJob({ mode: "replay" })
    const dependentJob = await createJob({
      mode: "replay",
      sourceId: dependentSourceId,
      principalId: TEST_PRINCIPAL_ID,
    })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.principalAssetOverrideApplications).values([
          {
            overrideId,
            sourceId: TEST_SOURCE_ID,
            replayJobId: ownerJob.id,
            dependsOnSourceIds: [],
          },
          {
            overrideId,
            sourceId: dependentSourceId,
            replayJobId: dependentJob.id,
            dependsOnSourceIds: [TEST_SOURCE_ID],
          },
        ])
      })
    )

    const listPendingJobIds = () =>
      runRepository(
        Effect.flatMap(SourceSyncJobRepository, (repository) =>
          repository
            .listPendingJobsNeedingDispatch({ staleBefore, limit: 20 })
            .pipe(Effect.map((jobs) => jobs.map((job) => job.id)))
        )
      )

    expect(await listPendingJobIds()).toEqual(expect.arrayContaining([ownerJob.id]))
    expect(await listPendingJobIds()).not.toContain(dependentJob.id)

    await claimJob({ jobId: ownerJob.id })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId: ownerJob.id,
          message: "Owner replay failed",
          completedAt: new Date("2025-01-02T00:00:00.000Z"),
        })
      )
    )
    expect(await listPendingJobIds()).not.toContain(dependentJob.id)

    const retryOwnerJob = await createJob({ mode: "replay" })
    expect(await listPendingJobIds()).toContain(retryOwnerJob.id)
    expect(await listPendingJobIds()).not.toContain(dependentJob.id)

    await claimJob({ jobId: retryOwnerJob.id })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: retryOwnerJob.id, state: successfulCompletedState })
      )
    )

    expect(await listPendingJobIds()).toContain(dependentJob.id)
  })

  it("recovers a stale active job and allows a fresh job to start", async () => {
    const staleBefore = new Date("2025-01-03T00:00:00.000Z")
    const staleHeartbeatAt = new Date("2025-01-02T00:00:00.000Z")
    const created = await createJob()

    await claimJob({ jobId: created.id })
    await updateProcessingJobStaleTimestamps({
      jobId: created.id,
      heartbeatAt: staleHeartbeatAt,
      updatedAt: staleHeartbeatAt,
    })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recoverStaleActiveJob({
          sourceId: TEST_SOURCE_ID,
          jobId: created.id,
          staleBefore,
          message: "Recovered stale source sync job after timeout.",
          completedAt: new Date("2025-01-04T00:00:00.000Z"),
        })
      )
    )

    const activeJobs = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.findActiveJob({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
        })
      )
    )

    expect(activeJobs).toHaveLength(0)

    const nextJob = await createJob()

    expect(nextJob._tag).toBe("CreatedSourceSyncJob")
    expect(nextJob.id).not.toBe(created.id)
  })

  it("maps a credit-required job to a resumable public status with its credit outcome, not a generic failure", async () => {
    const created = await createJob()
    await claimJob({ jobId: created.id, workerId: "worker-1" })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failCreditRequiredJob({
          jobId: created.id,
          completedAt: new Date("2025-01-02T00:10:00.000Z"),
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 3,
          additionalCreditsRequired: 2,
        })
      )
    )

    const job = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: created.id,
        })
      )
    )
    const persisted = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("credit_required")
    expect(job.resumable).toBe(true)
    expect(job.creditOutcome).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
      creditsConsumed: 3,
      additionalCreditsRequired: 2,
    })
    // No server-authored message: clients build localized copy from the
    // status and credit outcome instead.
    expect(job.message).toBeNull()
    expect(persisted.status).toBe("credit_required")
  })

  it("maps persisted job states to API-visible queued, running, completed, and failed statuses", async () => {
    const queued = await createJob()
    const queuedStatus = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: queued.id,
        })
      )
    )

    expect(queuedStatus.status).toBe("queued")

    await claimJob({ jobId: queued.id, workerId: "worker-1" })

    const runningStatus = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: queued.id,
        })
      )
    )

    expect(runningStatus.status).toBe("running")

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: queued.id, state: completedState })
      )
    )

    const completedStatus = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: queued.id,
        })
      )
    )

    expect(completedStatus.status).toBe("completed")

    const failed = await createJob()
    await claimJob({ jobId: failed.id, workerId: "worker-1" })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId: failed.id,
          message: "Failed terminally",
          completedAt: new Date("2025-01-04T00:00:00.000Z"),
        })
      )
    )

    const failedStatus = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: failed.id,
        })
      )
    )

    expect(failedStatus.status).toBe("failed")
    expect(failedStatus.message).toBe("Failed terminally")
  })

  it("uses the schema default sync mode when a processing job is inserted without a mode", async () => {
    const jobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            status: "pending",
          })
          .returning({ id: schema.processingJobs.id })

        if (job === undefined) {
          return yield* Effect.die("Failed to insert processing job without mode")
        }

        return job.id
      })
    )

    const executionJob = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) => repository.getExecutionJob({ jobId }))
    )

    expect(executionJob.mode).toBe("sync")
  })

  it("materializes a durable replay follow-up when an active job completes", async () => {
    const activeJobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "processing",
            followUpMode: "replay",
          })
          .returning({ id: schema.processingJobs.id })

        if (job === undefined) return yield* Effect.die("Failed to create active sync job")
        return job.id
      })
    )

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: activeJobId, state: completedState })
      )
    )

    const jobs = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            id: schema.processingJobs.id,
            mode: schema.processingJobs.mode,
            status: schema.processingJobs.status,
            followUpJobId: schema.processingJobs.followUpJobId,
          })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
      })
    )

    const followUpJob = jobs.find((job) => job.mode === "replay")
    expect(followUpJob).toMatchObject({ mode: "replay", status: "pending" })
    expect(jobs.find((job) => job.id === activeJobId)).toEqual({
      id: activeJobId,
      mode: "sync",
      status: "completed",
      followUpJobId: followUpJob?.id,
    })

    const visibleJob = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: activeJobId,
        })
      )
    )

    expect(visibleJob).toMatchObject({ jobId: followUpJob?.id, status: "queued" })
  })

  it.each([
    { initialStatus: "failed" as const, progressDetails: null },
    { initialStatus: "completed" as const, progressDetails: { failedRecords: 1 } },
  ])(
    "relinks a required override application after a $initialStatus replay",
    async ({ initialStatus, progressDetails }) => {
      const { applicationId, initialReplayJobId } = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [blockchain] = yield* db
            .select({ id: schema.blockchains.id })
            .from(schema.blockchains)
            .where(eq(schema.blockchains.name, "base"))
            .limit(1)

          if (blockchain === undefined) return yield* Effect.die("Missing Base blockchain")

          yield* db.insert(schema.sourceRepresentationUses).values({
            sourceId: TEST_SOURCE_ID,
            blockchainId: blockchain.id,
            representationType: "token",
            contractAddress: "0x0000000000000000000000000000000000000149",
          })

          const [override] = yield* db
            .insert(schema.principalAssetOverrides)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              kind: "inclusion",
              targetKind: "representation",
              blockchainId: blockchain.id,
              representationType: "token",
              contractAddress: "0x0000000000000000000000000000000000000149",
              action: "set",
              inspectedSystemRevision: "required-replay-retry-test",
              inspectedInclusionState: "excluded",
              inspectedInclusionReason: "taxmaxi_policy",
              replacementInclusionState: "included",
              actorId: TEST_USER_ID,
              reason: "Test required replay retry",
            })
            .returning({ id: schema.principalAssetOverrides.id })

          if (override === undefined) return yield* Effect.die("Failed to insert override")

          const [initialReplay] = yield* db
            .insert(schema.processingJobs)
            .values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: initialStatus,
              completedAt: new Date("2025-01-03T00:00:00.000Z"),
              progressDetails,
            })
            .returning({ id: schema.processingJobs.id })

          if (initialReplay === undefined) {
            return yield* Effect.die("Failed to insert initial replay")
          }

          const [application] = yield* db
            .insert(schema.principalAssetOverrideApplications)
            .values({
              overrideId: override.id,
              sourceId: TEST_SOURCE_ID,
              replayJobId: initialReplay.id,
              requiresReplay: true,
            })
            .returning({ id: schema.principalAssetOverrideApplications.id })

          if (application === undefined) {
            return yield* Effect.die("Failed to insert override application")
          }

          return {
            applicationId: application.id,
            initialReplayJobId: initialReplay.id,
          }
        })
      )

      let retryReplayJobId: string
      if (initialStatus === "failed") {
        const retryJob = await createJob({ mode: "replay" })
        retryReplayJobId = retryJob.id
      } else {
        const activeJobId = await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [activeJob] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "sync",
                status: "processing",
                followUpMode: "replay",
              })
              .returning({ id: schema.processingJobs.id })

            if (activeJob === undefined) return yield* Effect.die("Failed to insert active job")
            return activeJob.id
          })
        )

        await runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId: activeJobId, state: completedState })
          )
        )

        retryReplayJobId = await runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [activeJob] = yield* db
              .select({ followUpJobId: schema.processingJobs.followUpJobId })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.id, activeJobId))
              .limit(1)

            if (activeJob?.followUpJobId === null || activeJob === undefined) {
              return yield* Effect.die("Missing replay follow-up job")
            }
            return activeJob.followUpJobId
          })
        )
      }

      const linkedReplayJobId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [application] = yield* db
            .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
            .from(schema.principalAssetOverrideApplications)
            .where(eq(schema.principalAssetOverrideApplications.id, applicationId))

          return application?.replayJobId
        })
      )

      if (initialStatus === "completed") {
        expect(linkedReplayJobId).toBe(retryReplayJobId)
      } else {
        expect(linkedReplayJobId).toBe(initialReplayJobId)
      }

      await claimJob({ jobId: retryReplayJobId })
      await runRepository(
        Effect.flatMap(SourceSyncJobRepository, (repository) =>
          repository.completeJob({ jobId: retryReplayJobId, state: successfulCompletedState })
        )
      )

      const appliedReplayJobId = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [application] = yield* db
            .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
            .from(schema.principalAssetOverrideApplications)
            .where(eq(schema.principalAssetOverrideApplications.id, applicationId))

          return application?.replayJobId
        })
      )

      expect(appliedReplayJobId).toBe(retryReplayJobId)
    }
  )

  const seedRebuildTracking = ({
    processingJobId,
    status = "pending",
    failureCode = null,
  }: {
    readonly processingJobId: string | null
    readonly status?: "pending" | "operator_attention"
    readonly failureCode?: string | null
  }) =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "rebuild-tracking-asset",
            currencyCode: "RBT",
            retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to create provider asset fixture")
        }
        const [decision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 1,
            policyRevision: "test:rebuild-tracking",
            outcome: "excluded",
            status: "active",
            actor: TEST_USER_ID,
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (decision === undefined) {
          return yield* Effect.die("Failed to create decision fixture")
        }
        yield* db.insert(schema.assetDecisionRematerializations).values({
          decisionId: decision.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId,
          status,
          failureCode,
          lastFailureAt: failureCode === null ? null : new Date("2025-01-01T00:00:00.000Z"),
        })
        return decision.id
      })
    )

  const selectRebuildRow = (decisionId: string) =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({
            processingJobId: schema.assetDecisionRematerializations.processingJobId,
            status: schema.assetDecisionRematerializations.status,
            failureCode: schema.assetDecisionRematerializations.failureCode,
            lastFailureAt: schema.assetDecisionRematerializations.lastFailureAt,
          })
          .from(schema.assetDecisionRematerializations)
          .where(eq(schema.assetDecisionRematerializations.decisionId, decisionId))
        if (row === undefined) {
          return yield* Effect.die("Missing rematerialization row")
        }
        return row
      })
    )

  const insertProcessingReplayJob = () =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "processing",
          })
          .returning({ id: schema.processingJobs.id })
        if (job === undefined) return yield* Effect.die("Failed to create replay job")
        return job.id
      })
    )

  it("completes source rebuilds when a replay finishes without failed records", async () => {
    const jobId = await insertProcessingReplayJob()
    const decisionId = await seedRebuildTracking({ processingJobId: jobId })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId, state: { ...completedState, failedRecords: 0 } })
      )
    )

    expect(await selectRebuildRow(decisionId)).toMatchObject({
      status: "complete",
      failureCode: null,
      lastFailureAt: null,
    })
  })

  it("parks source rebuilds when a completed replay skipped records", async () => {
    const jobId = await insertProcessingReplayJob()
    const decisionId = await seedRebuildTracking({ processingJobId: jobId })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId, state: completedState })
      )
    )

    expect(await selectRebuildRow(decisionId)).toMatchObject({
      status: "operator_attention",
      failureCode: "replay_failed_records",
      lastFailureAt: expect.any(Date),
    })
  })

  it("parks source rebuilds when a replay fails terminally", async () => {
    const jobId = await insertProcessingReplayJob()
    const decisionId = await seedRebuildTracking({ processingJobId: jobId })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId,
          message: "replay exploded",
          completedAt: new Date("2025-01-02T00:00:00.000Z"),
        })
      )
    )

    expect(await selectRebuildRow(decisionId)).toMatchObject({
      status: "operator_attention",
      failureCode: "replay_failed",
    })
  })

  it("repoints unfinished rebuilds to the materialized follow-up replay", async () => {
    const activeJobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "processing",
            followUpMode: "replay",
          })
          .returning({ id: schema.processingJobs.id })
        if (job === undefined) return yield* Effect.die("Failed to create active sync job")
        return job.id
      })
    )
    const decisionId = await seedRebuildTracking({
      processingJobId: activeJobId,
      status: "operator_attention",
      failureCode: "replay_failed",
    })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: activeJobId, state: completedState })
      )
    )

    const followUpJobId = (await selectProcessingJob({ jobId: activeJobId })).followUpJobId
    expect(followUpJobId).toEqual(expect.any(String))
    expect(await selectRebuildRow(decisionId)).toEqual({
      processingJobId: followUpJobId,
      status: "pending",
      failureCode: null,
      lastFailureAt: null,
    })
  })

  it("completes rebuilds parked at operator_attention when a later replay succeeds", async () => {
    const decisionId = await seedRebuildTracking({
      processingJobId: null,
      status: "operator_attention",
      failureCode: "replay_failed",
    })

    const recoveryJobId = await insertProcessingReplayJob()
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({
          jobId: recoveryJobId,
          state: { ...completedState, failedRecords: 0 },
        })
      )
    )

    expect(await selectRebuildRow(decisionId)).toMatchObject({
      status: "complete",
      failureCode: null,
      lastFailureAt: null,
    })
  })
})
