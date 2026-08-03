import * as Effect from "effect/Effect"
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { PortfolioRepositoryLive } from "../src/layers/PortfolioRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { schema } from "../src/schema/index.ts"
import { PortfolioRepository } from "../src/services/PortfolioRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "./support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_portfolio_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, PortfolioRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: PortfolioRepositoryLive }))

await Effect.runPromise(context.recreateTestDatabase())

describe("PortfolioRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    const fixture = await runPg(seedSyncEngineRepositoryFixture())
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

  it("excludes spam representation lots while retaining chainless custody lots", async () => {
    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const timestamp = new Date("2025-05-01T10:00:00.000Z")

        yield* db
          .update(schema.assetRepresentations)
          .set({ isSpam: true })
          .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))

        const legs = yield* db
          .insert(schema.transactionLegs)
          .values([
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "portfolio-spam-representation-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              amount: "2",
              kind: "acquisition" as const,
              provenance: "deterministic" as const,
              fiatAmount: "20",
              fiatCurrency: "EUR",
            },
            {
              sourceId: TEST_SOURCE_ID,
              externalId: "portfolio-chainless-leg",
              timestamp,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              amount: "3",
              kind: "acquisition" as const,
              provenance: "deterministic" as const,
              fiatAmount: "30",
              fiatCurrency: "EUR",
            },
          ])
          .returning({ id: schema.transactionLegs.id })

        const spamLeg = legs[0]
        const chainlessLeg = legs[1]

        if (spamLeg === undefined || chainlessLeg === undefined) {
          return yield* Effect.dieMessage("Failed to create portfolio leg fixtures")
        }

        yield* db.insert(schema.fifoLots).values([
          {
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            acquiredAt: timestamp,
            originalAmount: "2",
            remainingAmount: "2",
            costBasisPerToken: "10",
            costBasisCurrency: "EUR",
            sourceLegId: spamLeg.id,
          },
          {
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
            assetId: TEST_BTC_ASSET_ID,
            assetRepresentationId: null,
            acquiredAt: timestamp,
            originalAmount: "3",
            remainingAmount: "3",
            costBasisPerToken: "10",
            costBasisCurrency: "EUR",
            sourceLegId: chainlessLeg.id,
          },
        ])
      })
    )

    const positions = await runRepository(
      Effect.flatMap(PortfolioRepository, (repository) =>
        repository.listAssetPositions({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: null,
        })
      )
    )

    expect(positions).toEqual([
      expect.objectContaining({
        assetId: TEST_BTC_ASSET_ID,
        amount: "3",
        costBasis: "30",
      }),
    ])
  })
})
