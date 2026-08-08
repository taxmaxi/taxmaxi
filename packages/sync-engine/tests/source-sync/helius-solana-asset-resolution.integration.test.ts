import { and, eq, inArray } from "drizzle-orm"
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
const SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001601"
const WRAPPED_SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001605"
const USDC_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001602"
const USDT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001603"
const UNKNOWN_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001604"
const REPLAY_USER_ID = "00000000-0000-0000-0000-000000001611"
const REPLAY_PRINCIPAL_ID = "00000000-0000-0000-0000-000000001612"
const REPLAY_ADDRESS_ID = "00000000-0000-0000-0000-000000001613"
const REPLAY_SOURCE_ID = "00000000-0000-0000-0000-000000001614"
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
    .delete(schema.assetRepresentations)
    .where(eq(schema.assetRepresentations.blockchainId, solanaBlockchain.id))
  yield* db
    .delete(schema.assets)
    .where(
      inArray(schema.assets.id, [SOL_ASSET_ID, USDC_ASSET_ID, USDT_ASSET_ID, UNKNOWN_ASSET_ID])
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

const seedObservedProviderTransfer = ({
  providerAssetRowId,
  observedDecimals,
  observedRepresentationType = "token",
  activeJob,
}: {
  readonly providerAssetRowId: string
  readonly observedDecimals: number
  readonly observedRepresentationType?: "native" | "token" | "nft" | null
  readonly activeJob: boolean
}) =>
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

    const now = new Date("2025-04-11T10:00:00.000Z")
    yield* db.insert(schema.users).values({
      id: REPLAY_USER_ID,
      email: "helius-replay@taxmaxi.test",
      name: "Helius replay fixture",
    })
    yield* db.insert(schema.principals).values({
      id: REPLAY_PRINCIPAL_ID,
      kind: "user",
      userId: REPLAY_USER_ID,
    })
    yield* db.insert(schema.addresses).values({
      id: REPLAY_ADDRESS_ID,
      address: "Replay11111111111111111111111111111111111111",
      type: "solana",
      name: "Helius replay wallet",
      principalId: REPLAY_PRINCIPAL_ID,
      createdAt: now,
      updatedAt: now,
    })
    yield* db.insert(schema.sources).values({
      id: REPLAY_SOURCE_ID,
      principalId: REPLAY_PRINCIPAL_ID,
      name: "Helius replay source",
      providerKey: "helius-solana",
      sourceableType: "onchain",
      cexAccountId: null,
      addressId: REPLAY_ADDRESS_ID,
      createdAt: now,
      updatedAt: now,
    })
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: REPLAY_SOURCE_ID,
        externalId: "helius-replay-transaction",
        timestamp: now,
        providerStatus: "confirmed",
        principalId: REPLAY_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) {
      return yield* Effect.dieMessage("Failed to seed Helius replay transaction")
    }
    yield* db.insert(schema.providerTransfers).values({
      sourceId: REPLAY_SOURCE_ID,
      transactionId: transaction.id,
      externalId: "helius-replay-provider-transfer",
      providerAssetId: providerAssetRowId,
      timestamp: now,
      direction: "inbound",
      fromAddress: "Sender11111111111111111111111111111111111111",
      toAddress: "Replay11111111111111111111111111111111111111",
      observedBlockchainId: solanaBlockchain.id,
      observedRepresentationType,
      observedContractAddress: null,
      observedMintAddress: UNKNOWN_MINT,
      observedDecimals,
      amount: "1.00000",
      metadata: { role: "principal" },
    })
    if (activeJob) {
      yield* db.insert(schema.processingJobs).values({
        sourceId: REPLAY_SOURCE_ID,
        principalId: REPLAY_PRINCIPAL_ID,
        mode: "sync",
        status: "processing",
        startedAt: now,
      })
    }
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

  it("resolves a mint through an existing exact representation without a built-in mapping", async () => {
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
          name: "Known private asset",
          symbol: "PRIVATE",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "token",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 5,
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
            name: "Known private asset",
            decimals: 5,
            tokenProgram: TOKEN_2022_PROGRAM,
          }),
        ])
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "token",
      mintAddress: UNKNOWN_MINT,
      decimals: 5,
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })

    const state = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))

    expect(state).toMatchObject({
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })
  })

  it("resolves an exact representation when DAS metadata omits decimals", async () => {
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
          name: "Known private asset",
          symbol: "PRIVATE",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "token",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 5,
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
      () => Effect.succeed([])
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "token",
      mintAddress: UNKNOWN_MINT,
      decimals: 5,
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })

    const state = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))

    expect(state).toMatchObject({
      exponent: null,
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })

    const conflictingMovement = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service
          .resolveAsset({
            kind: "spl",
            mintAddress: UNKNOWN_MINT,
            observedDecimals: [6],
          })
          .pipe(Effect.either)
      ),
      () => Effect.dieMessage("DAS should not be called for an approved cached mapping")
    )
    expect(conflictingMovement._tag).toBe("Left")
  })

  it("keeps an exact representation pending when transaction decimals conflict", async () => {
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
          name: "Known private asset",
          symbol: "PRIVATE",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "token",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 5,
        })
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [6],
        })
      ),
      () => Effect.succeed([])
    )

    expect(result).toMatchObject({
      kind: "review_required",
      mappingStatus: "pending_review",
      canonicalAssetId: null,
      assetRepresentationId: null,
    })
  })

  it("infers an exact NFT representation when DAS metadata is missing", async () => {
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
          name: "Known private NFT",
          symbol: "PRIVATE-NFT",
          type: "nft",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "nft",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 0,
        })
      })
    )

    const result = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [0],
        })
      ),
      () => Effect.succeed([])
    )

    expect(result).toMatchObject({
      kind: "canonical",
      assetKind: "nft",
      decimals: 0,
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })
  })

  it("resolves a pending mint after its exact representation is added", async () => {
    const firstResult = await runAssetService(
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
            name: "Known private asset",
            decimals: 5,
            tokenProgram: TOKEN_2022_PROGRAM,
          }),
        ])
    )

    expect(firstResult).toMatchObject({
      kind: "review_required",
      mappingStatus: "pending_review",
    })

    const pendingState = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
    if (pendingState === null) {
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
          name: "Known private asset",
          symbol: "PRIVATE",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "token",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 5,
        })

        yield* seedObservedProviderTransfer({
          providerAssetRowId: pendingState.providerAssetRowId,
          observedDecimals: 5,
          activeJob: true,
        })
      })
    )

    const replayedResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ),
      () => Effect.dieMessage("DAS should not be called for cached provider metadata")
    )

    expect(replayedResult).toMatchObject({
      kind: "canonical",
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })

    const replayJob = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .select({ followUpMode: schema.processingJobs.followUpMode })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, REPLAY_SOURCE_ID))
          .limit(1)
        return job ?? null
      })
    )
    expect(replayJob).toEqual({ followUpMode: "replay" })
  })

  it("keeps a pending mint unresolved when historical movement evidence conflicts", async () => {
    const firstResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [6],
        })
      ),
      () => Effect.succeed([])
    )
    expect(firstResult).toMatchObject({
      kind: "review_required",
      mappingStatus: "pending_review",
    })

    const pendingState = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
    if (pendingState === null) {
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
          name: "Known private asset",
          symbol: "PRIVATE",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "token",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 5,
        })
        yield* seedObservedProviderTransfer({
          providerAssetRowId: pendingState.providerAssetRowId,
          observedDecimals: 6,
          activeJob: false,
        })
      })
    )

    const laterCompatibleResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [5],
        })
      ),
      () => Effect.succeed([])
    )
    const state = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))

    expect(laterCompatibleResult).toMatchObject({
      kind: "review_required",
      mappingStatus: "pending_review",
      canonicalAssetId: null,
      assetRepresentationId: null,
    })
    expect(state).toMatchObject({ mappingStatus: "pending_review" })
  })

  it("resolves a pending NFT after a DAS-miss type guess was stored as unknown", async () => {
    const firstResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [0],
        })
      ),
      () => Effect.succeed([])
    )
    expect(firstResult).toMatchObject({
      kind: "review_required",
      mappingStatus: "pending_review",
      representationTypeObserved: false,
    })

    const pendingState = await context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
    if (pendingState === null) {
      expect.fail("Expected pending NFT provider asset state")
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
          name: "Known private NFT",
          symbol: "PRIVATE-NFT",
          type: "nft",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: UNKNOWN_REPRESENTATION_ID,
          assetId: UNKNOWN_ASSET_ID,
          blockchainId: solanaBlockchain.id,
          type: "nft",
          contractAddress: null,
          mintAddress: UNKNOWN_MINT,
          decimals: 0,
        })
        yield* seedObservedProviderTransfer({
          providerAssetRowId: pendingState.providerAssetRowId,
          observedDecimals: 0,
          observedRepresentationType: null,
          activeJob: true,
        })
      })
    )

    const resolved = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
          observedDecimals: [0],
        })
      ),
      () => Effect.succeed([])
    )
    const replayJob = await context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .select({ followUpMode: schema.processingJobs.followUpMode })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.sourceId, REPLAY_SOURCE_ID))
          .limit(1)
        return job ?? null
      })
    )

    expect(resolved).toMatchObject({
      kind: "canonical",
      assetKind: "nft",
      mappingStatus: "approved",
      canonicalAssetId: UNKNOWN_ASSET_ID,
      assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
    })
    expect(replayJob).toEqual({ followUpMode: "replay" })
  })

  it.each([
    { representationType: "token" as const, representationDecimals: 6 },
    { representationType: "nft" as const, representationDecimals: 5 },
  ])(
    "keeps an exact mint pending when its $representationType representation metadata conflicts",
    async ({ representationType, representationDecimals }) => {
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
            name: "Conflicting private asset",
            symbol: "PRIVATE",
            type: representationType === "nft" ? "nft" : "fungible",
          })
          yield* db.insert(schema.assetRepresentations).values({
            id: UNKNOWN_REPRESENTATION_ID,
            assetId: UNKNOWN_ASSET_ID,
            blockchainId: solanaBlockchain.id,
            type: representationType,
            contractAddress: null,
            mintAddress: UNKNOWN_MINT,
            decimals: representationDecimals,
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
              name: "Conflicting private asset",
              decimals: 5,
              tokenProgram: TOKEN_2022_PROGRAM,
            }),
          ])
      )

      expect(result).toMatchObject({
        kind: "review_required",
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
    }
  )

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

    await context.runPg(
      Effect.flatMap(drizzle, (db) =>
        db
          .update(schema.providerAssets)
          .set({ exponent: 5 })
          .where(eq(schema.providerAssets.id, providerAssetState.providerAssetRowId))
      )
    )

    const changedDecimalsResult = await runAssetService(
      Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
        service.resolveAsset({
          kind: "spl",
          mintAddress: UNKNOWN_MINT,
        })
      ).pipe(Effect.either),
      () => Effect.dieMessage("DAS should not be called when approved mapping is cached")
    )

    expect(changedDecimalsResult).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "HeliusSolanaBrokenApprovedProviderAssetMappingError",
      },
    })
  })
})
