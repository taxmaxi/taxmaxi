import { and, eq, inArray, isNull } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../../persistence/tests/support/integration-test-kit.ts"
import { HeliusSolanaAssetResolutionServiceLive } from "../../src/providers/helius-solana/layers/HeliusSolanaAssetResolutionServiceLive.ts"
import {
  HeliusSolanaAssetResolutionService,
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  SOLANA_WRAPPED_NATIVE_MINT,
} from "../../src/providers/helius-solana/services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_helius_assets_pr16",
})

await Effect.runPromise(context.recreateTestDatabase())

const SOL_ASSET_ID = "00000000-0000-0000-0000-000000001601"
const USDC_ASSET_ID = "00000000-0000-0000-0000-000000001602"
const USDT_ASSET_ID = "00000000-0000-0000-0000-000000001603"
const UNKNOWN_ASSET_ID = "00000000-0000-0000-0000-000000001604"
const UNKNOWN_MINT = "Drift111111111111111111111111111111111111111"
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

const makeDasAsset = ({
  mintAddress,
  symbol,
  name,
  decimals,
  tokenProgram = TOKEN_PROGRAM,
  interfaceName = "FungibleToken",
}: {
  readonly mintAddress: string
  readonly symbol?: string
  readonly name: string
  readonly decimals?: number
  readonly tokenProgram?: string
  readonly interfaceName?: string
}) => ({
  id: mintAddress,
  interface: interfaceName,
  content: {
    metadata: {
      name,
      symbol,
      token_standard: interfaceName,
    },
  },
  token_info: {
    symbol,
    decimals,
    token_program: tokenProgram,
  },
  compression: {
    compressed: false,
  },
  burnt: false,
})

const resetAssetResolutionFixture = Effect.gen(function* () {
  const db = yield* drizzle
  const [solanaBlockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))
    .limit(1)

  if (solanaBlockchain === undefined) {
    return yield* Effect.dieMessage("Missing seeded Solana blockchain")
  }

  yield* db.delete(schema.providerAssetMappings)
  yield* db.delete(schema.providerAssets)

  yield* db
    .delete(schema.assets)
    .where(
      and(
        eq(schema.assets.blockchainId, solanaBlockchain.id),
        inArray(schema.assets.contractAddress, [SOLANA_USDC_MINT, SOLANA_USDT_MINT, UNKNOWN_MINT])
      )
    )

  yield* db
    .delete(schema.assets)
    .where(
      and(
        eq(schema.assets.blockchainId, solanaBlockchain.id),
        isNull(schema.assets.contractAddress),
        eq(schema.assets.symbol, "SOL"),
        eq(schema.assets.type, "native")
      )
    )

  yield* db.insert(schema.assets).values([
    {
      id: SOL_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      contractAddress: null,
      name: "Solana",
      symbol: "SOL",
      decimals: 9,
      type: "native",
    },
    {
      id: USDC_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      contractAddress: SOLANA_USDC_MINT,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      type: "token",
    },
    {
      id: USDT_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      contractAddress: SOLANA_USDT_MINT,
      name: "Tether USD",
      symbol: "USDT",
      decimals: 6,
      type: "token",
    },
  ])

  return solanaBlockchain.id
})

const HeliusSolanaAssetResolutionTestLive = (
  fetchAssetBatch: HeliusSolanaSyncClientShape["fetchAssetBatch"]
) =>
  HeliusSolanaAssetResolutionServiceLive.pipe(
    Layer.provide(AssetRepositoryLive),
    Layer.provide(ProviderAssetRepositoryLive),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaSyncClient,
        HeliusSolanaSyncClient.of({
          fetchTransactionsForAddress: () =>
            Effect.dieMessage("fetchTransactionsForAddress should not be called"),
          fetchAssetBatch,
        })
      )
    )
  )

const runAssetService = <A, E>(
  effect: Effect.Effect<A, E, HeliusSolanaAssetResolutionService>,
  fetchAssetBatch: HeliusSolanaSyncClientShape["fetchAssetBatch"]
) =>
  Effect.runPromise(
    context.runWithLayer({
      effect,
      layer: HeliusSolanaAssetResolutionTestLive(fetchAssetBatch),
    })
  )

const fetchProviderAssetState = ({ mintAddress }: { readonly mintAddress: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [state] = yield* db
      .select({
        providerAssetRowId: schema.providerAssets.id,
        providerAssetId: schema.providerAssets.providerAssetId,
        naturalKey: schema.providerAssets.naturalKey,
        currencyCode: schema.providerAssets.currencyCode,
        exponent: schema.providerAssets.exponent,
        providerType: schema.providerAssets.providerType,
        rawProviderPayload: schema.providerAssets.rawProviderPayload,
        mappingKind: schema.providerAssetMappings.mappingKind,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        canonicalAssetSymbol: schema.providerAssetMappings.canonicalAssetSymbol,
        sourceNotes: schema.providerAssetMappings.sourceNotes,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "helius-solana"),
          eq(schema.providerAssets.providerAssetId, mintAddress)
        )
      )
      .limit(1)

    return state ?? null
  })

describe("HeliusSolanaAssetResolutionServiceLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await context.runPg(resetAssetResolutionFixture)
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("resolves native SOL without a DAS metadata call", async () => {
    let dasCallCount = 0

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "native",
          mintAddress: null,
        })
      ),
      () =>
        Effect.sync(() => {
          dasCallCount += 1
          return []
        })
    )

    expect(dasCallCount).toBe(0)
    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "native",
      providerAssetId: SOLANA_WRAPPED_NATIVE_MINT,
      currencyCode: "SOL",
      decimals: 9,
      mappingStatus: "approved",
      canonicalAssetId: SOL_ASSET_ID,
      canonicalAssetSymbol: "SOL",
    })
  })

  it("resolves known SPL stablecoin mints through one DAS batch and approved canonical mappings", async () => {
    const dasCalls: Array<ReadonlyArray<string>> = []

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAssets({
          assets: [
            {
              kind: "spl",
              mintAddress: SOLANA_USDC_MINT,
            },
            {
              kind: "spl",
              mintAddress: SOLANA_USDT_MINT,
            },
          ],
        })
      ),
      ({ mintAddresses }) =>
        Effect.sync(() => {
          dasCalls.push(mintAddresses)
          return [
            makeDasAsset({
              mintAddress: SOLANA_USDC_MINT,
              symbol: "USDC",
              name: "USD Coin",
              decimals: 6,
              tokenProgram: TOKEN_PROGRAM,
            }),
            makeDasAsset({
              mintAddress: SOLANA_USDT_MINT,
              symbol: "USDT",
              name: "Tether USD",
              decimals: 6,
              tokenProgram: TOKEN_PROGRAM,
            }),
          ]
        })
    )

    expect(dasCalls).toEqual([[SOLANA_USDC_MINT, SOLANA_USDT_MINT]])
    expect(result.map((asset) => asset.canonicalAssetId)).toEqual([USDC_ASSET_ID, USDT_ASSET_ID])
    expect(result.every((asset) => asset.kind === "canonical")).toBe(true)
    expect(result.every((asset) => asset.tokenProgram === TOKEN_PROGRAM)).toBe(true)

    const usdcState = await context.runPg(
      fetchProviderAssetState({
        mintAddress: SOLANA_USDC_MINT,
      })
    )

    expect(usdcState).toMatchObject({
      currencyCode: "USDC",
      exponent: 6,
      providerType: "spl-token",
      mappingKind: "asset",
      mappingStatus: "approved",
      canonicalAssetId: USDC_ASSET_ID,
      canonicalAssetSymbol: "USDC",
    })
    expect(usdcState?.rawProviderPayload).toMatchObject({
      source: "helius_das_get_asset_batch",
      tokenProgram: TOKEN_PROGRAM,
      nftHint: false,
    })
  })

  it("resolves approved built-in SPL mappings without refreshing non-DAS provider metadata", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        Effect.gen(function* () {
          yield* service.ensureDefaultMappings()

          return yield* service.resolveAsset({
            kind: "spl",
            mintAddress: SOLANA_USDC_MINT,
          })
        })
      ),
      () => Effect.dieMessage("DAS should not be called for approved cached mapping")
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "token",
      mintAddress: SOLANA_USDC_MINT,
      currencyCode: "USDC",
      decimals: 6,
      tokenProgram: null,
      mappingStatus: "approved",
      canonicalAssetId: USDC_ASSET_ID,
      canonicalAssetSymbol: "USDC",
    })

    const usdcState = await context.runPg(
      fetchProviderAssetState({
        mintAddress: SOLANA_USDC_MINT,
      })
    )

    expect(usdcState?.rawProviderPayload).toMatchObject({
      source: "taxmaxi_builtin_solana_asset_mapping",
    })
  })

  it("persists unknown SPL mints as pending provider asset review instead of failing", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          rawProviderPayload: {
            signature: "unknown-asset-signature",
          },
        })
      ),
      () =>
        Effect.succeed([
          makeDasAsset({
            mintAddress: UNKNOWN_MINT,
            name: "Drift Example",
            decimals: 5,
            tokenProgram: TOKEN_2022_PROGRAM,
          }),
        ])
    )

    expect(result).toMatchObject({
      kind: "review_required",
      assetKind: "token",
      mintAddress: UNKNOWN_MINT,
      decimals: 5,
      tokenProgram: TOKEN_2022_PROGRAM,
      mappingStatus: "pending_review",
      canonicalAssetId: null,
    })

    const state = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))

    expect(state).toMatchObject({
      providerAssetId: UNKNOWN_MINT,
      naturalKey: `solana:mint:${UNKNOWN_MINT}`,
      currencyCode: "SOLANA_MINT_DRIFT111",
      providerType: "spl-token-2022",
      mappingStatus: "pending_review",
      canonicalAssetId: null,
    })
    expect(state?.rawProviderPayload).toMatchObject({
      source: "helius_das_get_asset_batch",
      tokenProgram: TOKEN_2022_PROGRAM,
      nftHint: false,
    })
  })

  it("fails with a typed decode error for malformed DAS asset metadata", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service
          .resolveAsset({
            kind: "spl",
            mintAddress: UNKNOWN_MINT,
          })
          .pipe(Effect.either)
      ),
      () =>
        Effect.succeed([
          {
            id: UNKNOWN_MINT,
            token_info: {
              decimals: "6",
            },
          },
        ])
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "HeliusSolanaAssetMetadataDecodeError",
      })
      expect(result.left.message).toContain("Invalid Helius DAS asset batch payload")
    }
  })

  it("resolves a previously pending mint deterministically after provider asset approval", async () => {
    let dasCallCount = 0

    await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.sync(() => {
          dasCallCount += 1
          return [
            makeDasAsset({
              mintAddress: UNKNOWN_MINT,
              symbol: "DRIFT",
              name: "Drift Example",
              decimals: 6,
            }),
          ]
        })
    )

    const providerAssetState = await context.runPg(
      fetchProviderAssetState({ mintAddress: UNKNOWN_MINT })
    )
    if (providerAssetState === null) {
      expect.fail("Expected pending provider asset state")
    }

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [solanaBlockchain] = yield* db
          .select({ id: schema.blockchains.id })
          .from(schema.blockchains)
          .where(eq(schema.blockchains.name, "solana"))
          .limit(1)

        if (solanaBlockchain === undefined) {
          return yield* Effect.dieMessage("Missing seeded Solana blockchain")
        }

        yield* db.insert(schema.assets).values({
          id: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          contractAddress: UNKNOWN_MINT,
          name: "Drift Example",
          symbol: "DRIFT",
          decimals: 6,
          type: "token",
        })

        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingKind: "asset",
            canonicalAssetId: UNKNOWN_ASSET_ID,
            canonicalAssetSymbol: "DRIFT",
            canonicalFiatCurrency: null,
            mappingStatus: "approved",
            reviewerNotes: "Approved in test",
            sourceNotes: "Approved in test",
          })
          .where(
            eq(
              schema.providerAssetMappings.providerAssetRowId,
              providerAssetState.providerAssetRowId
            )
          )
      })
    )

    const replayResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.dieMessage("DAS should not be called when approved mapping is cached")
    )

    expect(dasCallCount).toBe(1)
    expect(replayResult).toMatchObject({
      kind: "canonical",
      mintAddress: UNKNOWN_MINT,
      canonicalAssetId: UNKNOWN_ASSET_ID,
      canonicalAssetSymbol: "DRIFT",
      mappingStatus: "approved",
    })
  })
})
