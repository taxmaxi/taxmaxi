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

const seedOwnedSource = ({
  sourceId,
  address,
}: {
  readonly sourceId: string
  readonly address: string
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [addressRow] = yield* db
        .insert(schema.addresses)
        .values({
          address,
          type: "bitcoin",
          name: address,
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.addresses.id })

      if (addressRow === undefined) return yield* Effect.die("Failed to create source address")

      yield* db.insert(schema.sources).values({
        id: sourceId,
        principalId: TEST_PRINCIPAL_ID,
        name: address,
        providerKey: "bitcoin-rpc",
        sourceableType: "onchain",
        addressId: addressRow.id,
      })
    })
  )

const recordJobDependency = ({
  jobId,
  prerequisiteJobId,
}: {
  readonly jobId: string
  readonly prerequisiteJobId: string
}) =>
  runPg(
    Effect.flatMap(drizzle, (db) =>
      db.insert(schema.processingJobDependencies).values({ jobId, prerequisiteJobId })
    )
  )

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
  startedAt = new Date("2025-01-02T00:00:00.000Z"),
}: {
  readonly jobId: string
  readonly workerId?: string
  readonly startedAt?: Date
}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.claimJob({
        jobId,
        workerId,
        startedAt,
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

const listClaimableJobs = ({
  dueBefore = new Date("2025-01-02T00:00:00.000Z"),
  limit = 20,
}: {
  readonly dueBefore?: Date
  readonly limit?: number
} = {}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.listClaimableJobs({ dueBefore, limit })
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
    })
  })

  it.each(["failed", "credit_required", "completed_with_failed_records"] as const)(
    "fails pending dependents when their prerequisite becomes %s and frees the active slot",
    async (terminalState) => {
      const dependentSourceId = "00000000-0000-0000-0000-000000009901"
      await seedOwnedSource({
        sourceId: dependentSourceId,
        address: "bc1qfailed-prerequisite-dependent",
      })

      const prerequisite = await createJob({ mode: "replay" })
      await claimJob({ jobId: prerequisite.id })
      const dependent = await createJob({ mode: "replay", sourceId: dependentSourceId })
      await recordJobDependency({ jobId: dependent.id, prerequisiteJobId: prerequisite.id })

      await runRepository(
        Effect.flatMap(SourceSyncJobRepository, (repository) => {
          switch (terminalState) {
            case "failed":
              return repository.failJob({
                jobId: prerequisite.id,
                message: "prerequisite failed",
                completedAt: new Date("2025-01-02T00:00:00.000Z"),
              })
            case "credit_required":
              return repository.failCreditRequiredJob({
                jobId: prerequisite.id,
                completedAt: new Date("2025-01-02T00:00:00.000Z"),
                reasonCode: "no_usable_credits",
                availableCredits: 0,
                creditsConsumed: 1,
                additionalCreditsRequired: 1,
              })
            case "completed_with_failed_records":
              return repository.completeJob({ jobId: prerequisite.id, state: completedState })
          }
        })
      )

      expect(await selectProcessingJob({ jobId: dependent.id })).toMatchObject({
        status: "failed",
        errorMessage: "Prerequisite processing job did not complete successfully.",
      })
      expect((await createJob({ mode: "replay", sourceId: dependentSourceId }))._tag).toBe(
        "CreatedSourceSyncJob"
      )
    }
  )

  it("fails the full pending dependency chain when an upstream prerequisite fails", async () => {
    const middleSourceId = "00000000-0000-0000-0000-000000009902"
    const downstreamSourceId = "00000000-0000-0000-0000-000000009903"
    await seedOwnedSource({ sourceId: middleSourceId, address: "bc1qdependency-middle" })
    await seedOwnedSource({ sourceId: downstreamSourceId, address: "bc1qdependency-downstream" })

    const prerequisite = await createJob({ mode: "replay" })
    await claimJob({ jobId: prerequisite.id })
    const middle = await createJob({ mode: "replay", sourceId: middleSourceId })
    const downstream = await createJob({ mode: "replay", sourceId: downstreamSourceId })
    await recordJobDependency({ jobId: middle.id, prerequisiteJobId: prerequisite.id })
    await recordJobDependency({ jobId: downstream.id, prerequisiteJobId: middle.id })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.failJob({
          jobId: prerequisite.id,
          message: "upstream replay failed",
          completedAt: new Date("2025-01-02T00:00:00.000Z"),
        })
      )
    )

    expect(await selectProcessingJob({ jobId: middle.id })).toMatchObject({ status: "failed" })
    expect(await selectProcessingJob({ jobId: downstream.id })).toMatchObject({ status: "failed" })
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

  it("stamps queued_at when the pending job row is created", async () => {
    const created = await createJob()

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.queuedAt).toBeInstanceOf(Date)
  })

  it("claims a pending job for worker execution and counts the attempt", async () => {
    const created = await createJob()
    const claimed = await claimJob({ jobId: created.id, workerId: "worker-1" })

    expect(claimed).toMatchObject({
      id: created.id,
      sourceId: TEST_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      mode: "sync",
      status: "processing",
      attemptCount: 1,
      maxAttempts: 3,
    })

    const job = await selectProcessingJob({ jobId: created.id })

    expect(job.status).toBe("processing")
    expect(job.workerId).toBe("worker-1")
    expect(job.attemptCount).toBe(1)
    expect(job.startedAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
    expect(job.heartbeatAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
  })

  it("returns a typed waiting result when a pending job has active prerequisites", async () => {
    const dependentSourceId = "00000000-0000-0000-0000-000000009911"
    await seedOwnedSource({
      sourceId: dependentSourceId,
      address: "bc1qwaiting-prerequisite-dependent",
    })

    const prerequisite = await createJob({ mode: "replay" })
    const dependent = await createJob({ mode: "replay", sourceId: dependentSourceId })
    await recordJobDependency({ jobId: dependent.id, prerequisiteJobId: prerequisite.id })

    const result = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository
          .claimJob({
            jobId: dependent.id,
            workerId: "worker-1",
            startedAt: new Date("2025-01-02T00:00:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SourceSyncJobPrerequisitesPendingError",
        jobId: dependent.id,
        sourceId: dependentSourceId,
      },
    })
    expect(await selectProcessingJob({ jobId: dependent.id })).toMatchObject({
      status: "pending",
      workerId: null,
    })
  })

  it("lets exactly one of two concurrently racing claims win", async () => {
    const created = await createJob()

    const results = await Promise.all(
      ["worker-1", "worker-2"].map((workerId) =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository
              .claimJob({
                jobId: created.id,
                workerId,
                startedAt: new Date("2025-01-02T00:00:00.000Z"),
              })
              .pipe(Effect.result)
          )
        )
      )
    )

    const wins = results.filter((result) => result._tag === "Success")
    const conflicts = results.filter(
      (result) =>
        result._tag === "Failure" &&
        result.failure._tag === "SourceSyncJobExecutionRecordConflictError"
    )

    expect(wins).toHaveLength(1)
    expect(conflicts).toHaveLength(1)

    const job = await selectProcessingJob({ jobId: created.id })
    expect(job.status).toBe("processing")
    // The claim of the losing worker never committed: one attempt counted.
    expect(job.attemptCount).toBe(1)
  })

  it("recovering a stale job materializes its follow-up and cascade-fails dependents", async () => {
    const dependentSourceId = "00000000-0000-0000-0000-000000009921"
    await seedOwnedSource({
      sourceId: dependentSourceId,
      address: "bc1qstale-recovery-dependent",
    })

    const staleBefore = new Date("2025-01-02T00:10:00.000Z")
    const staleAt = new Date("2025-01-02T00:00:00.000Z")

    const crashed = await createJob({ mode: "sync" })
    await claimJob({ jobId: crashed.id, workerId: "worker-crashed" })
    // A replay was requested while the job ran, so it owes a follow-up.
    await runPg(
      Effect.flatMap(drizzle, (db) =>
        db
          .update(schema.processingJobs)
          .set({ followUpMode: "replay" })
          .where(eq(schema.processingJobs.id, crashed.id))
      )
    )
    const dependent = await createJob({ mode: "replay", sourceId: dependentSourceId })
    await recordJobDependency({ jobId: dependent.id, prerequisiteJobId: crashed.id })
    await updateProcessingJobStaleTimestamps({
      jobId: crashed.id,
      heartbeatAt: staleAt,
      updatedAt: staleAt,
    })

    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recoverStaleActiveJob({
          sourceId: TEST_SOURCE_ID,
          jobId: crashed.id,
          staleBefore,
          message: "Stale-job sweep failed a processing source sync job without a heartbeat.",
          completedAt: new Date("2025-01-02T00:30:00.000Z"),
        })
      )
    )

    expect(await selectProcessingJob({ jobId: crashed.id })).toMatchObject({ status: "failed" })
    expect(await selectProcessingJob({ jobId: dependent.id })).toMatchObject({
      status: "failed",
      errorMessage: "Prerequisite processing job did not complete successfully.",
    })

    // The owed replay exists as a fresh pending row the poll loop can claim.
    const followUpJobId = (await selectProcessingJob({ jobId: crashed.id })).followUpJobId
    expect(followUpJobId).toEqual(expect.any(String))
    if (followUpJobId !== null) {
      expect(await selectProcessingJob({ jobId: followUpJobId })).toMatchObject({
        mode: "replay",
        status: "pending",
      })
      const claimable = await listClaimableJobs({
        dueBefore: new Date("2025-01-02T01:00:00.000Z"),
      })
      expect(claimable.map((job) => job.id)).toContain(followUpJobId)
    }
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

  it("refuses to reclaim a released job before its retry is due", async () => {
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

    const earlyClaim = await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository
          .claimJob({
            jobId: created.id,
            workerId: "worker-2",
            startedAt: new Date("2025-01-02T00:04:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(earlyClaim._tag).toBe("Failure")
    if (earlyClaim._tag === "Failure") {
      expect(earlyClaim.failure).toMatchObject({
        _tag: "SourceSyncJobExecutionRecordConflictError",
        reason: "Job retry is not due yet.",
      })
    }
    expect(await listClaimableJobs({ dueBefore: new Date("2025-01-02T00:04:00.000Z") })).toEqual([])
  })

  it("reclaims the same job once its retry is due and counts the new attempt", async () => {
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

    const claimable = await listClaimableJobs({
      dueBefore: new Date("2025-01-02T00:06:00.000Z"),
    })
    expect(claimable.map((job) => job.id)).toContain(created.id)

    const reclaimed = await claimJob({
      jobId: created.id,
      workerId: "worker-2",
      startedAt: new Date("2025-01-02T00:06:00.000Z"),
    })
    const job = await selectProcessingJob({ jobId: created.id })

    expect(reclaimed).toMatchObject({
      id: created.id,
      status: "processing",
      attemptCount: 2,
    })
    expect(job.attemptCount).toBe(2)
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

  it("lists only pending jobs with met prerequisites and a due retry as claimable", async () => {
    const now = new Date("2025-01-02T00:10:00.000Z")
    const fixtures = {
      processing: {
        sourceId: "00000000-0000-0000-0000-000000000291",
        principalId: "00000000-0000-0000-0000-000000000191",
      },
      blocked: {
        sourceId: "00000000-0000-0000-0000-000000000292",
        principalId: "00000000-0000-0000-0000-000000000192",
      },
      notDue: {
        sourceId: "00000000-0000-0000-0000-000000000293",
        principalId: "00000000-0000-0000-0000-000000000193",
      },
      completed: {
        sourceId: "00000000-0000-0000-0000-000000000294",
        principalId: "00000000-0000-0000-0000-000000000194",
      },
    } as const

    await Promise.all(Object.values(fixtures).map(seedSourceFixture))

    const claimablePending = await createJob()

    const processing = await createJob(fixtures.processing)
    await claimJob({ jobId: processing.id, workerId: "worker-processing" })

    // Blocked by an unfinished prerequisite (the processing job).
    const blocked = await createJob({ mode: "replay", ...fixtures.blocked })
    await recordJobDependency({ jobId: blocked.id, prerequisiteJobId: processing.id })

    const notDue = await createJob(fixtures.notDue)
    await claimJob({ jobId: notDue.id, workerId: "worker-retry" })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.recordRetryableFailure({
          jobId: notDue.id,
          message: "retry later",
          attemptCount: 1,
          nextRetryAt: new Date("2025-01-02T01:00:00.000Z"),
        })
      )
    )

    const completed = await createJob(fixtures.completed)
    await claimJob({ jobId: completed.id, workerId: "worker-completed" })
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({ jobId: completed.id, state: completedState })
      )
    )

    const claimableIds = (await listClaimableJobs({ dueBefore: now })).map((job) => job.id)

    expect(claimableIds).toContain(claimablePending.id)
    expect(claimableIds).not.toContain(processing.id)
    expect(claimableIds).not.toContain(blocked.id)
    expect(claimableIds).not.toContain(notDue.id)
    expect(claimableIds).not.toContain(completed.id)

    // Complete the prerequisite with no failed records: the dependent replay
    // becomes claimable on the next listing.
    await runRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({
          jobId: processing.id,
          state: { ...completedState, failedRecords: 0 },
        })
      )
    )

    const unblockedIds = (await listClaimableJobs({ dueBefore: now })).map((job) => job.id)
    expect(unblockedIds).toContain(blocked.id)

    // The released retry becomes claimable once its delay has passed.
    const dueIds = (
      await listClaimableJobs({ dueBefore: new Date("2025-01-02T01:00:00.000Z") })
    ).map((job) => job.id)
    expect(dueIds).toContain(notDue.id)
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
