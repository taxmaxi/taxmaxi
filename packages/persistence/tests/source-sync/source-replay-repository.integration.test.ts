import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"
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
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      payload: { id: "raw-replay-1" },
      importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
    })
  })

const seedOnchainSource = ({
  sourceId,
  address,
  name,
}: {
  readonly sourceId: string
  readonly address: string
  readonly name: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [addressRow] = yield* db
      .insert(schema.addresses)
      .values({ address, type: "bitcoin", name, principalId: TEST_PRINCIPAL_ID })
      .returning({ id: schema.addresses.id })
    if (addressRow === undefined) return yield* Effect.die(`Failed to create ${name} address`)

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: TEST_PRINCIPAL_ID,
      name,
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      addressId: addressRow.id,
    })
  })

const seedTransaction = ({
  id,
  sourceId,
  externalId,
  timestamp,
}: {
  readonly id: string
  readonly sourceId: string
  readonly externalId: string
  readonly timestamp: Date
}) =>
  Effect.flatMap(drizzle, (db) =>
    db.insert(schema.transactions).values({
      id,
      sourceId,
      externalId,
      timestamp,
      principalId: TEST_PRINCIPAL_ID,
    })
  )

const seedLeg = ({
  sourceId,
  transactionId,
  externalId,
  timestamp,
  amount,
  kind,
}: {
  readonly sourceId: string
  readonly transactionId: string
  readonly externalId: string
  readonly timestamp: Date
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "fee"
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [leg] = yield* db
      .insert(schema.transactionLegs)
      .values({
        sourceId,
        externalId,
        timestamp,
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount,
        kind,
        provenance: "deterministic",
        transactionId,
      })
      .returning({ id: schema.transactionLegs.id })
    if (leg === undefined) return yield* Effect.die(`Failed to create ${externalId}`)
    return leg.id
  })

const seedFifoLot = ({
  sourceId,
  sourceLegId,
  acquiredAt,
  originalAmount,
  remainingAmount,
  costBasisPerToken,
}: {
  readonly sourceId: string
  readonly sourceLegId: string
  readonly acquiredAt: Date
  readonly originalAmount: string
  readonly remainingAmount: string
  readonly costBasisPerToken: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [lot] = yield* db
      .insert(schema.fifoLots)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt,
        originalAmount,
        remainingAmount,
        costBasisPerToken,
        costBasisCurrency: "EUR",
        sourceLegId,
      })
      .returning({ id: schema.fifoLots.id })
    if (lot === undefined) return yield* Effect.die("Failed to create FIFO lot")
    return lot.id
  })

const seedInventoryMovement = ({
  sourceId,
  transactionId,
  transactionLegId,
  timestamp,
  amount,
}: {
  readonly sourceId: string
  readonly transactionId: string
  readonly transactionLegId: string
  readonly timestamp: Date
  readonly amount: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [movement] = yield* db
      .insert(schema.inventoryMovements)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId,
        transactionId,
        transactionLegId,
        assetId: TEST_BTC_ASSET_ID,
        timestamp,
        direction: "outbound",
        purpose: "fee",
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
        amount,
      })
      .returning({ id: schema.inventoryMovements.id })
    if (movement === undefined) return yield* Effect.die("Failed to create inventory movement")
    return movement.id
  })

const seedFifoOwnerLockScenario = () => {
  const ownerSourceId = "00000000-0000-0000-0000-000000000271"
  const ownerTransactionId = "00000000-0000-0000-0000-000000000272"
  const replayTransactionId = "00000000-0000-0000-0000-000000000273"
  const replayJobId = "00000000-0000-0000-0000-000000000274"

  return runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* seedOnchainSource({
        sourceId: ownerSourceId,
        address: "bc1qsource-replay-owner",
        name: "Replay FIFO owner",
      })
      yield* seedTransaction({
        id: ownerTransactionId,
        sourceId: ownerSourceId,
        externalId: "owner-acquisition",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      })
      yield* seedTransaction({
        id: replayTransactionId,
        sourceId: TEST_SOURCE_ID,
        externalId: "replay-consumption",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
      })
      const ownerLegId = yield* seedLeg({
        sourceId: ownerSourceId,
        transactionId: ownerTransactionId,
        externalId: "owner-acquisition-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        amount: "1.00000000",
        kind: "acquisition",
      })
      const replayLegId = yield* seedLeg({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        externalId: "replay-consumption-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        amount: "0.40000000",
        kind: "fee",
      })
      const lotId = yield* seedFifoLot({
        sourceId: ownerSourceId,
        sourceLegId: ownerLegId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        originalAmount: "1.00000000",
        remainingAmount: "0.60000000",
        costBasisPerToken: "10000.00",
      })
      const movementId = yield* seedInventoryMovement({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        transactionLegId: replayLegId,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        amount: "0.40000000",
      })
      yield* db.insert(schema.inventoryMovementAllocations).values({
        inventoryMovementId: movementId,
        fifoLotId: lotId,
        matchedAmount: "0.40000000",
      })
      yield* db.insert(schema.processingJobs).values({
        id: replayJobId,
        sourceId: TEST_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        mode: "replay",
        status: "processing",
      })

      return { ownerSourceId, replayJobId }
    })
  )
}

const seedReplayDependencyScenario = ({
  dependencyKind,
  dependentLegKind,
}: {
  readonly dependencyKind: "inventory allocation" | "disposal match"
  readonly dependentLegKind: "fee" | "disposal"
}) => {
  const dependentSourceId = "00000000-0000-0000-0000-000000000282"
  const replayTransactionId = "00000000-0000-0000-0000-000000000283"
  const dependentTransactionId = "00000000-0000-0000-0000-000000000284"
  const replayJobId = "00000000-0000-0000-0000-000000000285"
  const downstreamSourceId = "00000000-0000-0000-0000-000000000286"
  const downstreamTransactionId = "00000000-0000-0000-0000-000000000287"

  return runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* seedOnchainSource({
        sourceId: dependentSourceId,
        address: "bc1qsource-replay-dependent",
        name: "Replay dependent source",
      })
      yield* seedOnchainSource({
        sourceId: downstreamSourceId,
        address: "bc1qsource-replay-downstream",
        name: "Replay downstream source",
      })
      yield* db.insert(schema.processingJobs).values({
        id: replayJobId,
        sourceId: TEST_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        mode: "replay",
        status: "processing",
      })
      yield* seedTransaction({
        id: replayTransactionId,
        sourceId: TEST_SOURCE_ID,
        externalId: "replay-lot-origin",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      })
      yield* seedTransaction({
        id: dependentTransactionId,
        sourceId: dependentSourceId,
        externalId: "dependent-movement-origin",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
      })
      yield* seedTransaction({
        id: downstreamTransactionId,
        sourceId: downstreamSourceId,
        externalId: "downstream-movement-origin",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T10:00:00.000Z")),
      })
      const acquisitionLegId = yield* seedLeg({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        externalId: "replay-lot-origin-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        amount: "1.00000000",
        kind: "acquisition",
      })
      const dependentLegId = yield* seedLeg({
        sourceId: dependentSourceId,
        transactionId: dependentTransactionId,
        externalId: "dependent-consumption-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        amount: dependentLegKind === "disposal" ? "-0.40000000" : "0.40000000",
        kind: dependentLegKind,
      })
      const dependentAcquisitionLegId = yield* seedLeg({
        sourceId: dependentSourceId,
        transactionId: dependentTransactionId,
        externalId: "dependent-acquisition-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        amount: "0.50000000",
        kind: "acquisition",
      })
      const downstreamLegId = yield* seedLeg({
        sourceId: downstreamSourceId,
        transactionId: downstreamTransactionId,
        externalId: "downstream-consumption-leg",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T10:00:00.000Z")),
        amount: "0.20000000",
        kind: "fee",
      })
      const lotId = yield* seedFifoLot({
        sourceId: TEST_SOURCE_ID,
        sourceLegId: acquisitionLegId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        originalAmount: "1.00000000",
        remainingAmount: "0.60000000",
        costBasisPerToken: "10000.00",
      })
      const dependentLotId = yield* seedFifoLot({
        sourceId: dependentSourceId,
        sourceLegId: dependentAcquisitionLegId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
        originalAmount: "0.50000000",
        remainingAmount: "0.30000000",
        costBasisPerToken: "11000.00",
      })
      const downstreamMovementId = yield* seedInventoryMovement({
        sourceId: downstreamSourceId,
        transactionId: downstreamTransactionId,
        transactionLegId: downstreamLegId,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T10:00:00.000Z")),
        amount: "0.20000000",
      })
      yield* db.insert(schema.inventoryMovementAllocations).values({
        inventoryMovementId: downstreamMovementId,
        fifoLotId: dependentLotId,
        matchedAmount: "0.20000000",
      })

      if (dependencyKind === "inventory allocation") {
        const movementId = yield* seedInventoryMovement({
          sourceId: dependentSourceId,
          transactionId: dependentTransactionId,
          transactionLegId: dependentLegId,
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
          amount: "0.40000000",
        })
        yield* db.insert(schema.inventoryMovementAllocations).values({
          inventoryMovementId: movementId,
          fifoLotId: lotId,
          matchedAmount: "0.40000000",
        })
      } else {
        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: dependentLegId,
          fifoLotId: lotId,
          matchedAmount: "0.40000000",
          costBasis: "4000.00",
          proceeds: "5000.00",
          gainLoss: "1000.00",
        })
      }

      return { dependentSourceId, downstreamSourceId, replayJobId }
    })
  )
}

describe("SourceReplayRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
        yield* Effect.promise(() => runPg(seedReplayRawRecord()))
      })
    )
  )

  it.effect("resets factual rows without waiting for legacy FIFO owner locks", () =>
    Effect.gen(function* () {
      const { ownerSourceId } = yield* Effect.promise(() => seedFifoOwnerLockScenario())

      const sourceLockAcquired = yield* Deferred.make<void>()
      const releaseSourceLock = yield* Deferred.make<void>()
      const heldSourceLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, ownerSourceId))
                .for("update")
              yield* Deferred.succeed(sourceLockAcquired, undefined)
              yield* Deferred.await(releaseSourceLock)
            })
          )
        })
      )

      yield* Deferred.await(sourceLockAcquired)

      const replayWhileSourceLocked = runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
        )
      ).then(() => "completed" as const)

      const replayBeforeSourceRelease = yield* Effect.raceFirst(
        Effect.promise(() => replayWhileSourceLocked),
        Effect.sleep(500).pipe(Effect.as("blocked" as const))
      )

      expect(replayBeforeSourceRelease).toBe("completed")

      yield* Deferred.succeed(releaseSourceLock, undefined)
      yield* Effect.promise(() => heldSourceLock)
    })
  )

  it.effect("clears canonical source-derived rows while keeping cached raw rows reusable", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runNormalization(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                externalId: "tx-replay-1",
                externalGroupId: "group-replay-1",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-replay-1",
                providerDescription: "Replay seed buy",
                providerCreatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")
                ),
                providerUpdatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")
                ),
                metadata: { provider: "coinbase" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
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
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
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
      )

      yield* Effect.promise(() =>
        runRawRepository(
          Effect.flatMap(SourceRawRecordRepository, (repository) =>
            repository.markRawRecordNormalized({
              rawRecordId: TEST_RAW_RECORD_ID,
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runReplayRepository(
          Effect.flatMap(SourceReplayRepository, (repository) =>
            repository.resetSourceDerivedState({
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runRawRepository(
          Effect.flatMap(SourceRawRecordRepository, (repository) =>
            repository.resetNormalizationStateForSource({
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const snapshot = yield* Effect.promise(() =>
        runPg(
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
            const rawRows = yield* db
              .select()
              .from(schema.sourceRecordsRaw)
              .where(eq(schema.sourceRecordsRaw.sourceId, TEST_SOURCE_ID))
            return {
              transactions,
              transfers,
              legs,
              reviews,
              rawRows,
            }
          })
        )
      )

      expect(snapshot.transactions).toHaveLength(0)
      expect(snapshot.transfers).toHaveLength(0)
      expect(snapshot.legs).toHaveLength(0)
      expect(snapshot.reviews).toHaveLength(0)
      expect(snapshot.rawRows).toHaveLength(1)
      expect(snapshot.rawRows[0]?.externalRecordId).toBe("raw-replay-1")
      expect(snapshot.rawRows[0]?.normalizedAt).toBeNull()
      expect(snapshot.rawRows[0]?.normalizationError).toBeNull()
    })
  )

  it.effect.each([
    { dependencyKind: "inventory allocation", dependentLegKind: "fee" },
    { dependencyKind: "disposal match", dependentLegKind: "disposal" },
  ] as const)(
    "ignores legacy $dependencyKind projections when resetting factual source rows",
    ({ dependencyKind, dependentLegKind }) =>
      Effect.gen(function* () {
        const { dependentSourceId, downstreamSourceId } = yield* Effect.promise(() =>
          seedReplayDependencyScenario({ dependencyKind, dependentLegKind })
        )

        yield* Effect.promise(() =>
          runReplayRepository(
            Effect.flatMap(SourceReplayRepository, (repository) =>
              repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
            )
          )
        )

        const state = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const processingJobs = yield* db
                .select({ sourceId: schema.processingJobs.sourceId })
                .from(schema.processingJobs)
              const lots = yield* db.select().from(schema.fifoLots)
              const movements = yield* db.select().from(schema.inventoryMovements)
              const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
              const matches = yield* db.select().from(schema.disposalMatches)
              return { processingJobs, lots, movements, allocations, matches }
            })
          )
        )

        expect(
          state.processingJobs.filter(
            ({ sourceId }) => sourceId === dependentSourceId || sourceId === downstreamSourceId
          )
        ).toEqual([])
        expect(state.lots).toHaveLength(1)
        expect(state.movements).toHaveLength(dependencyKind === "inventory allocation" ? 2 : 1)
        expect(state.allocations).toHaveLength(1)
        expect(state.matches).toHaveLength(0)
      })
  )
})
