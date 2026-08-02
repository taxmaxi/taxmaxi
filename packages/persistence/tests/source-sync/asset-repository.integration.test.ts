import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { KNOWN_ASSET_IDS, KNOWN_ASSET_REPRESENTATION_IDS } from "@my/core/asset"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { seedData } from "../../src/seed/data.ts"
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
            name: "Existing USDC",
            symbol: "USDC",
            logoUrl: existingLogoUrl,
            type: "fungible",
          })
          yield* db.insert(schema.assetRepresentations).values({
            assetId: existingAssetId,
            blockchainId: base.id,
            contractAddress: "0xabcdefabcdef",
            mintAddress: null,
            decimals: 6,
            type: "token",
          })
        }
      })
    )

    const persistedAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.upsertEconomicAssetRepresentation({
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
            type: "fungible",
          },
          representation: {
            contractAddress: "0xabcdefabcdef",
            mintAddress: null,
            decimals: 6,
            logoUrl: null,
            type: "token",
            isSpam: false,
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
            contractAddress: schema.assetRepresentations.contractAddress,
          })
          .from(schema.assets)
          .innerJoin(
            schema.assetRepresentations,
            eq(schema.assetRepresentations.assetId, schema.assets.id)
          )
          .where(eq(schema.assets.id, existingAssetId))
          .limit(1)
      })
    )

    expect(persistedAsset.id).toBe(existingAssetId)
    expect(storedAsset).toEqual({
      id: existingAssetId,
      contractAddress: "0xabcdefabcdef",
      coingeckoCoinId: "usd-coin",
      logoUrl: existingLogoUrl,
    })

    const foundAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findRepresentationByBlockchainAndAddress({
          blockchainName: "base",
          address: "0xAbCdEfAbCdEf",
        })
      )
    )

    expect(Option.getOrNull(foundAsset)).toEqual(
      expect.objectContaining({
        assetId: existingAssetId,
        symbol: "USDC",
      })
    )
  })

  it("keeps known economic assets and network representations exact on repeated seeds", async () => {
    await runPg(seedData)
    await runPg(seedData)

    const state = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [usdc] = yield* db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(eq(schema.assets.id, KNOWN_ASSET_IDS.USDC))
          .limit(1)
        const representations = yield* db
          .select({ id: schema.assetRepresentations.id })
          .from(schema.assetRepresentations)
          .where(
            inArray(schema.assetRepresentations.id, [
              KNOWN_ASSET_REPRESENTATION_IDS.USDC_SOLANA,
              KNOWN_ASSET_REPRESENTATION_IDS.USDC_ETHEREUM,
              KNOWN_ASSET_REPRESENTATION_IDS.USDC_BASE,
            ])
          )

        return { usdc, representations }
      })
    )

    expect(state.usdc?.id).toBe(KNOWN_ASSET_IDS.USDC)
    expect(state.representations.map((representation) => representation.id).sort()).toEqual(
      [
        KNOWN_ASSET_REPRESENTATION_IDS.USDC_SOLANA,
        KNOWN_ASSET_REPRESENTATION_IDS.USDC_ETHEREUM,
        KNOWN_ASSET_REPRESENTATION_IDS.USDC_BASE,
      ].sort()
    )
  })
})
