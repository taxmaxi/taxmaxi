import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { PrincipalReplayRepository } from "@my/sync-engine/services"
import { PrincipalReplayRepositoryLive } from "../../src/layers/PrincipalReplayRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  type SyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const SECOND_SOURCE_ID = "00000000-0000-0000-0000-000000000842"
const RUN_ID = "00000000-0000-0000-0000-000000000843"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_replay_repo",
})

await Effect.runPromise(context.recreateTestDatabase())

const runPg = context.runPg
const runRepository = <A, E>(effect: Effect.Effect<A, E, PrincipalReplayRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: PrincipalReplayRepositoryLive }))

describe("PrincipalReplayRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    fixture = await runPg(seedSyncEngineRepositoryFixture())
    await runPg(
      seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
    )
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("resets a cyclic cross-source inventory graph and restores reviewed decisions on retry", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.transactionTypes)
          .values({ typeKey: "transfer", labelEn: "Transfer", labelDe: "Transfer" })
          .onConflictDoNothing()
        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            address: "bc1qprincipal-replay-cycle",
            type: "bitcoin",
            name: "Principal replay cycle",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.addresses.id })
        if (address === undefined) {
          return yield* Effect.dieMessage("Failed to seed second replay source address")
        }

        yield* db.insert(schema.sources).values({
          id: SECOND_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          name: "Principal replay source B",
          providerKey: "bitcoin-rpc",
          sourceableType: "onchain",
          addressId: address.id,
          cexAccountId: null,
        })
        const rawRows = yield* db
          .insert(schema.sourceRecordsRaw)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              provider: "coinbase",
              recordType: "transaction",
              externalRecordId: "raw-cycle-a",
              occurredAt: new Date("2025-01-01T00:00:00.000Z"),
              payload: { id: "raw-cycle-a" },
              importedAt: new Date("2025-01-01T00:00:00.000Z"),
              normalizedAt: new Date("2025-01-01T00:00:01.000Z"),
            },
            {
              sourceId: SECOND_SOURCE_ID,
              provider: "bitcoin-rpc",
              recordType: "transaction",
              externalRecordId: "raw-cycle-b",
              occurredAt: new Date("2025-01-02T00:00:00.000Z"),
              payload: { id: "raw-cycle-b" },
              importedAt: new Date("2025-01-02T00:00:00.000Z"),
              normalizedAt: new Date("2025-01-02T00:00:01.000Z"),
            },
          ])
          .returning({ id: schema.sourceRecordsRaw.id, sourceId: schema.sourceRecordsRaw.sourceId })
        const rawA = rawRows.find((row) => row.sourceId === TEST_SOURCE_ID)
        const rawB = rawRows.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (rawA === undefined || rawB === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay raw rows")
        }

        const transactions = yield* db
          .insert(schema.transactions)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              externalId: "cycle-a",
              timestamp: new Date("2025-01-01T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              sourceId: SECOND_SOURCE_ID,
              sourceRawRecordId: rawB.id,
              externalId: "cycle-b",
              timestamp: new Date("2025-01-02T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          .returning({
            id: schema.transactions.id,
            sourceId: schema.transactions.sourceId,
          })
        const transactionA = transactions.find((row) => row.sourceId === TEST_SOURCE_ID)
        const transactionB = transactions.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (transactionA === undefined || transactionB === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay transactions")
        }

        const [canonicalTransfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: SECOND_SOURCE_ID,
            sourceRawRecordId: rawB.id,
            principalId: TEST_PRINCIPAL_ID,
            externalId: "cycle-canonical-transfer",
            timestamp: new Date("2025-01-02T00:00:00.000Z"),
            type: "cex",
            fromAddress: "bc1qprincipal-replay-cycle",
            toAccountRef: "coinbase-account",
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.50000000",
          })
          .returning({ id: schema.transfers.id })
        if (canonicalTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay canonical transfer")
        }

        const providerTransfers = yield* db
          .insert(schema.providerTransfers)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              transactionId: transactionA.id,
              externalId: "cycle-provider-approved",
              timestamp: new Date("2025-01-01T00:00:00.000Z"),
              direction: "outbound",
              fromAccountRef: "coinbase-account",
              toAddress: "bc1qprincipal-replay-cycle",
              amount: "0.50000000",
            },
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              transactionId: transactionA.id,
              externalId: "cycle-provider-rejected",
              timestamp: new Date("2025-01-01T00:00:01.000Z"),
              direction: "outbound",
              fromAccountRef: "coinbase-account",
              toAddress: "bc1qrejected-destination",
              amount: "0.25000000",
            },
          ])
          .returning({
            id: schema.providerTransfers.id,
            externalId: schema.providerTransfers.externalId,
          })
        const approvedProviderTransfer = providerTransfers.find(
          (transfer) => transfer.externalId === "cycle-provider-approved"
        )
        const rejectedProviderTransfer = providerTransfers.find(
          (transfer) => transfer.externalId === "cycle-provider-rejected"
        )
        if (approvedProviderTransfer === undefined || rejectedProviderTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay provider transfers")
        }

        yield* db.insert(schema.transferReconciliations).values([
          {
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: approvedProviderTransfer.id,
            canonicalTransferId: canonicalTransfer.id,
            canonicalTransactionId: transactionB.id,
            status: "approved",
            matchReason: "user-approved-before-replay",
            confidence: "0.8000",
            deterministic: false,
            reviewMetadata: { reviewer: "principal" },
          },
          {
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: rejectedProviderTransfer.id,
            status: "rejected",
            matchReason: "user-rejected-before-replay",
            confidence: "0.2000",
            deterministic: false,
            reviewMetadata: { reviewer: "principal" },
          },
        ])

        const legs = yield* db
          .insert(schema.transactionLegs)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              externalId: "cycle-a-acquisition",
              timestamp: new Date("2025-01-01T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transactionA.id,
            },
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              externalId: "cycle-a-fee",
              timestamp: new Date("2025-01-03T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.50000000",
              kind: "fee",
              provenance: "deterministic",
              transactionId: transactionA.id,
            },
            {
              sourceId: SECOND_SOURCE_ID,
              sourceRawRecordId: rawB.id,
              externalId: "cycle-b-acquisition",
              timestamp: new Date("2025-01-02T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transactionB.id,
            },
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              externalId: "standalone-acquisition",
              timestamp: new Date("2025-01-05T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.25000000",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: null,
              sourceTransferId: null,
            },
            {
              sourceId: SECOND_SOURCE_ID,
              sourceRawRecordId: rawB.id,
              externalId: "cycle-b-fee",
              timestamp: new Date("2025-01-04T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.50000000",
              kind: "fee",
              provenance: "deterministic",
              transactionId: transactionB.id,
            },
          ])
          .returning({
            id: schema.transactionLegs.id,
            externalId: schema.transactionLegs.externalId,
          })
        const leg = (externalId: string) => legs.find((row) => row.externalId === externalId)
        const acquisitionA = leg("cycle-a-acquisition")
        const feeA = leg("cycle-a-fee")
        const acquisitionB = leg("cycle-b-acquisition")
        const feeB = leg("cycle-b-fee")
        const standaloneAcquisition = leg("standalone-acquisition")
        if (
          acquisitionA === undefined ||
          feeA === undefined ||
          acquisitionB === undefined ||
          feeB === undefined ||
          standaloneAcquisition === undefined
        ) {
          return yield* Effect.dieMessage("Failed to seed replay legs")
        }

        const lots = yield* db
          .insert(schema.fifoLots)
          .values([
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-01T00:00:00.000Z"),
              originalAmount: "1.00000000",
              remainingAmount: "0.50000000",
              costBasisPerToken: "10000.00",
              costBasisCurrency: "EUR",
              sourceLegId: acquisitionA.id,
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: SECOND_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-02T00:00:00.000Z"),
              originalAmount: "1.00000000",
              remainingAmount: "0.50000000",
              costBasisPerToken: "11000.00",
              costBasisCurrency: "EUR",
              sourceLegId: acquisitionB.id,
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-05T00:00:00.000Z"),
              originalAmount: "0.25000000",
              remainingAmount: "0.25000000",
              costBasisPerToken: "12000.00",
              costBasisCurrency: "EUR",
              sourceLegId: standaloneAcquisition.id,
            },
          ])
          .returning({ id: schema.fifoLots.id, sourceId: schema.fifoLots.sourceId })
        const lotA = lots.find((row) => row.sourceId === TEST_SOURCE_ID)
        const lotB = lots.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (lotA === undefined || lotB === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay lots")
        }

        const movements = yield* db
          .insert(schema.inventoryMovements)
          .values([
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              transactionId: transactionA.id,
              transactionLegId: feeA.id,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: new Date("2025-01-03T00:00:00.000Z"),
              direction: "outbound",
              purpose: "fee",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "0.50000000",
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: SECOND_SOURCE_ID,
              sourceRawRecordId: rawB.id,
              transactionId: transactionB.id,
              transactionLegId: feeB.id,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: new Date("2025-01-04T00:00:00.000Z"),
              direction: "outbound",
              purpose: "fee",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "0.50000000",
            },
          ])
          .returning({
            id: schema.inventoryMovements.id,
            sourceId: schema.inventoryMovements.sourceId,
          })
        const movementA = movements.find((row) => row.sourceId === TEST_SOURCE_ID)
        const movementB = movements.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (movementA === undefined || movementB === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay movements")
        }
        yield* db.insert(schema.inventoryMovementAllocations).values([
          { inventoryMovementId: movementA.id, fifoLotId: lotB.id, matchedAmount: "0.50000000" },
          { inventoryMovementId: movementB.id, fifoLotId: lotA.id, matchedAmount: "0.50000000" },
        ])
        yield* db.insert(schema.transactionReviews).values({
          transactionId: transactionA.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "changed",
          originalTypeKey: "buy_fiat",
          currentTypeKey: "transfer",
          needsReview: false,
          userNotes: "Keep my reviewed classification",
          reviewedAt: new Date("2025-02-01T00:00:00.000Z"),
        })
        yield* db.insert(schema.syncRuns).values({
          id: RUN_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "replay",
          status: "running",
          requestedSourceCount: 2,
        })
      })
    )

    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.preparePrincipalReplay({ runId: RUN_ID, principalId: TEST_PRINCIPAL_ID })
      )
    )
    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.preparePrincipalReplay({ runId: RUN_ID, principalId: TEST_PRINCIPAL_ID })
      )
    )

    const resetState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return {
          transactions: yield* db.select().from(schema.transactions),
          legs: yield* db.select().from(schema.transactionLegs),
          lots: yield* db.select().from(schema.fifoLots),
          movements: yield* db.select().from(schema.inventoryMovements),
          allocations: yield* db.select().from(schema.inventoryMovementAllocations),
          reconciliations: yield* db.select().from(schema.transferReconciliations),
          snapshots: yield* db.select().from(schema.principalReplayReviewSnapshots),
          rawRows: yield* db.select().from(schema.sourceRecordsRaw),
        }
      })
    )
    expect(resetState.transactions).toHaveLength(0)
    expect(resetState.legs).toHaveLength(0)
    expect(resetState.lots).toHaveLength(0)
    expect(resetState.movements).toHaveLength(0)
    expect(resetState.allocations).toHaveLength(0)
    expect(resetState.reconciliations).toHaveLength(0)
    expect(resetState.snapshots).toHaveLength(1)
    expect(resetState.rawRows.every((row) => row.normalizedAt === null)).toBe(true)

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const rawA = resetState.rawRows.find((row) => row.sourceId === TEST_SOURCE_ID)
        const rawB = resetState.rawRows.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (rawA === undefined || rawB === undefined) {
          return yield* Effect.dieMessage("Missing replay raw rows")
        }
        const rebuiltTransactions = yield* db
          .insert(schema.transactions)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: rawA.id,
              externalId: "cycle-a",
              timestamp: new Date("2025-01-01T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              sourceId: SECOND_SOURCE_ID,
              sourceRawRecordId: rawB.id,
              externalId: "cycle-b",
              timestamp: new Date("2025-01-02T00:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          .returning({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
        const rebuiltA = rebuiltTransactions.find((row) => row.sourceId === TEST_SOURCE_ID)
        const rebuiltB = rebuiltTransactions.find((row) => row.sourceId === SECOND_SOURCE_ID)
        if (rebuiltA === undefined || rebuiltB === undefined) {
          return yield* Effect.dieMessage("Failed to rebuild replay transactions")
        }

        const [rebuiltCanonicalTransfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: SECOND_SOURCE_ID,
            sourceRawRecordId: rawB.id,
            principalId: TEST_PRINCIPAL_ID,
            externalId: "cycle-canonical-transfer",
            timestamp: new Date("2025-01-02T00:00:00.000Z"),
            type: "cex",
            fromAddress: "bc1qprincipal-replay-cycle",
            toAccountRef: "coinbase-account",
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.50000000",
          })
          .returning({ id: schema.transfers.id })
        if (rebuiltCanonicalTransfer === undefined) {
          return yield* Effect.dieMessage("Failed to rebuild canonical transfer")
        }

        yield* db.insert(schema.providerTransfers).values([
          {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: rawA.id,
            transactionId: rebuiltA.id,
            externalId: "cycle-provider-approved",
            timestamp: new Date("2025-01-01T00:00:00.000Z"),
            direction: "outbound",
            fromAccountRef: "coinbase-account",
            toAddress: "bc1qprincipal-replay-cycle",
            amount: "0.50000000",
          },
          {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: rawA.id,
            transactionId: rebuiltA.id,
            externalId: "cycle-provider-rejected",
            timestamp: new Date("2025-01-01T00:00:01.000Z"),
            direction: "outbound",
            fromAccountRef: "coinbase-account",
            toAddress: "bc1qrejected-destination",
            amount: "0.25000000",
          },
        ])

        yield* db.insert(schema.transactionReviews).values({
          transactionId: rebuiltA.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          currentTypeKey: "buy_fiat",
          needsReview: true,
        })
      })
    )

    const restored = await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.restorePrincipalReviews({ runId: RUN_ID, principalId: TEST_PRINCIPAL_ID })
      )
    )
    const restoredState = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [review] = yield* db
          .select({
            reviewStatus: schema.transactionReviews.reviewStatus,
            currentTypeKey: schema.transactionReviews.currentTypeKey,
            needsReview: schema.transactionReviews.needsReview,
            userNotes: schema.transactionReviews.userNotes,
          })
          .from(schema.transactionReviews)
          .where(eq(schema.transactionReviews.principalId, TEST_PRINCIPAL_ID))
        const [transaction] = yield* db
          .select({ transactionType: schema.transactions.transactionType })
          .from(schema.transactions)
          .where(eq(schema.transactions.externalId, "cycle-a"))
        const reconciliations = yield* db
          .select({
            providerExternalId: schema.providerTransfers.externalId,
            canonicalTransferExternalId: schema.transfers.externalId,
            canonicalTransactionExternalId: schema.transactions.externalId,
            status: schema.transferReconciliations.status,
            matchReason: schema.transferReconciliations.matchReason,
            reviewMetadata: schema.transferReconciliations.reviewMetadata,
          })
          .from(schema.transferReconciliations)
          .innerJoin(
            schema.providerTransfers,
            eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
          )
          .leftJoin(
            schema.transfers,
            eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId)
          )
          .leftJoin(
            schema.transactions,
            eq(schema.transactions.id, schema.transferReconciliations.canonicalTransactionId)
          )
          .orderBy(schema.providerTransfers.externalId)
        return { review, transaction, reconciliations }
      })
    )

    expect(restored).toEqual({ restoredCount: 1, unmatchedTransactionIdentities: [] })
    expect(restoredState.review).toMatchObject({
      reviewStatus: "changed",
      currentTypeKey: "transfer",
      needsReview: false,
      userNotes: "Keep my reviewed classification",
    })
    expect(restoredState.transaction).toEqual({ transactionType: "transfer" })
    expect(restoredState.reconciliations).toEqual([
      {
        providerExternalId: "cycle-provider-approved",
        canonicalTransferExternalId: "cycle-canonical-transfer",
        canonicalTransactionExternalId: "cycle-b",
        status: "approved",
        matchReason: "user-approved-before-replay",
        reviewMetadata: { reviewer: "principal" },
      },
      {
        providerExternalId: "cycle-provider-rejected",
        canonicalTransferExternalId: null,
        canonicalTransactionExternalId: null,
        status: "rejected",
        matchReason: "user-rejected-before-replay",
        reviewMetadata: { reviewer: "principal" },
      },
    ])
  })

  it("records an empty review snapshot before the first reset", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.syncRuns).values({
          id: RUN_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "replay",
          status: "running",
          requestedSourceCount: 1,
        })
      })
    )

    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.preparePrincipalReplay({ runId: RUN_ID, principalId: TEST_PRINCIPAL_ID })
      )
    )

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [rawRecord] = yield* db
          .insert(schema.sourceRecordsRaw)
          .values({
            sourceId: TEST_SOURCE_ID,
            provider: "coinbase",
            recordType: "transaction",
            externalRecordId: "retry-review",
            occurredAt: new Date("2025-01-01T00:00:00.000Z"),
            payload: { id: "retry-review" },
            importedAt: new Date("2025-01-01T00:00:00.000Z"),
          })
          .returning({ id: schema.sourceRecordsRaw.id })
        if (rawRecord === undefined) {
          return yield* Effect.dieMessage("Failed to seed retry review raw record")
        }
        const [transaction] = yield* db
          .insert(schema.transactions)
          .values({
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: rawRecord.id,
            externalId: "retry-review",
            timestamp: new Date("2025-01-01T00:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.transactions.id })
        if (transaction === undefined) {
          return yield* Effect.dieMessage("Failed to seed retry review transaction")
        }
        yield* db.insert(schema.transactionReviews).values({
          transactionId: transaction.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "approved",
          currentTypeKey: "buy_fiat",
          needsReview: false,
          reviewedAt: new Date("2025-01-02T00:00:00.000Z"),
        })
      })
    )

    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.preparePrincipalReplay({ runId: RUN_ID, principalId: TEST_PRINCIPAL_ID })
      )
    )

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [run] = yield* db
          .select({ initializedAt: schema.syncRuns.reviewSnapshotInitializedAt })
          .from(schema.syncRuns)
          .where(eq(schema.syncRuns.id, RUN_ID))
        return {
          initializedAt: run?.initializedAt ?? null,
          snapshots: yield* db
            .select()
            .from(schema.principalReplayReviewSnapshots)
            .where(eq(schema.principalReplayReviewSnapshots.runId, RUN_ID)),
        }
      })
    )

    expect(state.initializedAt).not.toBeNull()
    expect(state.snapshots).toHaveLength(0)
  })

  it("creates one reusable principal run with a coordinator and reserved source jobs", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            address: "bc1qprincipal-replay-plan",
            type: "bitcoin",
            name: "Principal replay plan",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.addresses.id })
        if (address === undefined) {
          return yield* Effect.dieMessage("Failed to seed replay plan address")
        }
        yield* db.insert(schema.sources).values({
          id: SECOND_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          name: "Principal replay plan source",
          providerKey: "bitcoin-rpc",
          sourceableType: "onchain",
          addressId: address.id,
          cexAccountId: null,
        })
      })
    )

    const [first, second] = await Promise.all([
      runRepository(
        Effect.flatMap(PrincipalReplayRepository, (repository) =>
          repository.createOrReuseReplayRun({
            principalId: TEST_PRINCIPAL_ID,
            sourceIds: [SECOND_SOURCE_ID, TEST_SOURCE_ID],
            maxAttempts: 3,
          })
        )
      ),
      runRepository(
        Effect.flatMap(PrincipalReplayRepository, (repository) =>
          repository.createOrReuseReplayRun({
            principalId: TEST_PRINCIPAL_ID,
            sourceIds: [TEST_SOURCE_ID, SECOND_SOURCE_ID],
            maxAttempts: 3,
          })
        )
      ),
    ])
    if (first.coordinatorJobId === null) {
      return Effect.runPromise(Effect.dieMessage("Expected a replay coordinator job"))
    }
    const coordinatorJobId = first.coordinatorJobId
    const plan = await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.findPlanByCoordinatorJobId({ jobId: coordinatorJobId })
      )
    )

    expect(second).toEqual(first)
    expect(plan).toMatchObject({
      _tag: "Some",
      value: {
        runId: first.runId,
        principalId: TEST_PRINCIPAL_ID,
        sourceJobs: [
          { sourceId: TEST_SOURCE_ID, isCoordinator: true },
          { sourceId: SECOND_SOURCE_ID, isCoordinator: false },
        ],
      },
    })

    const jobs = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select()
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.principalId, TEST_PRINCIPAL_ID))
      })
    )
    expect(jobs).toHaveLength(2)
    expect(jobs.find((job) => job.id !== coordinatorJobId)).toMatchObject({
      queueName: "principal-replay-child",
    })
  })

  it("reclaims a processing replay plan when BullMQ redelivers its coordinator", async () => {
    const dispatch = await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.createOrReuseReplayRun({
          principalId: TEST_PRINCIPAL_ID,
          sourceIds: [TEST_SOURCE_ID],
          maxAttempts: 3,
        })
      )
    )
    const firstClaimAt = new Date("2025-01-01T00:00:00.000Z")
    const redeliveryClaimAt = new Date("2025-01-01T00:00:05.000Z")

    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.claimPlan({
          runId: dispatch.runId,
          workerId: "worker-before-redelivery",
          startedAt: firstClaimAt,
        })
      )
    )

    await runRepository(
      Effect.flatMap(PrincipalReplayRepository, (repository) =>
        repository.claimPlan({
          runId: dispatch.runId,
          workerId: "worker-after-redelivery",
          startedAt: redeliveryClaimAt,
        })
      )
    )

    const previousOwnerHeartbeat = await runRepository(
      Effect.gen(function* () {
        const repository = yield* PrincipalReplayRepository
        return yield* repository
          .heartbeatPlan({
            runId: dispatch.runId,
            workerId: "worker-before-redelivery",
            heartbeatAt: new Date("2025-01-01T00:00:06.000Z"),
          })
          .pipe(Effect.either)
      })
    )
    const previousOwnerRetryParams = {
      runId: dispatch.runId,
      workerId: "worker-before-redelivery",
      message: "Previous delivery lost ownership",
      attemptCount: 1,
      nextRetryAt: new Date("2025-01-01T00:01:00.000Z"),
    }
    const previousOwnerRetry = await runRepository(
      Effect.gen(function* () {
        const repository = yield* PrincipalReplayRepository
        return yield* repository
          .recordRetryableFailure(previousOwnerRetryParams)
          .pipe(Effect.either)
      })
    )

    const jobs = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            status: schema.processingJobs.status,
            workerId: schema.processingJobs.workerId,
            heartbeatAt: schema.processingJobs.heartbeatAt,
          })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.principalId, TEST_PRINCIPAL_ID))
      })
    )

    expect(jobs).toEqual([
      {
        status: "processing",
        workerId: "worker-after-redelivery",
        heartbeatAt: redeliveryClaimAt,
      },
    ])
    expect(previousOwnerHeartbeat).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SyncEngineStorageError",
        operation: "principalReplayRepository.heartbeatPlan.ownership",
      },
    })
    expect(previousOwnerRetry).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SyncEngineStorageError",
        operation: "principalReplayRepository.recordRetryableFailure.ownership",
      },
    })
  })

  it("does not start from a stale source snapshot while another principal job is active", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values({
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "sync",
          status: "pending",
          maxAttempts: 3,
        })
      })
    )

    const result = await runRepository(
      Effect.gen(function* () {
        const repository = yield* PrincipalReplayRepository
        return yield* repository
          .createOrReuseReplayRun({
            principalId: TEST_PRINCIPAL_ID,
            sourceIds: [],
            maxAttempts: 3,
          })
          .pipe(Effect.either)
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SyncEngineStorageError",
        operation: "principalReplayRepository.createOrReuseReplayRun.busySources",
      })
    }
  })
})
