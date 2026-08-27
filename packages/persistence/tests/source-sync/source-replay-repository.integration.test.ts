import { eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
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
  SourceReplayPlanRepository,
  SourceReplayRepository,
  SourceSyncJobRepository,
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

const runReplayPlanRepository = <A, E>(effect: Effect.Effect<A, E, SourceReplayPlanRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceReplayRepositoryLive }))

const runSyncJobRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncJobRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncJobRepositoryLive }))

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
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
      })
      yield* seedTransaction({
        id: replayTransactionId,
        sourceId: TEST_SOURCE_ID,
        externalId: "replay-consumption",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
      })
      const ownerLegId = yield* seedLeg({
        sourceId: ownerSourceId,
        transactionId: ownerTransactionId,
        externalId: "owner-acquisition-leg",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        amount: "1.00000000",
        kind: "acquisition",
      })
      const replayLegId = yield* seedLeg({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        externalId: "replay-consumption-leg",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
        amount: "0.40000000",
        kind: "fee",
      })
      const lotId = yield* seedFifoLot({
        sourceId: ownerSourceId,
        sourceLegId: ownerLegId,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "1.00000000",
        remainingAmount: "0.60000000",
        costBasisPerToken: "10000.00",
      })
      const movementId = yield* seedInventoryMovement({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        transactionLegId: replayLegId,
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
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
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
      })
      yield* seedTransaction({
        id: dependentTransactionId,
        sourceId: dependentSourceId,
        externalId: "dependent-movement-origin",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
      })
      yield* seedTransaction({
        id: downstreamTransactionId,
        sourceId: downstreamSourceId,
        externalId: "downstream-movement-origin",
        timestamp: new Date("2025-01-03T10:00:00.000Z"),
      })
      const acquisitionLegId = yield* seedLeg({
        sourceId: TEST_SOURCE_ID,
        transactionId: replayTransactionId,
        externalId: "replay-lot-origin-leg",
        timestamp: new Date("2025-01-01T10:00:00.000Z"),
        amount: "1.00000000",
        kind: "acquisition",
      })
      const dependentLegId = yield* seedLeg({
        sourceId: dependentSourceId,
        transactionId: dependentTransactionId,
        externalId: "dependent-consumption-leg",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
        amount: dependentLegKind === "disposal" ? "-0.40000000" : "0.40000000",
        kind: dependentLegKind,
      })
      const dependentAcquisitionLegId = yield* seedLeg({
        sourceId: dependentSourceId,
        transactionId: dependentTransactionId,
        externalId: "dependent-acquisition-leg",
        timestamp: new Date("2025-01-02T10:00:00.000Z"),
        amount: "0.50000000",
        kind: "acquisition",
      })
      const downstreamLegId = yield* seedLeg({
        sourceId: downstreamSourceId,
        transactionId: downstreamTransactionId,
        externalId: "downstream-consumption-leg",
        timestamp: new Date("2025-01-03T10:00:00.000Z"),
        amount: "0.20000000",
        kind: "fee",
      })
      const lotId = yield* seedFifoLot({
        sourceId: TEST_SOURCE_ID,
        sourceLegId: acquisitionLegId,
        acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
        originalAmount: "1.00000000",
        remainingAmount: "0.60000000",
        costBasisPerToken: "10000.00",
      })
      const dependentLotId = yield* seedFifoLot({
        sourceId: dependentSourceId,
        sourceLegId: dependentAcquisitionLegId,
        acquiredAt: new Date("2025-01-02T10:00:00.000Z"),
        originalAmount: "0.50000000",
        remainingAmount: "0.30000000",
        costBasisPerToken: "11000.00",
      })
      const downstreamMovementId = yield* seedInventoryMovement({
        sourceId: downstreamSourceId,
        transactionId: downstreamTransactionId,
        transactionLegId: downstreamLegId,
        timestamp: new Date("2025-01-03T10:00:00.000Z"),
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
          timestamp: new Date("2025-01-02T10:00:00.000Z"),
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

  it("persists replay prerequisites and keeps the earliest rebuild boundary", async () => {
    const [firstPrerequisiteJob, secondPrerequisiteJob, replayJob] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .insert(schema.processingJobs)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "completed",
            },
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "completed",
            },
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "pending",
            },
          ])
          .returning({ id: schema.processingJobs.id })
      })
    )

    if (
      firstPrerequisiteJob === undefined ||
      secondPrerequisiteJob === undefined ||
      replayJob === undefined
    ) {
      throw new Error("Failed to create replay plan jobs")
    }

    const earliestBoundary = new Date("2025-01-01T00:00:00.000Z")
    await runReplayPlanRepository(
      Effect.flatMap(SourceReplayPlanRepository, (repository) =>
        repository.recordReplayPlan({
          jobId: replayJob.id,
          prerequisiteJobIds: [firstPrerequisiteJob.id],
          rebuildFrom: earliestBoundary,
        })
      )
    )

    const plan = await runReplayPlanRepository(
      Effect.flatMap(SourceReplayPlanRepository, (repository) =>
        repository.recordReplayPlan({
          jobId: replayJob.id,
          prerequisiteJobIds: [secondPrerequisiteJob.id],
          rebuildFrom: new Date("2025-01-03T00:00:00.000Z"),
        })
      )
    )

    expect(plan).toEqual({
      jobId: replayJob.id,
      prerequisiteJobIds: [firstPrerequisiteJob.id, secondPrerequisiteJob.id].sort(),
      rebuildFrom: earliestBoundary,
    })
  })

  it("returns a typed error for a missing prerequisite without changing the replay plan", async () => {
    const existingPrerequisiteJobId = "00000000-0000-0000-0000-000000000403"
    const missingPrerequisiteJobId = "00000000-0000-0000-0000-000000000404"
    const replayJobId = "00000000-0000-0000-0000-000000000405"
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.processingJobs).values([
          {
            id: existingPrerequisiteJobId,
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "completed",
          },
          {
            id: replayJobId,
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "pending",
          },
        ])
      })
    )

    const failedPlan = await runReplayPlanRepository(
      Effect.flatMap(SourceReplayPlanRepository, (repository) =>
        repository
          .recordReplayPlan({
            jobId: replayJobId,
            prerequisiteJobIds: [missingPrerequisiteJobId],
            rebuildFrom: new Date("2025-01-01T00:00:00.000Z"),
          })
          .pipe(Effect.result)
      )
    )

    expect(failedPlan).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SourceReplayPlanJobNotFoundError",
        jobId: missingPrerequisiteJobId,
      },
    })

    const acceptedBoundary = new Date("2025-01-03T00:00:00.000Z")
    const acceptedPlan = await runReplayPlanRepository(
      Effect.flatMap(SourceReplayPlanRepository, (repository) =>
        repository.recordReplayPlan({
          jobId: replayJobId,
          prerequisiteJobIds: [existingPrerequisiteJobId],
          rebuildFrom: acceptedBoundary,
        })
      )
    )

    expect(acceptedPlan).toEqual({
      jobId: replayJobId,
      prerequisiteJobIds: [existingPrerequisiteJobId],
      rebuildFrom: acceptedBoundary,
    })
  })

  it("waits for FIFO owner inventory locks before resetting replay state", async () => {
    const { ownerSourceId, replayJobId } = await seedFifoOwnerLockScenario()

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
              .where(eq(schema.sources.id, ownerSourceId))
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
        repository.resetSourceDerivedState({ jobId: replayJobId, sourceId: TEST_SOURCE_ID })
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
          jobId: "00000000-0000-0000-0000-000000000270",
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
    "plans and gates dependent replay when another source has a $dependencyKind consuming one of its FIFO lots",
    async ({ dependencyKind, dependentLegKind }) => {
      const { dependentSourceId, downstreamSourceId, replayJobId } =
        await seedReplayDependencyScenario({ dependencyKind, dependentLegKind })

      const replayResult = await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID, jobId: replayJobId })
        )
      )

      const dependentReplay = replayResult.dependentReplays.find(
        (replay) => replay.sourceId === dependentSourceId
      )
      const downstreamReplay = replayResult.dependentReplays.find(
        (replay) => replay.sourceId === downstreamSourceId
      )

      expect(dependentReplay).toMatchObject({
        sourceId: dependentSourceId,
        prerequisiteJobIds: [replayJobId],
        rebuildFrom: new Date("2025-01-01T10:00:00.000Z"),
      })
      expect(downstreamReplay).toMatchObject({
        sourceId: downstreamSourceId,
        prerequisiteJobIds: [dependentReplay?.jobId],
        rebuildFrom: new Date("2025-01-02T10:00:00.000Z"),
      })

      expect(dependentReplay).toBeDefined()
      if (dependentReplay === undefined) return

      const blockedDispatch = await runSyncJobRepository(
        Effect.flatMap(SourceSyncJobRepository, (repository) =>
          repository.getExecutionJob({ jobId: dependentReplay.jobId }).pipe(Effect.result)
        )
      )
      expect(blockedDispatch).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SourceSyncJobExecutionRecordConflictError" },
      })

      await runPg(
        Effect.flatMap(drizzle, (db) =>
          db
            .update(schema.processingJobs)
            .set({ status: "completed", progressDetails: { failedRecords: 0 } })
            .where(eq(schema.processingJobs.id, replayJobId))
        )
      )
      const readyDispatch = await runSyncJobRepository(
        Effect.flatMap(SourceSyncJobRepository, (repository) =>
          repository.getExecutionJob({ jobId: dependentReplay.jobId })
        )
      )
      expect(readyDispatch).toMatchObject({ id: dependentReplay.jobId, status: "pending" })

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
      expect(state.movements).toHaveLength(dependencyKind === "inventory allocation" ? 2 : 1)
      expect(state.allocations).toHaveLength(1)
      expect(state.matches).toHaveLength(0)
    }
  )
})
