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
  validateManualRepresentationIdentity,
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

  it("keeps an exact EVM representation when durable movement evidence supplies the chain", () => {
    const representationId = "00000000-0000-4000-8000-000000000002"

    expect(
      representationIdForProviderObservation({
        providerAsset: makeProviderAsset(),
        representationId,
        observedRepresentations: [
          {
            blockchainName: "ethereum",
            representationType: "token",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            mintAddress: null,
            decimals: 6,
          },
        ],
      })
    ).toBe(representationId)
  })

  it("validates an EVM representation against durable contract and decimals evidence", () => {
    const result = Effect.runSync(
      validateManualRepresentationIdentity({
        providerAsset: makeProviderAsset(),
        representation: {
          id: "00000000-0000-4000-8000-000000000002",
          assetId: "00000000-0000-4000-8000-000000000003",
          symbol: "USDC",
          blockchainName: "ethereum",
          representationType: "token",
          contractAddress: "0xa0B86991c6218b36c1d19d4a2e9eb0cE3606eB48",
          mintAddress: null,
          decimals: 6,
        },
        observedRepresentations: [
          {
            blockchainName: "ethereum",
            representationType: "token",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            mintAddress: null,
            decimals: 6,
          },
        ],
      }).pipe(Effect.either)
    )

    expect(result._tag).toBe("Right")
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

  it("supports repeated and corrected approval for an observed Solana token", async () => {
    const providerAssetRowId = "00000000-0000-4000-8000-000000000003"
    const canonicalAssetId = "00000000-0000-4000-8000-000000000004"
    const alternateCanonicalAssetId = "00000000-0000-4000-8000-00000000000c"
    const representationId = "00000000-0000-4000-8000-000000000005"
    const alternateRepresentationId = "00000000-0000-4000-8000-00000000000d"
    const mismatchedRepresentationId = "00000000-0000-4000-8000-00000000000a"
    const mismatchedDecimalsRepresentationId = "00000000-0000-4000-8000-00000000000b"
    const blockchainId = "00000000-0000-4000-8000-000000000006"
    const principalId = "00000000-0000-4000-8000-000000000007"
    const sourceId = "00000000-0000-4000-8000-000000000008"
    const secondSourceId = "00000000-0000-4000-8000-00000000000e"
    const mintAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const events: Array<string> = []
    const sourceNotes: Array<string | null> = []
    const replayRequests: Array<boolean | undefined> = []
    const providerSnapshotDates: Array<Date | undefined> = []
    let mappingApproved = false
    let approvedCanonicalAssetId = canonicalAssetId
    let approvedRepresentationId = representationId
    let replayAttempts = 0
    let coinGeckoDecimals = 6
    let includeAdditionalCoinGeckoPlatform = false
    let observedRepresentationsAvailable = true
    let providerAsset: ProviderAssetRecord = makeProviderAsset({
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
          const [mapping] = mappings
          if (mapping !== undefined) {
            approvedCanonicalAssetId = mapping.canonicalAssetId ?? canonicalAssetId
            approvedRepresentationId = mapping.assetRepresentationId ?? representationId
          }
          mappingApproved = true
          events.push("approve")
          sourceNotes.push(mappings[0]?.sourceNotes ?? null)
          replayRequests.push(mappings[0]?.requestReplayOnApproval)
          providerSnapshotDates.push(mappings[0]?.expectedProviderAssetRetrievedAt)
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
              canonicalAssetId: mappingApproved ? approvedCanonicalAssetId : null,
              assetRepresentationId: mappingApproved ? approvedRepresentationId : null,
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
          return replayAttempts === 0
            ? [
                { principalId, sourceId },
                { principalId, sourceId: secondSourceId },
              ]
            : [{ principalId, sourceId }]
        }),
      listProviderAssetObservedRepresentations: () =>
        Effect.succeed(
          observedRepresentationsAvailable
            ? [
                {
                  blockchainName: "solana",
                  representationType: "token" as const,
                  contractAddress: null,
                  mintAddress,
                  decimals: 6,
                },
              ]
            : []
        ),
      findProviderAssetMapping: () =>
        Effect.dieMessage("findProviderAssetMapping should not be called"),
    }
    const layer = AssetCanonicalizationServiceLive.pipe(
      Layer.provide(Layer.succeed(ProviderAssetRepository, providerAssetRepository)),
      Layer.provide(
        Layer.succeed(AssetRepository, {
          findAssetById: ({ assetId }) =>
            Effect.succeed(
              assetId === canonicalAssetId || assetId === alternateCanonicalAssetId
                ? Option.some({ id: assetId, symbol: "USDC" })
                : Option.none()
            ),
          findAssetByCoinGeckoId: () =>
            Effect.dieMessage("findAssetByCoinGeckoId should not be called"),
          findRepresentationById: ({ assetRepresentationId }) =>
            Effect.succeed(
              assetRepresentationId === representationId
                ? Option.some({
                    id: representationId,
                    assetId: canonicalAssetId,
                    symbol: "USDC",
                    blockchainName: "solana",
                    representationType: "token" as const,
                    contractAddress: null,
                    mintAddress,
                    decimals: 6,
                  })
                : assetRepresentationId === alternateRepresentationId
                  ? Option.some({
                      id: alternateRepresentationId,
                      assetId: alternateCanonicalAssetId,
                      symbol: "USDC",
                      blockchainName: "solana",
                      representationType: "token" as const,
                      contractAddress: null,
                      mintAddress,
                      decimals: 6,
                    })
                  : assetRepresentationId === mismatchedRepresentationId
                    ? Option.some({
                        id: mismatchedRepresentationId,
                        assetId: canonicalAssetId,
                        symbol: "USDC",
                        blockchainName: "ethereum",
                        representationType: "token" as const,
                        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                        mintAddress: null,
                        decimals: 6,
                      })
                    : assetRepresentationId === mismatchedDecimalsRepresentationId
                      ? Option.some({
                          id: mismatchedDecimalsRepresentationId,
                          assetId: canonicalAssetId,
                          symbol: "USDC",
                          blockchainName: "solana",
                          representationType: "token" as const,
                          contractAddress: null,
                          mintAddress,
                          decimals: 9,
                        })
                      : Option.none()
            ),
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
              platforms: includeAdditionalCoinGeckoPlatform
                ? {
                    solana: mintAddress,
                    ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  }
                : { solana: mintAddress },
              detail_platforms: {
                solana: { contract_address: mintAddress, decimal_place: coinGeckoDecimals },
                ethereum: {
                  contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  decimal_place: 6,
                },
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

    expect(firstResult._tag).toBe("Right")
    expect(mappingApproved).toBe(true)
    expect(sourceNotes).toEqual([
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
    ])
    expect(events).toEqual(["approve"])
    expect(replayRequests).toEqual([true])
    expect(providerSnapshotDates).toEqual([providerAsset.retrievedAt])

    const result = await Effect.runPromise(canonicalize().pipe(Effect.provide(layer)))

    expect(result.providerAsset.mapping?.mappingStatus).toBe("approved")
    expect(sourceNotes).toEqual([
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
      "transfer_reconciliation_evidence: observed Solana mint\nApproved with CoinGecko asset/platform metadata.",
    ])
    expect(events).toEqual(["approve", "approve"])
    expect(replayRequests).toEqual([true, true])
    expect(providerSnapshotDates).toEqual([providerAsset.retrievedAt, providerAsset.retrievedAt])

    const approvedRemap = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId: alternateCanonicalAssetId,
          assetRepresentationId: alternateRepresentationId,
          reviewerNotes: "Change approved target",
        })
      ).pipe(Effect.provide(layer))
    )

    expect(approvedRemap.mapping).toMatchObject({
      canonicalAssetId: alternateCanonicalAssetId,
      assetRepresentationId: alternateRepresentationId,
      mappingStatus: "approved",
    })
    expect(events.slice(-1)).toEqual(["approve"])
    expect(replayRequests.at(-1)).toBe(true)
    expect(providerSnapshotDates.at(-1)).toEqual(providerAsset.retrievedAt)

    const eventsBeforeMismatch = [...events]
    const mismatchedApproval = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId,
          assetRepresentationId: mismatchedRepresentationId,
          reviewerNotes: "Wrong chain",
        })
      ).pipe(Effect.either, Effect.provide(layer))
    )

    expect(mismatchedApproval._tag).toBe("Left")
    if (mismatchedApproval._tag === "Left") {
      expect(mismatchedApproval.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Selected representation does not match the observed Solana mint.",
      })
    }
    expect(events).toEqual(eventsBeforeMismatch)

    const mismatchedDecimalsApproval = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId,
          assetRepresentationId: mismatchedDecimalsRepresentationId,
          reviewerNotes: "Wrong decimals",
        })
      ).pipe(Effect.either, Effect.provide(layer))
    )

    expect(mismatchedDecimalsApproval._tag).toBe("Left")
    if (mismatchedDecimalsApproval._tag === "Left") {
      expect(mismatchedDecimalsApproval.left).toMatchObject({
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Selected representation does not match the observed Solana mint.",
      })
    }
    expect(events).toEqual(eventsBeforeMismatch)

    mappingApproved = false
    observedRepresentationsAvailable = false
    const approvalDuringReplay = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId,
          assetRepresentationId: representationId,
          reviewerNotes: "Approve during replay",
        })
      ).pipe(Effect.either, Effect.provide(layer))
    )

    expect(approvalDuringReplay).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "AssetCanonicalizationBadRequestError",
        message:
          "Observed on-chain identity is temporarily unavailable; finish source replay before approval.",
      },
    })
    expect(events).toEqual(eventsBeforeMismatch)
    observedRepresentationsAvailable = true

    const manuallyApproved = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId,
          assetRepresentationId: representationId,
          reviewerNotes: "Approved private mint",
        })
      ).pipe(Effect.provide(layer))
    )

    expect(manuallyApproved.mapping).toMatchObject({
      canonicalAssetId,
      assetRepresentationId: representationId,
      mappingStatus: "approved",
    })
    expect(sourceNotes.at(-1)).toBe(
      "transfer_reconciliation_evidence: observed Solana mint\nApproved by an admin with an existing canonical asset."
    )
    expect(replayRequests.at(-1)).toBe(true)
    expect(providerSnapshotDates.at(-1)).toEqual(providerAsset.retrievedAt)

    const eventsBeforeCoinGeckoMismatch = [...events]
    coinGeckoDecimals = 9
    const mismatchedCoinGeckoApproval = await Effect.runPromise(
      canonicalize().pipe(Effect.either, Effect.provide(layer))
    )

    expect(mismatchedCoinGeckoApproval).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "AssetCanonicalizationBadRequestError",
        message: "CoinGecko representation does not match observed on-chain movement evidence.",
      },
    })
    expect(events).toEqual(eventsBeforeCoinGeckoMismatch)
    coinGeckoDecimals = 6

    mappingApproved = false
    includeAdditionalCoinGeckoPlatform = true
    const observedPlatformApproval = await Effect.runPromise(
      canonicalize().pipe(Effect.provide(layer))
    )

    expect(observedPlatformApproval.canonicalAsset).toMatchObject({
      blockchainName: "solana",
      mintAddress,
      representationType: "token",
    })
    includeAdditionalCoinGeckoPlatform = false

    const eventsBeforeChainlessApproval = [...events]
    providerAsset = makeProviderAsset({ id: providerAssetRowId })
    observedRepresentationsAvailable = false
    const chainlessApproval = await Effect.runPromise(
      Effect.flatMap(AssetCanonicalizationService, (service) =>
        service.approveProviderAssetMapping({
          providerAssetRowId,
          canonicalAssetId,
          assetRepresentationId: representationId,
          reviewerNotes: "No observed chain",
        })
      ).pipe(Effect.either, Effect.provide(layer))
    )

    expect(chainlessApproval).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "AssetCanonicalizationBadRequestError",
        message: "Provider assets without an observed chain cannot select a representation.",
      },
    })
    expect(events).toEqual(eventsBeforeChainlessApproval)
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
