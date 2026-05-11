import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
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
  importedRecords: 4,
  normalizedRecords: 3,
  failedRecords: 1,
  cursorPayload: { page: "done" },
  highWatermark: new Date("2025-01-03T00:00:00.000Z"),
  checkpointExternalId: "tx-4",
  checkpointRawRecordId: "00000000-0000-0000-0000-000000000999",
}

const createJob = ({
  mode = "sync",
  maxAttempts = 3,
  sourceId = TEST_SOURCE_ID,
  userId = TEST_USER_ID,
}: {
  readonly mode?: SourceSyncJobMode
  readonly maxAttempts?: number
  readonly sourceId?: string
  readonly userId?: string
} = {}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.createOrReuseJob({
        sourceId,
        userId,
        mode,
        maxAttempts,
      })
    )
  )

const seedSourceFixture = ({
  sourceId,
  userId,
}: {
  readonly sourceId: string
  readonly userId: string
}) => runPg(seedSyncEngineRepositoryFixture({ sourceId, userId }))

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
        return yield* Effect.dieMessage(`Missing processing job ${jobId}`)
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

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
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
      userId: TEST_USER_ID,
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
      userId: TEST_USER_ID,
      mode: "sync",
      status: "pending",
      queueName: null,
      queueJobId: null,
    })

    const activeJobs = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.findActiveJob({
          sourceId: TEST_SOURCE_ID,
          userId: TEST_USER_ID,
        })
      )
    )

    expect(activeJobs).toHaveLength(1)
    expect(activeJobs[0]?.id).toBe(created.id)
    expect(activeJobs[0]?.mode).toBe("sync")
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
      userId: TEST_USER_ID,
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
          .pipe(Effect.either)
      )
    )

    expect(secondClaim._tag).toBe("Left")
    if (secondClaim._tag === "Left") {
      expect(secondClaim.left._tag).toBe("SourceSyncJobExecutionRecordConflictError")
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
          .pipe(Effect.either)
      )
    )

    expect(rejectedHeartbeat._tag).toBe("Left")

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
          userId: TEST_USER_ID,
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
      importedRecords: 4,
      normalizedRecords: 3,
      failedRecords: 1,
      message: null,
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

  it("lists repairable active jobs by queue metadata and stale execution predicates", async () => {
    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const oldTimestamp = new Date("2025-01-02T00:00:00.000Z")
    const recentTimestamp = new Date("2025-01-02T00:20:00.000Z")
    const fixtures = {
      freshPending: {
        sourceId: "00000000-0000-0000-0000-000000000291",
        userId: "00000000-0000-0000-0000-000000000191",
      },
      stalePending: {
        sourceId: "00000000-0000-0000-0000-000000000292",
        userId: "00000000-0000-0000-0000-000000000192",
      },
      staleHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000293",
        userId: "00000000-0000-0000-0000-000000000193",
      },
      recentHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000294",
        userId: "00000000-0000-0000-0000-000000000194",
      },
      nullHeartbeat: {
        sourceId: "00000000-0000-0000-0000-000000000295",
        userId: "00000000-0000-0000-0000-000000000195",
      },
      completed: {
        sourceId: "00000000-0000-0000-0000-000000000296",
        userId: "00000000-0000-0000-0000-000000000196",
      },
      failed: {
        sourceId: "00000000-0000-0000-0000-000000000297",
        userId: "00000000-0000-0000-0000-000000000197",
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
  })

  it("recovers a stale active job and allows a fresh job to start", async () => {
    const created = await createJob()

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recoverStaleActiveJob({
          sourceId: TEST_SOURCE_ID,
          jobId: created.id,
          message: "Recovered stale source sync job after timeout.",
          completedAt: new Date("2025-01-04T00:00:00.000Z"),
        })
      )
    )

    const activeJobs = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.findActiveJob({
          sourceId: TEST_SOURCE_ID,
          userId: TEST_USER_ID,
        })
      )
    )

    expect(activeJobs).toHaveLength(0)

    const nextJob = await createJob()

    expect(nextJob._tag).toBe("CreatedSourceSyncJob")
    expect(nextJob.id).not.toBe(created.id)
  })

  it("keeps getJob backward-compatible for queued, running, completed, and failed statuses", async () => {
    const queued = await createJob()
    const queuedStatus = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.getJob({
          userId: TEST_USER_ID,
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
          userId: TEST_USER_ID,
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
          userId: TEST_USER_ID,
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
          userId: TEST_USER_ID,
          sourceId: TEST_SOURCE_ID,
          jobId: failed.id,
        })
      )
    )

    expect(failedStatus.status).toBe("failed")
    expect(failedStatus.message).toBe("Failed terminally")
  })

  it("defaults omitted job mode to sync for migration-compatible old inserts", async () => {
    const jobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            userId: TEST_USER_ID,
            status: "pending",
          })
          .returning({ id: schema.processingJobs.id })

        if (job === undefined) {
          return yield* Effect.dieMessage("Failed to insert processing job without mode")
        }

        return job.id
      })
    )

    const executionJob = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) => repository.getExecutionJob({ jobId }))
    )

    expect(executionJob.mode).toBe("sync")
  })
})
