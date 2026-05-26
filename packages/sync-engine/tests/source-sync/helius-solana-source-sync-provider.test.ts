import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import { HeliusSolanaSourceSyncProviderFromClientLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HeliusSolanaSourceSyncProvider,
} from "../../src/providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type FetchHeliusSolanaTransactionsForAddressParams,
  type HeliusSolanaSyncClientShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"
import { FetchProviderRawBatchParams } from "../../src/shared/SourceProviderRawBatch.ts"

const WALLET_ADDRESS = "So11111111111111111111111111111111111111112"

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

const makeProviderLayer = ({
  fetchTransactionsForAddress,
}: {
  readonly fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"]
}) =>
  HeliusSolanaSourceSyncProviderFromClientLive.pipe(
    Layer.provide(
      Layer.succeed(
        HeliusSolanaSyncClient,
        HeliusSolanaSyncClient.of({
          fetchTransactionsForAddress,
          fetchAssetBatch: () => Effect.dieMessage("fetchAssetBatch should not be called"),
        })
      )
    )
  )

const runProvider = <A, E>(
  effect: Effect.Effect<A, E, HeliusSolanaSourceSyncProvider>,
  fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"]
) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeProviderLayer({ fetchTransactionsForAddress }))))

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
})
