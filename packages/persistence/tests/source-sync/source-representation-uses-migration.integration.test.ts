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
  databaseNamePrefix: "taxmaxi_source_representation_uses_migration",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const migrationSql = readFileSync(
  new URL("../../drizzle/20260827130155_far_eddie_brock/migration.sql", import.meta.url),
  "utf8"
)

describe("source representation-use migration", () => {
  it("backfills exact native, contract, and mint observations", async () => {
    await runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.execute(sql`drop table source_representation_uses`)

        const occurredAt = new Date("2025-04-20T13:00:00.000Z")
        const transactions = yield* db
          .insert(schema.transactions)
          .values(
            ["native", "contract-upper", "contract-lower", "mint", "unknown-type"].map(
              (suffix) => ({
                sourceId: TEST_SOURCE_ID,
                externalId: `historical-representation-${suffix}`,
                timestamp: occurredAt,
                providerTransactionType: "send",
                providerStatus: "completed",
                principalId: TEST_PRINCIPAL_ID,
              })
            )
          )
          .returning({ id: schema.transactions.id })

        const [
          nativeTransaction,
          upperContractTransaction,
          lowerContractTransaction,
          mintTransaction,
          unknownTypeTransaction,
        ] = transactions
        if (
          nativeTransaction === undefined ||
          upperContractTransaction === undefined ||
          lowerContractTransaction === undefined ||
          mintTransaction === undefined ||
          unknownTypeTransaction === undefined
        ) {
          return yield* Effect.die("Failed to create historical representation transactions")
        }

        const sharedTransfer = {
          sourceId: TEST_SOURCE_ID,
          timestamp: occurredAt,
          direction: "inbound" as const,
          processingMode: "accounting_and_evidence" as const,
          fromAddress: "external-address",
          toAddress: "owned-address",
          amount: "1",
          observedBlockchainId: fixture.baseBlockchainId,
        }
        yield* db.insert(schema.providerTransfers).values([
          {
            ...sharedTransfer,
            transactionId: nativeTransaction.id,
            externalId: "historical-representation-native",
            observedRepresentationType: "native",
          },
          {
            ...sharedTransfer,
            transactionId: upperContractTransaction.id,
            externalId: "historical-representation-contract-upper",
            observedRepresentationType: "token",
            observedContractAddress: "0xAbCd000000000000000000000000000000000096",
          },
          {
            ...sharedTransfer,
            transactionId: lowerContractTransaction.id,
            externalId: "historical-representation-contract-lower",
            observedRepresentationType: "token",
            observedContractAddress: "0xabcd000000000000000000000000000000000096",
          },
          {
            ...sharedTransfer,
            transactionId: mintTransaction.id,
            externalId: "historical-representation-mint",
            observedRepresentationType: "token",
            observedMintAddress: "0xAbCd000000000000000000000000000000000097",
          },
          {
            ...sharedTransfer,
            transactionId: unknownTypeTransaction.id,
            externalId: "historical-representation-unknown-type",
            observedRepresentationType: null,
            observedMintAddress: "UnknownHistoricalMint11111111111111111111111111",
          },
        ])

        for (const statement of migrationSql
          .split("--> statement-breakpoint")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)) {
          yield* db.execute(sql.raw(statement))
        }

        const uses = yield* db
          .select({
            representationType: schema.sourceRepresentationUses.representationType,
            contractAddress: schema.sourceRepresentationUses.contractAddress,
            mintAddress: schema.sourceRepresentationUses.mintAddress,
          })
          .from(schema.sourceRepresentationUses)
          .orderBy(
            asc(schema.sourceRepresentationUses.representationType),
            asc(schema.sourceRepresentationUses.contractAddress),
            asc(schema.sourceRepresentationUses.mintAddress)
          )

        expect(uses).toEqual([
          { representationType: "native", contractAddress: null, mintAddress: null },
          {
            representationType: "token",
            contractAddress: "0xabcd000000000000000000000000000000000096",
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: null,
            mintAddress: "0xabcd000000000000000000000000000000000097",
          },
        ])
      })
    )
  })
})
