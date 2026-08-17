import { readFileSync } from "node:fs"
import { asc, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_asset_source_uses_migration",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const migrationSql = readFileSync(
  new URL("../../drizzle/20260816075641_legal_nocturne/migration.sql", import.meta.url),
  "utf8"
)

describe("provider asset source-use migration", () => {
  it("backfills transfer and review-only provider asset uses", async () => {
    await runPg(
      Effect.gen(function* () {
        yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.execute(sql`drop table provider_asset_source_uses`)

        const now = new Date("2025-04-20T13:00:00.000Z")
        const [transferAsset, reviewedAsset, unrelatedAsset] = yield* db
          .insert(schema.providerAssets)
          .values([
            {
              provider: "coinbase",
              providerAssetId: "migration-transfer-btc",
              currencyCode: "BTC",
              name: "Bitcoin",
              exponent: 8,
              providerType: "crypto",
              retrievedAt: now,
            },
            {
              provider: "coinbase",
              providerAssetId: "migration-reviewed-eth",
              currencyCode: "ETH",
              name: "Ether",
              exponent: 18,
              providerType: "crypto",
              retrievedAt: now,
            },
            {
              provider: "coinbase",
              providerAssetId: "migration-unrelated-sol",
              currencyCode: "SOL",
              name: "Solana",
              exponent: 9,
              providerType: "crypto",
              retrievedAt: now,
            },
          ])
          .returning({ id: schema.providerAssets.id })
        if (
          transferAsset === undefined ||
          reviewedAsset === undefined ||
          unrelatedAsset === undefined
        ) {
          return yield* Effect.die("Failed to create migration provider assets")
        }

        yield* db.insert(schema.providerAssetMappings).values(
          [reviewedAsset.id, unrelatedAsset.id].map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            mappingStatus: "pending_review" as const,
            canonicalAssetId: null,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
          }))
        )
        const [transferTransaction, reviewedTransaction] = yield* db
          .insert(schema.transactions)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "migration-provider-transfer",
              timestamp: now,
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            },
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "migration-review-only",
              timestamp: now,
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            },
          ])
          .returning({ id: schema.transactions.id })
        if (transferTransaction === undefined || reviewedTransaction === undefined) {
          return yield* Effect.die("Failed to create migration transactions")
        }

        yield* db.insert(schema.providerTransfers).values({
          sourceId: TEST_SOURCE_ID,
          transactionId: transferTransaction.id,
          externalId: "migration-provider-transfer",
          providerAssetId: transferAsset.id,
          timestamp: now,
          direction: "outbound",
          processingMode: "accounting_only",
          fromAccountRef: "coinbase-account",
          toAddress: "0xmigrationdestination",
          amount: "0.10000000",
        })
        yield* db.insert(schema.transactionReviews).values({
          transactionId: reviewedTransaction.id,
          principalId: TEST_PRINCIPAL_ID,
          reviewStatus: "needs_review",
          categorizationReason:
            "Coinbase send requires review. provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for ETH, USDC.",
          matchedLayer: "provider_asset_mapping",
          needsReview: true,
        })

        for (const statement of migrationSql
          .split("--> statement-breakpoint")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)) {
          yield* db.execute(sql.raw(statement))
        }

        const uses = yield* db
          .select({
            providerAssetRowId: schema.providerAssetSourceUses.providerAssetRowId,
            sourceId: schema.providerAssetSourceUses.sourceId,
          })
          .from(schema.providerAssetSourceUses)
          .orderBy(asc(schema.providerAssetSourceUses.providerAssetRowId))

        expect(uses).toEqual(
          [transferAsset.id, reviewedAsset.id].sort().map((providerAssetRowId) => ({
            providerAssetRowId,
            sourceId: TEST_SOURCE_ID,
          }))
        )
      })
    )
  })
})
