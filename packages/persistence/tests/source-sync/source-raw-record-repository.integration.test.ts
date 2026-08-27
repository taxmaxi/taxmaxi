import { asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProviderRawRecord } from "@my/sync-engine/shared"
import { SourceRawRecordRepository } from "@my/sync-engine/services"

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

    const pendingIds = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listPendingNormalizationRecordIds({ sourceId: TEST_SOURCE_ID })
      )
    )
    const firstPendingBatch = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listRawRecordsByIds({
          sourceId: TEST_SOURCE_ID,
          rawRecordIds: pendingIds.slice(0, 1),
        })
      )
    )

    expect(pendingIds).toHaveLength(2)
    expect(firstPendingBatch.map((row) => row.id)).toEqual(pendingIds.slice(0, 1))

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

  it("uses raw row ids to break equal-time replay ties", async () => {
    const occurredAt = new Date("2025-01-01T12:00:00.000Z")
    const records = ["tx-tie-c", "tx-tie-a", "tx-tie-b"].map((externalRecordId) =>
      ProviderRawRecord.make({
        providerKey: "coinbase",
        recordType: "coinbase_transaction",
        externalRecordId,
        externalAccountId: "coinbase-account-1",
        externalParentId: null,
        occurredAt,
        payload: { id: externalRecordId },
      })
    )
    const write = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({ sourceId: TEST_SOURCE_ID, records })
      )
    )
    const expectedIds = write.rawRecords
      .map((record) => record.id)
      .sort((left, right) => left.localeCompare(right))

    const [allRows, pendingIds, selectedRows, pairingRows] = await Promise.all([
      runRepository(
        Effect.flatMap(SourceRawRecordRepository, (repository) =>
          repository.listAllRawRowsForReplay({ sourceId: TEST_SOURCE_ID })
        )
      ),
      runRepository(
        Effect.flatMap(SourceRawRecordRepository, (repository) =>
          repository.listPendingNormalizationRecordIds({ sourceId: TEST_SOURCE_ID })
        )
      ),
      runRepository(
        Effect.flatMap(SourceRawRecordRepository, (repository) =>
          repository.listRawRecordsByIds({
            sourceId: TEST_SOURCE_ID,
            rawRecordIds: [...expectedIds].reverse(),
          })
        )
      ),
      runRepository(
        Effect.flatMap(SourceRawRecordRepository, (repository) =>
          repository.listRawRecordsByOccurredAt({
            sourceId: TEST_SOURCE_ID,
            recordType: "coinbase_transaction",
            occurredAt,
          })
        )
      ),
    ])

    expect(allRows.map((row) => row.id)).toEqual(expectedIds)
    expect(pendingIds).toEqual(expectedIds)
    expect(selectedRows.map((row) => row.id)).toEqual(expectedIds)
    expect(pairingRows.map((row) => row.id)).toEqual(expectedIds)

    await runRepository(
      Effect.gen(function* () {
        const repository = yield* SourceRawRecordRepository
        yield* Effect.forEach(
          expectedIds,
          (rawRecordId) =>
            repository.markRawRecordFailed({ rawRecordId, message: "Equal-time replay fixture" }),
          { concurrency: 1, discard: true }
        )
      })
    )
    const replayCandidates = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listReplayCandidates({ sourceId: TEST_SOURCE_ID })
      )
    )
    expect(replayCandidates.map((row) => row.id)).toEqual(expectedIds)
  })

  it("lists only matching mutable provider rows for one indexed source account", async () => {
    const otherSourceId = "00000000-0000-0000-0000-000000000282"
    await runPg(
      seedSyncEngineRepositoryFixture({
        userId: "00000000-0000-0000-0000-000000000182",
        principalId: "00000000-0000-0000-0000-000000000182",
        sourceId: otherSourceId,
      })
    )

    const makeRecord = ({
      externalRecordId,
      externalAccountId = "coinbase-account-1",
      recordType = "coinbase_transaction",
      payload,
    }: {
      readonly externalRecordId: string
      readonly externalAccountId?: string
      readonly recordType?: string
      readonly payload: unknown
    }) =>
      ProviderRawRecord.make({
        providerKey: "coinbase",
        recordType,
        externalRecordId,
        externalAccountId,
        externalParentId: null,
        occurredAt: new Date("2025-01-01T12:00:00.000Z"),
        payload,
      })

    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [
            makeRecord({
              externalRecordId: "pending-tx-match",
              payload: { type: "TX", status: "Pending" },
            }),
            makeRecord({
              externalRecordId: "failed-tx-match",
              payload: { type: "tx", status: "FAILED" },
            }),
            makeRecord({
              externalRecordId: "completed-tx",
              payload: { type: "tx", status: "completed" },
            }),
            makeRecord({
              externalRecordId: "pending-buy",
              payload: { type: "buy", status: "pending" },
            }),
            makeRecord({
              externalRecordId: "pending-other-account",
              externalAccountId: "coinbase-account-2",
              payload: { type: "tx", status: "pending" },
            }),
            makeRecord({
              externalRecordId: "pending-other-record-type",
              recordType: "coinbase_account",
              payload: { type: "tx", status: "pending" },
            }),
            makeRecord({
              externalRecordId: "malformed-payload",
              payload: { status: 42 },
            }),
          ],
        })
      )
    )
    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: otherSourceId,
          records: [
            makeRecord({
              externalRecordId: "pending-other-source",
              payload: { type: "tx", status: "pending" },
            }),
          ],
        })
      )
    )

    const externalRecordIds = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listExternalRecordIdsByProviderStatus({
          sourceId: TEST_SOURCE_ID,
          externalAccountId: "coinbase-account-1",
          recordType: "coinbase_transaction",
          providerTransactionType: "tx",
          providerStatuses: ["pending", "failed"],
        })
      )
    )

    expect(externalRecordIds).toEqual(["failed-tx-match", "pending-tx-match"])
  })

  it("updates duplicate Solana signatures instead of inserting another raw row", async () => {
    const signature = "solana-signature-1"
    const firstWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [
            ProviderRawRecord.make({
              providerKey: "helius-solana",
              recordType: "solana_transaction_full",
              externalRecordId: signature,
              externalAccountId: "So11111111111111111111111111111111111111112",
              externalParentId: null,
              occurredAt: new Date("2025-01-01T00:00:00.000Z"),
              payload: { transaction: { signatures: [signature] }, version: 1 },
            }),
          ],
        })
      )
    )
    const secondWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [
            ProviderRawRecord.make({
              providerKey: "helius-solana",
              recordType: "solana_transaction_full",
              externalRecordId: signature,
              externalAccountId: "So11111111111111111111111111111111111111112",
              externalParentId: null,
              occurredAt: new Date("2025-01-01T00:01:00.000Z"),
              payload: { transaction: { signatures: [signature] }, version: 2 },
            }),
          ],
        })
      )
    )

    expect(firstWrite.rawRecords).toHaveLength(1)
    expect(secondWrite.rawRecords).toHaveLength(1)
    expect(secondWrite.rawRecords[0]?.id).toBe(firstWrite.rawRecords[0]?.id)

    const rows = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            externalRecordId: schema.sourceRecordsRaw.externalRecordId,
            occurredAt: schema.sourceRecordsRaw.occurredAt,
            payload: schema.sourceRecordsRaw.payload,
          })
          .from(schema.sourceRecordsRaw)
          .where(eq(schema.sourceRecordsRaw.sourceId, TEST_SOURCE_ID))
      })
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      externalRecordId: signature,
      payload: { transaction: { signatures: [signature] }, version: 2 },
    })
    expect(rows[0]?.occurredAt.toISOString()).toBe("2025-01-01T00:01:00.000Z")
  })

  it("reopens flagged changed payloads while preserving unchanged failures", async () => {
    const [record] = firstBatch.slice(1)
    if (record === undefined) {
      throw new Error("Expected a transaction fixture in firstBatch")
    }
    const makeRecord = ({
      amount,
      externalRecordId = record.externalRecordId,
      status,
      reopenNormalizationOnChange,
    }: {
      readonly amount: string
      readonly externalRecordId?: string
      readonly status: string
      readonly reopenNormalizationOnChange: boolean
    }) =>
      ProviderRawRecord.make({
        providerKey: record.providerKey,
        recordType: record.recordType,
        externalRecordId,
        externalAccountId: record.externalAccountId,
        externalParentId: record.externalParentId,
        occurredAt: record.occurredAt,
        payload: { id: externalRecordId, amount, status },
        reopenNormalizationOnChange,
      })
    const pendingRecord = makeRecord({
      amount: "1.0",
      status: "pending",
      reopenNormalizationOnChange: true,
    })
    const stableRecord = makeRecord({
      amount: "1.0",
      externalRecordId: "tx-stable",
      status: "completed",
      reopenNormalizationOnChange: false,
    })

    const firstWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [pendingRecord, stableRecord],
        })
      )
    )
    const rawRecord = firstWrite.rawRecords.find((row) => row.externalRecordId === "tx-1")
    const stableRawRecord = firstWrite.rawRecords.find(
      (row) => row.externalRecordId === "tx-stable"
    )
    if (rawRecord === undefined || stableRawRecord === undefined) {
      throw new Error("Expected pending and stable raw records to be returned from upsertRawBatch")
    }

    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.markRawRecordFailed({
          rawRecordId: rawRecord.id,
          message: "Coinbase transaction is still pending",
        })
      )
    )
    await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.markRawRecordNormalized({ rawRecordId: stableRawRecord.id })
      )
    )

    const unchangedWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({ sourceId: TEST_SOURCE_ID, records: [pendingRecord] })
      )
    )
    expect(unchangedWrite.rawRecords[0]?.normalizedAt).toBeNull()
    expect(unchangedWrite.rawRecords[0]?.normalizationError).toBe(
      "Coinbase transaction is still pending"
    )

    const replayCandidates = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.listReplayCandidates({ sourceId: TEST_SOURCE_ID })
      )
    )
    expect(replayCandidates.map((row) => row.externalRecordId)).toEqual(["tx-1"])

    const changedWrite = await runRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.upsertRawBatch({
          sourceId: TEST_SOURCE_ID,
          records: [
            makeRecord({
              amount: "1.0",
              status: "completed",
              reopenNormalizationOnChange: true,
            }),
            makeRecord({
              amount: "2.0",
              externalRecordId: "tx-stable",
              status: "completed",
              reopenNormalizationOnChange: false,
            }),
          ],
        })
      )
    )

    const reopenedRow = changedWrite.rawRecords.find((row) => row.externalRecordId === "tx-1")
    const preservedRow = changedWrite.rawRecords.find((row) => row.externalRecordId === "tx-stable")
    expect(reopenedRow?.normalizedAt).toBeNull()
    expect(reopenedRow?.normalizationError).toBeNull()
    expect(preservedRow?.normalizedAt).not.toBeNull()
  })
})
