import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HeliusSolanaSourceSyncProviderFromClientLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { ActivityClassificationServiceLive } from "../../src/layers/ActivityClassificationServiceLive.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HeliusSolanaSourceSyncProvider,
} from "../../src/providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAssetResolutionService,
  type HeliusSolanaResolvedAsset,
} from "../../src/providers/helius-solana/services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type FetchHeliusSolanaTransactionsForAddressParams,
  type HeliusSolanaSyncClientShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"
import {
  ActivityClassificationService,
  ActivityFacts,
} from "../../src/services/ActivityClassificationService.ts"
import { AssetRepository } from "../../src/services/AssetRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"
import { FetchProviderRawBatchParams } from "../../src/shared/SourceProviderRawBatch.ts"

const WALLET_ADDRESS = "So11111111111111111111111111111111111111112"
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

const makeFetchParams = ({
  providerKey = HELIUS_SOLANA_PROVIDER_KEY,
  walletAddress = WALLET_ADDRESS,
  cursorPayload = null,
  resumeHighWatermark = null,
  resumeCheckpointExternalId = null,
  pageSize = 2,
}: {
  readonly providerKey?: string
  readonly walletAddress?: string | null
  readonly cursorPayload?: unknown
  readonly resumeHighWatermark?: Date | null
  readonly resumeCheckpointExternalId?: string | null
  readonly pageSize?: number
} = {}) =>
  FetchProviderRawBatchParams.make({
    providerKey,
    sourceId: "source-solana-1",
    walletAddress,
    cursorPayload,
    resumeHighWatermark,
    resumeCheckpointExternalId,
    pageSize,
  })

const makeHeliusTransaction = ({
  signature,
  blockTime,
  meta,
}: {
  readonly signature: string
  readonly blockTime: number | null
  readonly meta: unknown
}) => ({
  slot: 1,
  transactionIndex: 0,
  transaction: {
    signatures: [signature],
    message: {
      accountKeys: [WALLET_ADDRESS],
    },
  },
  meta,
  blockTime,
})

const makeSource = (): SourceSyncSource => ({
  id: "source-solana-1",
  principalId: "principal-solana-1",
  providerKey: HELIUS_SOLANA_PROVIDER_KEY,
  cexAccountId: null,
  addressId: "address-solana-1",
  walletAddress: WALLET_ADDRESS,
})

const makeRawRecord = ({ payload }: { readonly payload: unknown }): SourceRawRecord => ({
  id: "raw-solana-1",
  sourceId: "source-solana-1",
  provider: HELIUS_SOLANA_PROVIDER_KEY,
  recordType: "solana_transaction_full",
  externalAccountId: WALLET_ADDRESS,
  externalRecordId: "signature-normalized",
  externalParentId: null,
  occurredAt: new Date("2025-01-01T00:00:00.000Z"),
  payload,
  importedAt: new Date("2025-01-01T00:00:00.000Z"),
  normalizedAt: null,
  normalizationError: null,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-01T00:00:00.000Z"),
})

const makeProviderLayer = ({
  fetchTransactionsForAddress,
  fetchTransfersForAddress = () =>
    Effect.succeed({
      data: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
      },
    }),
}: {
  readonly fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"]
  readonly fetchTransfersForAddress?: HeliusSolanaSyncClientShape["fetchTransfersForAddress"]
}) =>
  HeliusSolanaSourceSyncProviderFromClientLive.pipe(
    Layer.provide(
      Layer.succeed(
        AssetRepository,
        AssetRepository.of({
          findAssetById: () => Effect.succeed(Option.none()),
          findAssetBySymbol: () => Effect.succeed(Option.none()),
          findNativeAssetForBlockchain: () => Effect.succeed(Option.none()),
          findAssetByBlockchainAndContractAddress: () => Effect.succeed(Option.none()),
          listBlockchains: () => Effect.succeed([{ id: "solana-blockchain-id", name: "solana" }]),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaAssetResolutionService,
        HeliusSolanaAssetResolutionService.of({
          ensureDefaultMappings: () =>
            Effect.succeed({
              providerAssetCatalogCount: 0,
              defaultProviderAssetMappingCount: 0,
            }),
          resolveAsset: () =>
            Effect.succeed({
              kind: "canonical",
              assetKind: "native",
              mintAddress: null,
              providerAssetRowId: "provider-asset-sol",
              providerAssetId: null,
              naturalKey: "native:SOL",
              currencyCode: "SOL",
              name: "Solana",
              decimals: 9,
              tokenProgram: null,
              nftHint: false,
              mappingStatus: "approved",
              mappingKind: "asset",
              canonicalAssetId: "asset-sol",
              canonicalAssetSymbol: "SOL",
              canonicalFiatCurrency: null,
            } satisfies HeliusSolanaResolvedAsset),
          resolveAssets: ({ assets }) =>
            Effect.succeed(
              assets.flatMap((asset) =>
                asset.mintAddress === null
                  ? []
                  : asset.mintAddress === WRAPPED_SOL_MINT
                    ? [
                        {
                          kind: "canonical",
                          assetKind: "native",
                          mintAddress: null,
                          providerAssetRowId: "provider-asset-sol",
                          providerAssetId: null,
                          naturalKey: "native:SOL",
                          currencyCode: "SOL",
                          name: "Solana",
                          decimals: 9,
                          tokenProgram: null,
                          nftHint: false,
                          mappingStatus: "approved",
                          mappingKind: "asset",
                          canonicalAssetId: "asset-sol",
                          canonicalAssetSymbol: "SOL",
                          canonicalFiatCurrency: null,
                        } satisfies HeliusSolanaResolvedAsset,
                      ]
                    : [
                        {
                          kind: "canonical",
                          assetKind: "token",
                          mintAddress: asset.mintAddress,
                          providerAssetRowId: `provider-asset-${asset.mintAddress}`,
                          providerAssetId: asset.mintAddress,
                          naturalKey: `spl:${asset.mintAddress}`,
                          currencyCode: "USDC",
                          name: "USD Coin",
                          decimals: 6,
                          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                          nftHint: false,
                          mappingStatus: "approved",
                          mappingKind: "asset",
                          canonicalAssetId: "asset-usdc",
                          canonicalAssetSymbol: "USDC",
                          canonicalFiatCurrency: null,
                        } satisfies HeliusSolanaResolvedAsset,
                      ]
              )
            ),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaSyncClient,
        HeliusSolanaSyncClient.of({
          fetchTransactionsForAddress,
          fetchAssetBatch: () => Effect.dieMessage("fetchAssetBatch should not be called"),
          fetchTransfersForAddress,
        })
      )
    )
  )

const runProvider = <A, E>(
  effect: Effect.Effect<A, E, HeliusSolanaSourceSyncProvider>,
  fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"],
  fetchTransfersForAddress?: HeliusSolanaSyncClientShape["fetchTransfersForAddress"]
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        fetchTransfersForAddress === undefined
          ? makeProviderLayer({ fetchTransactionsForAddress })
          : makeProviderLayer({ fetchTransactionsForAddress, fetchTransfersForAddress })
      )
    )
  )

describe("HeliusSolanaSourceSyncProviderLive", () => {
  it("imports paginated full Solana transactions including failed transactions", async () => {
    const calls: Array<FetchHeliusSolanaTransactionsForAddressParams> = []
    const responses: Array<unknown> = [
      {
        data: [
          makeHeliusTransaction({
            signature: "signature-1",
            blockTime: 1_735_689_600,
            meta: { err: null },
          }),
          makeHeliusTransaction({
            signature: "signature-failed",
            blockTime: 1_735_689_660,
            meta: { err: { InstructionError: [1, "Custom"] } },
          }),
        ],
        paginationToken: "next-page",
      },
      {
        data: [
          makeHeliusTransaction({
            signature: "signature-3",
            blockTime: 1_735_689_720,
            meta: { err: null },
          }),
        ],
        paginationToken: null,
      },
    ]

    const fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"] =
      (params) =>
        Effect.gen(function* () {
          calls.push(params)
          const response = responses.shift()

          if (response === undefined) {
            return yield* Effect.dieMessage("Unexpected Helius request")
          }

          return response
        })

    const firstPage = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams())
      ),
      fetchTransactionsForAddress
    )
    const secondPage = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(
          makeFetchParams({
            cursorPayload: firstPage.cursorPayload,
          })
        )
      ),
      fetchTransactionsForAddress
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      walletAddress: WALLET_ADDRESS,
      config: {
        limit: 2,
        paginationToken: null,
        transactionDetails: "full",
        sortOrder: "desc",
        filters: {
          status: "any",
          tokenAccounts: "balanceChanged",
        },
      },
    })
    expect(calls[1]).toMatchObject({
      config: {
        paginationToken: "next-page",
      },
    })

    expect(firstPage.records.map((record) => record.externalRecordId)).toEqual([
      "signature-1",
      "signature-failed",
    ])
    expect(
      firstPage.records.every((record) => record.recordType === "solana_transaction_full")
    ).toBe(true)
    expect(firstPage.records.every((record) => record.externalAccountId === WALLET_ADDRESS)).toBe(
      true
    )
    expect(firstPage.records[1]?.payload).toMatchObject({
      meta: { err: { InstructionError: [1, "Custom"] } },
    })
    expect(firstPage.cursorPayload).toEqual({ paginationToken: "next-page" })
    expect(firstPage.done).toBe(false)
    expect(firstPage.highWatermark?.toISOString()).toBe("2025-01-01T00:01:00.000Z")

    expect(secondPage.records.map((record) => record.externalRecordId)).toEqual(["signature-3"])
    expect(secondPage.cursorPayload).toEqual({ paginationToken: null })
    expect(secondPage.done).toBe(true)
  })

  it("continues incremental scans only until the persisted resume boundary", async () => {
    const calls: Array<FetchHeliusSolanaTransactionsForAddressParams> = []
    const resumeHighWatermark = new Date("2025-01-01T00:00:00.000Z")
    const responses: Array<unknown> = [
      {
        data: [
          makeHeliusTransaction({
            signature: "signature-newer-1",
            blockTime: 1_735_689_900,
            meta: { err: null },
          }),
          makeHeliusTransaction({
            signature: "signature-newer-2",
            blockTime: 1_735_689_840,
            meta: { err: null },
          }),
        ],
        paginationToken: "resume-page-2",
      },
      {
        data: [
          makeHeliusTransaction({
            signature: "signature-newer-3",
            blockTime: 1_735_689_780,
            meta: { err: null },
          }),
          makeHeliusTransaction({
            signature: "signature-checkpoint",
            blockTime: 1_735_689_600,
            meta: { err: null },
          }),
          makeHeliusTransaction({
            signature: "signature-older",
            blockTime: 1_735_689_540,
            meta: { err: null },
          }),
        ],
        paginationToken: "should-not-be-used",
      },
    ]

    const fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"] =
      (params) =>
        Effect.gen(function* () {
          calls.push(params)
          const response = responses.shift()

          if (response === undefined) {
            return yield* Effect.dieMessage("Unexpected Helius request")
          }

          return response
        })

    const firstPage = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(
          makeFetchParams({
            resumeHighWatermark,
            resumeCheckpointExternalId: "signature-checkpoint",
          })
        )
      ),
      fetchTransactionsForAddress
    )
    const secondPage = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(
          makeFetchParams({
            cursorPayload: firstPage.cursorPayload,
            resumeHighWatermark: firstPage.highWatermark,
            resumeCheckpointExternalId: "signature-checkpoint",
          })
        )
      ),
      fetchTransactionsForAddress
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.config.paginationToken).toBeNull()
    expect(calls[1]?.config.paginationToken).toBe("resume-page-2")
    expect(firstPage.records.map((record) => record.externalRecordId)).toEqual([
      "signature-newer-1",
      "signature-newer-2",
    ])
    expect(firstPage.cursorPayload).toEqual({
      paginationToken: "resume-page-2",
      resumeBoundaryActive: true,
      resumeCheckpointExternalId: "signature-checkpoint",
      resumeHighWatermarkIso: "2025-01-01T00:00:00.000Z",
    })
    expect(firstPage.done).toBe(false)
    expect(secondPage.records.map((record) => record.externalRecordId)).toEqual([
      "signature-newer-3",
    ])
    expect(secondPage.cursorPayload).toEqual({ paginationToken: null })
    expect(secondPage.done).toBe(true)
  })

  it("rejects malformed persisted cursor payloads", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(
          makeFetchParams({
            cursorPayload: { paginationToken: 42 },
          })
        )
      ).pipe(Effect.either),
      () => Effect.dieMessage("Helius client should not be called for malformed cursors")
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncCursorDecodeError",
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      })
      expect(result.left.message).toContain("Invalid persisted Helius Solana cursor payload")
    }
  })

  it("fails non-retryably when a Solana source has no wallet address", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams({ walletAddress: null }))
      ).pipe(Effect.either),
      () => Effect.dieMessage("Helius client should not be called without a wallet address")
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        retryable: false,
      })
      expect(result.left.message).toContain("has no wallet address")
    }
  })

  it("keeps unsupported provider-key behavior", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams({ providerKey: "coinbase" }))
      ).pipe(Effect.either),
      () => Effect.dieMessage("Helius client should not be called for unsupported providers")
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "UnsupportedSyncProviderError",
        providerKey: "coinbase",
      })
    }
  })

  it("maps auth failures to non-retryable provider failures", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams())
      ).pipe(Effect.either),
      () =>
        Effect.fail(
          new HeliusSolanaAuthError({
            message: "HELIUS_API_KEY is not configured",
          })
        )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        retryable: false,
      })
      expect(result.left.message).toBe("HELIUS_API_KEY is not configured")
    }
  })

  it("maps rate-limit and transient failures as retryable", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams())
      ).pipe(Effect.either),
      () =>
        Effect.fail(
          new HeliusSolanaProviderError({
            message: "Helius request failed with status 429",
            statusCode: 429,
            retryable: true,
          })
        )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        retryable: true,
      })
    }
  })

  it("maps malformed transaction payloads to non-retryable decode failures", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams())
      ).pipe(Effect.either),
      () =>
        Effect.succeed({
          data: [
            {
              slot: 1,
              transactionIndex: 0,
              transaction: { signatures: [] },
              meta: null,
              blockTime: 1_735_689_600,
            },
          ],
          paginationToken: null,
        })
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        retryable: false,
      })
      expect(result.left.message).toContain("missing signature")
    }
  })

  it("rejects Helius transactions with missing block times", async () => {
    const result = await runProvider(
      Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
        provider.fetchRawBatch(makeFetchParams())
      ).pipe(Effect.either),
      () =>
        Effect.succeed({
          data: [
            makeHeliusTransaction({
              signature: "signature-null-block-time",
              blockTime: null,
              meta: { err: null },
            }),
          ],
          paginationToken: null,
        })
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncProviderFailureError",
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        retryable: false,
      })
      expect(result.left.message).toContain("signature-null-block-time")
      expect(result.left.message).toContain("missing blockTime")
    }
  })

  it("normalizes SOL balance deltas and transaction fees from full transaction metadata", async () => {
    const payload = {
      slot: 123,
      transactionIndex: 4,
      transaction: {
        signatures: ["signature-normalized"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
          ],
          instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_499_995_000, 500_000_000],
      },
      blockTime: 1_735_689_600,
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      description: "Transfer 0.5 SOL",
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result.transaction.externalId).toBe("signature-normalized")
    expect(result.transaction.providerStatus).toBe("succeeded")
    expect(result.onchainContext).toMatchObject({
      chainTxId: "signature-normalized",
      blockHeight: "123",
      positionInBlock: "4",
      feeAmount: "5000",
      isError: false,
    })
    expect(result.feeTransfers.map((transfer) => transfer.amount)).toEqual(["0.5", "0.000005"])
    expect(result.feeTransfers.map((transfer) => transfer.type)).toEqual(["native", "fee"])
    expect(result.providerTransfers).toHaveLength(2)
    expect(result.transactionReview).toBeNull()
  })

  it("does not record Solana fees when the wallet is not the fee payer", async () => {
    const payload = {
      slot: 123,
      transactionIndex: 5,
      transaction: {
        signatures: ["signature-inbound-fee-paid-by-sender"],
        message: {
          accountKeys: [
            { pubkey: "counterparty-address", signer: true },
            { pubkey: WALLET_ADDRESS, signer: false },
          ],
          instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000, 2_000_000_000],
        postBalances: [499_995_000, 2_500_000_000],
      },
      blockTime: 1_735_689_600,
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      description: "Transfer 0.5 SOL",
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result.feeTransfers.map((transfer) => transfer.type)).toEqual(["native"])
    expect(result.feeTransfers.map((transfer) => transfer.amount)).toEqual(["0.5"])
    expect(result.providerTransfers).toHaveLength(1)
    expect(result.providerTransfers[0]).toMatchObject({
      fromAddress: "counterparty-address",
      toAddress: WALLET_ADDRESS,
      providerAssetId: "provider-asset-sol",
    })
    expect(result.transactionReview).toBeNull()
  })

  it("uses the first string account key as the Solana fee payer", async () => {
    const payload = {
      slot: 123,
      transactionIndex: 6,
      transaction: {
        signatures: ["signature-string-account-keys"],
        message: {
          accountKeys: ["counterparty-address", WALLET_ADDRESS],
          instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000, 2_000_000_000],
        postBalances: [499_995_000, 2_500_000_000],
      },
      blockTime: 1_735_689_600,
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      description: "Transfer 0.5 SOL",
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result.feeTransfers.map((transfer) => transfer.type)).toEqual(["native"])
    expect(result.feeTransfers.map((transfer) => transfer.amount)).toEqual(["0.5"])
    expect(result.providerTransfers).toHaveLength(1)
    const metadata = Schema.decodeUnknownSync(Schema.Struct({ activityFacts: ActivityFacts }))(
      result.transaction.metadata
    )
    expect(metadata.activityFacts.onchain?.feePayer).toBe("counterparty-address")
    expect(result.transactionReview).toBeNull()
  })

  it("normalizes failed Solana transactions to fee-only data with review state", async () => {
    const payload = {
      slot: 124,
      transactionIndex: 0,
      transaction: {
        signatures: ["signature-failed-normalized"],
        message: {
          accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
          instructions: [],
        },
      },
      meta: {
        err: { InstructionError: [1, "Custom"] },
        fee: 5_000,
        preBalances: [2_000_000_000],
        postBalances: [1_999_995_000],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result.transaction.providerStatus).toBe("failed")
    expect(result.feeTransfers.map((transfer) => transfer.type)).toEqual(["fee"])
    expect(result.feeTransfers.map((transfer) => transfer.amount)).toEqual(["0.000005"])
    expect(result.onchainContext?.isError).toBe(true)
    expect(result.transactionReview?.matchedLayer).toBe("solana_failed_transaction")
  })

  it("marks successful Solana transactions without deterministic classification for review", async () => {
    const payload = {
      slot: 125,
      transactionIndex: 1,
      transaction: {
        signatures: ["signature-unknown-successful"],
        message: {
          accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
          instructions: [{ programId: "unknown-program", program: "unknown" }],
        },
      },
      meta: {
        err: null,
        fee: 0,
        preBalances: [2_000_000_000],
        postBalances: [2_000_000_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      blockTime: 1_735_689_600,
      type: "UNKNOWN",
      source: "UNKNOWN_PROGRAM",
      description: "Unknown successful transaction",
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result.feeTransfers).toHaveLength(0)
    expect(result.providerTransfers).toHaveLength(0)
    expect(result.transactionReview).toMatchObject({
      matchedLayer: "solana_unknown_activity",
      needsReview: true,
    })
  })

  it("prefers parsed SPL token transfer evidence when present", async () => {
    const payload = {
      slot: 125,
      transactionIndex: 1,
      transaction: {
        signatures: ["signature-spl-normalized"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_999_995_000, 0],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      blockTime: 1_735_689_600,
      tokenTransfers: [
        {
          mint: USDC_MINT,
          tokenAmount: 12.5,
          fromUserAccount: "counterparty-address",
          toUserAccount: WALLET_ADDRESS,
        },
      ],
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization"),
      () =>
        Effect.succeed({
          data: [
            {
              signature: "signature-spl-normalized",
              timestamp: 1_735_689_600,
              direction: "in",
              counterparty: "counterparty-address",
              mint: USDC_MINT,
              symbol: "USDC",
              amount: 12.5,
              amountRaw: "12500000",
              decimals: 6,
            },
          ],
          pagination: {
            hasMore: false,
            nextCursor: null,
          },
        })
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({
      amount: "12.5",
      type: "spl",
      fromAddress: "counterparty-address",
      toAddress: WALLET_ADDRESS,
    })
    expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "parsed_transfer" })
    expect(splTransfer?.metadata).toMatchObject({
      supplementalTransferRow: {
        signature: "signature-spl-normalized",
        amountRaw: "12500000",
      },
    })
    expect(result.providerTransfers.map((transfer) => transfer.externalId)).toEqual([
      "signature-spl-normalized:provider:fee:1",
      "signature-spl-normalized:provider:principal:1",
    ])
    const splProviderTransfer = result.providerTransfers.find(
      (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
    )
    expect(splProviderTransfer?.metadata).toMatchObject({
      evidenceKind: "parsed_transfer",
      supplementalTransferRow: {
        signature: "signature-spl-normalized",
        amountRaw: "12500000",
      },
    })
    expect(new Set(result.providerTransfers.map((transfer) => transfer.externalId)).size).toBe(
      result.providerTransfers.length
    )

    const metadata = Schema.decodeUnknownSync(Schema.Struct({ activityFacts: ActivityFacts }))(
      result.transaction.metadata
    )
    const classification = await Effect.runPromise(
      Effect.gen(function* () {
        const classifier = yield* ActivityClassificationService
        return yield* classifier.classifyActivity({ facts: metadata.activityFacts })
      }).pipe(Effect.provide(ActivityClassificationServiceLive))
    )
    expect(classification.evidence).toEqual(metadata.activityFacts.evidence)
  })

  it("uses wallet transfer rows as SPL evidence when full transaction SPL evidence is absent", async () => {
    const payload = {
      slot: 126,
      transactionIndex: 2,
      transaction: {
        signatures: ["signature-transfer-row-normalized"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_999_995_000, 0],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization"),
      () =>
        Effect.succeed({
          data: [
            {
              signature: "signature-transfer-row-normalized",
              timestamp: 1_735_689_600,
              direction: "in",
              counterparty: "counterparty-address",
              mint: USDC_MINT,
              symbol: "USDC",
              amount: 12.5,
              amountRaw: "12500000",
              decimals: 6,
            },
          ],
          pagination: {
            hasMore: false,
            nextCursor: null,
          },
        })
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({
      amount: "12.5",
      type: "spl",
      fromAddress: "counterparty-address",
      toAddress: WALLET_ADDRESS,
    })
    expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "transfer_row" })
    expect(result.transactionReview).toBeNull()
  })

  it("uses wallet transfer row raw units for exact display amounts", async () => {
    const payload = {
      slot: 126,
      transactionIndex: 2,
      transaction: {
        signatures: ["signature-transfer-row-raw-amount"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_999_995_000, 0],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization"),
      () =>
        Effect.succeed({
          data: [
            {
              signature: "signature-transfer-row-raw-amount",
              timestamp: 1_735_689_600,
              direction: "in",
              counterparty: "counterparty-address",
              mint: USDC_MINT,
              symbol: "USDC",
              amount: 1.2345678901234567,
              amountRaw: "1234567890123456789",
              decimals: 18,
            },
          ],
          pagination: {
            hasMore: false,
            nextCursor: null,
          },
        })
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({
      amount: "1.234567890123456789",
      type: "spl",
    })
    expect(splTransfer?.metadata).toMatchObject({
      evidenceKind: "transfer_row",
      rawUnits: "1234567890123456789",
    })
  })

  it("normalizes wrapped SOL token balance movements as native SOL", async () => {
    const payload = {
      slot: 126,
      transactionIndex: 2,
      transaction: {
        signatures: ["signature-wrapped-sol-balance"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
            { pubkey: "wallet-wsol-account", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: WRAPPED_SOL_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 9 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: WRAPPED_SOL_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "1250000000", decimals: 9 },
          },
        ],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    const wrappedSolTransfer = result.feeTransfers.find(
      (transfer) =>
        transfer.assetId === "asset-sol" &&
        transfer.metadata !== null &&
        transfer.metadata.role === "principal"
    )
    expect(wrappedSolTransfer).toMatchObject({
      amount: "1.25",
      type: "native",
      assetId: "asset-sol",
    })
    expect(wrappedSolTransfer?.metadata).toMatchObject({
      evidenceKind: "token_balance_delta",
      rawUnits: "1250000000",
    })
  })

  it("falls back to token balance deltas for SPL movements", async () => {
    const payload = {
      slot: 127,
      transactionIndex: 3,
      transaction: {
        signatures: ["signature-token-balance-normalized"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
            { pubkey: "wallet-token-account", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "12500000", decimals: 6 },
          },
        ],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({ amount: "12.5", type: "spl" })
    expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "token_balance_delta" })
  })

  it("prefers exact token balance deltas over parsed SPL token summaries", async () => {
    const payload = {
      slot: 127,
      transactionIndex: 3,
      transaction: {
        signatures: ["signature-token-balance-over-parsed"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
            { pubkey: "wallet-token-account", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 18 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "1234567890123456789", decimals: 18 },
          },
        ],
      },
      blockTime: 1_735_689_600,
      tokenTransfers: [
        {
          mint: USDC_MINT,
          tokenAmount: 1.2345678901234567,
          fromUserAccount: "counterparty-address",
          toUserAccount: WALLET_ADDRESS,
        },
      ],
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({
      amount: "1.234567890123456789",
      type: "spl",
    })
    expect(splTransfer?.metadata).toMatchObject({
      evidenceKind: "token_balance_delta",
      rawUnits: "1234567890123456789",
    })
  })

  it("marks contradictory transfer-row evidence for review without overriding full transaction evidence", async () => {
    const payload = {
      slot: 128,
      transactionIndex: 4,
      transaction: {
        signatures: ["signature-contradictory-transfer-row"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "counterparty-address", signer: false },
            { pubkey: "wallet-token-account", signer: false },
          ],
          instructions: [],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "12500000", decimals: 6 },
          },
        ],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization"),
      () =>
        Effect.succeed({
          data: [
            {
              signature: "signature-contradictory-transfer-row",
              timestamp: 1_735_689_600,
              direction: "in",
              counterparty: "counterparty-address",
              mint: USDC_MINT,
              symbol: "USDC",
              amount: 99,
              amountRaw: "99000000",
              decimals: 6,
            },
          ],
          pagination: {
            hasMore: false,
            nextCursor: null,
          },
        })
    )

    const splTransfer = result.feeTransfers.find((transfer) => transfer.assetId === "asset-usdc")
    expect(splTransfer).toMatchObject({ amount: "12.5", type: "spl" })
    expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "token_balance_delta" })
    expect(result.transactionReview?.matchedLayer).toBe("solana_transfer_evidence")
  })

  it("represents token account close rent refunds without inventing SPL value", async () => {
    const payload = {
      slot: 129,
      transactionIndex: 5,
      transaction: {
        signatures: ["signature-close-account-rent-refund"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "closed-token-account", signer: false },
          ],
          instructions: [
            {
              program: "spl-token",
              programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              parsed: { type: "closeAccount" },
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 2_039_280],
        postBalances: [2_002_034_280, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    const rentTransfer = result.feeTransfers.find((transfer) => transfer.notes !== null)
    const splTransfers = result.feeTransfers.filter((transfer) => transfer.type === "spl")
    expect(rentTransfer).toMatchObject({
      amount: "0.00203928",
      type: "native",
      notes: "Solana account close or rent refund balance effect",
    })
    expect(rentTransfer?.metadata).toMatchObject({ role: "rent" })
    expect(splTransfers).toHaveLength(0)
  })

  it("detects token account close rent refunds from inner instructions", async () => {
    const payload = {
      slot: 129,
      transactionIndex: 5,
      transaction: {
        signatures: ["signature-inner-close-account-rent-refund"],
        message: {
          accountKeys: [
            { pubkey: WALLET_ADDRESS, signer: true },
            { pubkey: "closed-token-account", signer: false },
          ],
          instructions: [
            {
              program: "defi-program",
              programId: "defi-program-id",
              parsed: { type: "swap" },
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 2_039_280],
        postBalances: [2_002_034_280, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: WALLET_ADDRESS,
            uiTokenAmount: { amount: "0", decimals: 6 },
          },
        ],
        postTokenBalances: [],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                program: "spl-token",
                programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                parsed: { type: "closeAccount" },
              },
            ],
          },
        ],
      },
      blockTime: 1_735_689_600,
    }

    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ payload }),
          lookups,
        })
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    const rentTransfer = result.feeTransfers.find((transfer) => transfer.notes !== null)
    expect(rentTransfer).toMatchObject({
      amount: "0.00203928",
      type: "native",
      notes: "Solana account close or rent refund balance effect",
    })
    expect(rentTransfer?.metadata).toMatchObject({ role: "rent" })
  })

  it("returns a recoverable decode failure for malformed cached Solana payloads", async () => {
    const result = await runProvider(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups()
        return yield* provider
          .prepareNormalization({
            source: makeSource(),
            sourceRecord: makeRawRecord({ payload: { malformed: true } }),
            lookups,
          })
          .pipe(Effect.either)
      }),
      () => Effect.dieMessage("Helius client should not be called during normalization")
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("HeliusSolanaNormalizationDecodeError")
    }
  })
})
