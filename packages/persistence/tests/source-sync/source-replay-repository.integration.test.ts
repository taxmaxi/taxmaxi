import { and, eq, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { sourceInventoryLockQuery } from "../../src/layers/SourceInventoryLock.ts"
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

const runJobRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncJobRepository>) =>
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

const seedUpstreamConsumption = ({
  ownerSourceId,
  relationshipKind,
  suffix,
}: {
  readonly ownerSourceId: string
  readonly relationshipKind: "inventory allocation" | "disposal match"
  readonly suffix: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [address] = yield* db
      .insert(schema.addresses)
      .values({
        address: `bc1qupstream-replay-${suffix}`,
        type: "bitcoin",
        name: `Upstream replay owner ${suffix}`,
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.addresses.id })
    if (address === undefined) {
      return yield* Effect.die("Failed to create upstream replay address")
    }

    yield* db.insert(schema.sources).values({
      id: ownerSourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: `Upstream replay owner ${suffix}`,
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      cexAccountId: null,
      addressId: address.id,
    })
    const [ownerTransaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ownerSourceId,
        externalId: `upstream-owner-${suffix}`,
        timestamp: new Date("2025-01-01T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    const [consumerTransaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        externalId: `upstream-consumer-${suffix}`,
        timestamp: new Date("2025-01-02T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (ownerTransaction === undefined || consumerTransaction === undefined) {
      return yield* Effect.die("Failed to create upstream replay transactions")
    }

    const [ownerLeg] = yield* db
      .insert(schema.transactionLegs)
      .values({
        sourceId: ownerSourceId,
        externalId: `upstream-owner-leg-${suffix}`,
        timestamp: new Date("2025-01-01T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "1.00000000",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: ownerTransaction.id,
      })
      .returning({ id: schema.transactionLegs.id })
    const [consumerLeg] = yield* db
      .insert(schema.transactionLegs)
      .values({
        sourceId: TEST_SOURCE_ID,
        externalId: `upstream-consumer-leg-${suffix}`,
        timestamp: new Date("2025-01-02T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "-0.20000000",
        kind: relationshipKind === "inventory allocation" ? "fee" : "disposal",
        provenance: "deterministic",
        transactionId: consumerTransaction.id,
      })
      .returning({ id: schema.transactionLegs.id })
    if (ownerLeg === undefined || consumerLeg === undefined) {
      return yield* Effect.die("Failed to create upstream replay legs")
    }

    const [lot] = yield* db
      .insert(schema.fifoLots)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId: ownerSourceId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T08:00:00.000Z"),
        originalAmount: "1.00000000",
        remainingAmount: "0.80000000",
        costBasisPerToken: "10000.00",
        costBasisCurrency: "EUR",
        sourceLegId: ownerLeg.id,
      })
      .returning({ id: schema.fifoLots.id })
    if (lot === undefined) {
      return yield* Effect.die("Failed to create upstream replay inventory")
    }

    if (relationshipKind === "inventory allocation") {
      const [movement] = yield* db
        .insert(schema.inventoryMovements)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
          transactionId: consumerTransaction.id,
          transactionLegId: consumerLeg.id,
          assetId: TEST_BTC_ASSET_ID,
          timestamp: new Date("2025-01-02T08:00:00.000Z"),
          direction: "outbound",
          purpose: "fee",
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
          amount: "0.20000000",
        })
        .returning({ id: schema.inventoryMovements.id })
      if (movement === undefined) {
        return yield* Effect.die("Failed to create upstream replay movement")
      }
      yield* db.insert(schema.inventoryMovementAllocations).values({
        inventoryMovementId: movement.id,
        fifoLotId: lot.id,
        matchedAmount: "0.20000000",
      })
    } else {
      yield* db.insert(schema.disposalMatches).values({
        disposalLegId: consumerLeg.id,
        fifoLotId: lot.id,
        matchedAmount: "0.20000000",
        costBasis: "2000.00",
        proceeds: "2500.00",
        gainLoss: "500.00",
      })
    }

    return { lotId: lot.id }
  })

const seedDownstreamConsumption = ({
  dependentSourceId,
  relationshipKind,
  suffix,
}: {
  readonly dependentSourceId: string
  readonly relationshipKind: "inventory allocation" | "disposal match"
  readonly suffix: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [address] = yield* db
      .insert(schema.addresses)
      .values({
        address: `bc1qdownstream-replay-${suffix}`,
        type: "bitcoin",
        name: `Downstream replay consumer ${suffix}`,
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.addresses.id })
    if (address === undefined) {
      return yield* Effect.die("Failed to create downstream replay address")
    }

    yield* db.insert(schema.sources).values({
      id: dependentSourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: `Downstream replay consumer ${suffix}`,
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      cexAccountId: null,
      addressId: address.id,
    })
    const [ownerTransaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        externalId: `downstream-owner-${suffix}`,
        timestamp: new Date("2025-01-01T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    const [consumerTransaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: dependentSourceId,
        externalId: `downstream-consumer-${suffix}`,
        timestamp: new Date("2025-01-02T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (ownerTransaction === undefined || consumerTransaction === undefined) {
      return yield* Effect.die("Failed to create downstream replay transactions")
    }

    const [ownerLeg] = yield* db
      .insert(schema.transactionLegs)
      .values({
        sourceId: TEST_SOURCE_ID,
        externalId: `downstream-owner-leg-${suffix}`,
        timestamp: new Date("2025-01-01T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "1.00000000",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: ownerTransaction.id,
      })
      .returning({ id: schema.transactionLegs.id })
    const [consumerLeg] = yield* db
      .insert(schema.transactionLegs)
      .values({
        sourceId: dependentSourceId,
        externalId: `downstream-consumer-leg-${suffix}`,
        timestamp: new Date("2025-01-02T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "-0.20000000",
        kind: relationshipKind === "inventory allocation" ? "fee" : "disposal",
        provenance: "deterministic",
        transactionId: consumerTransaction.id,
      })
      .returning({ id: schema.transactionLegs.id })
    if (ownerLeg === undefined || consumerLeg === undefined) {
      return yield* Effect.die("Failed to create downstream replay legs")
    }

    const [lot] = yield* db
      .insert(schema.fifoLots)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T08:00:00.000Z"),
        originalAmount: "1.00000000",
        remainingAmount: "0.80000000",
        costBasisPerToken: "10000.00",
        costBasisCurrency: "EUR",
        sourceLegId: ownerLeg.id,
      })
      .returning({ id: schema.fifoLots.id })
    if (lot === undefined) {
      return yield* Effect.die("Failed to create downstream replay inventory")
    }

    if (relationshipKind === "inventory allocation") {
      const [movement] = yield* db
        .insert(schema.inventoryMovements)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: dependentSourceId,
          transactionId: consumerTransaction.id,
          transactionLegId: consumerLeg.id,
          assetId: TEST_BTC_ASSET_ID,
          timestamp: new Date("2025-01-02T08:00:00.000Z"),
          direction: "outbound",
          purpose: "fee",
          taxTreatment: "pending_review",
          reconciliationStatus: "unmatched",
          amount: "0.20000000",
        })
        .returning({ id: schema.inventoryMovements.id })
      if (movement === undefined) {
        return yield* Effect.die("Failed to create downstream replay movement")
      }
      yield* db.insert(schema.inventoryMovementAllocations).values({
        inventoryMovementId: movement.id,
        fifoLotId: lot.id,
        matchedAmount: "0.20000000",
      })
    } else {
      yield* db.insert(schema.disposalMatches).values({
        disposalLegId: consumerLeg.id,
        fifoLotId: lot.id,
        matchedAmount: "0.20000000",
        costBasis: "2000.00",
        proceeds: "2500.00",
        gainLoss: "500.00",
      })
    }
  })

const seedIndependentReplayInventory = ({
  createSource,
  sourceId,
  suffix,
}: {
  readonly createSource: boolean
  readonly sourceId: string
  readonly suffix: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    if (createSource) {
      const [address] = yield* db
        .insert(schema.addresses)
        .values({
          address: `bc1qindependent-replay-${suffix}`,
          type: "bitcoin",
          name: `Independent replay ${suffix}`,
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.addresses.id })
      if (address === undefined) {
        return yield* Effect.die("Failed to create independent replay address")
      }

      yield* db.insert(schema.sources).values({
        id: sourceId,
        principalId: TEST_PRINCIPAL_ID,
        name: `Independent replay ${suffix}`,
        providerKey: "bitcoin-rpc",
        sourceableType: "onchain",
        cexAccountId: null,
        addressId: address.id,
      })
    }

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId,
        externalId: `independent-replay-${suffix}`,
        timestamp: new Date("2025-01-01T08:00:00.000Z"),
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) {
      return yield* Effect.die("Failed to create independent replay transaction")
    }

    const [acquisitionLeg, disposalLeg] = yield* db
      .insert(schema.transactionLegs)
      .values([
        {
          sourceId,
          externalId: `independent-replay-acquisition-${suffix}`,
          timestamp: new Date("2025-01-01T08:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "1.00000000",
          kind: "acquisition" as const,
          provenance: "deterministic" as const,
          transactionId: transaction.id,
        },
        {
          sourceId,
          externalId: `independent-replay-disposal-${suffix}`,
          timestamp: new Date("2025-01-02T08:00:00.000Z"),
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "-0.20000000",
          kind: "disposal" as const,
          provenance: "deterministic" as const,
          transactionId: transaction.id,
        },
      ])
      .returning({ id: schema.transactionLegs.id, kind: schema.transactionLegs.kind })
    if (acquisitionLeg === undefined || disposalLeg === undefined) {
      return yield* Effect.die("Failed to create independent replay legs")
    }

    const legsByKind = new Map(
      [acquisitionLeg, disposalLeg].map((leg) => [leg.kind, leg.id] as const)
    )
    const acquisitionLegId = legsByKind.get("acquisition")
    const disposalLegId = legsByKind.get("disposal")
    if (acquisitionLegId === undefined || disposalLegId === undefined) {
      return yield* Effect.die("Failed to identify independent replay legs")
    }

    const [lot] = yield* db
      .insert(schema.fifoLots)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: new Date("2025-01-01T08:00:00.000Z"),
        originalAmount: "1.00000000",
        remainingAmount: "0.80000000",
        costBasisPerToken: "10000.00",
        costBasisCurrency: "EUR",
        sourceLegId: acquisitionLegId,
      })
      .returning({ id: schema.fifoLots.id })
    if (lot === undefined) {
      return yield* Effect.die("Failed to create independent replay lot")
    }

    yield* db.insert(schema.disposalMatches).values({
      disposalLegId,
      fifoLotId: lot.id,
      matchedAmount: "0.20000000",
      costBasis: "2000.00",
      proceeds: "2500.00",
      gainLoss: "500.00",
    })
  })

const holdSourceInventoryLock = ({
  sourceId,
  acquired,
  release,
}: {
  readonly sourceId: string
  readonly acquired: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sourceInventoryLockQuery([sourceId]))
          yield* Deferred.succeed(acquired, undefined)
          yield* Deferred.await(release)
        })
      )
    })
  )

describe("SourceReplayRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  const seedLateDependentApplication = ({
    activeMode,
    ownerSourceId,
    suffix,
  }: {
    readonly activeMode: "replay" | "sync"
    readonly ownerSourceId: string
    readonly suffix: string
  }) =>
    runPg(
      Effect.gen(function* () {
        yield* seedUpstreamConsumption({
          ownerSourceId,
          relationshipKind: "disposal match",
          suffix,
        })
        const db = yield* drizzle
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: suffix,
            mintAddress: null,
            action: "set",
            inspectedSystemRevision: `${suffix}-revision`,
            inspectedIdentityState: "resolved",
            inspectedAssetId: TEST_BTC_ASSET_ID,
            replacementAssetId: TEST_BTC_ASSET_ID,
            actorId: fixture.userId,
            reason: "Track a dependent while another job is active.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        const [activeJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: activeMode,
            status: activeMode === "sync" ? "processing" : "pending",
          })
          .returning({ id: schema.processingJobs.id })
        if (override === undefined || activeJob === undefined) {
          return yield* Effect.die("Failed to seed late dependent application")
        }
        yield* db.insert(schema.principalAssetOverrideApplications).values({
          overrideId: override.id,
          sourceId: ownerSourceId,
          dependsOnSourceIds: [],
        })
        return { activeJobId: activeJob.id, overrideId: override.id }
      })
    )

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

  it.each([
    { relationshipKind: "inventory allocation", ownerSourceSuffix: "291" },
    { relationshipKind: "disposal match", ownerSourceSuffix: "294" },
  ] as const)(
    "waits for an upstream FIFO lot owner's inventory lock for a $relationshipKind",
    async ({ relationshipKind, ownerSourceSuffix }) => {
      const ownerSourceId = `00000000-0000-0000-0000-000000000${ownerSourceSuffix}`
      const { lotId } = await runPg(
        seedUpstreamConsumption({
          ownerSourceId,
          relationshipKind,
          suffix: `owner-lock-${ownerSourceSuffix}`,
        })
      )
      const lockAcquired = await Effect.runPromise(Deferred.make<void>())
      const releaseLock = await Effect.runPromise(Deferred.make<void>())
      const heldLock = holdSourceInventoryLock({
        sourceId: ownerSourceId,
        acquired: lockAcquired,
        release: releaseLock,
      })
      await Effect.runPromise(Deferred.await(lockAcquired))

      const replay = runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
        )
      )

      await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })
      await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
      await Promise.all([heldLock, replay])

      const [lot] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db.select().from(schema.fifoLots).where(eq(schema.fifoLots.id, lotId))
        })
      )
      expect(lot?.remainingAmount).toContain("1.00000000")
    }
  )

  it.each([
    { relationshipKind: "inventory allocation", consumerSourceSuffix: "307" },
    { relationshipKind: "disposal match", consumerSourceSuffix: "308" },
  ] as const)(
    "waits for a downstream FIFO consumer inventory lock for a $relationshipKind",
    async ({ relationshipKind, consumerSourceSuffix }) => {
      const dependentSourceId = `00000000-0000-0000-0000-000000000${consumerSourceSuffix}`
      await runPg(
        seedDownstreamConsumption({
          dependentSourceId,
          relationshipKind,
          suffix: `consumer-lock-${consumerSourceSuffix}`,
        })
      )
      const lockAcquired = await Effect.runPromise(Deferred.make<void>())
      const releaseLock = await Effect.runPromise(Deferred.make<void>())
      const heldLock = holdSourceInventoryLock({
        sourceId: dependentSourceId,
        acquired: lockAcquired,
        release: releaseLock,
      })
      await Effect.runPromise(Deferred.await(lockAcquired))

      const replay = runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
        )
      )

      await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })
      await Effect.runPromise(Deferred.succeed(releaseLock, undefined))
      await Promise.all([heldLock, replay])

      const [dependentReplay] = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, dependentSourceId))
        })
      )
      expect(dependentReplay).toEqual({ mode: "replay", status: "pending" })
    }
  )

  it("retries with a newly discovered downstream FIFO consumer locked", async () => {
    const firstConsumerSourceId = "00000000-0000-0000-0000-000000000309"
    const secondConsumerSourceId = "00000000-0000-0000-0000-000000000310"
    await runPg(
      seedDownstreamConsumption({
        dependentSourceId: firstConsumerSourceId,
        relationshipKind: "inventory allocation",
        suffix: "first-consumer",
      })
    )

    const firstLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseFirstLock = await Effect.runPromise(Deferred.make<void>())
    const firstHeldLock = holdSourceInventoryLock({
      sourceId: firstConsumerSourceId,
      acquired: firstLockAcquired,
      release: releaseFirstLock,
    })
    await Effect.runPromise(Deferred.await(firstLockAcquired))

    const replay = runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      )
    )
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })

    const secondLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseSecondLock = await Effect.runPromise(Deferred.make<void>())
    const secondHeldLock = holdSourceInventoryLock({
      sourceId: secondConsumerSourceId,
      acquired: secondLockAcquired,
      release: releaseSecondLock,
    })
    await Effect.runPromise(Deferred.await(secondLockAcquired))
    await runPg(
      seedDownstreamConsumption({
        dependentSourceId: secondConsumerSourceId,
        relationshipKind: "disposal match",
        suffix: "second-consumer",
      })
    )

    await Effect.runPromise(Deferred.succeed(releaseFirstLock, undefined))
    await firstHeldLock
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })

    await Effect.runPromise(Deferred.succeed(releaseSecondLock, undefined))
    await Promise.all([secondHeldLock, replay])

    const dependentSourceIds = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const jobs = yield* db
          .select({ sourceId: schema.processingJobs.sourceId })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.mode, "replay"))
        return jobs.map(({ sourceId }) => sourceId).sort()
      })
    )
    expect(dependentSourceIds).toEqual([firstConsumerSourceId, secondConsumerSourceId].sort())
  })

  it("runs two disjoint replay resets concurrently without deadlocking", async () => {
    const otherSourceId = "00000000-0000-0000-0000-000000000312"
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* seedIndependentReplayInventory({
          createSource: false,
          sourceId: TEST_SOURCE_ID,
          suffix: "first",
        })
        yield* seedIndependentReplayInventory({
          createSource: true,
          sourceId: otherSourceId,
          suffix: "second",
        })
        yield* db.execute(
          sql.raw(`
            create function pause_source_replay_leg_delete()
            returns trigger
            language plpgsql
            as $$
            begin
              perform pg_sleep(1);
              return null;
            end;
            $$
          `)
        )
        yield* db.execute(
          sql.raw(`
            create trigger pause_source_replay_leg_delete
            before delete on transaction_legs
            for each statement execute function pause_source_replay_leg_delete()
          `)
        )
      })
    )

    const replay = (sourceId: string) =>
      runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId })
        ).pipe(Effect.result)
      )
    const replays = [replay(TEST_SOURCE_ID), replay(otherSourceId)]
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const [activity] = yield* db.$client<{ readonly count: string }>`
            select count(*)::text as count
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event = 'PgSleep'
              and position('delete from "transaction_legs"' in query) > 0
          `
          if (Number(activity?.count ?? "0") >= 2) return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Disjoint replay deletes did not overlap")
      })
    )

    const results = await Promise.all(replays)

    expect(results).toEqual([
      expect.objectContaining({ _tag: "Success" }),
      expect.objectContaining({ _tag: "Success" }),
    ])
  })

  it("defers a consumer replay until its active inventory-owner replay finishes", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000295"
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId,
        relationshipKind: "disposal match",
        suffix: "ordered-owner",
      })
    )
    const ownerJobId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: ownerSourceId,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "pending",
          })
          .returning({ id: schema.processingJobs.id })
        if (job === undefined) return yield* Effect.die("Failed to seed owner replay job")
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: "ordered-owner-dependency",
            mintAddress: null,
            action: "set",
            inspectedSystemRevision: "ordered-owner-revision",
            inspectedIdentityState: "resolved",
            inspectedAssetId: TEST_BTC_ASSET_ID,
            replacementAssetId: TEST_BTC_ASSET_ID,
            actorId: fixture.userId,
            reason: "Keep the consumer behind its inventory owner.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        if (override === undefined) return yield* Effect.die("Failed to seed replay override")
        yield* db.insert(schema.principalAssetOverrideApplications).values([
          {
            overrideId: override.id,
            sourceId: ownerSourceId,
            replayJobId: job.id,
            dependsOnSourceIds: [],
          },
          {
            overrideId: override.id,
            sourceId: TEST_SOURCE_ID,
            replayJobId: null,
            dependsOnSourceIds: [ownerSourceId],
          },
        ])
        return job.id
      })
    )

    const deferred = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      ).pipe(Effect.result)
    )
    expect(deferred).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SourceReplayDependencyPendingError",
        sourceId: TEST_SOURCE_ID,
        ownerSourceIds: [ownerSourceId],
      },
    })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "failed", errorMessage: "owner replay failed" })
          .where(eq(schema.processingJobs.id, ownerJobId))
      })
    )
    const failedOwner = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      ).pipe(Effect.result)
    )
    expect(failedOwner).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SourceReplayDependencyPendingError", ownerSourceIds: [ownerSourceId] },
    })

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({
            status: "completed",
            completedAt: new Date("2025-01-03T00:00:00.000Z"),
            progressDetails: { failedRecords: 0 },
          })
          .where(eq(schema.processingJobs.id, ownerJobId))
      })
    )
    const replayed = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      ).pipe(Effect.result)
    )
    expect(replayed).toMatchObject({ _tag: "Success" })
  })

  it("records a durable application for a FIFO dependent discovered after acceptance", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000298"
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId,
        relationshipKind: "disposal match",
        suffix: "late-override-dependent",
      })
    )
    const overrideId = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: "late-override-dependent",
            mintAddress: null,
            action: "set",
            inspectedSystemRevision: "late-override-dependent-revision",
            inspectedIdentityState: "resolved",
            inspectedAssetId: TEST_BTC_ASSET_ID,
            replacementAssetId: TEST_BTC_ASSET_ID,
            actorId: fixture.userId,
            reason: "Track dependents discovered when the owner replay starts.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        if (override === undefined) return yield* Effect.die("Failed to seed late override")
        yield* db.insert(schema.principalAssetOverrideApplications).values({
          overrideId: override.id,
          sourceId: ownerSourceId,
          dependsOnSourceIds: [],
        })
        return override.id
      })
    )

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: ownerSourceId })
      )
    )

    const dependent = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [application] = yield* db
          .select({
            replayJobId: schema.principalAssetOverrideApplications.replayJobId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
          .limit(1)
        return application
      })
    )
    expect(dependent).toEqual({
      replayJobId: expect.any(String),
      dependsOnSourceIds: [ownerSourceId],
    })
  })

  it("links the owner application to the current replay before scheduling its consumer", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000311"
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId,
        relationshipKind: "disposal match",
        suffix: "current-owner-replay",
      })
    )
    const seeded = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: "current-owner-replay",
            mintAddress: null,
            action: "set",
            inspectedSystemRevision: "current-owner-replay-revision",
            inspectedIdentityState: "resolved",
            inspectedAssetId: TEST_BTC_ASSET_ID,
            replacementAssetId: TEST_BTC_ASSET_ID,
            actorId: fixture.userId,
            reason: "Keep consumers behind the replay that is resetting their owner.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        const [staleJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: ownerSourceId,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "completed",
            completedAt: new Date("2025-01-01T00:00:00.000Z"),
            progressDetails: { failedRecords: 0 },
          })
          .returning({ id: schema.processingJobs.id })
        const [currentJob] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: ownerSourceId,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "processing",
          })
          .returning({ id: schema.processingJobs.id })
        if (override === undefined || staleJob === undefined || currentJob === undefined) {
          return yield* Effect.die("Failed to seed current owner replay")
        }
        yield* db.insert(schema.principalAssetOverrideApplications).values({
          overrideId: override.id,
          sourceId: ownerSourceId,
          replayJobId: staleJob.id,
          dependsOnSourceIds: [],
        })
        return { currentJobId: currentJob.id, overrideId: override.id }
      })
    )

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: ownerSourceId })
      )
    )

    const applications = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            sourceId: schema.principalAssetOverrideApplications.sourceId,
            replayJobId: schema.principalAssetOverrideApplications.replayJobId,
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
          .where(eq(schema.principalAssetOverrideApplications.overrideId, seeded.overrideId))
      })
    )
    const ownerApplication = applications.find(({ sourceId }) => sourceId === ownerSourceId)
    const consumerApplication = applications.find(({ sourceId }) => sourceId === TEST_SOURCE_ID)

    expect(ownerApplication).toEqual({
      sourceId: ownerSourceId,
      replayJobId: seeded.currentJobId,
      dependsOnSourceIds: [],
    })
    expect(consumerApplication).toEqual({
      sourceId: TEST_SOURCE_ID,
      replayJobId: expect.any(String),
      dependsOnSourceIds: [ownerSourceId],
    })
    const consumerReplayJobId = consumerApplication?.replayJobId
    expect(consumerReplayJobId).toEqual(expect.any(String))
    if (consumerReplayJobId === null || consumerReplayJobId === undefined) return

    const dispatchable = await runJobRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.listPendingJobsNeedingDispatch({
          jobId: consumerReplayJobId,
          staleBefore: new Date("2030-01-01T00:00:00.000Z"),
          limit: 1,
        })
      )
    )
    expect(dispatchable).toEqual([])
  })

  it("links a late FIFO-dependent application to an active replay", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000299"
    const { activeJobId, overrideId } = await seedLateDependentApplication({
      activeMode: "replay",
      ownerSourceId,
      suffix: "late-active-replay",
    })

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: ownerSourceId })
      )
    )

    const application = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        return row
      })
    )

    expect(application?.replayJobId).toBe(activeJobId)

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.processingJobs)
          .set({ status: "processing" })
          .where(eq(schema.processingJobs.id, activeJobId))
      })
    )
    await runJobRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({
          jobId: activeJobId,
          state: {
            phase: "completed",
            processedRecords: 0,
            totalRecords: 0,
            fetchedRecords: 0,
            normalizedRecords: 0,
            failedRecords: 0,
            cursorPayload: null,
            highWatermark: null,
            checkpointExternalId: null,
            checkpointRawRecordId: null,
          },
        })
      )
    )

    const afterCompletion = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [completedJob] = yield* db
          .select({ followUpJobId: schema.processingJobs.followUpJobId })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, activeJobId))
        const [followUp] =
          completedJob?.followUpJobId === null || completedJob?.followUpJobId === undefined
            ? []
            : yield* db
                .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
                .from(schema.processingJobs)
                .where(eq(schema.processingJobs.id, completedJob.followUpJobId))
        const [repointedApplication] = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        return { followUp, repointedApplication }
      })
    )
    expect(afterCompletion).toEqual({
      followUp: { id: expect.any(String), mode: "replay" },
      repointedApplication: { replayJobId: afterCompletion.followUp?.id },
    })
  })

  it("links a late FIFO-dependent application when a replay wins the insertion race", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000304"
    const { activeJobId, overrideId } = await seedLateDependentApplication({
      activeMode: "replay",
      ownerSourceId,
      suffix: "late-racing-replay",
    })
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.delete(schema.processingJobs).where(eq(schema.processingJobs.id, activeJobId))
        yield* db.execute(
          sql.raw(`
            CREATE FUNCTION test_insert_racing_dependency_replay()
            RETURNS trigger AS $$
            BEGIN
              IF pg_trigger_depth() = 1 THEN
                INSERT INTO processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  progress_details
                ) VALUES (
                  NEW.source_id,
                  NEW.principal_id,
                  'replay',
                  'pending',
                  '{"mode":"replay","reason":"race_test"}'::jsonb
                );
                RETURN NULL;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
          `)
        )
        yield* db.execute(
          sql.raw(`
            CREATE TRIGGER test_insert_racing_dependency_replay
            BEFORE INSERT ON processing_jobs
            FOR EACH ROW
            EXECUTE FUNCTION test_insert_racing_dependency_replay()
          `)
        )
      })
    )

    try {
      await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: ownerSourceId })
        )
      )
    } finally {
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(
              "DROP TRIGGER IF EXISTS test_insert_racing_dependency_replay ON processing_jobs"
            )
          )
          yield* db.execute(
            sql.raw("DROP FUNCTION IF EXISTS test_insert_racing_dependency_replay()")
          )
        })
      )
    }

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [application] = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        const [job] = yield* db
          .select({
            id: schema.processingJobs.id,
            progressDetails: schema.processingJobs.progressDetails,
          })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        return { application, job }
      })
    )
    expect(state).toEqual({
      application: { replayJobId: state.job?.id },
      job: {
        id: expect.any(String),
        progressDetails: { mode: "replay", reason: "race_test" },
      },
    })
  })

  it("returns a typed retryable error when dependent replay scheduling stays contended", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000305"
    await seedLateDependentApplication({
      activeMode: "replay",
      ownerSourceId,
      suffix: "late-contended-replay",
    })
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.execute(
          sql.raw(`
            CREATE FUNCTION test_block_dependent_replay_update()
            RETURNS trigger AS $$
            BEGIN
              IF NEW.follow_up_mode = 'replay' THEN
                RETURN NULL;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
          `)
        )
        yield* db.execute(
          sql.raw(`
            CREATE TRIGGER test_block_dependent_replay_update
            BEFORE UPDATE ON processing_jobs
            FOR EACH ROW
            EXECUTE FUNCTION test_block_dependent_replay_update()
          `)
        )
      })
    )

    try {
      const result = await Effect.runPromise(
        context
          .runWithLayer({
            effect: Effect.flatMap(SourceReplayRepository, (repository) =>
              repository.resetSourceDerivedState({ sourceId: ownerSourceId })
            ),
            layer: SourceReplayRepositoryLive,
          })
          .pipe(Effect.result)
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourceReplaySchedulingPendingError")
      }
    } finally {
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw("DROP TRIGGER IF EXISTS test_block_dependent_replay_update ON processing_jobs")
          )
          yield* db.execute(sql.raw("DROP FUNCTION IF EXISTS test_block_dependent_replay_update()"))
        })
      )
    }
  })

  it("repoints a late FIFO-dependent application after an active sync completes", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000301"
    const { activeJobId, overrideId } = await seedLateDependentApplication({
      activeMode: "sync",
      ownerSourceId,
      suffix: "late-active-sync",
    })

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: ownerSourceId })
      )
    )

    const beforeCompletion = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [application] = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        const [activeJob] = yield* db
          .select({ followUpMode: schema.processingJobs.followUpMode })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, activeJobId))
        return { activeJob, application }
      })
    )
    expect(beforeCompletion).toEqual({
      activeJob: { followUpMode: "replay" },
      application: { replayJobId: null },
    })

    await runJobRepository(
      Effect.flatMap(SourceSyncJobRepository, (repository) =>
        repository.completeJob({
          jobId: activeJobId,
          state: {
            phase: "completed",
            processedRecords: 0,
            totalRecords: 0,
            fetchedRecords: 0,
            normalizedRecords: 0,
            failedRecords: 0,
            cursorPayload: null,
            highWatermark: null,
            checkpointExternalId: null,
            checkpointRawRecordId: null,
          },
        })
      )
    )

    const afterCompletion = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [application] = yield* db
          .select({ replayJobId: schema.principalAssetOverrideApplications.replayJobId })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        const [completedJob] = yield* db
          .select({ followUpJobId: schema.processingJobs.followUpJobId })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, activeJobId))
        const [followUp] =
          completedJob?.followUpJobId === null || completedJob?.followUpJobId === undefined
            ? []
            : yield* db
                .select({ id: schema.processingJobs.id, mode: schema.processingJobs.mode })
                .from(schema.processingJobs)
                .where(eq(schema.processingJobs.id, completedJob.followUpJobId))
        return { application, followUp }
      })
    )
    expect(afterCompletion).toEqual({
      application: { replayJobId: afterCompletion.followUp?.id },
      followUp: { id: expect.any(String), mode: "replay" },
    })
  })

  it("merges durable dependencies when another inventory owner is discovered", async () => {
    const firstOwnerSourceId = "00000000-0000-0000-0000-000000000302"
    const secondOwnerSourceId = "00000000-0000-0000-0000-000000000303"
    const overrideId = await runPg(
      Effect.gen(function* () {
        yield* seedUpstreamConsumption({
          ownerSourceId: firstOwnerSourceId,
          relationshipKind: "disposal match",
          suffix: "merge-first-owner",
        })
        yield* seedUpstreamConsumption({
          ownerSourceId: secondOwnerSourceId,
          relationshipKind: "disposal match",
          suffix: "merge-second-owner",
        })
        const db = yield* drizzle
        const [override] = yield* db
          .insert(schema.principalAssetOverrides)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            kind: "identity",
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: "merged-owner-dependencies",
            mintAddress: null,
            action: "set",
            inspectedSystemRevision: "merged-owner-dependencies-revision",
            inspectedIdentityState: "resolved",
            inspectedAssetId: TEST_BTC_ASSET_ID,
            replacementAssetId: TEST_BTC_ASSET_ID,
            actorId: fixture.userId,
            reason: "Preserve every FIFO owner dependency.",
          })
          .returning({ id: schema.principalAssetOverrides.id })
        if (override === undefined) return yield* Effect.die("Failed to seed merged override")
        yield* db.insert(schema.principalAssetOverrideApplications).values([
          {
            overrideId: override.id,
            sourceId: firstOwnerSourceId,
            dependsOnSourceIds: [],
          },
          {
            overrideId: override.id,
            sourceId: secondOwnerSourceId,
            dependsOnSourceIds: [],
          },
        ])
        return override.id
      })
    )

    for (const ownerSourceId of [firstOwnerSourceId, secondOwnerSourceId]) {
      await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: ownerSourceId })
        )
      )
    }

    const application = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({
            dependsOnSourceIds: schema.principalAssetOverrideApplications.dependsOnSourceIds,
          })
          .from(schema.principalAssetOverrideApplications)
          .where(
            and(
              eq(schema.principalAssetOverrideApplications.overrideId, overrideId),
              eq(schema.principalAssetOverrideApplications.sourceId, TEST_SOURCE_ID)
            )
          )
        return row
      })
    )
    expect(application?.dependsOnSourceIds).toEqual([firstOwnerSourceId, secondOwnerSourceId])
  })

  it("rejects a cross-principal FIFO link from either replay direction", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000305"
    const otherPrincipalId = "00000000-0000-0000-0000-000000000306"
    await runPg(
      Effect.gen(function* () {
        yield* seedUpstreamConsumption({
          ownerSourceId,
          relationshipKind: "disposal match",
          suffix: "cross-principal-dependent",
        })
        const db = yield* drizzle
        yield* db.insert(schema.principals).values({
          id: otherPrincipalId,
          kind: "anonymous_wallet",
          userId: null,
        })
        yield* db
          .update(schema.sources)
          .set({ principalId: otherPrincipalId })
          .where(eq(schema.sources.id, TEST_SOURCE_ID))
      })
    )

    const ownerResult = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: ownerSourceId })
      ).pipe(Effect.result)
    )
    expect(ownerResult).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SourceReplayDependencyError",
        dependentSourceIds: [TEST_SOURCE_ID],
        affectedPrincipalIds: [otherPrincipalId],
      },
    })

    const dependentResult = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      ).pipe(Effect.result)
    )
    expect(dependentResult).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SourceReplayDependencyError",
        dependentSourceIds: [TEST_SOURCE_ID],
        affectedPrincipalIds: [TEST_PRINCIPAL_ID],
      },
    })
  })

  it("rejects a source replay whose cross-source inventory dependencies form a cycle", async () => {
    const ownerSourceId = "00000000-0000-0000-0000-000000000296"
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId,
        relationshipKind: "disposal match",
        suffix: "cyclic-owner",
      })
    )
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const timestamp = new Date("2025-01-03T08:00:00.000Z")
        const [sourceTransaction, ownerTransaction] = yield* db
          .insert(schema.transactions)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "cyclic-source-acquisition",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              sourceId: ownerSourceId,
              externalId: "cyclic-owner-disposal",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          .returning({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
        if (sourceTransaction === undefined || ownerTransaction === undefined) {
          return yield* Effect.die("Failed to seed cyclic replay transactions")
        }
        const transactionBySource = new Map(
          [sourceTransaction, ownerTransaction].map((transaction) => [
            transaction.sourceId,
            transaction.id,
          ])
        )
        const sourceTransactionId = transactionBySource.get(TEST_SOURCE_ID)
        const ownerTransactionId = transactionBySource.get(ownerSourceId)
        if (sourceTransactionId === undefined || ownerTransactionId === undefined) {
          return yield* Effect.die("Failed to identify cyclic replay transactions")
        }

        const [sourceLeg, ownerLeg] = yield* db
          .insert(schema.transactionLegs)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "cyclic-source-acquisition-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: sourceTransactionId,
            },
            {
              sourceId: ownerSourceId,
              externalId: "cyclic-owner-disposal-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "disposal",
              provenance: "deterministic",
              transactionId: ownerTransactionId,
            },
          ])
          .returning({ id: schema.transactionLegs.id, sourceId: schema.transactionLegs.sourceId })
        if (sourceLeg === undefined || ownerLeg === undefined) {
          return yield* Effect.die("Failed to seed cyclic replay legs")
        }
        const legBySource = new Map([sourceLeg, ownerLeg].map((leg) => [leg.sourceId, leg.id]))
        const sourceLegId = legBySource.get(TEST_SOURCE_ID)
        const ownerLegId = legBySource.get(ownerSourceId)
        if (sourceLegId === undefined || ownerLegId === undefined) {
          return yield* Effect.die("Failed to identify cyclic replay legs")
        }

        const [sourceLot] = yield* db
          .insert(schema.fifoLots)
          .values({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: timestamp,
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "10000",
            costBasisCurrency: "EUR",
            sourceLegId,
          })
          .returning({ id: schema.fifoLots.id })
        if (sourceLot === undefined) return yield* Effect.die("Failed to seed cyclic replay lot")

        yield* db.insert(schema.disposalMatches).values({
          disposalLegId: ownerLegId,
          fifoLotId: sourceLot.id,
          matchedAmount: "1",
          costBasis: "10000",
          proceeds: "11000",
          gainLoss: "1000",
        })
      })
    )

    const result = await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      ).pipe(Effect.result)
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SourceReplayDependencyCycleError", sourceId: TEST_SOURCE_ID },
    })
  })

  it("retries with a newly referenced upstream FIFO owner locked", async () => {
    const firstOwnerSourceId = "00000000-0000-0000-0000-000000000292"
    const secondOwnerSourceId = "00000000-0000-0000-0000-000000000293"
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId: firstOwnerSourceId,
        relationshipKind: "inventory allocation",
        suffix: "first",
      })
    )

    const firstLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseFirstLock = await Effect.runPromise(Deferred.make<void>())
    const firstHeldLock = holdSourceInventoryLock({
      sourceId: firstOwnerSourceId,
      acquired: firstLockAcquired,
      release: releaseFirstLock,
    })
    await Effect.runPromise(Deferred.await(firstLockAcquired))

    const replay = runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      )
    )
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })

    const secondLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseSecondLock = await Effect.runPromise(Deferred.make<void>())
    const secondHeldLock = holdSourceInventoryLock({
      sourceId: secondOwnerSourceId,
      acquired: secondLockAcquired,
      release: releaseSecondLock,
    })
    await Effect.runPromise(Deferred.await(secondLockAcquired))
    await runPg(
      seedUpstreamConsumption({
        ownerSourceId: secondOwnerSourceId,
        relationshipKind: "inventory allocation",
        suffix: "second",
      })
    )

    await Effect.runPromise(Deferred.succeed(releaseFirstLock, undefined))
    await firstHeldLock
    await context.waitForQueryBlockedOnLock({ queryIncludes: "source-inventory:" })

    await Effect.runPromise(Deferred.succeed(releaseSecondLock, undefined))
    await Promise.all([secondHeldLock, replay])

    const allocations = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db.select().from(schema.inventoryMovementAllocations)
      })
    )
    expect(allocations).toHaveLength(0)
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
    "resets replay state and schedules a dependent source with a $dependencyKind",
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

      expect(replayResult).toMatchObject({ _tag: "Success" })

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const lots = yield* db.select().from(schema.fifoLots)
          const movements = yield* db.select().from(schema.inventoryMovements)
          const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
          const matches = yield* db.select().from(schema.disposalMatches)
          const jobs = yield* db
            .select({ sourceId: schema.processingJobs.sourceId, mode: schema.processingJobs.mode })
            .from(schema.processingJobs)
          return { lots, movements, allocations, matches, jobs }
        })
      )

      expect(state.lots).toHaveLength(0)
      expect(state.movements).toHaveLength(dependencyKind === "inventory allocation" ? 1 : 0)
      expect(state.allocations).toHaveLength(0)
      expect(state.matches).toHaveLength(0)
      expect(state.jobs).toEqual([{ sourceId: dependentSourceId, mode: "replay" }])
    }
  )
})
