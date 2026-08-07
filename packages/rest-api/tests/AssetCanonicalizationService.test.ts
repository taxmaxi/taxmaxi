import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetCanonicalizationServiceLive,
  deriveChainType,
  deriveNativeAssetDecimals,
  representationIdForProviderObservation,
  selectNativePlatform,
  validateNativeProviderIdentity,
} from "../src/layers/AssetCanonicalizationServiceLive.ts"
import {
  AssetRepository,
  ProviderAssetRepository,
  SourceSyncService,
  SourceSyncQueueError,
  type ProviderAssetRecord,
  type ProviderAssetRepositoryShape,
} from "@my/sync-engine/services"
import { AssetCanonicalizationService } from "../src/services/AssetCanonicalizationService.ts"
import { CoinGeckoClient } from "../src/services/coingecko/CoinGeckoClient.ts"
import { coinGeckoAssetPlatformSnapshot } from "../src/services/coingecko/CoinGeckoAssetPlatformSnapshot.ts"

describe("AssetCanonicalizationService", () => {
  const makeProviderAsset = (
    overrides: Partial<ProviderAssetRecord> = {}
  ): ProviderAssetRecord => ({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "coinbase",
    providerAssetId: "coinbase-usdc",
    naturalKey: null,
    currencyCode: "USDC",
    name: "USD Coin",
    exponent: 6,
    providerType: "crypto",
    rawProviderPayload: {},
    discoveredAt: new Date("2025-01-01T00:00:00.000Z"),
    retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  })

  it("keeps chainless provider mappings at the economic asset level", () => {
    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset(),
        representationId: "00000000-0000-4000-8000-000000000002",
      })
    ).toBeNull()
  })

  it("keeps an exact representation for an observed Solana mint", () => {
    const representationId = "00000000-0000-4000-8000-000000000002"

    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: "Mint111111111111111111111111111111111111111",
          naturalKey: "solana:mint:Mint111111111111111111111111111111111111111",
          providerType: "spl-token",
        }),
        representationId,
      })
    ).toBe(representationId)
  })

  it("keeps the native representation for an observed Solana native asset", () => {
    const representationId = "00000000-0000-4000-8000-000000000002"

    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: null,
          naturalKey: "solana:native:SOL",
          providerType: "native",
        }),
        representationId,
      })
    ).toBe(representationId)
  })

  it("surfaces replay failures and allows retrying an approved provider asset", async () => {
    const providerAssetRowId = "00000000-0000-4000-8000-000000000003"
    const canonicalAssetId = "00000000-0000-4000-8000-000000000004"
    const representationId = "00000000-0000-4000-8000-000000000005"
    const blockchainId = "00000000-0000-4000-8000-000000000006"
    const principalId = "00000000-0000-4000-8000-000000000007"
    const sourceId = "00000000-0000-4000-8000-000000000008"
    const mintAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const events: Array<string> = []
    const sourceNotes: Array<string | null> = []
    let mappingApproved = false
    let replayAttempts = 0
    const providerAsset = makeProviderAsset({
      id: providerAssetRowId,
      provider: "helius-solana",
      providerAssetId: mintAddress,
      naturalKey: `solana:mint:${mintAddress}`,
      currencyCode: "USDC",
      name: "USD Coin",
      exponent: null,
      providerType: "spl-token",
    })
    const providerAssetRepository: ProviderAssetRepositoryShape = {
      upsertProviderAssets: () => Effect.dieMessage("upsertProviderAssets should not be called"),
      upsertProviderAssetMappings: ({ mappings }) =>
        Effect.sync(() => {
          mappingApproved = true
          events.push("approve")
          sourceNotes.push(mappings[0]?.sourceNotes ?? null)
          return 1
        }),
      seedProviderAssetMappingsIfMissing: () =>
        Effect.dieMessage("seedProviderAssetMappingsIfMissing should not be called"),
      findProviderAssetByProviderAssetId: () =>
        Effect.dieMessage("findProviderAssetByProviderAssetId should not be called"),
      findProviderAssetByNaturalKey: () =>
        Effect.dieMessage("findProviderAssetByNaturalKey should not be called"),
      findProviderAssetByCurrencyCode: () =>
        Effect.dieMessage("findProviderAssetByCurrencyCode should not be called"),
      findProviderAssetReviewById: () =>
        Effect.succeed(
          Option.some({
            providerAsset,
            mapping: {
              providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: mappingApproved ? canonicalAssetId : null,
              assetRepresentationId: mappingApproved ? representationId : null,
              canonicalFiatCurrency: null,
              mappingStatus: mappingApproved ? "approved" : "pending_review",
              reviewerNotes: null,
              sourceNotes: "transfer_reconciliation_evidence: observed Solana mint",
            },
          })
        ),
      listProviderAssetReviews: () =>
        Effect.dieMessage("listProviderAssetReviews should not be called"),
      listProviderAssetSources: () =>
        Effect.sync(() => {
          events.push("list-sources")
          return [{ principalId, sourceId }]
        }),
      findProviderAssetMapping: () =>
        Effect.dieMessage("findProviderAssetMapping should not be called"),
    }
    const layer = AssetCanonicalizationServiceLive.pipe(
      Layer.provide(Layer.succeed(ProviderAssetRepository, providerAssetRepository)),
      Layer.provide(
        Layer.succeed(AssetRepository, {
          findAssetById: () => Effect.dieMessage("findAssetById should not be called"),
          findAssetByCoinGeckoId: () =>
            Effect.dieMessage("findAssetByCoinGeckoId should not be called"),
          findRepresentationById: () =>
            Effect.dieMessage("findRepresentationById should not be called"),
          findNativeRepresentationForBlockchain: () =>
            Effect.dieMessage("findNativeRepresentationForBlockchain should not be called"),
          findRepresentationByBlockchainAndAddress: () =>
            Effect.dieMessage("findRepresentationByBlockchainAndAddress should not be called"),
          listBlockchains: () => Effect.dieMessage("listBlockchains should not be called"),
          upsertEconomicAssetRepresentation: () =>
            Effect.succeed({
              id: canonicalAssetId,
              name: "USD Coin",
              symbol: "USDC",
              type: "fungible",
              representationId,
              blockchainId,
              blockchainName: "solana",
              decimals: 6,
              contractAddress: null,
              mintAddress,
              representationType: "token",
            }),
        })
      ),
      Layer.provide(
        Layer.succeed(CoinGeckoClient, {
          searchCoins: () => Effect.succeed([{ id: "usd-coin", name: "USD Coin", symbol: "USDC" }]),
          getCoin: () =>
            Effect.succeed({
              id: "usd-coin",
              name: "USD Coin",
              symbol: "usdc",
              asset_platform_id: "solana",
              platforms: { solana: mintAddress },
              detail_platforms: {
                solana: { contract_address: mintAddress, decimal_place: 6 },
              },
            }),
          listMarkets: () => Effect.dieMessage("listMarkets should not be called"),
        })
      ),
      Layer.provide(
        Layer.succeed(SourceSyncService, {
          startSourceSyncJob: () => Effect.dieMessage("startSourceSyncJob should not be called"),
          replaySourceSyncJob: ({ principalId: replayPrincipalId, sourceId: replaySourceId }) =>
            Effect.gen(function* () {
              replayAttempts += 1
              events.push(`replay:${replayPrincipalId}:${replaySourceId}`)

              if (replayAttempts === 1) {
                return yield* Effect.fail(
                  new SourceSyncQueueError({
                    operation: "enqueueSourceSyncJob",
                    cause: "queue unavailable",
                  })
                )
              }

              return {
                sourceId: replaySourceId,
                jobId: "00000000-0000-4000-8000-000000000009",
                status: "queued" as const,
                message: null,
              }
            }),
          getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
        })
      )
    )

    const canonicalize = () =>
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.canonicalizeProviderAssetFromCoinGecko({
          providerAssetRowId,
          reviewerNotes: "Reviewed",
        })
      )

    const firstResult = await Effect.runPromise(
      canonicalize().pipe(Effect.either, Effect.provide(layer))
    )

    expect(firstResult._tag).toBe("Left")
    if (firstResult._tag === "Left") {
      expect(firstResult.left._tag).toBe("AssetCanonicalizationInternalError")
    }
    expect(mappingApproved).toBe(true)
    expect(sourceNotes).toEqual([
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
    ])
    expect(events).toEqual(["approve", "list-sources", `replay:${principalId}:${sourceId}`])

    const result = await Effect.runPromise(canonicalize().pipe(Effect.provide(layer)))

    expect(result.providerAsset.mapping?.mappingStatus).toBe("approved")
    expect(sourceNotes).toEqual([
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
    ])
    expect(events).toEqual([
      "approve",
      "list-sources",
      `replay:${principalId}:${sourceId}`,
      "approve",
      "list-sources",
      `replay:${principalId}:${sourceId}`,
    ])
  })

  it("rejects a native asset resolution for an observed Solana token", () => {
    const result = Effect.runSync(
      validateNativeProviderIdentity(
        makeProviderAsset({
          provider: "helius-solana",
          providerAssetId: "Mint111111111111111111111111111111111111111",
          naturalKey: "solana:mint:Mint111111111111111111111111111111111111111",
          currencyCode: "SOL",
          name: "Solana",
          providerType: "spl-token",
        })
      ).pipe(Effect.either)
    )

    expect(result._tag).toBe("Left")
  })

  it("includes Cardano native platform metadata from CoinGecko", () => {
    const cardanoPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "cardano"
    )

    expect(cardanoPlatform).toMatchObject({
      id: "cardano",
      name: "Cardano",
      native_coin_id: "cardano",
      chain_identifier: null,
    })
  })

  it("derives native chain decimals without using provider display precision", () => {
    const ethereumPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "ethereum"
    )
    const cardanoPlatform = coinGeckoAssetPlatformSnapshot.find(
      (platform) => platform.id === "cardano"
    )

    expect(ethereumPlatform).toBeDefined()
    expect(cardanoPlatform).toBeDefined()

    if (ethereumPlatform !== undefined && cardanoPlatform !== undefined) {
      expect(
        deriveNativeAssetDecimals({
          coinId: "ethereum",
          platform: ethereumPlatform,
        })
      ).toBe(18)
      expect(
        deriveNativeAssetDecimals({
          coinId: "cardano",
          platform: cardanoPlatform,
        })
      ).toBe(6)
    }
  })

  it("selects native Bitcoin without treating related platforms as ambiguity", () => {
    const bitcoinPlatform = selectNativePlatform({
      coinId: "bitcoin",
      assetPlatforms: coinGeckoAssetPlatformSnapshot,
    })

    expect(bitcoinPlatform).toMatchObject({
      id: "bitcoin",
      name: "Bitcoin",
      native_coin_id: "bitcoin",
      chain_identifier: null,
    })
  })

  it("does not select a single related native platform for token coins", () => {
    expect(
      selectNativePlatform({
        coinId: "usd-coin",
        assetPlatforms: [
          {
            id: "hyperliquid",
            name: "Hyperliquid",
            chain_identifier: null,
            shortname: "HYPE",
            native_coin_id: "usd-coin",
          },
        ],
      })
    ).toBeNull()
  })

  it("uses explicit chain identifiers before platform name heuristics", () => {
    expect(
      deriveChainType({
        id: "bitlayer",
        name: "Bitlayer",
        chain_identifier: 200901,
        shortname: null,
        native_coin_id: "bitcoin",
      })
    ).toBe("evm")
  })
})
