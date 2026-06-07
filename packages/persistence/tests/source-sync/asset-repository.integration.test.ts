import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { AssetRepository } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, AssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetRepositoryLive }))

describe("AssetRepositoryLive", () => {
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

  it("loads canonical assets and blockchain lookups", async () => {
    const asset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findAssetById({ assetId: TEST_BTC_ASSET_ID })
      )
    )
    const missingAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findAssetById({
          assetId: "00000000-0000-0000-0000-000000009999",
        })
      )
    )
    const blockchains = await runRepository(
      Effect.flatMap(AssetRepository, (repository) => repository.listBlockchains())
    )

    expect(Option.isSome(asset)).toBe(true)
    expect(Option.getOrNull(asset)).toEqual({
      id: TEST_BTC_ASSET_ID,
      symbol: "BTC",
    })
    expect(Option.isNone(missingAsset)).toBe(true)
    expect(blockchains.some((blockchain) => blockchain.name === "base")).toBe(true)
    expect(blockchains.some((blockchain) => blockchain.name === "bitcoin")).toBe(true)
  })

  it("matches EVM token contracts case-insensitively and preserves existing asset logos", async () => {
    const existingAssetId = "00000000-0000-0000-0000-00000000a551"
    const existingLogoUrl = "https://assets.example/usdc.png"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [base] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
          .limit(1)

        expect(base).toBeDefined()

        if (base !== undefined) {
          yield* db.insert(schema.assets).values({
            id: existingAssetId,
            blockchainId: base.id,
            contractAddress: "0xAbCdEfAbCdEf",
            name: "Existing USDC",
            symbol: "USDC",
            decimals: 6,
            logoUrl: existingLogoUrl,
            type: "token",
          })
        }
      })
    )

    const persistedAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.upsertCanonicalAsset({
          blockchain: {
            name: "base",
            chainType: "evm",
            chainId: 8453,
            nativeAssetSymbol: "ETH",
            explorerUrl: null,
            logoUrl: null,
            coingeckoPlatformId: "base",
          },
          asset: {
            contractAddress: "0xabcdefabcdef",
            name: "USD Coin",
            symbol: "usdc",
            decimals: 6,
            logoUrl: null,
            type: "token",
            isSpam: false,
          },
        })
      )
    )

    const [storedAsset] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            id: schema.assets.id,
            contractAddress: schema.assets.contractAddress,
            logoUrl: schema.assets.logoUrl,
          })
          .from(schema.assets)
          .where(eq(schema.assets.id, existingAssetId))
          .limit(1)
      })
    )

    expect(persistedAsset.id).toBe(existingAssetId)
    expect(storedAsset).toEqual({
      id: existingAssetId,
      contractAddress: "0xabcdefabcdef",
      logoUrl: existingLogoUrl,
    })
  })
})
