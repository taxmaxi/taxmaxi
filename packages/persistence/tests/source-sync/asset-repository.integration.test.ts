import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
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
})
