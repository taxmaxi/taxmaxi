import { eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_RAW_RECORD_ID,
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  SourceNormalizationRepository,
  SourceRawRecordRepository,
  SourceReplayRepository,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_replay_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const runRawRepository = <A, E>(effect: Effect.Effect<A, E, SourceRawRecordRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceRawRecordRepositoryLive }))

const runReplayRepository = <A, E>(effect: Effect.Effect<A, E, SourceReplayRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceReplayRepositoryLive }))

const seedReplayRawRecord = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: TEST_RAW_RECORD_ID,
      sourceId: TEST_SOURCE_ID,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId: "coinbase-account-1",
      externalRecordId: "raw-replay-1",
      externalParentId: null,
      occurredAt: new Date("2025-01-01T10:00:00.000Z"),
      payload: { id: "raw-replay-1" },
      importedAt: new Date("2025-01-01T10:00:00.000Z"),
      createdAt: new Date("2025-01-01T10:00:00.000Z"),
      updatedAt: new Date("2025-01-01T10:00:00.000Z"),
    })
  })

describe("SourceReplayRepositoryLive", () => {
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
    await runPg(seedReplayRawRecord())
  })

  it("waits for the source inventory lock before resetting replay state", async () => {
    const sourceLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseSourceLock = await Effect.runPromise(Deferred.make<void>())
    const heldSourceLock = runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, TEST_SOURCE_ID))
              .for("update")
            yield* Deferred.succeed(sourceLockAcquired, undefined)
            yield* Deferred.await(releaseSourceLock)
          })
        )
      })
    )

    await Effect.runPromise(Deferred.await(sourceLockAcquired))

    const replayWaitingForSource = runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      )
    ).then(() => "completed" as const)

    // Phase 1: replay must remain blocked while another transaction owns the source lock.
    const replayBeforeSourceRelease = await context
      .waitForQueryBlockedOnLock({ queryIncludes: "sources" })
      .then(() => "blocked" as const)

    expect(replayBeforeSourceRelease).toBe("blocked")

    // Phase 2: replay must finish after the source lock is released.
    await Effect.runPromise(Deferred.succeed(releaseSourceLock, undefined))
    const [, laterOutcome] = await Promise.all([heldSourceLock, replayWaitingForSource])

    expect(laterOutcome).toBe("completed")
  })

  it("clears canonical source-derived rows while keeping cached raw rows reusable", async () => {
    await runNormalization(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId: "tx-replay-1",
            externalGroupId: "group-replay-1",
            timestamp: new Date("2025-01-01T10:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-replay-1",
            providerDescription: "Replay seed buy",
            providerCreatedAt: new Date("2025-01-01T10:00:00.000Z"),
            providerUpdatedAt: new Date("2025-01-01T10:00:00.000Z"),
            metadata: { provider: "coinbase" },
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: "order-replay-1",
            externalFillId: "fill-replay-1",
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          canonicalTransfers: [],
          providerAssetRowIds: [],
          legs: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "leg-replay-1",
              txHash: null,
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "spot_buy",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: "10000.00000000",
              fiatCurrency: "EUR",
              feeForTransactionId: null,
            },
          ],
          transactionReview: {
            principalId: TEST_PRINCIPAL_ID,
            reviewStatus: "needs_review",
            originalTypeKey: "buy_fiat",
            originalConfidence: "0.80",
            currentTypeKey: "buy_fiat",
            legalRuleSetVersion: "de-2025-01",
            categorizationReason: "Replay fixture review",
            matchedLayer: "fixture",
            needsReview: true,
            userNotes: null,
            reviewedAt: null,
          },
          resolvedTransactionType: {
            providerTransactionType: "buy",
            transactionType: "buy_fiat",
            inventoryEffect: "acquisition",
            taxTreatment: "non_taxable_by_default",
            resolutionStrategy: "static",
            pairedRecordRequired: false,
            mappingStatus: "approved",
          },
        })
      )
    )

    await runRawRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.markRawRecordNormalized({
          rawRecordId: TEST_RAW_RECORD_ID,
        })
      )
    )

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    await runRawRepository(
      Effect.flatMap(SourceRawRecordRepository, (repository) =>
        repository.resetNormalizationStateForSource({
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    const snapshot = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const transactions = yield* db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
        const transfers = yield* db
          .select()
          .from(schema.transfers)
          .where(eq(schema.transfers.sourceId, TEST_SOURCE_ID))
        const legs = yield* db
          .select()
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.sourceId, TEST_SOURCE_ID))
        const reviews = yield* db.select().from(schema.transactionReviews)
        const fifoLots = yield* db
          .select()
          .from(schema.fifoLots)
          .where(eq(schema.fifoLots.sourceId, TEST_SOURCE_ID))
        const rawRows = yield* db
          .select()
          .from(schema.sourceRecordsRaw)
          .where(eq(schema.sourceRecordsRaw.sourceId, TEST_SOURCE_ID))
        return {
          transactions,
          transfers,
          legs,
          reviews,
          fifoLots,
          rawRows,
        }
      })
    )

    expect(snapshot.transactions).toHaveLength(0)
    expect(snapshot.transfers).toHaveLength(0)
    expect(snapshot.legs).toHaveLength(0)
    expect(snapshot.reviews).toHaveLength(0)
    expect(snapshot.fifoLots).toHaveLength(0)
    expect(snapshot.rawRows).toHaveLength(1)
    expect(snapshot.rawRows[0]?.externalRecordId).toBe("raw-replay-1")
    expect(snapshot.rawRows[0]?.normalizedAt).toBeNull()
    expect(snapshot.rawRows[0]?.normalizationError).toBeNull()
  })

  it.each([
    { dependencyKind: "inventory allocation", dependentLegKind: "fee" },
    { dependencyKind: "disposal match", dependentLegKind: "disposal" },
  ] as const)(
    "blocks replay when another source has a $dependencyKind consuming one of its FIFO lots",
    async ({ dependencyKind, dependentLegKind }) => {
      const dependentSourceId = "00000000-0000-0000-0000-000000000282"
      const replayTransactionId = "00000000-0000-0000-0000-000000000283"
      const dependentTransactionId = "00000000-0000-0000-0000-000000000284"

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [address] = yield* db
            .insert(schema.addresses)
            .values({
              address: "bc1qsource-replay-dependent",
              type: "bitcoin",
              name: "Replay dependent source",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.addresses.id })

          if (address === undefined) {
            return yield* Effect.die("Failed to create dependent replay source address")
          }

          yield* db.insert(schema.sources).values({
            id: dependentSourceId,
            principalId: TEST_PRINCIPAL_ID,
            name: "Replay dependent source",
            providerKey: "bitcoin-rpc",
            sourceableType: "onchain",
            cexAccountId: null,
            addressId: address.id,
          })
          yield* db.insert(schema.transactions).values([
            {
              id: replayTransactionId,
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-lot-origin",
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              id: dependentTransactionId,
              sourceId: dependentSourceId,
              externalId: "dependent-movement-origin",
              timestamp: new Date("2025-01-02T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          const [acquisitionLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-lot-origin-leg",
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: replayTransactionId,
            })
            .returning({ id: schema.transactionLegs.id })
          const [dependentLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: dependentSourceId,
              externalId: "dependent-consumption-leg",
              timestamp: new Date("2025-01-02T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: dependentLegKind === "disposal" ? "-0.40000000" : "0.40000000",
              kind: dependentLegKind,
              provenance: "deterministic",
              transactionId: dependentTransactionId,
            })
            .returning({ id: schema.transactionLegs.id })

          if (acquisitionLeg === undefined || dependentLeg === undefined) {
            return yield* Effect.die("Failed to create cross-source replay legs")
          }

          const [lot] = yield* db
            .insert(schema.fifoLots)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
              originalAmount: "1.00000000",
              remainingAmount: "0.60000000",
              costBasisPerToken: "10000.00",
              costBasisCurrency: "EUR",
              sourceLegId: acquisitionLeg.id,
            })
            .returning({ id: schema.fifoLots.id })
          if (lot === undefined) {
            return yield* Effect.die("Failed to create cross-source replay lot")
          }

          if (dependencyKind === "inventory allocation") {
            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: dependentSourceId,
                transactionId: dependentTransactionId,
                transactionLegId: dependentLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: new Date("2025-01-02T10:00:00.000Z"),
                direction: "outbound",
                purpose: "fee",
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                amount: "0.40000000",
              })
              .returning({ id: schema.inventoryMovements.id })

            if (movement === undefined) {
              return yield* Effect.die("Failed to create cross-source replay allocation")
            }

            yield* db.insert(schema.inventoryMovementAllocations).values({
              inventoryMovementId: movement.id,
              fifoLotId: lot.id,
              matchedAmount: "0.40000000",
            })
          } else {
            yield* db.insert(schema.disposalMatches).values({
              disposalLegId: dependentLeg.id,
              fifoLotId: lot.id,
              matchedAmount: "0.40000000",
              costBasis: "4000.00",
              proceeds: "5000.00",
              gainLoss: "1000.00",
            })
          }
        })
      )

      const replayResult = await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
        ).pipe(Effect.result)
      )

      expect(replayResult).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SourceReplayDependencyError",
          sourceId: TEST_SOURCE_ID,
          dependentSourceIds: [dependentSourceId],
          affectedPrincipalIds: [TEST_PRINCIPAL_ID],
        },
      })

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const lots = yield* db.select().from(schema.fifoLots)
          const movements = yield* db.select().from(schema.inventoryMovements)
          const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
          const matches = yield* db.select().from(schema.disposalMatches)
          return { lots, movements, allocations, matches }
        })
      )

      expect(state.lots).toHaveLength(1)
      expect(state.movements).toHaveLength(dependencyKind === "inventory allocation" ? 1 : 0)
      expect(state.allocations).toHaveLength(dependencyKind === "inventory allocation" ? 1 : 0)
      expect(state.matches).toHaveLength(dependencyKind === "disposal match" ? 1 : 0)
      expect(state.lots[0]?.remainingAmount).toContain("0.60000000")
    }
  )
})
