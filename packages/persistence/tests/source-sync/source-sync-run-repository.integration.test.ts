import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
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
        return yield* Effect.dieMessage("Missing seeded coinbase CEX fixture")
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
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scopes: "wallet:accounts:read wallet:transactions:read",
        })
        .returning({ id: schema.cexAccount.id })

      if (createdAccount === undefined) {
        return yield* Effect.dieMessage("Failed to create second cex account fixture")
      }

      yield* db.insert(schema.sources).values({
        id: SECOND_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        name: "Coinbase Source 2",
        providerKey: "coinbase",
        sourceableType: "cex",
        cexAccountId: createdAccount.id,
        addressId: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
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
      const now = new Date("2025-01-02T00:00:00.000Z")
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
            importedRecords: status === "completed" ? 4 : 0,
            normalizedRecords: status === "completed" ? 3 : 0,
            failedRecords: status === "failed" ? 1 : 0,
          },
        })
        .returning({ id: schema.processingJobs.id })

      if (job === undefined) {
        return yield* Effect.dieMessage("Failed to create processing job fixture")
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
      const now = new Date("2025-01-02T00:05:00.000Z")
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
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
    await seedSecondSource()
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("creates a run with principal id and initial counters", async () => {
    const run = await createRun({ requestedSourceCount: 2 })

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

  it("attaches a run item and reuses a duplicate run/source link", async () => {
    const run = await createRun({ requestedSourceCount: 1 })
    const jobId = await createProcessingJob()

    const first = await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: jobId,
    })
    const second = await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: jobId,
    })

    expect(first).toMatchObject({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: jobId,
      provider: "coinbase",
      status: "queued",
    })
    expect(second.id).toBe(first.id)
  })

  it("reuses the original run/source link when duplicate attach uses a different job", async () => {
    const run = await createRun({ requestedSourceCount: 1 })
    const firstJobId = await createProcessingJob({ status: "completed" })
    const secondJobId = await createProcessingJob({ status: "pending" })

    const first = await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: firstJobId,
    })
    const second = await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: secondJobId,
    })

    expect(second.id).toBe(first.id)
    expect(second.processingJobId).toBe(firstJobId)
  })

  it("returns storage error when attaching a missing processing job", async () => {
    const run = await createRun({ requestedSourceCount: 1 })
    const result = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository
          .attachRunItem({
            runId: run.id,
            sourceId: TEST_SOURCE_ID,
            processingJobId: "00000000-0000-0000-0000-000000009999",
          })
          .pipe(Effect.either)
      )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SyncEngineStorageError")
    }
  })

  it("records a failed item without a processing job", async () => {
    const run = await createRun({ requestedSourceCount: 1 })

    const item = await recordRunItemFailure({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      message: "Failed to enqueue source sync job.",
    })

    expect(item).toMatchObject({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: null,
      provider: "coinbase",
      status: "failed",
      message: "Failed to enqueue source sync job.",
    })
  })

  it("keeps a dispatch failure item when a later attach uses the same run/source", async () => {
    const run = await createRun({ requestedSourceCount: 1 })
    const jobId = await createProcessingJob()
    const failed = await recordRunItemFailure({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      message: "Failed to enqueue source sync job.",
    })

    const attached = await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: jobId,
    })

    expect(attached.id).toBe(failed.id)
    expect(attached).toMatchObject({
      processingJobId: null,
      status: "failed",
      message: "Failed to enqueue source sync job.",
    })
  })

  it("does not expose another principal's run", async () => {
    const run = await createRun({ requestedSourceCount: 0 })
    const visible = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.getVisibleRun({ principalId: OTHER_PRINCIPAL_ID, runId: run.id })
      )
    )

    expect(Option.isNone(visible)).toBe(true)
  })

  it("refreshes a zero-source run as completed", async () => {
    const run = await createRun({ requestedSourceCount: 0 })
    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed.status).toBe("completed")
    expect(refreshed.message).toBe("No sources to sync.")
  })

  it("refreshes all completed children as completed", async () => {
    const run = await createRun({ requestedSourceCount: 2 })
    const firstJobId = await createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "completed" })
    const secondJobId = await createProcessingJob({
      sourceId: SECOND_SOURCE_ID,
      status: "completed",
    })
    await attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: firstJobId })
    await attachRunItem({
      runId: run.id,
      sourceId: SECOND_SOURCE_ID,
      processingJobId: secondJobId,
    })

    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed).toMatchObject({
      status: "completed",
      completedSourceCount: 2,
      failedSourceCount: 0,
    })
  })

  it("refreshes all failed children as failed", async () => {
    const run = await createRun({ requestedSourceCount: 2 })
    const firstJobId = await createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "failed" })
    const secondJobId = await createProcessingJob({
      sourceId: SECOND_SOURCE_ID,
      status: "failed",
    })
    await attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: firstJobId })
    await attachRunItem({
      runId: run.id,
      sourceId: SECOND_SOURCE_ID,
      processingJobId: secondJobId,
    })

    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed).toMatchObject({
      status: "failed",
      completedSourceCount: 0,
      failedSourceCount: 2,
    })
  })

  it("refreshes mixed terminal children as partially failed", async () => {
    const run = await createRun({ requestedSourceCount: 2 })
    const completedJobId = await createProcessingJob({
      sourceId: TEST_SOURCE_ID,
      status: "completed",
    })
    const failedJobId = await createProcessingJob({
      sourceId: SECOND_SOURCE_ID,
      status: "failed",
    })
    await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: completedJobId,
    })
    await attachRunItem({
      runId: run.id,
      sourceId: SECOND_SOURCE_ID,
      processingJobId: failedJobId,
    })

    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed).toMatchObject({
      status: "partially_failed",
      completedSourceCount: 1,
      failedSourceCount: 1,
    })
  })

  it("refreshes dispatch failure items as failed sources", async () => {
    const run = await createRun({ requestedSourceCount: 2 })
    const completedJobId = await createProcessingJob({
      sourceId: TEST_SOURCE_ID,
      status: "completed",
    })
    await attachRunItem({
      runId: run.id,
      sourceId: TEST_SOURCE_ID,
      processingJobId: completedJobId,
    })
    await recordRunItemFailure({
      runId: run.id,
      sourceId: SECOND_SOURCE_ID,
      message: "Failed to enqueue source sync job.",
    })

    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed).toMatchObject({
      status: "partially_failed",
      completedSourceCount: 1,
      failedSourceCount: 1,
    })
  })

  it("refreshes active children as running", async () => {
    const run = await createRun({ requestedSourceCount: 2 })
    const queuedJobId = await createProcessingJob({ sourceId: TEST_SOURCE_ID, status: "pending" })
    const runningJobId = await createProcessingJob({
      sourceId: SECOND_SOURCE_ID,
      status: "processing",
    })
    await attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: queuedJobId })
    await attachRunItem({
      runId: run.id,
      sourceId: SECOND_SOURCE_ID,
      processingJobId: runningJobId,
    })

    const refreshed = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )

    expect(refreshed).toMatchObject({
      status: "running",
      queuedSourceCount: 1,
      runningSourceCount: 1,
    })
  })

  it("refreshes stale item status from the linked processing job", async () => {
    const run = await createRun({ requestedSourceCount: 1 })
    const jobId = await createProcessingJob({ status: "pending" })
    await attachRunItem({ runId: run.id, sourceId: TEST_SOURCE_ID, processingJobId: jobId })
    await updateProcessingJobStatus({ jobId, status: "completed" })

    await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.refreshRunStatus({ runId: run.id })
      )
    )
    const items = await runRepository(
      Effect.flatMap(SourceSyncRunRepository, (repository) =>
        repository.listRunItems({ runId: run.id })
      )
    )

    expect(items[0]?.status).toBe("completed")
  })
})
