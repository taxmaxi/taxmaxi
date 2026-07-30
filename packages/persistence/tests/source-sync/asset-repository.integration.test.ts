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

  it("allows duplicate symbols while resolving economic assets by exact identity", async () => {
    const firstAssetId = "00000000-0000-0000-0000-00000000d001"
    const secondAssetId = "00000000-0000-0000-0000-00000000d002"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.assets).values([
          {
            id: firstAssetId,
            name: "Example Dollar",
            symbol: "DUP",
            coingeckoCoinId: "example-dollar",
          },
          {
            id: secondAssetId,
            name: "Duplicate Token",
            symbol: "DUP",
            coingeckoCoinId: "duplicate-token",
          },
        ])
      })
    )

    const firstAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findAssetByCoinGeckoId({ coingeckoCoinId: "example-dollar" })
      )
    )
    const secondAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findAssetByCoinGeckoId({ coingeckoCoinId: "duplicate-token" })
      )
    )

    expect(Option.getOrNull(firstAsset)).toEqual({
      id: firstAssetId,
      symbol: "DUP",
    })
    expect(Option.getOrNull(secondAsset)).toEqual({
      id: secondAssetId,
      symbol: "DUP",
    })
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
            name: "Existing USDC",
            symbol: "USDC",
            coingeckoCoinId: "usd-coin",
            logoUrl: existingLogoUrl,
          })
          yield* db.insert(schema.assetRepresentations).values({
            assetId: existingAssetId,
            blockchainId: base.id,
            contractAddress: "0xabcdefabcdef",
            decimals: 6,
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
            name: "USD Coin",
            symbol: "usdc",
            coingeckoCoinId: "usd-coin",
            logoUrl: null,
            isSpam: false,
          },
          representation: {
            contractAddress: "0xabcdefabcdef",
            decimals: 6,
            type: "token",
            metadata: null,
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
            coingeckoCoinId: schema.assets.coingeckoCoinId,
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
      coingeckoCoinId: "usd-coin",
      logoUrl: existingLogoUrl,
    })

    const foundAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findAssetByBlockchainAndContractAddress({
          blockchainName: "base",
          contractAddress: "0xAbCdEfAbCdEf",
        })
      )
    )

    expect(Option.getOrNull(foundAsset)).toEqual({
      representationId: persistedAsset.representationId,
      assetId: existingAssetId,
      symbol: "USDC",
    })

    const replayedAsset = await runRepository(
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
            name: "USD Coin",
            symbol: "USDC",
            coingeckoCoinId: "usd-coin",
            logoUrl: null,
            isSpam: false,
          },
          representation: {
            contractAddress: "0xAbCdEfAbCdEf",
            decimals: 6,
            type: "token",
            metadata: null,
          },
        })
      )
    )

    expect(replayedAsset.id).toBe(existingAssetId)
    expect(replayedAsset.representationId).toBe(persistedAsset.representationId)
  })
})
