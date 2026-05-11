import { asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProviderRawRecord, SourceRawRecordRepository } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_raw_record_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceRawRecordRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceRawRecordRepositoryLive }))

const firstBatch = [
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType: "coinbase_account",
    externalRecordId: "coinbase-account-1",
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    payload: { id: "coinbase-account-1" },
  }),
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType: "coinbase_transaction",
    externalRecordId: "tx-1",
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt: new Date("2025-01-01T12:00:00.000Z"),
    payload: { id: "tx-1", amount: "1.0" },
  }),
] as const

describe("SourceRawRecordRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("upserts raw batches idempotently and exposes replay candidates", async () => {
    const firstWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: firstBatch,
        })
      )
    )

    expect(firstWrite.rawRecords).toHaveLength(2)
    expect(firstWrite.checkpointExternalId).toBe("tx-1")
    expect(firstWrite.checkpointRawRecordId).not.toBeNull()

    const secondWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [
            firstBatch[0],
            ProviderRawRecord.make({
              ...firstBatch[1],
              payload: { id: "tx-1", amount: "2.0" },
            }),
          ],
        })
      )
    )

    expect(secondWrite.rawRecords).toHaveLength(2)

    const transactionRow = secondWrite.rawRecords.find((row) => row.externalRecordId === "tx-1")
    expect(transactionRow).toBeDefined()
    if (transactionRow === undefined) {
      return
    }

    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.markRawRecordFailed({
          rawRecordId: transactionRow.id,
          message: "Unknown provider currency: TAO",
        })
      )
    )

    const replayCandidates = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listReplayCandidates({
          sourceId: TEST_SOURCE_ID,
          importedBefore: new Date("2027-01-02T00:00:00.000Z"),
        })
      )
    )

    expect(replayCandidates.map((row) => row.externalRecordId)).toEqual(["tx-1"])

    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.markRawRecordNormalized({
          rawRecordId: transactionRow.id,
        })
      )
    )

    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.resetNormalizationStateForSource({
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.sourceRecordsRaw)
          .where(eq(schema.sourceRecordsRaw.sourceId, TEST_SOURCE_ID))
          .orderBy(asc(schema.sourceRecordsRaw.occurredAt))
      })
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.normalizedAt === null)).toBe(true)
    expect(rows.every((row) => row.normalizationError === null)).toBe(true)
  })
})
