import { eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
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
const CLAIMED_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000803"
const REPLAY_LOCK_ADDRESS_ID = "00000000-0000-0000-0000-000000000101"
const REPLAY_LOCK_SOURCE_ID = "00000000-0000-0000-0000-000000000102"
const REPLAY_DESTINATION_ADDRESS_ID = "00000000-0000-4000-8000-000000000801"
const REPLAY_DESTINATION_SOURCE_ID = "00000000-0000-4000-8000-000000000802"

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

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
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
        repository.resetSourceDerivedState({
          sourceId: TEST_SOURCE_ID,
          expectedPrincipalId: TEST_PRINCIPAL_ID,
        })
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

  it("rejects replay when the source owner changes before its lock is acquired", async () => {
    const timestamp = new Date("2025-04-09T10:00:00.000Z")
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.principals).values({
          id: CLAIMED_PRINCIPAL_ID,
          kind: "anonymous_wallet",
          userId: null,
        })
        yield* db.insert(schema.addresses).values({
          id: REPLAY_LOCK_ADDRESS_ID,
          address: "bc1qreplaylock00000000000000000000000000000",
          type: "bitcoin",
          name: "Replay lock",
          principalId: TEST_PRINCIPAL_ID,
        })
        yield* db.insert(schema.sources).values({
          id: REPLAY_LOCK_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          name: "Replay lock source",
          providerKey: "bitcoin",
          sourceableType: "onchain",
          addressId: REPLAY_LOCK_ADDRESS_ID,
          cexAccountId: null,
        })
        yield* db.insert(schema.transactions).values({
          sourceId: TEST_SOURCE_ID,
          externalId: "replay-owner-change-transaction",
          timestamp,
          transactionType: "internal_transfer",
          providerTransactionType: "buy",
          providerStatus: "completed",
          principalId: TEST_PRINCIPAL_ID,
        })
      })
    )

    const blockerLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseBlockerLock = await Effect.runPromise(Deferred.make<void>())
    const heldBlockerLock = runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, REPLAY_LOCK_SOURCE_ID))
              .for("update")
            yield* Deferred.succeed(blockerLockAcquired, undefined)
            yield* Deferred.await(releaseBlockerLock)
          })
        )
      })
    )

    await Effect.runPromise(Deferred.await(blockerLockAcquired))

    const replayResultPromise = runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({
          sourceId: TEST_SOURCE_ID,
          expectedPrincipalId: TEST_PRINCIPAL_ID,
        })
      ).pipe(Effect.either)
    )

    await context.waitForQueryBlockedOnLock({ queryIncludes: "sources" })
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.sources)
          .set({ principalId: CLAIMED_PRINCIPAL_ID })
          .where(eq(schema.sources.id, TEST_SOURCE_ID))
      })
    )

    await Effect.runPromise(Deferred.succeed(releaseBlockerLock, undefined))
    const [, replayResult] = await Promise.all([heldBlockerLock, replayResultPromise])

    expect(replayResult).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SyncEngineStorageError",
        operation: "sourceReplayRepository.resetSourceDerivedState.verifyLockedOwnership",
      },
    })

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [source] = yield* db
          .select({ principalId: schema.sources.principalId })
          .from(schema.sources)
          .where(eq(schema.sources.id, TEST_SOURCE_ID))
        const transactions = yield* db
          .select({ externalId: schema.transactions.externalId })
          .from(schema.transactions)
          .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
        return { source, transactions }
      })
    )

    expect(state.source?.principalId).toBe(CLAIMED_PRINCIPAL_ID)
    expect(state.transactions).toContainEqual({
      externalId: "replay-owner-change-transaction",
    })
  })

  it.each([
    {
      label: "approved cleanup",
      status: "approved" as const,
      reviewMetadata: null,
      laterOriginUsage: null,
    },
    {
      label: "retained blocked cleanup",
      status: "needs_review" as const,
      reviewMetadata: {
        rollback: {
          status: "blocked",
          reason: "dependent_destination_lot_usage",
          appliedEffectsRetained: true,
        },
      },
      laterOriginUsage: null,
    },
    {
      label: "same-timestamp origin disposal dependency",
      status: "approved" as const,
      reviewMetadata: null,
      laterOriginUsage: "disposal" as const,
    },
    {
      label: "same-timestamp origin allocation dependency",
      status: "approved" as const,
      reviewMetadata: null,
      laterOriginUsage: "allocation" as const,
    },
  ])(
    "handles $label when the replayed source consumes the destination lot",
    async ({ status, reviewMetadata, laterOriginUsage }) => {
      const timestamp = new Date("2025-04-10T10:00:00.000Z")
      const fixtureState = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.addresses).values({
            id: REPLAY_DESTINATION_ADDRESS_ID,
            address: "bc1qreplaydestination000000000000000000000000",
            type: "bitcoin",
            name: "Replay destination",
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db.insert(schema.sources).values({
            id: REPLAY_DESTINATION_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            name: "Replay destination source",
            providerKey: "bitcoin",
            sourceableType: "onchain",
            addressId: REPLAY_DESTINATION_ADDRESS_ID,
            cexAccountId: null,
          })

          const [originTransaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-origin-transaction",
              timestamp,
              transactionType: "internal_transfer",
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          const [destinationTransaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: REPLAY_DESTINATION_SOURCE_ID,
              externalId: "replay-destination-transaction",
              timestamp,
              transactionType: "internal_transfer",
              providerTransactionType: "receive",
              providerStatus: "confirmed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })

          if (originTransaction === undefined || destinationTransaction === undefined) {
            return yield* Effect.dieMessage("Failed to seed replay transaction pair")
          }

          const [providerTransfer] = yield* db
            .insert(schema.providerTransfers)
            .values({
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransaction.id,
              externalId: "replay-origin-provider-transfer",
              timestamp,
              direction: "outbound",
              fromAccountRef: "coinbase-account-1",
              toAddress: "bc1qreplaydestination000000000000000000000000",
              networkName: "bitcoin",
              networkHash: "replay-pair-hash",
              amount: "0.25000000",
              metadata: {},
            })
            .returning({ id: schema.providerTransfers.id })
          const [canonicalTransfer] = yield* db
            .insert(schema.transfers)
            .values({
              sourceId: REPLAY_DESTINATION_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "replay-destination-transfer",
              addressId: REPLAY_DESTINATION_ADDRESS_ID,
              blockchainId: fixture.bitcoinBlockchainId,
              txHash: "replay-pair-hash",
              timestamp,
              type: "utxo",
              fromAddress: "bc1qexternalsender00000000000000000000000000",
              toAddress: "bc1qreplaydestination000000000000000000000000",
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              amount: "0.25000000",
            })
            .returning({ id: schema.transfers.id })

          if (providerTransfer === undefined || canonicalTransfer === undefined) {
            return yield* Effect.dieMessage("Failed to seed replay transfer pair")
          }

          yield* db.insert(schema.transferReconciliations).values({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: providerTransfer.id,
            canonicalTransferId: canonicalTransfer.id,
            canonicalTransactionId: destinationTransaction.id,
            status,
            matchReason: "deterministic_wallet_receipt_match",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata,
          })

          const [openingLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-opening-leg",
              timestamp: new Date("2025-04-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1.00000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "fixture_opening_lot",
              fiatAmount: "50000.00",
              fiatCurrency: "EUR",
            })
            .returning({ id: schema.transactionLegs.id })
          if (openingLeg === undefined) {
            return yield* Effect.dieMessage("Failed to seed replay opening leg")
          }

          const [openingLot] = yield* db
            .insert(schema.fifoLots)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-04-01T10:00:00.000Z"),
              originalAmount: "1.00000000",
              remainingAmount: laterOriginUsage === null ? "0.75000000" : "0.65000000",
              costBasisPerToken: "50000.000000000000000000",
              costBasisCurrency: "EUR",
              sourceLegId: openingLeg.id,
            })
            .returning({ id: schema.fifoLots.id })
          const reconciliationMetadata = {
            reconciliation: {
              providerTransferId: providerTransfer.id,
              canonicalTransferId: canonicalTransfer.id,
            },
          }
          const [originLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-origin-internal-transfer",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.25000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: "internal_transfer_out",
              metadata: reconciliationMetadata,
              transactionId: originTransaction.id,
            })
            .returning({ id: schema.transactionLegs.id })
          const [destinationLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: REPLAY_DESTINATION_SOURCE_ID,
              externalId: "replay-destination-internal-transfer",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              addressId: REPLAY_DESTINATION_ADDRESS_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.25000000",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "internal_transfer_in",
              metadata: reconciliationMetadata,
              transactionId: destinationTransaction.id,
              sourceTransferId: canonicalTransfer.id,
            })
            .returning({ id: schema.transactionLegs.id })

          if (openingLot === undefined || originLeg === undefined || destinationLeg === undefined) {
            return yield* Effect.dieMessage("Failed to seed replay internal transfer legs")
          }

          yield* db.insert(schema.disposalMatches).values({
            disposalLegId: originLeg.id,
            fifoLotId: openingLot.id,
            matchedAmount: "0.25000000",
            costBasis: "12500.00000000",
            proceeds: "12500.00000000",
            gainLoss: "0.00000000",
          })
          if (laterOriginUsage !== null) {
            const [laterOriginConsumer] = yield* db
              .insert(schema.transactionLegs)
              .values({
                sourceId: TEST_SOURCE_ID,
                externalId: "replay-later-origin-consumer",
                timestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.10000000",
                kind: laterOriginUsage === "disposal" ? "disposal" : "fee",
                provenance: "deterministic",
                derivationRule: "fixture_later_origin_consumer",
              })
              .returning({ id: schema.transactionLegs.id })
            if (laterOriginConsumer === undefined) {
              return yield* Effect.dieMessage("Failed to seed later origin FIFO usage")
            }
            if (laterOriginUsage === "disposal") {
              yield* db.insert(schema.disposalMatches).values({
                disposalLegId: laterOriginConsumer.id,
                fifoLotId: openingLot.id,
                matchedAmount: "0.10000000",
                costBasis: "5000.00000000",
                proceeds: "6000.00000000",
                gainLoss: "1000.00000000",
              })
            } else {
              const [movement] = yield* db
                .insert(schema.inventoryMovements)
                .values({
                  principalId: TEST_PRINCIPAL_ID,
                  sourceId: TEST_SOURCE_ID,
                  transactionId: originTransaction.id,
                  transactionLegId: laterOriginConsumer.id,
                  assetId: TEST_BTC_ASSET_ID,
                  timestamp,
                  direction: "outbound",
                  purpose: "fee",
                  taxTreatment: "pending_review",
                  reconciliationStatus: "unmatched",
                  amount: "0.10000000",
                })
                .returning({ id: schema.inventoryMovements.id })
              if (movement === undefined) {
                return yield* Effect.dieMessage("Failed to seed later origin allocation")
              }
              yield* db.insert(schema.inventoryMovementAllocations).values({
                inventoryMovementId: movement.id,
                fifoLotId: openingLot.id,
                matchedAmount: "0.10000000",
              })
            }
          }
          const [destinationLot] = yield* db
            .insert(schema.fifoLots)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: REPLAY_DESTINATION_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: timestamp,
              originalAmount: "0.25000000",
              remainingAmount: "0.20000000",
              costBasisPerToken: "50000.000000000000000000",
              costBasisCurrency: "EUR",
              sourceLegId: destinationLeg.id,
            })
            .returning({ id: schema.fifoLots.id })
          const [sameSourceConsumer] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: REPLAY_DESTINATION_SOURCE_ID,
              externalId: "replay-destination-lot-consumer",
              timestamp: new Date("2025-04-11T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              addressId: REPLAY_DESTINATION_ADDRESS_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.05000000",
              kind: "disposal",
              provenance: "deterministic",
              derivationRule: "fixture_same_source_consumer",
            })
            .returning({ id: schema.transactionLegs.id })
          if (destinationLot === undefined || sameSourceConsumer === undefined) {
            return yield* Effect.dieMessage("Failed to seed same-source destination lot usage")
          }
          yield* db.insert(schema.disposalMatches).values({
            disposalLegId: sameSourceConsumer.id,
            fifoLotId: destinationLot.id,
            matchedAmount: "0.05000000",
            costBasis: "2500.00000000",
            proceeds: "3000.00000000",
            gainLoss: "500.00000000",
          })
          yield* db.insert(schema.transactionReviews).values([
            {
              transactionId: originTransaction.id,
              principalId: TEST_PRINCIPAL_ID,
              reviewStatus: "auto_applied",
              currentTypeKey: "internal_transfer",
              categorizationReason:
                "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
              matchedLayer: "transfer_reconciliation",
              needsReview: false,
            },
            {
              transactionId: destinationTransaction.id,
              principalId: TEST_PRINCIPAL_ID,
              reviewStatus: "auto_applied",
              currentTypeKey: "internal_transfer",
              categorizationReason:
                "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
              matchedLayer: "transfer_reconciliation",
              needsReview: false,
            },
          ])
          yield* db.insert(schema.inventoryMovements).values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: originTransaction.id,
            providerTransferId: providerTransfer.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.25000000",
          })

          return {
            openingLotId: openingLot.id,
            originTransactionId: originTransaction.id,
            providerTransferId: providerTransfer.id,
            sameSourceConsumerId: sameSourceConsumer.id,
          }
        })
      )

      const replayResult = await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({
            sourceId: REPLAY_DESTINATION_SOURCE_ID,
            expectedPrincipalId: TEST_PRINCIPAL_ID,
          })
        ).pipe(Effect.either)
      )

      if (laterOriginUsage !== null) {
        expect(replayResult).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "SourceReplayDependencyError",
            sourceId: REPLAY_DESTINATION_SOURCE_ID,
            dependentSourceIds: [TEST_SOURCE_ID],
            affectedPrincipalIds: [TEST_PRINCIPAL_ID],
          },
        })
      } else {
        expect(replayResult).toMatchObject({ _tag: "Right" })
      }

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [openingLot] = yield* db
            .select({ remainingAmount: schema.fifoLots.remainingAmount })
            .from(schema.fifoLots)
            .where(eq(schema.fifoLots.id, fixtureState.openingLotId))
          const [originTransaction] = yield* db
            .select({ transactionType: schema.transactions.transactionType })
            .from(schema.transactions)
            .where(eq(schema.transactions.id, fixtureState.originTransactionId))
          const internalLegs = yield* db
            .select({ id: schema.transactionLegs.id })
            .from(schema.transactionLegs)
            .where(eq(schema.transactionLegs.derivationRule, "internal_transfer_out"))
          const reconciliations = yield* db.select().from(schema.transferReconciliations)
          const [movement] = yield* db
            .select({
              taxTreatment: schema.inventoryMovements.taxTreatment,
              reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
            })
            .from(schema.inventoryMovements)
            .where(
              eq(schema.inventoryMovements.providerTransferId, fixtureState.providerTransferId)
            )
          const [sameSourceConsumer] = yield* db
            .select({ id: schema.transactionLegs.id })
            .from(schema.transactionLegs)
            .where(eq(schema.transactionLegs.id, fixtureState.sameSourceConsumerId))

          return {
            openingLot,
            originTransaction,
            internalLegs,
            reconciliations,
            movement,
            sameSourceConsumer,
          }
        })
      )

      if (laterOriginUsage !== null) {
        expect(state.openingLot?.remainingAmount).toContain("0.65000000")
        expect(state.originTransaction?.transactionType).toBe("internal_transfer")
        expect(state.internalLegs).toHaveLength(1)
        expect(state.reconciliations).toHaveLength(1)
        expect(state.sameSourceConsumer).toBeDefined()
        expect(state.movement).toEqual({
          taxTreatment: "non_taxable",
          reconciliationStatus: "matched",
        })
      } else {
        expect(state.openingLot?.remainingAmount).toContain("1.00000000")
        expect(state.originTransaction?.transactionType).toBeNull()
        expect(state.internalLegs).toEqual([])
        expect(state.reconciliations).toEqual([])
        expect(state.sameSourceConsumer).toBeUndefined()
        expect(state.movement).toEqual({
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
        })
      }
    }
  )

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
          feeTransfers: [],
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
          expectedPrincipalId: TEST_PRINCIPAL_ID,
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
            return yield* Effect.dieMessage("Failed to create dependent replay source address")
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
            return yield* Effect.dieMessage("Failed to create cross-source replay legs")
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
            return yield* Effect.dieMessage("Failed to create cross-source replay lot")
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
              return yield* Effect.dieMessage("Failed to create cross-source replay allocation")
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
          repository.resetSourceDerivedState({
            sourceId: TEST_SOURCE_ID,
            expectedPrincipalId: TEST_PRINCIPAL_ID,
          })
        ).pipe(Effect.either)
      )

      expect(replayResult).toMatchObject({
        _tag: "Left",
        left: {
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
