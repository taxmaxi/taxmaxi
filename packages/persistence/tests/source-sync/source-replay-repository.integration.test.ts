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

    const replayGenerationBefore = new Date("2000-01-01T00:00:00.000Z")
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.sources)
          .set({ updatedAt: replayGenerationBefore })
          .where(eq(schema.sources.id, TEST_SOURCE_ID))
      })
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
        const [source] = yield* db
          .select({ updatedAt: schema.sources.updatedAt })
          .from(schema.sources)
          .where(eq(schema.sources.id, TEST_SOURCE_ID))
          .limit(1)
        return {
          transactions,
          transfers,
          legs,
          reviews,
          fifoLots,
          rawRows,
          source,
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
    expect(snapshot.source?.updatedAt.getTime()).toBeGreaterThan(replayGenerationBefore.getTime())
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
          repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
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

  it.each([
    {
      replaySide: "provider",
      downstreamUsage: null,
      remainingReconciliationStatus: "approved",
      outcome: "clears",
    },
    {
      replaySide: "canonical",
      downstreamUsage: null,
      remainingReconciliationStatus: "approved",
      outcome: "clears",
    },
    {
      replaySide: "provider",
      downstreamUsage: "disposal",
      remainingReconciliationStatus: "approved",
      outcome: "blocks",
    },
    {
      replaySide: "provider",
      downstreamUsage: "allocation",
      remainingReconciliationStatus: "approved",
      outcome: "blocks",
    },
    {
      replaySide: "canonical",
      downstreamUsage: "disposal",
      remainingReconciliationStatus: "approved",
      outcome: "clears",
    },
    {
      replaySide: "canonical",
      downstreamUsage: "allocation",
      remainingReconciliationStatus: "approved",
      outcome: "clears",
    },
    {
      replaySide: "provider",
      downstreamUsage: null,
      remainingReconciliationStatus: null,
      outcome: "clears last",
    },
    {
      replaySide: "canonical",
      downstreamUsage: null,
      remainingReconciliationStatus: null,
      outcome: "clears last",
    },
    {
      replaySide: "provider",
      downstreamUsage: null,
      remainingReconciliationStatus: "pending",
      outcome: "ignores pending",
    },
    {
      replaySide: "provider",
      downstreamUsage: null,
      remainingReconciliationStatus: "auto_applied",
      outcome: "preserves auto-applied",
    },
    {
      replaySide: "provider",
      downstreamUsage: null,
      remainingReconciliationStatus: "approved_cascades",
      outcome: "ignores cascading approved",
    },
    {
      replaySide: "canonical",
      downstreamUsage: null,
      remainingReconciliationStatus: "approved_cascades",
      outcome: "ignores canonical cascading approved",
    },
  ] as const)(
    "$outcome copied FIFO state before replaying the $replaySide side of a reconciliation",
    async ({ replaySide, downstreamUsage, remainingReconciliationStatus }) => {
      const dependentSourceId = "00000000-0000-0000-0000-000000000292"
      const originTransactionId = "00000000-0000-0000-0000-000000000293"
      const destinationTransactionId = "00000000-0000-0000-0000-000000000294"
      const providerTransferId = "00000000-0000-0000-0000-000000000295"
      const canonicalTransferId = "00000000-0000-0000-0000-000000000296"
      const basisTransactionId = "00000000-0000-0000-0000-000000000298"
      const unrelatedProviderTransferId = "00000000-0000-0000-0000-000000000299"
      const unrelatedCanonicalTransferId = "00000000-0000-0000-0000-000000000300"
      const destinationProviderTransferId = "00000000-0000-0000-0000-000000000301"
      const destinationCanonicalTransferId = "00000000-0000-0000-0000-000000000302"
      const cascadingProviderTransferId = "00000000-0000-0000-0000-000000000309"
      const cascadingCanonicalTransferId = "00000000-0000-0000-0000-000000000310"
      const durableRemainingReconciliationStatus =
        remainingReconciliationStatus === "approved_cascades" ? null : remainingReconciliationStatus

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [address] = yield* db
            .insert(schema.addresses)
            .values({
              address: "bc1qsource-replay-reconciled-copy",
              type: "bitcoin",
              name: "Replay reconciliation destination",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.addresses.id })

          if (address === undefined) {
            return yield* Effect.dieMessage("Failed to create replay reconciliation address")
          }

          yield* db.insert(schema.sources).values({
            id: dependentSourceId,
            principalId: TEST_PRINCIPAL_ID,
            name: "Replay reconciliation destination",
            providerKey: "bitcoin-rpc",
            sourceableType: "onchain",
            cexAccountId: null,
            addressId: address.id,
          })
          yield* db.insert(schema.transactions).values([
            {
              id: originTransactionId,
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-reconciliation-origin",
              timestamp: new Date("2025-01-02T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              transactionType: "internal_transfer",
            },
            {
              id: destinationTransactionId,
              sourceId: dependentSourceId,
              externalId: "replay-reconciliation-destination",
              timestamp: new Date("2025-01-02T10:05:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              transactionType: "internal_transfer",
            },
            {
              id: basisTransactionId,
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-reconciliation-basis",
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          yield* db.insert(schema.transactionReviews).values([
            {
              transactionId: originTransactionId,
              principalId: TEST_PRINCIPAL_ID,
              reviewStatus: "changed",
              originalTypeKey: "internal_transfer",
              originalConfidence: "1",
              currentTypeKey: "internal_transfer",
              categorizationReason:
                "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
              matchedLayer: "transfer_reconciliation",
              needsReview: false,
              userNotes: "Keep this manual internal-transfer decision.",
              reviewedAt: new Date("2025-01-04T10:00:00.000Z"),
            },
            {
              transactionId: destinationTransactionId,
              principalId: TEST_PRINCIPAL_ID,
              reviewStatus: "needs_review",
              originalTypeKey: "internal_transfer",
              originalConfidence: "1",
              currentTypeKey: "internal_transfer",
              categorizationReason:
                "fifo_inventory: Preserve this unrelated review.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
              matchedLayer: "fifo_inventory,transfer_reconciliation",
              needsReview: true,
            },
          ])
          yield* db.insert(schema.providerTransfers).values([
            {
              id: providerTransferId,
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransactionId,
              externalId: "replay-reconciliation-provider-transfer",
              timestamp: new Date("2025-01-02T10:00:00.000Z"),
              direction: "outbound",
              fromAccountRef: "coinbase-account-1",
              toAddress: "bc1qsource-replay-reconciled-copy",
              amount: "0.5",
            },
            {
              id: unrelatedProviderTransferId,
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransactionId,
              externalId: "replay-unrelated-provider-transfer",
              timestamp: new Date("2025-01-02T10:01:00.000Z"),
              direction: "outbound",
              fromAccountRef: "coinbase-account-1",
              toAddress: "bc1qunrelated-reconciliation",
              amount: "0.25",
            },
            {
              id: destinationProviderTransferId,
              sourceId: dependentSourceId,
              transactionId: destinationTransactionId,
              externalId: "replay-destination-unrelated-provider-transfer",
              timestamp: new Date("2025-01-02T10:07:00.000Z"),
              direction: "outbound",
              fromAccountRef: "dependent-account",
              toAddress: "bc1qdestination-unrelated-reconciliation",
              amount: "0.125",
            },
          ])
          yield* db.insert(schema.inventoryMovements).values([
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransactionId,
              providerTransferId,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: new Date("2025-01-02T10:00:00.000Z"),
              direction: "outbound",
              purpose: "principal",
              taxTreatment: "non_taxable",
              reconciliationStatus: "matched",
              amount: "0.5",
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransactionId,
              providerTransferId: unrelatedProviderTransferId,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: new Date("2025-01-02T10:01:00.000Z"),
              direction: "outbound",
              purpose: "principal",
              taxTreatment:
                durableRemainingReconciliationStatus === "pending"
                  ? "pending_review"
                  : "non_taxable",
              reconciliationStatus:
                durableRemainingReconciliationStatus === "pending" ? "unmatched" : "matched",
              amount: "0.25",
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: dependentSourceId,
              transactionId: destinationTransactionId,
              providerTransferId: destinationProviderTransferId,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: new Date("2025-01-02T10:07:00.000Z"),
              direction: "outbound",
              purpose: "principal",
              taxTreatment:
                durableRemainingReconciliationStatus === "pending"
                  ? "pending_review"
                  : "non_taxable",
              reconciliationStatus:
                durableRemainingReconciliationStatus === "pending" ? "unmatched" : "matched",
              amount: "0.125",
            },
          ])
          yield* db.insert(schema.transfers).values([
            {
              id: canonicalTransferId,
              sourceId: dependentSourceId,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "replay-reconciliation-canonical-transfer",
              timestamp: new Date("2025-01-02T10:05:00.000Z"),
              type: "utxo",
              fromAddress: "coinbase-account-1",
              toAddress: "bc1qsource-replay-reconciled-copy",
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.5",
            },
            {
              id: unrelatedCanonicalTransferId,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "replay-unrelated-canonical-transfer",
              timestamp: new Date("2025-01-02T10:06:00.000Z"),
              type: "utxo",
              fromAddress: "coinbase-account-1",
              toAddress: "bc1qunrelated-reconciliation",
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.25",
            },
            {
              id: destinationCanonicalTransferId,
              sourceId: dependentSourceId,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "replay-destination-unrelated-canonical-transfer",
              timestamp: new Date("2025-01-02T10:08:00.000Z"),
              type: "utxo",
              fromAddress: "dependent-account",
              toAddress: "bc1qdestination-unrelated-reconciliation",
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.125",
            },
          ])
          yield* db.insert(schema.transferReconciliations).values([
            {
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId,
              canonicalTransactionId: destinationTransactionId,
              status: durableRemainingReconciliationStatus ?? "approved",
              matchReason: "replay_dependency_fixture",
              confidence: "1",
              deterministic: true,
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: destinationProviderTransferId,
              canonicalTransferId: destinationCanonicalTransferId,
              canonicalTransactionId: destinationTransactionId,
              status: durableRemainingReconciliationStatus ?? "approved",
              matchReason: "destination_unrelated_reconciliation_fixture",
              confidence: "1",
              deterministic: true,
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: unrelatedProviderTransferId,
              canonicalTransferId: unrelatedCanonicalTransferId,
              canonicalTransactionId: originTransactionId,
              status: "approved",
              matchReason: "unrelated_reconciliation_fixture",
              confidence: "1",
              deterministic: true,
            },
          ])

          if (remainingReconciliationStatus === "approved_cascades") {
            yield* db.insert(schema.providerTransfers).values({
              id: cascadingProviderTransferId,
              sourceId: TEST_SOURCE_ID,
              transactionId: originTransactionId,
              externalId: "replay-cascading-provider-transfer",
              timestamp: new Date("2025-01-02T10:09:00.000Z"),
              direction: "outbound",
              fromAccountRef: "coinbase-account-1",
              toAddress: "bc1qcascading-reconciliation",
              amount: "0.0625",
            })
            yield* db.insert(schema.transfers).values({
              id: cascadingCanonicalTransferId,
              sourceId: dependentSourceId,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "replay-cascading-canonical-transfer",
              timestamp: new Date("2025-01-02T10:10:00.000Z"),
              type: "utxo",
              fromAddress: "coinbase-account-1",
              toAddress: "bc1qcascading-reconciliation",
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.0625",
            })
            yield* db.insert(schema.transferReconciliations).values({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: cascadingProviderTransferId,
              canonicalTransferId: cascadingCanonicalTransferId,
              canonicalTransactionId: destinationTransactionId,
              status: "approved",
              matchReason: "cascading_reconciliation_fixture",
              confidence: "1",
              deterministic: true,
            })
          }

          const reconciliationMetadata = {
            reconciliation: { providerTransferId, canonicalTransferId },
          }
          const [originLeg, destinationLeg] = yield* db
            .insert(schema.transactionLegs)
            .values([
              {
                sourceId: TEST_SOURCE_ID,
                externalId: "replay-reconciliation-origin:internal-transfer-out",
                timestamp: new Date("2025-01-02T10:00:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.5",
                kind: "disposal",
                provenance: "deterministic",
                derivationRule: "internal_transfer_out",
                metadata: reconciliationMetadata,
                transactionId: originTransactionId,
              },
              {
                sourceId: dependentSourceId,
                externalId: "replay-reconciliation-destination:internal-transfer-in",
                timestamp: new Date("2025-01-02T10:05:00.000Z"),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.5",
                kind: "acquisition",
                provenance: "deterministic",
                derivationRule: "internal_transfer_in",
                metadata: reconciliationMetadata,
                transactionId: destinationTransactionId,
                sourceTransferId: canonicalTransferId,
              },
            ])
            .returning({ id: schema.transactionLegs.id })

          if (originLeg === undefined || destinationLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create replay reconciliation legs")
          }

          const [basisLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "replay-reconciliation-basis:acquisition",
              timestamp: new Date("2025-01-01T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.5",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "fixture_acquisition",
              transactionId: basisTransactionId,
            })
            .returning({ id: schema.transactionLegs.id })

          if (basisLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create source basis leg")
          }

          const [basisLot] = yield* db
            .insert(schema.fifoLots)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
              originalAmount: "0.5",
              remainingAmount: "0",
              costBasisPerToken: "10000",
              costBasisCurrency: "EUR",
              sourceLegId: basisLeg.id,
            })
            .returning({ id: schema.fifoLots.id })

          if (basisLot === undefined) {
            return yield* Effect.dieMessage("Failed to create source basis lot")
          }

          yield* db.insert(schema.disposalMatches).values({
            disposalLegId: originLeg.id,
            fifoLotId: basisLot.id,
            matchedAmount: "0.5",
            costBasis: "5000",
            proceeds: "0",
            gainLoss: "-5000",
          })

          const [destinationLot] = yield* db
            .insert(schema.fifoLots)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: dependentSourceId,
              assetId: TEST_BTC_ASSET_ID,
              acquiredAt: new Date("2025-01-01T10:00:00.000Z"),
              originalAmount: "0.5",
              remainingAmount: downstreamUsage === null ? "0.5" : "0.4",
              costBasisPerToken: "10000",
              costBasisCurrency: "EUR",
              sourceLegId: destinationLeg.id,
            })
            .returning({ id: schema.fifoLots.id })

          if (durableRemainingReconciliationStatus === null) {
            yield* db
              .delete(schema.providerTransfers)
              .where(eq(schema.providerTransfers.id, unrelatedProviderTransferId))
            yield* db
              .delete(schema.providerTransfers)
              .where(eq(schema.providerTransfers.id, destinationProviderTransferId))
          }

          if (downstreamUsage === null) {
            return
          }

          if (destinationLot === undefined) {
            return yield* Effect.dieMessage("Failed to create copied reconciliation lot")
          }

          const downstreamTransactionId = "00000000-0000-0000-0000-000000000297"
          yield* db.insert(schema.transactions).values({
            id: downstreamTransactionId,
            sourceId: dependentSourceId,
            externalId: "replay-reconciliation-downstream-disposal",
            timestamp: new Date("2025-01-03T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
          })
          const [downstreamLeg] = yield* db
            .insert(schema.transactionLegs)
            .values({
              sourceId: dependentSourceId,
              externalId: `replay-reconciliation-downstream-${downstreamUsage}:${downstreamUsage}`,
              timestamp: new Date("2025-01-03T10:00:00.000Z"),
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: downstreamUsage === "disposal" ? "disposal" : "fee",
              provenance: "deterministic",
              derivationRule: "fixture_disposal",
              transactionId: downstreamTransactionId,
            })
            .returning({ id: schema.transactionLegs.id })

          if (downstreamLeg === undefined) {
            return yield* Effect.dieMessage("Failed to create downstream disposal leg")
          }

          if (downstreamUsage === "disposal") {
            yield* db.insert(schema.disposalMatches).values({
              disposalLegId: downstreamLeg.id,
              fifoLotId: destinationLot.id,
              matchedAmount: "0.1",
              costBasis: "1000",
              proceeds: "1100",
              gainLoss: "100",
            })
          } else {
            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: dependentSourceId,
                transactionId: downstreamTransactionId,
                transactionLegId: downstreamLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: new Date("2025-01-03T10:00:00.000Z"),
                direction: "outbound",
                purpose: "fee",
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                amount: "0.1",
              })
              .returning({ id: schema.inventoryMovements.id })

            if (movement === undefined) {
              return yield* Effect.dieMessage("Failed to create downstream custody movement")
            }

            yield* db.insert(schema.inventoryMovementAllocations).values({
              inventoryMovementId: movement.id,
              fifoLotId: destinationLot.id,
              matchedAmount: "0.1",
            })
          }
        })
      )

      const replaySourceId = replaySide === "provider" ? TEST_SOURCE_ID : dependentSourceId
      const replayResult = await runReplayRepository(
        Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: replaySourceId })
        ).pipe(Effect.either)
      )
      const shouldBlock = replaySide === "provider" && downstreamUsage !== null
      const preservesReconciliationState =
        durableRemainingReconciliationStatus === "approved" ||
        durableRemainingReconciliationStatus === "auto_applied"

      if (shouldBlock) {
        expect(replayResult).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "SourceReplayDependencyError",
            sourceId: replaySourceId,
            dependentSourceIds: [dependentSourceId],
            affectedPrincipalIds: [TEST_PRINCIPAL_ID],
          },
        })
      } else {
        expect(replayResult).toMatchObject({
          _tag: "Right",
        })
      }

      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const transactions = yield* db.select().from(schema.transactions)
          const legs = yield* db.select().from(schema.transactionLegs)
          const lots = yield* db.select().from(schema.fifoLots)
          const reconciliations = yield* db.select().from(schema.transferReconciliations)
          const reviews = yield* db.select().from(schema.transactionReviews)
          const movements = yield* db.select().from(schema.inventoryMovements)
          const allocations = yield* db.select().from(schema.inventoryMovementAllocations)
          return { transactions, legs, lots, reconciliations, reviews, movements, allocations }
        })
      )
      if (shouldBlock) {
        expect(state.transactions.map((transaction) => transaction.id)).toEqual(
          expect.arrayContaining([originTransactionId, destinationTransactionId])
        )
        expect(state.legs).toHaveLength(4)
        expect(state.lots).toHaveLength(2)
        expect(
          state.lots.find((lot) => lot.sourceId === dependentSourceId)?.remainingAmount
        ).toContain("0.40000000")
        expect(
          state.lots.find((lot) => lot.sourceId === TEST_SOURCE_ID)?.remainingAmount
        ).toContain("0.00000000")
        expect(state.reconciliations).toHaveLength(3)
        expect(state.reviews).toHaveLength(2)
        expect(state.allocations).toHaveLength(downstreamUsage === "allocation" ? 1 : 0)
      } else {
        expect(state.transactions.map((transaction) => transaction.id)).not.toContain(
          replaySide === "provider" ? originTransactionId : destinationTransactionId
        )
        expect(state.transactions.map((transaction) => transaction.id)).toContain(
          replaySide === "provider" ? destinationTransactionId : originTransactionId
        )
        expect(state.reconciliations).toHaveLength(
          durableRemainingReconciliationStatus === null ? 0 : 1
        )

        const survivingReconciliationTransaction = state.transactions.find(
          (transaction) =>
            transaction.id ===
            (replaySide === "provider" ? destinationTransactionId : originTransactionId)
        )
        expect(survivingReconciliationTransaction?.transactionType).toBe(
          preservesReconciliationState || replaySide === "canonical" ? "internal_transfer" : null
        )

        if (replaySide === "provider") {
          expect(state.legs).toHaveLength(0)
          expect(state.lots).toHaveLength(0)
          if (durableRemainingReconciliationStatus === null) {
            expect(state.movements).toHaveLength(0)
          } else {
            expect(state.movements).toEqual([
              expect.objectContaining({
                providerTransferId: destinationProviderTransferId,
                taxTreatment: preservesReconciliationState ? "non_taxable" : "pending_review",
                reconciliationStatus: preservesReconciliationState ? "matched" : "unmatched",
              }),
            ])
          }
          expect(state.reviews).toEqual(
            preservesReconciliationState
              ? [
                  expect.objectContaining({
                    transactionId: destinationTransactionId,
                    reviewStatus: "needs_review",
                    originalTypeKey: "internal_transfer",
                    originalConfidence: "1.00",
                    currentTypeKey: "internal_transfer",
                    categorizationReason:
                      "fifo_inventory: Preserve this unrelated review.\nDeterministic provider transfer reconciled to a principal-owned onchain transfer.",
                    matchedLayer: "fifo_inventory,transfer_reconciliation",
                    needsReview: true,
                  }),
                ]
              : [
                  expect.objectContaining({
                    transactionId: destinationTransactionId,
                    reviewStatus: "needs_review",
                    originalTypeKey: null,
                    originalConfidence: null,
                    currentTypeKey: null,
                    categorizationReason: "fifo_inventory: Preserve this unrelated review.",
                    matchedLayer: "fifo_inventory",
                    needsReview: true,
                  }),
                ]
          )
        } else {
          expect(state.legs).toHaveLength(1)
          expect(state.lots).toHaveLength(1)
          expect(state.lots[0]?.sourceId).toBe(TEST_SOURCE_ID)
          expect(state.lots[0]?.remainingAmount).toContain("0.50000000")
          expect(state.movements).toHaveLength(preservesReconciliationState ? 2 : 1)
          expect(state.movements).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                providerTransferId,
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
              }),
              ...(preservesReconciliationState
                ? [
                    expect.objectContaining({
                      providerTransferId: unrelatedProviderTransferId,
                      taxTreatment: "non_taxable",
                      reconciliationStatus: "matched",
                    }),
                  ]
                : []),
            ])
          )
          expect(state.reviews).toEqual(
            preservesReconciliationState
              ? [
                  expect.objectContaining({
                    transactionId: originTransactionId,
                    reviewStatus: "changed",
                    originalTypeKey: "internal_transfer",
                    originalConfidence: "1.00",
                    currentTypeKey: "internal_transfer",
                    categorizationReason:
                      "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
                    matchedLayer: "transfer_reconciliation",
                    needsReview: false,
                    userNotes: "Keep this manual internal-transfer decision.",
                    reviewedAt: new Date("2025-01-04T10:00:00.000Z"),
                  }),
                ]
              : [
                  expect.objectContaining({
                    transactionId: originTransactionId,
                    reviewStatus: "changed",
                    originalTypeKey: null,
                    originalConfidence: null,
                    currentTypeKey: "internal_transfer",
                    categorizationReason: null,
                    matchedLayer: null,
                    needsReview: false,
                    userNotes: "Keep this manual internal-transfer decision.",
                    reviewedAt: new Date("2025-01-04T10:00:00.000Z"),
                  }),
                ]
          )
        }
      }
    }
  )

  it("resets the distinct canonical custody movement for an inbound reconciliation", async () => {
    const canonicalSourceId = "00000000-0000-0000-0000-000000000303"
    const providerTransactionId = "00000000-0000-0000-0000-000000000304"
    const canonicalTransactionId = "00000000-0000-0000-0000-000000000305"
    const providerTransferId = "00000000-0000-0000-0000-000000000306"
    const custodyProviderTransferId = "00000000-0000-0000-0000-000000000307"
    const canonicalTransferId = "00000000-0000-0000-0000-000000000308"
    const canonicalTransferExternalId = "replay-inbound-canonical-transfer"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            address: "bc1qreplay-inbound-canonical",
            type: "bitcoin",
            name: "Replay inbound canonical source",
            principalId: TEST_PRINCIPAL_ID,
          })
          .returning({ id: schema.addresses.id })

        if (address === undefined) {
          return yield* Effect.dieMessage("Failed to create replay inbound address")
        }

        yield* db.insert(schema.sources).values({
          id: canonicalSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Replay inbound canonical source",
          providerKey: "bitcoin-rpc",
          sourceableType: "onchain",
          cexAccountId: null,
          addressId: address.id,
        })
        yield* db.insert(schema.transactions).values([
          {
            id: providerTransactionId,
            sourceId: TEST_SOURCE_ID,
            externalId: "replay-inbound-provider-transaction",
            timestamp: new Date("2025-02-02T10:05:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            transactionType: "internal_transfer",
          },
          {
            id: canonicalTransactionId,
            sourceId: canonicalSourceId,
            externalId: "replay-inbound-canonical-transaction",
            timestamp: new Date("2025-02-02T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            transactionType: "internal_transfer",
          },
        ])
        yield* db.insert(schema.providerTransfers).values([
          {
            id: providerTransferId,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransactionId,
            externalId: "replay-inbound-provider-transfer",
            timestamp: new Date("2025-02-02T10:05:00.000Z"),
            direction: "inbound",
            fromAddress: "bc1qreplay-inbound-canonical",
            toAccountRef: "coinbase-account-1",
            amount: "0.5",
          },
          {
            id: custodyProviderTransferId,
            sourceId: canonicalSourceId,
            transactionId: canonicalTransactionId,
            externalId: "replay-inbound-custody-transfer",
            timestamp: new Date("2025-02-02T10:00:00.000Z"),
            direction: "outbound",
            fromAddress: "bc1qreplay-inbound-canonical",
            toAddress: "coinbase-account-1",
            amount: "0.5",
            metadata: { canonicalTransferExternalId },
          },
        ])
        yield* db.insert(schema.inventoryMovements).values([
          {
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            transactionId: providerTransactionId,
            providerTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-02-02T10:05:00.000Z"),
            direction: "inbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.5",
          },
          {
            principalId: TEST_PRINCIPAL_ID,
            sourceId: canonicalSourceId,
            transactionId: canonicalTransactionId,
            providerTransferId: custodyProviderTransferId,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: new Date("2025-02-02T10:00:00.000Z"),
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "0.5",
          },
        ])
        yield* db.insert(schema.transfers).values({
          id: canonicalTransferId,
          sourceId: canonicalSourceId,
          principalId: TEST_PRINCIPAL_ID,
          externalId: canonicalTransferExternalId,
          timestamp: new Date("2025-02-02T10:00:00.000Z"),
          type: "utxo",
          fromAddress: "bc1qreplay-inbound-canonical",
          toAddress: "coinbase-account-1",
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.5",
        })
        yield* db.insert(schema.transferReconciliations).values({
          principalId: TEST_PRINCIPAL_ID,
          providerTransferId,
          canonicalTransferId,
          canonicalTransactionId,
          status: "approved",
          matchReason: "replay_inbound_custody_fixture",
          confidence: "1",
          deterministic: true,
        })
        const reconciliationMetadata = {
          reconciliation: { providerTransferId, canonicalTransferId },
        }
        yield* db.insert(schema.transactionLegs).values([
          {
            sourceId: TEST_SOURCE_ID,
            externalId: "replay-inbound-provider:internal-transfer-in",
            timestamp: new Date("2025-02-02T10:05:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.5",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            metadata: reconciliationMetadata,
            transactionId: providerTransactionId,
          },
          {
            sourceId: canonicalSourceId,
            externalId: "replay-inbound-canonical:internal-transfer-out",
            timestamp: new Date("2025-02-02T10:00:00.000Z"),
            principalId: TEST_PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.5",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            metadata: reconciliationMetadata,
            transactionId: canonicalTransactionId,
          },
        ])
      })
    )

    await runReplayRepository(
      Effect.flatMap(SourceReplayRepository, (repository) =>
        repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
      )
    )

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const reconciliations = yield* db.select().from(schema.transferReconciliations)
        const movements = yield* db.select().from(schema.inventoryMovements)
        return { reconciliations, movements }
      })
    )
    expect(state.reconciliations).toHaveLength(0)
    expect(state.movements).toEqual([
      expect.objectContaining({
        providerTransferId: custodyProviderTransferId,
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
      }),
    ])
  })
})
