import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
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
import { AssetRepository, SyncEngineStorageError } from "@my/sync-engine/services"

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
    const existingExplorerUrl = "https://base.example"
    const existingBlockchainLogoUrl = "https://assets.example/base.png"

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
          yield* db
            .update(schema.blockchains)
            .set({ explorerUrl: existingExplorerUrl, logoUrl: existingBlockchainLogoUrl })
            .where(eq(schema.blockchains.id, base.id))
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
            explorerUrl: schema.blockchains.explorerUrl,
            blockchainLogoUrl: schema.blockchains.logoUrl,
          })
          .from(schema.assets)
          .innerJoin(
            schema.assetRepresentations,
            eq(schema.assetRepresentations.assetId, schema.assets.id)
          )
          .innerJoin(
            schema.blockchains,
            eq(schema.blockchains.id, schema.assetRepresentations.blockchainId)
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
      explorerUrl: existingExplorerUrl,
      blockchainLogoUrl: existingBlockchainLogoUrl,
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

  it("rejects a reviewed representation owned by a different economic asset", async () => {
    const existingAssetId = "00000000-0000-0000-0000-00000000a552"
    const contractAddress = "0xfeedfeedfeed"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [base] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "base"))
          .limit(1)

        if (base === undefined) {
          return yield* Effect.dieMessage("Missing Base blockchain fixture")
        }

        yield* db.insert(schema.assets).values({
          id: existingAssetId,
          name: "Existing Asset",
          symbol: "OLD",
          coingeckoCoinId: "existing-asset",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          assetId: existingAssetId,
          blockchainId: base.id,
          contractAddress,
          mintAddress: null,
          decimals: 18,
          type: "token",
        })
      })
    )

    const error = await runRepository(
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
            name: "Reviewed Asset",
            symbol: "NEW",
            coingeckoCoinId: "reviewed-asset",
            logoUrl: null,
            type: "fungible",
          },
          representation: {
            contractAddress,
            mintAddress: null,
            decimals: 18,
            logoUrl: null,
            type: "token",
            isSpam: false,
            metadata: null,
          },
        })
      ).pipe(Effect.flip)
    )

    expect(error).toBeInstanceOf(SyncEngineStorageError)

    const [storedAsset] = await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            name: schema.assets.name,
            symbol: schema.assets.symbol,
            coingeckoCoinId: schema.assets.coingeckoCoinId,
          })
          .from(schema.assets)
          .where(eq(schema.assets.id, existingAssetId))
          .limit(1)
      })
    )

    expect(storedAsset).toEqual({
      name: "Existing Asset",
      symbol: "OLD",
      coingeckoCoinId: "existing-asset",
    })
  })

  it("matches non-EVM contract addresses exactly", async () => {
    const contractAddress = "cardanoAsset1AbCdEf"
    const persistedAsset = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.upsertEconomicAssetRepresentation({
          blockchain: {
            name: "cardano",
            chainType: "cardano",
            chainId: null,
            nativeAssetSymbol: "ADA",
            explorerUrl: null,
            logoUrl: null,
            coingeckoPlatformId: "cardano",
          },
          asset: {
            name: "Cardano Test Token",
            symbol: "CTT",
            coingeckoCoinId: "cardano-test-token",
            logoUrl: null,
            type: "fungible",
          },
          representation: {
            contractAddress,
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

    const exactMatch = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findRepresentationByBlockchainAndAddress({
          blockchainName: "cardano",
          address: contractAddress,
        })
      )
    )
    const wrongCase = await runRepository(
      Effect.flatMap(AssetRepository, (repository) =>
        repository.findRepresentationByBlockchainAndAddress({
          blockchainName: "cardano",
          address: contractAddress.toLowerCase(),
        })
      )
    )

    expect(Option.getOrNull(exactMatch)).toEqual(
      expect.objectContaining({
        id: persistedAsset.representationId,
        assetId: persistedAsset.id,
        symbol: "CTT",
      })
    )
    expect(Option.isNone(wrongCase)).toBe(true)
  })

  it("keeps known economic assets and network representations exact on repeated seeds", async () => {
    await runPg(seedData)

    const readUsdcState = () =>
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [usdc] = yield* db
            .select({ id: schema.assets.id, logoUrl: schema.assets.logoUrl })
            .from(schema.assets)
            .where(eq(schema.assets.coingeckoCoinId, "usd-coin"))
            .limit(1)

          if (usdc === undefined) {
            return yield* Effect.dieMessage("Missing seeded USD Coin economic asset")
          }

          const representations = yield* db
            .select({
              id: schema.assetRepresentations.id,
              blockchainName: schema.blockchains.name,
              contractAddress: schema.assetRepresentations.contractAddress,
              mintAddress: schema.assetRepresentations.mintAddress,
              logoUrl: schema.assetRepresentations.logoUrl,
              isSpam: schema.assetRepresentations.isSpam,
              metadata: schema.assetRepresentations.metadata,
            })
            .from(schema.assetRepresentations)
            .innerJoin(
              schema.blockchains,
              eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
            )
            .where(eq(schema.assetRepresentations.assetId, usdc.id))

          return { usdc, representations }
        })
      )

    const firstState = await readUsdcState()
    const reviewedRepresentation = firstState.representations.find(
      (representation) => representation.blockchainName === "base"
    )

    if (reviewedRepresentation === undefined) {
      expect.fail("Missing seeded Base USDC representation")
    }

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.assets)
          .set({ logoUrl: "https://assets.example/reviewed-usdc-asset.png" })
          .where(eq(schema.assets.id, firstState.usdc.id))
        yield* db
          .update(schema.assetRepresentations)
          .set({
            logoUrl: "https://assets.example/reviewed-usdc.png",
            isSpam: true,
            metadata: { source: "manual_review", reviewer: "test" },
          })
          .where(eq(schema.assetRepresentations.id, reviewedRepresentation.id))
      })
    )

    const reviewedState = await readUsdcState()
    await runPg(seedData)
    const secondState = await readUsdcState()

    expect(firstState.usdc).toBeDefined()
    expect(firstState.representations).toHaveLength(3)
    expect(
      firstState.representations.map((representation) => representation.blockchainName).sort()
    ).toEqual(["base", "ethereum", "solana"])
    expect(secondState).toEqual(reviewedState)
  })
})
