import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { assetReferenceCatalogProjections } from "@my/core/assets"
import { eq, inArray } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { seedData } from "../../src/seed/data.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_ASSET_ID,
  TEST_EUR_REPRESENTATION_ID,
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
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
      })
    )
  )

  it.effect("loads canonical assets and blockchain lookups", () =>
    Effect.gen(function* () {
      const asset = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetRepository, (repository) =>
            repository.findAssetById({ assetId: TEST_BTC_ASSET_ID })
          )
        )
      )
      const missingAsset = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetRepository, (repository) =>
            repository.findAssetById({
              assetId: "00000000-0000-0000-0000-000000009999",
            })
          )
        )
      )
      const blockchains = yield* Effect.promise(() =>
        runRepository(Effect.flatMap(AssetRepository, (repository) => repository.listBlockchains))
      )

      expect(Option.isSome(asset)).toBe(true)
      expect(Option.getOrNull(asset)).toEqual({
        id: TEST_BTC_ASSET_ID,
        symbol: "BTC",
        type: "fungible",
      })
      expect(Option.isNone(missingAsset)).toBe(true)
      expect(blockchains.some((blockchain) => blockchain.name === "base")).toBe(true)
      expect(blockchains.some((blockchain) => blockchain.name === "bitcoin")).toBe(true)
    })
  )

  it.effect.each([
    ["economic asset type", "asset-type", "validateEconomicAssetType"],
    ["representation type", "representation-type", "validateRepresentationIdentity"],
    ["representation decimals", "representation-decimals", "validateRepresentationIdentity"],
  ] as const)("rejects changes to an existing %s", (testCase) => {
    const [_field, mutation, operation] = testCase
    return Effect.gen(function* () {
      const upsert = (change: typeof mutation | null) =>
        runRepository(
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
                name: "Immutable Coin",
                symbol: "IMM",
                coingeckoCoinId: "immutable-coin",
                logoUrl: null,
                type: change === "asset-type" ? "nft" : "fungible",
              },
              representation: {
                contractAddress: "0x0000000000000000000000000000000000001a11",
                mintAddress: null,
                decimals: change === "representation-decimals" ? 8 : 6,
                logoUrl: null,
                type: change === "representation-type" ? "nft" : "token",
                isSpam: false,
                metadata: null,
              },
            })
          )
        )

      const created = yield* Effect.promise(() => upsert(null))
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
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
                  name: "Immutable Coin",
                  symbol: "IMM",
                  coingeckoCoinId: "immutable-coin",
                  logoUrl: null,
                  type: mutation === "asset-type" ? "nft" : "fungible",
                },
                representation: {
                  contractAddress: "0x0000000000000000000000000000000000001a11",
                  mintAddress: null,
                  decimals: mutation === "representation-decimals" ? 8 : 6,
                  logoUrl: null,
                  type: mutation === "representation-type" ? "nft" : "token",
                  isSpam: false,
                  metadata: null,
                },
              })
            )
          )
        )
      )
      const stored = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetRepository, (repository) =>
            repository.findRepresentationById({ assetRepresentationId: created.representationId })
          )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          operation: "assetRepository.upsertEconomicAssetRepresentation",
          cause: { operation: `assetRepository.upsertEconomicAssetRepresentation.${operation}` },
        })
      }
      expect(Option.getOrNull(stored)).toMatchObject({
        representationType: "token",
        decimals: 6,
      })
    })
  })

  it.effect(
    "matches EVM token contracts case-insensitively and preserves existing asset logos",
    () =>
      Effect.gen(function* () {
        const existingAssetId = "00000000-0000-0000-0000-00000000a551"
        const existingLogoUrl = "https://assets.example/usdc.png"
        const existingExplorerUrl = "https://base.example"
        const existingBlockchainLogoUrl = "https://assets.example/base.png"

        yield* Effect.promise(() =>
          runPg(
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
        )

        const persistedAsset = yield* Effect.promise(() =>
          runRepository(
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
        )

        const [storedAsset] = yield* Effect.promise(() =>
          runPg(
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

        const foundAsset = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findRepresentationByBlockchainAndAddress({
                blockchainName: "base",
                address: "0xAbCdEfAbCdEf",
              })
            )
          )
        )

        expect(Option.getOrNull(foundAsset)).toEqual(
          expect.objectContaining({
            assetId: existingAssetId,
            symbol: "USDC",
          })
        )
      })
  )

  it.effect("rejects a reviewed representation owned by a different economic asset", () =>
    Effect.gen(function* () {
      const existingAssetId = "00000000-0000-0000-0000-00000000a552"
      const contractAddress = "0xfeedfeedfeed"

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [base] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
              .limit(1)

            if (base === undefined) {
              return yield* Effect.die("Missing Base blockchain fixture")
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
      )

      const error = yield* Effect.promise(() =>
        runRepository(
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
      )

      expect(error).toBeInstanceOf(SyncEngineStorageError)

      const [storedAsset] = yield* Effect.promise(() =>
        runPg(
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
      )

      expect(storedAsset).toEqual({
        name: "Existing Asset",
        symbol: "OLD",
        coingeckoCoinId: "existing-asset",
      })
    })
  )

  it.effect("shares one economic asset across concurrent network representation inserts", () =>
    Effect.gen(function* () {
      const upsertRepresentation = ({
        blockchainName,
        contractAddress,
      }: {
        readonly blockchainName: string
        readonly contractAddress: string
      }) =>
        Effect.flatMap(AssetRepository, (repository) =>
          repository.upsertEconomicAssetRepresentation({
            blockchain: {
              name: blockchainName,
              chainType: "other",
              chainId: null,
              nativeAssetSymbol: "NATIVE",
              explorerUrl: null,
              logoUrl: null,
              coingeckoPlatformId: blockchainName,
            },
            asset: {
              name: "Concurrent Asset",
              symbol: "CON",
              coingeckoCoinId: "concurrent-asset",
              logoUrl: null,
              type: "fungible",
            },
            representation: {
              contractAddress,
              mintAddress: null,
              decimals: 8,
              logoUrl: null,
              type: "token",
              isSpam: false,
              metadata: null,
            },
          })
        )

      const [first, second] = yield* Effect.promise(() =>
        runRepository(
          Effect.all(
            [
              upsertRepresentation({
                blockchainName: "concurrent-chain-a",
                contractAddress: "contract-a",
              }),
              upsertRepresentation({
                blockchainName: "concurrent-chain-b",
                contractAddress: "contract-b",
              }),
            ],
            { concurrency: "unbounded" }
          )
        )
      )

      expect(first.id).toBe(second.id)
      expect(first.representationId).not.toBe(second.representationId)

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const economicAssets = yield* db
              .select({ id: schema.assets.id })
              .from(schema.assets)
              .where(eq(schema.assets.coingeckoCoinId, "concurrent-asset"))
            const representations = yield* db
              .select({ assetId: schema.assetRepresentations.assetId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.assetId, first.id))

            return { economicAssets, representations }
          })
        )
      )

      expect(stored.economicAssets).toEqual([{ id: first.id }])
      expect(stored.representations).toHaveLength(2)
    })
  )

  it.effect("reuses native, contract, and mint representations across concurrent inserts", () =>
    Effect.gen(function* () {
      const cases = [
        {
          name: "native",
          representation: { contractAddress: null, mintAddress: null, type: "native" as const },
        },
        {
          name: "contract",
          representation: {
            contractAddress: "concurrent-contract",
            mintAddress: null,
            type: "token" as const,
          },
        },
        {
          name: "mint",
          representation: {
            contractAddress: null,
            mintAddress: "concurrent-mint",
            type: "token" as const,
          },
        },
      ] as const

      const upsertRepresentation = ({
        name,
        representation,
      }: {
        readonly name: string
        readonly representation: {
          readonly contractAddress: string | null
          readonly mintAddress: string | null
          readonly type: "native" | "token"
        }
      }) =>
        Effect.flatMap(AssetRepository, (repository) =>
          repository.upsertEconomicAssetRepresentation({
            blockchain: {
              name: `concurrent-representation-${name}`,
              chainType: "other",
              chainId: null,
              nativeAssetSymbol: "NATIVE",
              explorerUrl: null,
              logoUrl: null,
              coingeckoPlatformId: `concurrent-representation-${name}`,
            },
            asset: {
              name: `Concurrent Representation ${name}`,
              symbol: "CRP",
              coingeckoCoinId: `concurrent-representation-${name}`,
              logoUrl: null,
              type: "fungible",
            },
            representation: {
              ...representation,
              decimals: 8,
              logoUrl: null,
              isSpam: false,
              metadata: null,
            },
          })
        )

      const results = yield* Effect.promise(() =>
        runRepository(
          Effect.forEach(cases, ({ name, representation }) =>
            Effect.all(
              [
                upsertRepresentation({ name, representation }),
                upsertRepresentation({ name, representation }),
              ],
              { concurrency: "unbounded" }
            )
          )
        )
      )

      for (const [first, second] of results) {
        expect(first.id).toBe(second.id)
        expect(first.representationId).toBe(second.representationId)
      }
    })
  )

  it.effect("keeps case-distinct non-EVM contract addresses separate", () =>
    Effect.gen(function* () {
      const firstContractAddress = "cardanoAsset1AbCdEf"
      const secondContractAddress = firstContractAddress.toLowerCase()
      const firstAsset = yield* Effect.promise(() =>
        runRepository(
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
                contractAddress: firstContractAddress,
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
      )
      const secondAsset = yield* Effect.promise(() =>
        runRepository(
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
                name: "Second Cardano Test Token",
                symbol: "CT2",
                coingeckoCoinId: "second-cardano-test-token",
                logoUrl: null,
                type: "fungible",
              },
              representation: {
                contractAddress: secondContractAddress,
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
      )

      const firstMatch = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetRepository, (repository) =>
            repository.findRepresentationByBlockchainAndAddress({
              blockchainName: "cardano",
              address: firstContractAddress,
            })
          )
        )
      )
      const secondMatch = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetRepository, (repository) =>
            repository.findRepresentationByBlockchainAndAddress({
              blockchainName: "cardano",
              address: secondContractAddress,
            })
          )
        )
      )

      expect(Option.getOrNull(firstMatch)).toEqual(
        expect.objectContaining({
          id: firstAsset.representationId,
          assetId: firstAsset.id,
          symbol: "CTT",
        })
      )
      expect(Option.getOrNull(secondMatch)).toEqual(
        expect.objectContaining({
          id: secondAsset.representationId,
          assetId: secondAsset.id,
          symbol: "CT2",
        })
      )
      expect(firstAsset.representationId).not.toBe(secondAsset.representationId)
    })
  )

  it.effect("keeps known economic assets and network representations exact on repeated seeds", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedData))

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
              return yield* Effect.die("Missing seeded USD Coin economic asset")
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

      const firstState = yield* Effect.promise(() => readUsdcState())
      const reviewedRepresentation = firstState.representations.find(
        (representation) => representation.blockchainName === "base"
      )

      if (reviewedRepresentation === undefined) {
        expect.fail("Missing seeded Base USDC representation")
      }

      yield* Effect.promise(() =>
        runPg(
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
      )

      const reviewedState = yield* Effect.promise(() => readUsdcState())
      yield* Effect.promise(() => runPg(seedData))
      const secondState = yield* Effect.promise(() => readUsdcState())

      expect(firstState.usdc).toBeDefined()
      expect(firstState.representations).toHaveLength(3)
      expect(
        firstState.representations.map((representation) => representation.blockchainName).sort()
      ).toEqual(["base", "ethereum", "solana"])
      expect(secondState).toEqual(reviewedState)
    })
  )

  it.effect("seeds every catalog asset and representation idempotently", () =>
    Effect.gen(function* () {
      const assetCoinGeckoIdsByKey = new Map(
        assetReferenceCatalogProjections.economicAssets.map(
          (asset) => [asset.key, asset.coingeckoCoinId] as const
        )
      )
      const expectedAssets = assetReferenceCatalogProjections.economicAssets
        .map((asset) => ({
          name: asset.name,
          symbol: asset.symbol,
          coingeckoCoinId: asset.coingeckoCoinId,
          logoUrl: asset.logoUrl,
          type: asset.type,
        }))
        .sort((left, right) => left.coingeckoCoinId.localeCompare(right.coingeckoCoinId))
      const readCatalogRows = () =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const coinGeckoIds = assetReferenceCatalogProjections.economicAssets.map(
              (asset) => asset.coingeckoCoinId
            )
            const assets = yield* db
              .select({
                name: schema.assets.name,
                symbol: schema.assets.symbol,
                coingeckoCoinId: schema.assets.coingeckoCoinId,
                logoUrl: schema.assets.logoUrl,
                type: schema.assets.type,
              })
              .from(schema.assets)
              .where(inArray(schema.assets.coingeckoCoinId, coinGeckoIds))
            const representations = yield* db
              .select({
                assetCoinGeckoId: schema.assets.coingeckoCoinId,
                blockchain: schema.blockchains.name,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
                decimals: schema.assetRepresentations.decimals,
              })
              .from(schema.assetRepresentations)
              .innerJoin(schema.assets, eq(schema.assetRepresentations.assetId, schema.assets.id))
              .innerJoin(
                schema.blockchains,
                eq(schema.assetRepresentations.blockchainId, schema.blockchains.id)
              )
              .where(inArray(schema.assets.coingeckoCoinId, coinGeckoIds))

            const catalogRepresentations = representations.filter((row) =>
              assetReferenceCatalogProjections.networkRepresentations.some(
                (reference) =>
                  assetCoinGeckoIdsByKey.get(reference.assetKey) === row.assetCoinGeckoId &&
                  reference.blockchain === row.blockchain &&
                  reference.type === row.type &&
                  reference.contractAddress === row.contractAddress &&
                  reference.mintAddress === row.mintAddress &&
                  reference.decimals === row.decimals
              )
            )

            return {
              assets: [...assets].sort((left, right) =>
                (left.coingeckoCoinId ?? "").localeCompare(right.coingeckoCoinId ?? "")
              ),
              representations: [...catalogRepresentations].sort((left, right) =>
                `${left.blockchain}:${left.contractAddress ?? left.mintAddress ?? "native"}`.localeCompare(
                  `${right.blockchain}:${right.contractAddress ?? right.mintAddress ?? "native"}`
                )
              ),
            }
          })
        )

      yield* Effect.promise(() => runPg(seedData))
      const first = yield* Effect.promise(() => readCatalogRows())
      yield* Effect.promise(() => runPg(seedData))
      const second = yield* Effect.promise(() => readCatalogRows())

      expect(first.assets).toEqual(expectedAssets)
      expect(first.representations).toHaveLength(
        assetReferenceCatalogProjections.networkRepresentations.length
      )
      expect(second).toEqual(first)
    })
  )

  describe("representation ownership decisions", () => {
    it.effect("records the settled owner once and reads it back keyed on the representation", () =>
      Effect.gen(function* () {
        const first = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.recordRepresentationOwnershipDecision({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                assetId: TEST_BTC_ASSET_ID,
                policyRevision: "2026-08-19.attach-only.1",
                actor: "system:attach-only-policy",
              })
            )
          )
        )
        expect(first).toEqual({ recorded: true })

        const second = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.recordRepresentationOwnershipDecision({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                assetId: TEST_BTC_ASSET_ID,
                policyRevision: "2026-08-19.attach-only.1",
                actor: "system:attach-only-policy",
              })
            )
          )
        )
        expect(second).toEqual({ recorded: false })

        const active = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findCurrentRepresentationOwnership({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              })
            )
          )
        )
        if (Option.isNone(active)) {
          throw new Error("Expected an active ownership decision")
        }
        expect(active.value).toMatchObject({
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          assetId: TEST_BTC_ASSET_ID,
          supersedesOwnershipDecisionId: null,
        })
      })
    )

    it.effect("serializes concurrent root ownership decisions across policy revisions", () =>
      Effect.gen(function* () {
        const record = (policyRevision: string) =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.recordRepresentationOwnershipDecision({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                assetId: TEST_BTC_ASSET_ID,
                policyRevision,
                actor: `system:${policyRevision}`,
              })
            )
          )

        const results = yield* Effect.promise(() =>
          Promise.all([record("2026-08-19.attach-only.1"), record("2026-08-26.attach-only.2")])
        )
        const roots = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.assetRepresentationOwnershipDecisions.id })
                .from(schema.assetRepresentationOwnershipDecisions)
                .where(
                  eq(
                    schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                    TEST_BTC_REPRESENTATION_ID
                  )
                )
            })
          )
        )

        expect(
          results
            .map(({ recorded }) => recorded)
            .sort((left, right) => Number(left) - Number(right))
        ).toEqual([false, true])
        expect(roots).toHaveLength(1)
      })
    )

    it.effect("keeps ownership history when a representation is reassigned", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [original] = yield* db
                .insert(schema.assetRepresentationOwnershipDecisions)
                .values({
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  policyRevision: "2026-08-19.attach-only.1",
                  actor: "test:direct-insert",
                })
                .returning({ id: schema.assetRepresentationOwnershipDecisions.id })
              if (original === undefined) {
                return yield* Effect.die("Expected original ownership decision")
              }
              yield* db
                .update(schema.assetRepresentations)
                .set({ assetId: TEST_EUR_ASSET_ID })
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              yield* db.insert(schema.assetRepresentationOwnershipDecisions).values({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                assetId: TEST_EUR_ASSET_ID,
                supersedesDecisionId: original.id,
                policyRevision: "2026-08-26.human-supersession.1",
                actor: "human:admin",
              })
            })
          )
        )

        yield* Effect.promise(() => runPg(seedData))

        const persisted = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const decisions = yield* db
                .select({ assetId: schema.assetRepresentationOwnershipDecisions.assetId })
                .from(schema.assetRepresentationOwnershipDecisions)
                .where(
                  eq(
                    schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                    TEST_BTC_REPRESENTATION_ID
                  )
                )
              const [representation] = yield* db
                .select({ assetId: schema.assetRepresentations.assetId })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              return { decisions, representation }
            })
          )
        )

        expect(persisted.decisions).toHaveLength(2)
        expect(persisted.decisions.map(({ assetId }) => assetId)).toEqual(
          expect.arrayContaining([TEST_BTC_ASSET_ID, TEST_EUR_ASSET_ID])
        )
        expect(persisted.representation).toEqual({ assetId: TEST_EUR_ASSET_ID })
      })
    )

    it.effect("keeps a representation referenced by a decision from being deleted", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.recordRepresentationOwnershipDecision({
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                assetId: TEST_BTC_ASSET_ID,
                policyRevision: "2026-08-19.attach-only.1",
                actor: "system:attach-only-policy",
              })
            )
          )
        )

        const deleteRepresentation = runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )

        yield* Effect.promise(() => expect(deleteRepresentation).rejects.toThrow())
      })
    )

    it.effect("rejects supersession links that cross representation histories", () =>
      Effect.gen(function* () {
        const crossRepresentation = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [eurOwnership] = yield* db
                .insert(schema.assetRepresentationOwnershipDecisions)
                .values({
                  assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                  assetId: TEST_EUR_ASSET_ID,
                  policyRevision: "2026-08-19.attach-only.1",
                  actor: "test:direct-insert",
                })
                .returning({ id: schema.assetRepresentationOwnershipDecisions.id })
              if (eurOwnership === undefined) {
                return yield* Effect.die("Expected EUR ownership decision")
              }
              return yield* db
                .insert(schema.assetRepresentationOwnershipDecisions)
                .values({
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  supersedesDecisionId: eurOwnership.id,
                  policyRevision: "2026-08-26.human-supersession.1",
                  actor: "human:admin",
                })
                .pipe(Effect.result)
            })
          )
        )

        expect(crossRepresentation._tag).toBe("Failure")
      })
    )
  })

  describe("display candidate discovery", () => {
    it.effect("matches assets by symbol or name, NFKC-normalized and case-insensitive", () =>
      Effect.gen(function* () {
        const bySymbol = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({ symbol: "btc", name: null })
            )
          )
        )
        const byName = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({
                symbol: "XXX",
                name: "sync engine bitcoin fixture",
              })
            )
          )
        )
        // Fullwidth "BTC" collides with the stored symbol through NFKC.
        const byLookalike = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({
                symbol: "\uFF22\uFF34\uFF23",
                name: null,
              })
            )
          )
        )
        const noMatch = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({
                symbol: "ZZZ",
                name: "Nothing",
              })
            )
          )
        )

        expect(bySymbol).toEqual([expect.objectContaining({ id: TEST_BTC_ASSET_ID })])
        expect(byName).toEqual([expect.objectContaining({ id: TEST_BTC_ASSET_ID })])
        expect(byLookalike).toEqual([expect.objectContaining({ id: TEST_BTC_ASSET_ID })])
        expect(noMatch).toEqual([])
      })
    )

    it.effect("matches a provider name against a stored symbol", () =>
      Effect.gen(function* () {
        const candidates = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({ symbol: "OTHER", name: "BTC" })
            )
          )
        )

        expect(candidates).toEqual([expect.objectContaining({ id: TEST_BTC_ASSET_ID })])
      })
    )

    it.effect("matches a stored symbol with padding, mirroring the trimmed provider side", () =>
      Effect.gen(function* () {
        const PADDED_ASSET_ID = "00000000-0000-0000-0000-000000000483"
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.assets).values({
                id: PADDED_ASSET_ID,
                name: "Padded Fixture",
                symbol: " PAD ",
                type: "fungible",
              })
            })
          )
        )

        const candidates = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetRepository, (repository) =>
              repository.findAssetResolutionCandidatesByDisplay({ symbol: "pad", name: null })
            )
          )
        )

        expect(candidates).toEqual([expect.objectContaining({ id: PADDED_ASSET_ID })])
      })
    )
  })

  describe("standalone asset creation", () => {
    const ORB_MINT = "OrbRepoMint111111111111111111111111111111111"
    const ORB_PROVIDER_ASSET_ROW_ID = "00000000-0000-0000-0000-000000000681"
    const ORB_POLICY_REVISION = "2026-08-21.standalone-create.1"

    const seedOrbProviderAsset = () =>
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.providerAssets).values({
            id: ORB_PROVIDER_ASSET_ROW_ID,
            provider: "helius",
            providerAssetId: null,
            naturalKey: `solana:${ORB_MINT}`,
            currencyCode: "ORBR",
            name: "Orb Repo Coin",
            retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")),
          })
        })
      )

    const orbDecision = ({ mintAddress = ORB_MINT }: { readonly mintAddress?: string } = {}) => ({
      providerAssetRowId: ORB_PROVIDER_ASSET_ROW_ID,
      evidenceRevision: 1,
      policyRevision: ORB_POLICY_REVISION,
      outcome: "create_standalone" as const,
      assetId: null,
      assetRepresentationId: null,
      blockchain: "solana",
      representationType: "token" as const,
      contractAddress: null,
      mintAddress,
      decimals: 9,
      reason: null,
      evidence: [],
      actor: "system:asset-resolution-policy",
    })

    const createOrb = ({
      mintAddress = ORB_MINT,
      coingeckoCoinId = null,
      blockchainName = "solana",
    }: {
      readonly mintAddress?: string
      readonly coingeckoCoinId?: string | null
      readonly blockchainName?: string
    } = {}) =>
      Effect.flatMap(AssetRepository, (repository) =>
        repository.createStandaloneAssetRepresentation({
          blockchainName,
          asset: {
            name: "Orb Repo Coin",
            symbol: "ORBR",
            coingeckoCoinId,
            logoUrl: null,
            type: "fungible",
          },
          representation: {
            contractAddress: null,
            mintAddress,
            decimals: 9,
            logoUrl: null,
            type: "token",
            isSpam: false,
            metadata: null,
          },
          decision: orbDecision({ mintAddress }),
        })
      )

    beforeEach(() => Effect.runPromise(Effect.asVoid(Effect.promise(() => seedOrbProviderAsset()))))

    it.effect(
      "creates the asset, representation, and audit decision in one durable operation",
      () =>
        Effect.gen(function* () {
          const created = yield* Effect.promise(() =>
            runRepository(createOrb({ coingeckoCoinId: "orb-repo-coin" }))
          )

          expect(created).toMatchObject({
            name: "Orb Repo Coin",
            symbol: "ORBR",
            type: "fungible",
            blockchainName: "solana",
            mintAddress: ORB_MINT,
            contractAddress: null,
            decimals: 9,
            representationType: "token",
          })

          const stored = yield* Effect.promise(() =>
            runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                const assets = yield* db
                  .select({
                    id: schema.assets.id,
                    coingeckoCoinId: schema.assets.coingeckoCoinId,
                  })
                  .from(schema.assets)
                  .where(eq(schema.assets.symbol, "ORBR"))
                const representations = yield* db
                  .select({ assetId: schema.assetRepresentations.assetId })
                  .from(schema.assetRepresentations)
                  .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))
                const decisions = yield* db
                  .select({
                    outcome: schema.assetResolutionDecisions.outcome,
                    assetId: schema.assetResolutionDecisions.assetId,
                    assetRepresentationId: schema.assetResolutionDecisions.assetRepresentationId,
                  })
                  .from(schema.assetResolutionDecisions)
                  .where(
                    eq(
                      schema.assetResolutionDecisions.providerAssetRowId,
                      ORB_PROVIDER_ASSET_ROW_ID
                    )
                  )

                return { assets, representations, decisions }
              })
            )
          )

          expect(stored.assets).toEqual([{ id: created.id, coingeckoCoinId: "orb-repo-coin" }])
          expect(stored.representations).toEqual([{ assetId: created.id }])
          // The decision carries the created ids, so the audit shows the creation.
          expect(stored.decisions).toEqual([
            {
              outcome: "create_standalone",
              assetId: created.id,
              assetRepresentationId: created.representationId,
            },
          ])
        })
    )

    it.effect(
      "fails without creating an orphan asset when the representation already has an owner",
      () =>
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => runRepository(createOrb()))

          yield* Effect.promise(() => expect(runRepository(createOrb())).rejects.toThrow())

          const stored = yield* Effect.promise(() =>
            runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                const assets = yield* db
                  .select({ id: schema.assets.id })
                  .from(schema.assets)
                  .where(eq(schema.assets.symbol, "ORBR"))
                const representations = yield* db
                  .select({ assetId: schema.assetRepresentations.assetId })
                  .from(schema.assetRepresentations)
                  .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))

                return { assets, representations }
              })
            )
          )

          expect(stored.assets).toEqual([{ id: first.id }])
          expect(stored.representations).toEqual([{ assetId: first.id }])
        })
    )

    it.effect("fails when the blockchain does not exist instead of inventing reference data", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          expect(runRepository(createOrb({ blockchainName: "unknown-chain" }))).rejects.toThrow()
        )

        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.assets.id })
                .from(schema.assets)
                .where(eq(schema.assets.symbol, "ORBR"))
            })
          )
        )

        expect(stored).toEqual([])
      })
    )

    it.effect("lets exactly one of two concurrent creations win and keeps no orphan rows", () =>
      Effect.gen(function* () {
        const results = yield* Effect.promise(() =>
          runRepository(
            Effect.all([Effect.result(createOrb()), Effect.result(createOrb())], {
              concurrency: "unbounded",
            })
          )
        )

        const successes = results.filter((result) => result._tag === "Success")
        const failures = results.filter((result) => result._tag === "Failure")
        expect(successes).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(failures[0]?.failure).toBeInstanceOf(SyncEngineStorageError)

        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const assets = yield* db
                .select({ id: schema.assets.id })
                .from(schema.assets)
                .where(eq(schema.assets.symbol, "ORBR"))
              const representations = yield* db
                .select({ id: schema.assetRepresentations.id })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))
              const decisions = yield* db
                .select({ id: schema.assetResolutionDecisions.id })
                .from(schema.assetResolutionDecisions)
                .where(
                  eq(schema.assetResolutionDecisions.providerAssetRowId, ORB_PROVIDER_ASSET_ROW_ID)
                )

              return { assets, representations, decisions }
            })
          )
        )

        expect(stored.assets).toHaveLength(1)
        expect(stored.representations).toHaveLength(1)
        expect(stored.decisions).toHaveLength(1)
      })
    )

    it.effect("rejects a second standalone asset for an already-claimed CoinGecko coin id", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runRepository(createOrb({ coingeckoCoinId: "orb-repo-coin" })))

        yield* Effect.promise(() =>
          expect(
            runRepository(
              createOrb({
                mintAddress: "OrbRepoMint211111111111111111111111111111111",
                coingeckoCoinId: "orb-repo-coin",
              })
            )
          ).rejects.toThrow()
        )

        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.assets.id })
                .from(schema.assets)
                .where(eq(schema.assets.coingeckoCoinId, "orb-repo-coin"))
            })
          )
        )

        expect(stored).toHaveLength(1)
      })
    )
  })
})
