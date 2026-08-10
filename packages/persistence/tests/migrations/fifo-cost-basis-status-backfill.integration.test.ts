import { readFile } from "node:fs/promises"
import { inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { drizzle, runSqlUnsafe } from "../../src/layers/PgClientLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { SourceNormalizationRepository } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_fifo_basis_backfill",
})

await Effect.runPromise(context.recreateTestDatabase())

describe("FIFO cost basis status backfill", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("marks missing-valuation lots and transferred descendants pending without hiding known basis", async () => {
    const fixture = await context.runPg(seedSyncEngineRepositoryFixture())
    await context.runPg(
      seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
    )

    const secondAddressId = "00000000-0000-0000-0000-000000000691"
    const secondSourceId = "00000000-0000-0000-0000-000000000692"
    const thirdAddressId = "00000000-0000-0000-0000-000000000693"
    const thirdSourceId = "00000000-0000-0000-0000-000000000694"
    const pendingSourceLegId = "00000000-0000-0000-0000-000000000701"
    const pendingOriginLegId = "00000000-0000-0000-0000-000000000702"
    const pendingDestinationLegId = "00000000-0000-0000-0000-000000000703"
    const knownSourceLegId = "00000000-0000-0000-0000-000000000704"
    const knownOriginLegId = "00000000-0000-0000-0000-000000000705"
    const knownDestinationLegId = "00000000-0000-0000-0000-000000000706"
    const pendingDownstreamOriginLegId = "00000000-0000-0000-0000-000000000707"
    const pendingDownstreamDestinationLegId = "00000000-0000-0000-0000-000000000708"
    const providerPendingOriginLegId = "00000000-0000-0000-0000-000000000709"
    const providerPendingDestinationLegId = "00000000-0000-0000-0000-000000000710"
    const knownTwinSourceLegId = "00000000-0000-0000-0000-000000000718"
    const pendingSourceLotId = "00000000-0000-0000-0000-000000000711"
    const pendingDestinationLotId = "00000000-0000-0000-0000-000000000712"
    const knownSourceLotId = "00000000-0000-0000-0000-000000000713"
    const knownDestinationLotId = "00000000-0000-0000-0000-000000000714"
    const pendingDownstreamDestinationLotId = "00000000-0000-0000-0000-000000000715"
    const providerPendingSourceLotId = "00000000-0000-0000-0000-000000000716"
    const providerPendingDestinationLotId = "00000000-0000-0000-0000-000000000717"
    const knownTwinSourceLotId = "00000000-0000-0000-0000-000000000700"
    const knownTwinDestinationLotId = "00000000-0000-0000-0000-000000000719"
    const providerTransactionId = "00000000-0000-0000-0000-000000000731"
    const providerTransferId = "00000000-0000-0000-0000-000000000732"
    const providerCanonicalTransferId = "00000000-0000-0000-0000-000000000733"

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.addresses).values([
          {
            id: secondAddressId,
            principalId: fixture.principalId,
            address: "0x0000000000000000000000000000000000000692",
            type: "evm",
            name: "Backfill destination",
          },
          {
            id: thirdAddressId,
            principalId: fixture.principalId,
            address: "0x0000000000000000000000000000000000000694",
            type: "evm",
            name: "Backfill downstream destination",
          },
        ])
        yield* db.insert(schema.sources).values([
          {
            id: secondSourceId,
            principalId: fixture.principalId,
            addressId: secondAddressId,
            name: "Backfill destination",
            providerKey: "etherscan",
            sourceableType: "onchain",
          },
          {
            id: thirdSourceId,
            principalId: fixture.principalId,
            addressId: thirdAddressId,
            name: "Backfill downstream destination",
            providerKey: "etherscan",
            sourceableType: "onchain",
          },
        ])
        yield* db.insert(schema.transactions).values({
          id: providerTransactionId,
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          externalId: "legacy-provider-pending-transaction",
          timestamp: new Date("2024-05-01T00:00:00.000Z"),
        })
        yield* db.insert(schema.providerTransfers).values({
          id: providerTransferId,
          sourceId: fixture.sourceId,
          transactionId: providerTransactionId,
          externalId: "legacy-provider-pending-transfer",
          timestamp: new Date("2024-05-01T00:00:00.000Z"),
          direction: "inbound",
          fromAddress: "bc1qlegacy-provider-origin",
          toAccountRef: "coinbase-account-1",
          amount: "1",
        })

        yield* db.insert(schema.transactionLegs).values([
          {
            id: pendingSourceLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-pending-acquisition",
            timestamp: new Date("2024-01-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "spot_buy",
            fiatAmount: null,
            fiatCurrency: null,
          },
          {
            id: pendingOriginLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-pending-transfer-out",
            timestamp: new Date("2024-02-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "2",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000721",
                canonicalTransferId: "00000000-0000-0000-0000-000000000722",
              },
            },
          },
          {
            id: pendingDestinationLegId,
            sourceId: secondSourceId,
            principalId: fixture.principalId,
            externalId: "legacy-pending-transfer-in",
            timestamp: new Date("2024-02-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "2",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000721",
                canonicalTransferId: "00000000-0000-0000-0000-000000000722",
              },
            },
          },
          {
            id: knownTwinSourceLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-known-twin-acquisition",
            timestamp: new Date("2024-01-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "spot_buy",
            fiatAmount: "0",
            fiatCurrency: "EUR",
          },
          {
            id: knownSourceLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-known-acquisition",
            timestamp: new Date("2024-03-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "spot_buy",
            fiatAmount: "10000",
            fiatCurrency: "EUR",
          },
          {
            id: knownOriginLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-known-transfer-out",
            timestamp: new Date("2024-04-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000723",
                canonicalTransferId: "00000000-0000-0000-0000-000000000724",
              },
            },
          },
          {
            id: knownDestinationLegId,
            sourceId: secondSourceId,
            principalId: fixture.principalId,
            externalId: "legacy-known-transfer-in",
            timestamp: new Date("2024-04-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000723",
                canonicalTransferId: "00000000-0000-0000-0000-000000000724",
              },
            },
          },
          {
            id: pendingDownstreamOriginLegId,
            sourceId: secondSourceId,
            principalId: fixture.principalId,
            externalId: "legacy-pending-downstream-transfer-out",
            timestamp: new Date("2024-02-02T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000725",
                canonicalTransferId: "00000000-0000-0000-0000-000000000726",
              },
            },
          },
          {
            id: pendingDownstreamDestinationLegId,
            sourceId: thirdSourceId,
            principalId: fixture.principalId,
            externalId: "legacy-pending-downstream-transfer-in",
            timestamp: new Date("2024-02-02T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            metadata: {
              reconciliation: {
                providerTransferId: "00000000-0000-0000-0000-000000000725",
                canonicalTransferId: "00000000-0000-0000-0000-000000000726",
              },
            },
          },
          {
            id: providerPendingOriginLegId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "legacy-provider-pending-transfer-out",
            timestamp: new Date("2024-06-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "disposal",
            provenance: "deterministic",
            derivationRule: "internal_transfer_out",
            metadata: {
              reconciliation: {
                providerTransferId,
                canonicalTransferId: providerCanonicalTransferId,
              },
            },
          },
          {
            id: providerPendingDestinationLegId,
            sourceId: secondSourceId,
            principalId: fixture.principalId,
            externalId: "legacy-provider-pending-transfer-in",
            timestamp: new Date("2024-06-01T00:00:00.000Z"),
            assetId: TEST_BTC_ASSET_ID,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            derivationRule: "internal_transfer_in",
            metadata: {
              reconciliation: {
                providerTransferId,
                canonicalTransferId: providerCanonicalTransferId,
              },
            },
          },
        ])

        yield* db.insert(schema.fifoLots).values([
          {
            id: pendingSourceLotId,
            principalId: fixture.principalId,
            sourceId: fixture.sourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-01-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: pendingSourceLegId,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
          {
            id: pendingDestinationLotId,
            principalId: fixture.principalId,
            sourceId: secondSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-01-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: pendingDestinationLegId,
            sourceLegSequence: 1,
          },
          {
            id: knownTwinSourceLotId,
            principalId: fixture.principalId,
            sourceId: fixture.sourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-01-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: knownTwinSourceLegId,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
          {
            id: knownTwinDestinationLotId,
            principalId: fixture.principalId,
            sourceId: secondSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-01-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "1",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: pendingDestinationLegId,
            sourceLegSequence: 0,
          },
          {
            id: knownSourceLotId,
            principalId: fixture.principalId,
            sourceId: fixture.sourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-03-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "10000",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: knownSourceLegId,
          },
          {
            id: knownDestinationLotId,
            principalId: fixture.principalId,
            sourceId: secondSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-03-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "1",
            costBasisPerToken: "10000",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: knownDestinationLegId,
          },
          {
            id: pendingDownstreamDestinationLotId,
            principalId: fixture.principalId,
            sourceId: thirdSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-01-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "1",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: pendingDownstreamDestinationLegId,
          },
          {
            id: providerPendingSourceLotId,
            principalId: fixture.principalId,
            sourceId: fixture.sourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-05-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "0",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "pending_review",
            sourceProviderTransferId: providerTransferId,
          },
          {
            id: providerPendingDestinationLotId,
            principalId: fixture.principalId,
            sourceId: secondSourceId,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt: new Date("2024-05-01T00:00:00.000Z"),
            originalAmount: "1",
            remainingAmount: "1",
            costBasisPerToken: "0",
            costBasisCurrency: "EUR",
            costBasisStatus: "known",
            sourceLegId: providerPendingDestinationLegId,
          },
        ])

        yield* db.insert(schema.disposalMatches).values([
          {
            disposalLegId: pendingOriginLegId,
            fifoLotId: pendingSourceLotId,
            matchedAmount: "1",
            costBasis: "0",
            proceeds: "0",
            gainLoss: "0",
          },
          {
            disposalLegId: pendingOriginLegId,
            fifoLotId: knownTwinSourceLotId,
            matchedAmount: "1",
            costBasis: "0",
            proceeds: "0",
            gainLoss: "0",
          },
          {
            disposalLegId: knownOriginLegId,
            fifoLotId: knownSourceLotId,
            matchedAmount: "1",
            costBasis: "10000",
            proceeds: "10000",
            gainLoss: "0",
          },
          {
            disposalLegId: pendingDownstreamOriginLegId,
            fifoLotId: pendingDestinationLotId,
            matchedAmount: "1",
            costBasis: "0",
            proceeds: "0",
            gainLoss: "0",
          },
          {
            disposalLegId: providerPendingOriginLegId,
            fifoLotId: providerPendingSourceLotId,
            matchedAmount: "1",
            costBasis: "0",
            proceeds: "0",
            gainLoss: "0",
          },
        ])
      })
    )

    const migrationSql = await readFile(
      new URL(
        "../../drizzle/20260809141450_backfill_pending_fifo_cost_basis/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    expect(migrationSql).toContain(
      "ORDER BY source_lot.acquired_at, source_lot.created_at, source_lot.id"
    )
    await context.runPg(runSqlUnsafe({ statement: migrationSql }))
    await context.runPg(runSqlUnsafe({ statement: migrationSql }))

    const retryLegacyAcquisition = Effect.flatMap(
      SourceNormalizationRepository,
      (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: fixture.sourceId,
            sourceRawRecordId: null,
            externalId: "legacy-pending-transaction",
            externalGroupId: null,
            timestamp: new Date("2024-01-01T00:00:00.000Z"),
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: "Legacy pending acquisition",
            providerCreatedAt: null,
            providerUpdatedAt: null,
            metadata: { provider: "coinbase" },
            principalId: fixture.principalId,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: null,
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          feeTransfers: [],
          legs: [
            {
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              sourceRawRecordId: null,
              externalId: "legacy-pending-acquisition",
              txHash: null,
              timestamp: new Date("2024-01-01T00:00:00.000Z"),
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              derivationRule: "spot_buy",
              metadata: { provider: "coinbase" },
              transactionId: null,
              sourceTransferId: null,
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: null,
            },
          ],
          transactionReview: null,
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
    await Effect.runPromise(
      context.runWithLayer({
        effect: retryLegacyAcquisition,
        layer: SourceNormalizationRepositoryLive,
      })
    )
    await Effect.runPromise(
      context.runWithLayer({
        effect: retryLegacyAcquisition,
        layer: SourceNormalizationRepositoryLive,
      })
    )

    const lots = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ id: schema.fifoLots.id, costBasisStatus: schema.fifoLots.costBasisStatus })
          .from(schema.fifoLots)
          .where(
            inArray(schema.fifoLots.id, [
              pendingSourceLotId,
              pendingDestinationLotId,
              knownSourceLotId,
              knownDestinationLotId,
              pendingDownstreamDestinationLotId,
              providerPendingSourceLotId,
              providerPendingDestinationLotId,
              knownTwinSourceLotId,
              knownTwinDestinationLotId,
            ])
          )
      })
    )
    const statusById = new Map(lots.map((lot) => [lot.id, lot.costBasisStatus]))
    expect(statusById.get(pendingSourceLotId)).toBe("pending_review")
    expect(statusById.get(pendingDestinationLotId)).toBe("pending_review")
    expect(statusById.get(pendingDownstreamDestinationLotId)).toBe("pending_review")
    expect(statusById.get(providerPendingSourceLotId)).toBe("pending_review")
    expect(statusById.get(providerPendingDestinationLotId)).toBe("pending_review")
    expect(statusById.get(knownSourceLotId)).toBe("known")
    expect(statusById.get(knownDestinationLotId)).toBe("known")
    expect(statusById.get(knownTwinSourceLotId)).toBe("known")
    expect(statusById.get(knownTwinDestinationLotId)).toBe("known")
  })
})
