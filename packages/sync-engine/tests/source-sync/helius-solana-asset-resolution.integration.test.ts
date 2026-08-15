import { and, eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "vitest"
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
const NFT_ASSET_ID = "00000000-0000-0000-0000-000000001606"
const SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001601"
const WRAPPED_SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001605"
const USDC_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001602"
const USDT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001603"
const UNKNOWN_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001604"
const NFT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001606"
const UNKNOWN_MINT = "Drift111111111111111111111111111111111111111"
const NFT_MINT = "Nft11111111111111111111111111111111111111111"
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
    .delete(schema.assetRepresentations)
    .where(eq(schema.assetRepresentations.blockchainId, solanaBlockchain.id))
  yield* db
    .delete(schema.assets)
    .where(
      inArray(schema.assets.id, [
        SOL_ASSET_ID,
        USDC_ASSET_ID,
        USDT_ASSET_ID,
        UNKNOWN_ASSET_ID,
        NFT_ASSET_ID,
      ])
    )

  yield* db.insert(schema.assets).values([
    {
      id: SOL_ASSET_ID,
      name: "Solana",
      symbol: "SOL",
      type: "fungible",
    },
    {
      id: USDC_ASSET_ID,
      name: "USD Coin",
      symbol: "USDC",
      type: "fungible",
    },
    {
      id: USDT_ASSET_ID,
      name: "Tether USD",
      symbol: "USDT",
      type: "fungible",
    },
  ])

  yield* db.insert(schema.assetRepresentations).values([
    {
      id: SOL_REPRESENTATION_ID,
      assetId: SOL_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "native",
      contractAddress: null,
      mintAddress: null,
      decimals: 9,
    },
    {
      id: WRAPPED_SOL_REPRESENTATION_ID,
      assetId: SOL_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
      decimals: 9,
    },
    {
      id: USDC_REPRESENTATION_ID,
      assetId: USDC_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_USDC_MINT,
      decimals: 6,
    },
    {
      id: USDT_REPRESENTATION_ID,
      assetId: USDT_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_USDT_MINT,
      decimals: 6,
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
          fetchTransfersForAddress: () =>
            Effect.dieMessage("fetchTransfersForAddress should not be called"),
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
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
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
      providerAssetId: null,
      currencyCode: "SOL",
      decimals: 9,
      mappingStatus: "approved",
      canonicalAssetId: SOL_ASSET_ID,
      assetRepresentationId: SOL_REPRESENTATION_ID,
    })
  })

  it("resolves wrapped SOL to its mint representation", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        Effect.gen(function* () {
          yield* service.ensureDefaultMappings()

          return yield* service.resolveAsset({
            kind: "spl",
            mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
          })
        })
      ),
      () => Effect.dieMessage("DAS should not be called for wrapped SOL default mapping")
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "token",
      mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
      canonicalAssetId: SOL_ASSET_ID,
      assetRepresentationId: WRAPPED_SOL_REPRESENTATION_ID,
    })
  })

  it("rejects a wrapped SOL mapping that points to native SOL", async () => {
    await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.ensureDefaultMappings()
      ),
      () => Effect.dieMessage("DAS should not be called while seeding default mappings")
    )

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [wrappedSolProviderAsset] = yield* db
          .select({ id: schema.providerAssets.id })
          .from(schema.providerAssets)
          .where(eq(schema.providerAssets.providerAssetId, SOLANA_WRAPPED_NATIVE_MINT))
          .limit(1)

        if (wrappedSolProviderAsset === undefined) {
          return yield* Effect.dieMessage("Missing wrapped SOL provider asset")
        }

        yield* db
          .update(schema.providerAssetMappings)
          .set({
            canonicalAssetId: SOL_ASSET_ID,
            assetRepresentationId: SOL_REPRESENTATION_ID,
            mappingStatus: "approved",
          })
          .where(eq(schema.providerAssetMappings.providerAssetRowId, wrappedSolProviderAsset.id))
      })
    )

    const result = await runAssetService(
      Effect.either(
        Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
          service.resolveAsset({
            kind: "spl",
            mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
          })
        )
      ),
      () => Effect.dieMessage("DAS should not be called for an approved mapping")
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "HeliusSolanaBrokenApprovedProviderAssetMappingError",
        mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
      })
    }
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
      assetRepresentationId: USDC_REPRESENTATION_ID,
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
      assetRepresentationId: USDC_REPRESENTATION_ID,
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
      representationTypeObserved: true,
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

  it("automatically resolves an exact known Solana representation", async () => {
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
          name: "Drift Example",
          symbol: "DRIFT",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 6,
          type: "token",
        })
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          makeDasAsset({
            mintAddress: UNKNOWN_MINT,
            symbol: "DRIFT",
            name: "Drift Example",
            decimals: 6,
          }),
        ])
    )

    const state = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))

    expect(result).toMatchObject({
      kind: "canonical",
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })
    expect(state).toMatchObject({
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })
    expect(state?.sourceNotes).toContain("exact mint, type, and compatible decimals")
  })

  it("derives an exact known NFT type when DAS type evidence is missing", async () => {
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
          id: NFT_ASSET_ID,
          name: "Known NFT",
          symbol: "KNFT",
          type: "nft",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: NFT_REPRESENTATION_ID,
          assetId: NFT_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          contractAddress: null,
          mintAddress: NFT_MINT,
          decimals: 0,
          type: "nft",
        })
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: NFT_MINT,
        })
      ),
      () => Effect.succeed([])
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "nft",
      representationTypeObserved: true,
      decimals: 0,
      mappingStatus: "approved",
      canonicalAssetId: NFT_ASSET_ID,
      assetRepresentationId: NFT_REPRESENTATION_ID,
      nftHint: true,
    })
  })

  it("recovers observed type evidence from cached DAS payloads without a derived marker", async () => {
    await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          makeDasAsset({
            mintAddress: UNKNOWN_MINT,
            name: "Cached Token",
            decimals: 5,
          }),
        ])
    )

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({
            rawProviderPayload: sql`${schema.providerAssets.rawProviderPayload} - 'representationTypeObserved'`,
          })
          .where(eq(schema.providerAssets.providerAssetId, UNKNOWN_MINT))
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.dieMessage("Cached DAS metadata should not be refetched")
    )

    expect(result).toMatchObject({
      assetKind: "token",
      representationTypeObserved: true,
      mintAddress: UNKNOWN_MINT,
    })
  })

  it("marks token-versus-NFT type as unknown when the DAS record is missing", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.succeed([])
    )

    expect(result).toMatchObject({
      kind: "review_required",
      assetKind: "token",
      representationTypeObserved: false,
      mintAddress: UNKNOWN_MINT,
      decimals: null,
      mappingStatus: "pending_review",
    })
  })

  it("refreshes sparse DAS records until token-versus-NFT type is observed", async () => {
    const sparseResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          {
            id: UNKNOWN_MINT,
            content: {
              metadata: {
                name: "Name That Looks Like An NFT",
                symbol: "NFT",
              },
            },
            token_info: {
              symbol: "NFT",
            },
          },
        ])
    )

    expect(sparseResult).toMatchObject({
      kind: "review_required",
      assetKind: "token",
      representationTypeObserved: false,
      mintAddress: UNKNOWN_MINT,
      decimals: null,
      mappingStatus: "pending_review",
    })

    const refreshedResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          makeDasAsset({
            mintAddress: UNKNOWN_MINT,
            name: "Now Identified NFT",
            decimals: 0,
            interfaceName: "V1_PRINT",
          }),
        ])
    )

    expect(refreshedResult).toMatchObject({
      kind: "review_required",
      assetKind: "nft",
      representationTypeObserved: true,
      mintAddress: UNKNOWN_MINT,
      decimals: 0,
      mappingStatus: "pending_review",
    })
  })

  it("recognizes an explicit non-fungible DAS token standard", async () => {
    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          makeDasAsset({
            mintAddress: UNKNOWN_MINT,
            name: "Programmable NFT",
            decimals: 0,
            interfaceName: "ProgrammableNonFungible",
          }),
        ])
    )

    expect(result).toMatchObject({
      kind: "review_required",
      assetKind: "nft",
      representationTypeObserved: true,
      mintAddress: UNKNOWN_MINT,
      decimals: 0,
      mappingStatus: "pending_review",
    })
  })

  it("preserves observed decimals when a type refresh omits them", async () => {
    const sparseResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          {
            id: UNKNOWN_MINT,
            content: {
              metadata: {
                name: "Sparse asset with decimals",
                symbol: "SPARSE",
              },
            },
            token_info: {
              symbol: "SPARSE",
              decimals: 5,
            },
          },
        ])
    )

    expect(sparseResult).toMatchObject({
      representationTypeObserved: false,
      decimals: 5,
    })

    const refreshedResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () =>
        Effect.succeed([
          {
            id: UNKNOWN_MINT,
            interface: "V1_PRINT",
            content: {
              metadata: {
                name: "Identified NFT without decimals",
                symbol: "NFT",
              },
            },
          },
        ])
    )

    expect(refreshedResult).toMatchObject({
      assetKind: "nft",
      representationTypeObserved: true,
      decimals: 5,
    })
  })

  it.each(["V1_PRINT", "MplCoreAsset"])(
    "recognizes the explicit %s DAS NFT interface",
    async (interfaceName) => {
      const result = await runAssetService(
        Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
          service.resolveAsset({
            kind: "spl",
            mintAddress: UNKNOWN_MINT,
          })
        ),
        () =>
          Effect.succeed([
            {
              id: UNKNOWN_MINT,
              interface: interfaceName,
              content: {
                metadata: {
                  name: "Explicit NFT Interface",
                },
              },
              token_info: {
                decimals: 0,
                token_program: TOKEN_PROGRAM,
              },
              compression: {
                compressed: false,
              },
            },
          ])
      )

      expect(result).toMatchObject({
        kind: "review_required",
        assetKind: "nft",
        representationTypeObserved: true,
        mintAddress: UNKNOWN_MINT,
        decimals: 0,
      })
    }
  )

  it("derives the asset kind from cached DAS evidence instead of stale stored fields", async () => {
    const cachedDasAsset = makeDasAsset({
      mintAddress: UNKNOWN_MINT,
      name: "Cached Explicit NFT",
      decimals: 0,
      interfaceName: "V1_PRINT",
    })

    await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.succeed([cachedDasAsset])
    )

    await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.providerAssets)
          .set({
            providerType: "spl-token",
            rawProviderPayload: {
              source: "helius_das_get_asset_batch",
              tokenProgram: TOKEN_PROGRAM,
              nftHint: false,
              asset: cachedDasAsset,
            },
          })
          .where(eq(schema.providerAssets.providerAssetId, UNKNOWN_MINT))
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.dieMessage("Complete cached DAS metadata should not be refetched")
    )

    expect(result).toMatchObject({
      assetKind: "nft",
      representationTypeObserved: true,
      mintAddress: UNKNOWN_MINT,
      nftHint: true,
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
          name: "Drift Example",
          symbol: "DRIFT",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 6,
          type: "token",
        })

        yield* db
          .update(schema.providerAssetMappings)
          .set({
            mappingKind: "asset",
            canonicalAssetId: UNKNOWN_ASSET_ID,
            assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
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
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
      mappingStatus: "approved",
    })
  })
})
