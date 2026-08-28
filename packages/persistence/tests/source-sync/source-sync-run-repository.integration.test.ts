import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncRunRepositoryLive } from "../../src/layers/SourceSyncRunRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { SourceSyncRunRepository, type SourceSyncJobStatus } from "@my/sync-engine/services"

const SECOND_SOURCE_ID = "00000000-0000-0000-0000-000000000282"
const OTHER_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000182"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_sync_run_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncRunRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncRunRepositoryLive }))

const seedSecondSource = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [coinbaseCex] = yield* db
        .select({ id: schema.cex.id })
        .from(schema.cex)
        .where(eq(schema.cex.name, "coinbase"))
        .limit(1)

      if (coinbaseCex === undefined) {
        return yield* Effect.die("Missing seeded coinbase CEX fixture")
      }

      const [createdAccount] = yield* db
        .insert(schema.cexAccount)
        .values({
          cexId: coinbaseCex.id,
          principalId: TEST_PRINCIPAL_ID,
          providerUserId: "coinbase-user-2",
          providerAccountId: "coinbase-account-2",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
          scopes: "wallet:accounts:read wallet:transactions:read",
        })
        .returning({ id: schema.cexAccount.id })

      if (createdAccount === undefined) {
        return yield* Effect.die("Failed to create second cex account fixture")
      }

      yield* db.insert(schema.sources).values({
        id: SECOND_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        name: "Coinbase Source 2",
        providerKey: "coinbase",
        sourceableType: "cex",
        cexAccountId: createdAccount.id,
        addressId: null,
        createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      })
    })
  )

const createProcessingJob = ({
  sourceId = TEST_SOURCE_ID,
  status = "pending",
  errorMessage = null,
}: {
  readonly sourceId?: string
  readonly status?: SourceSyncJobStatus
  readonly errorMessage?: string | null
} = {}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const [job] = yield* db
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId: TEST_PRINCIPAL_ID,
          mode: "sync",
          status,
          startedAt: status === "processing" ? now : null,
          completedAt: status === "completed" || status === "failed" ? now : null,
          errorMessage,
          progressDetails: {
            fetchedRecords: status === "completed" ? 4 : 0,
            normalizedRecords: status === "completed" ? 3 : 0,
            failedRecords: status === "failed" ? 1 : 0,
          },
        })
        .returning({ id: schema.processingJobs.id })

      if (job === undefined) {
        return yield* Effect.die("Failed to create processing job fixture")
      }

      return job.id
    })
  )

const updateProcessingJobStatus = ({
  jobId,
  status,
}: {
  readonly jobId: string
  readonly status: SourceSyncJobStatus
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:05:00.000Z"))
      yield* db
        .update(schema.processingJobs)
        .set({
          status,
          startedAt: status === "processing" ? now : null,
          completedAt: status === "completed" || status === "failed" ? now : null,
          updatedAt: now,
        })
        .where(eq(schema.processingJobs.id, jobId))
    })
  )

const createRun = ({ requestedSourceCount }: { readonly requestedSourceCount: number }) =>
  runRepository(
    Effect.flatMap(SourceSyncRunRepository, (repository) =>
      repository.createRun({ principalId: TEST_PRINCIPAL_ID, requestedSourceCount })
    )
  )

const attachRunItem = ({
  runId,
  sourceId,
  processingJobId,
}: {
  readonly runId: string
  readonly sourceId: string
  readonly processingJobId: string
}) =>
  runRepository(
    Effect.flatMap(SourceSyncRunRepository, (repository) =>
      repository.attachRunItem({ runId, sourceId, processingJobId })
    )
  )

const recordRunItemFailure = ({
  runId,
  sourceId,
  message,
}: {
  readonly runId: string
  readonly sourceId: string
  readonly message: string
}) =>
  runRepository(
    Effect.flatMap(SourceSyncRunRepository, (repository) =>
      repository.recordRunItemFailure({ runId, sourceId, message })
    )
  )

describe("SourceSyncRunRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() => seedSecondSource())
      })
    )
  )

  it.effect("creates a run with principal id and initial counters", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))

      expect(run).toMatchObject({
        principalId: TEST_PRINCIPAL_ID,
        status: "queued",
        requestedSourceCount: 2,
        queuedSourceCount: 0,
        runningSourceCount: 0,
        completedSourceCount: 0,
        failedSourceCount: 0,
        message: null,
      })
    })
  )

  it.effect("attaches a run item and reuses a duplicate run/source link", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))
      const jobId = yield* Effect.promise(() => createProcessingJob())

      const first = yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: jobId,
        })
      )
      const second = yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: jobId,
        })
      )

      expect(first).toMatchObject({
        runId: run.id,
        sourceId: TEST_SOURCE_ID,
        processingJobId: jobId,
        provider: "coinbase",
        status: "queued",
      })
      expect(second.id).toBe(first.id)
    })
  )

  it.effect("reuses the original run/source link when duplicate attach uses a different job", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))
      const firstJobId = yield* Effect.promise(() => createProcessingJob({ status: "completed" }))
      const secondJobId = yield* Effect.promise(() => createProcessingJob({ status: "pending" }))

      const first = yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: firstJobId,
        })
      )
      const second = yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: secondJobId,
        })
      )

      expect(second.id).toBe(first.id)
      expect(second.processingJobId).toBe(firstJobId)
    })
  )

  it.effect("returns storage error when attaching a missing processing job", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository
              .attachRunItem({
                runId: run.id,
                sourceId: TEST_SOURCE_ID,
                processingJobId: "00000000-0000-0000-0000-000000009999",
              })
              .pipe(Effect.result)
          )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SyncEngineStorageError")
      }
    })
  )

  it.effect("records a failed item without a processing job", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))

      const item = yield* Effect.promise(() =>
        recordRunItemFailure({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          message: "Failed to enqueue source sync job.",
        })
      )

      expect(item).toMatchObject({
        runId: run.id,
        sourceId: TEST_SOURCE_ID,
        processingJobId: null,
        provider: "coinbase",
        status: "failed",
        message: "Failed to enqueue source sync job.",
      })
    })
  )

  it.effect("keeps a dispatch failure item when a later attach uses the same run/source", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))
      const jobId = yield* Effect.promise(() => createProcessingJob())
      const failed = yield* Effect.promise(() =>
        recordRunItemFailure({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          message: "Failed to enqueue source sync job.",
        })
      )

      const attached = yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: jobId,
        })
      )

      expect(attached.id).toBe(failed.id)
      expect(attached).toMatchObject({
        processingJobId: null,
        status: "failed",
        message: "Failed to enqueue source sync job.",
      })
    })
  )

  it.effect("does not expose another principal's run", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 0 }))
      const visible = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.getVisibleRun({ principalId: OTHER_PRINCIPAL_ID, runId: run.id })
          )
        )
      )

      expect(Option.isNone(visible)).toBe(true)
    })
  )

  it.effect("refreshes a zero-source run as completed", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 0 }))
      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed.status).toBe("completed")
      expect(refreshed.message).toBe("No sources to sync.")
    })
  )

  it.effect("refreshes all completed children as completed", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))
      const firstJobId = yield* Effect.promise(() =>
        createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "completed" })
      )
      const secondJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: SECOND_SOURCE_ID,
          status: "completed",
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: firstJobId })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: SECOND_SOURCE_ID,
          processingJobId: secondJobId,
        })
      )

      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed).toMatchObject({
        status: "completed",
        completedSourceCount: 2,
        failedSourceCount: 0,
      })
    })
  )

  it.effect("refreshes all failed children as failed", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))
      const firstJobId = yield* Effect.promise(() =>
        createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "failed" })
      )
      const secondJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: SECOND_SOURCE_ID,
          status: "failed",
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: firstJobId })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: SECOND_SOURCE_ID,
          processingJobId: secondJobId,
        })
      )

      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed).toMatchObject({
        status: "failed",
        completedSourceCount: 0,
        failedSourceCount: 2,
      })
    })
  )

  it.effect("refreshes mixed terminal children as partially failed", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))
      const completedJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: TEST_SOURCE_ID,
          status: "completed",
        })
      )
      const failedJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: SECOND_SOURCE_ID,
          status: "failed",
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: completedJobId,
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: SECOND_SOURCE_ID,
          processingJobId: failedJobId,
        })
      )

      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed).toMatchObject({
        status: "partially_failed",
        completedSourceCount: 1,
        failedSourceCount: 1,
      })
    })
  )

  it.effect("refreshes dispatch failure items as failed sources", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))
      const completedJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: TEST_SOURCE_ID,
          status: "completed",
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId: completedJobId,
        })
      )
      yield* Effect.promise(() =>
        recordRunItemFailure({
          runId: run.id,
          sourceId: SECOND_SOURCE_ID,
          message: "Failed to enqueue source sync job.",
        })
      )

      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed).toMatchObject({
        status: "partially_failed",
        completedSourceCount: 1,
        failedSourceCount: 1,
      })
    })
  )

  it.effect("refreshes active children as running", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 2 }))
      const queuedJobId = yield* Effect.promise(() =>
        createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "pending" })
      )
      const runningJobId = yield* Effect.promise(() =>
        createProcessingJob({
          sourceId: SECOND_SOURCE_ID,
          status: "processing",
        })
      )
      yield* Effect.promise(() =>
        attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: queuedJobId })
      )
      yield* Effect.promise(() =>
        attachRunItem({
          runId: run.id,
          sourceId: SECOND_SOURCE_ID,
          processingJobId: runningJobId,
        })
      )

      const refreshed = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )

      expect(refreshed).toMatchObject({
        status: "running",
        queuedSourceCount: 1,
        runningSourceCount: 1,
      })
    })
  )

  it.effect("refreshes stale item status from the linked processing job", () =>
    Effect.gen(function* () {
      const run = yield* Effect.promise(() => createRun({ requestedSourceCount: 1 }))
      const jobId = yield* Effect.promise(() => createProcessingJob({ status: "pending" }))
      yield* Effect.promise(() =>
        attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: jobId })
      )
      yield* Effect.promise(() => updateProcessingJobStatus({ jobId, status: "completed" }))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.refreshRunStatus({ runId: run.id })
          )
        )
      )
      const items = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncRunRepository, (repository) =>
            repository.listRunItems({ runId: run.id })
          )
        )
      )

      expect(items[0]?.status).toBe("completed")
    })
  )
})
