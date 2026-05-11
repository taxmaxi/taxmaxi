import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncStateRepositoryLive } from "../../src/layers/SourceSyncStateRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { SourceSyncStateRepository, type SourceSyncExecutionState } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_sync_state_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncStateRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncStateRepositoryLive }))

const seedProcessingJob = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [job] = yield* db
      .insert(schema.processingJobs)
      .values({
        sourceId: TEST_SOURCE_ID,
        userId: TEST_USER_ID,
        status: "processing",
      })
      .returning({ id: schema.processingJobs.id })

    if (job === undefined) {
      return yield* Effect.dieMessage("Failed to create processing job fixture")
    }

    return job.id
  })

describe("SourceSyncStateRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("returns default execution state before any sync row exists", async () => {
    const executionState = await runRepository(
      Effect.flatMap(SourceSyncStateRepository, (repository) =>
        repository.getExecutionState({ sourceId: TEST_SOURCE_ID })
      )
    )

    expect(executionState).toEqual({
      importedRecords: 0,
      normalizedRecords: 0,
      failedRecords: 0,
      cursorPayload: null,
      highWatermark: null,
      checkpointExternalId: null,
      checkpointRawRecordId: null,
    })
  })

  it("persists progress and clears replay failure metadata without losing checkpoints", async () => {
    const jobId = await runPg(seedProcessingJob())

    const state: SourceSyncExecutionState = {
      importedRecords: 7,
      normalizedRecords: 6,
      failedRecords: 1,
      cursorPayload: { cursor: "page-2" },
      highWatermark: new Date("2025-02-01T00:00:00.000Z"),
      checkpointExternalId: "tx-7",
      checkpointRawRecordId: null,
    }

    await runRepository(
      Effect.flatMap(SourceSyncStateRepository, (repository) =>
        repository.persistProgress({
          sourceId: TEST_SOURCE_ID,
          jobId,
          state,
          lastSyncedAt: new Date("2025-02-01T00:10:00.000Z"),
          lastErrorMessage: null,
        })
      )
    )

    await runRepository(
      Effect.flatMap(SourceSyncStateRepository, (repository) =>
        repository.persistFailureMetadata({
          sourceId: TEST_SOURCE_ID,
          lastErrorMessage: "Coinbase token refresh failed.",
        })
      )
    )

    await runRepository(
      Effect.flatMap(SourceSyncStateRepository, (repository) =>
        repository.clearReplayFailureMetadata({
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const persisted = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [syncState] = yield* db
          .select()
          .from(schema.sourceSyncState)
          .where(eq(schema.sourceSyncState.sourceId, TEST_SOURCE_ID))
          .limit(1)
        const [job] = yield* db
          .select()
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, jobId))
          .limit(1)
        return { syncState, job }
      })
    )

    expect(persisted.syncState?.checkpointExternalId).toBe("tx-7")
    expect(persisted.syncState?.checkpointRawRecordId).toBeNull()
    expect(persisted.syncState?.lastErrorMessage).toBeNull()
    expect(persisted.job?.checkpointExternalId).toBe("tx-7")
    expect(persisted.job?.progressDetails).toMatchObject({
      importedRecords: 7,
      normalizedRecords: 6,
      failedRecords: 1,
      cursorPayload: { cursor: "page-2" },
      highWatermark: "2025-02-01T00:00:00.000Z",
    })
  })
})
