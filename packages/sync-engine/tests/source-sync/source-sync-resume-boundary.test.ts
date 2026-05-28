import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import {
  CoinbaseLegDerivationService,
  CoinbaseRecordNormalizer,
  CoinbaseReferenceDataService,
  CoinbaseReferenceMappingService,
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClient,
  type CoinbaseSyncClientShape,
} from "@my/sync-engine/providers/coinbase"
import {
  AssetRepository,
  ProviderAssetRepository,
  ProviderReferenceRepository,
} from "@my/sync-engine/services"

const watermark = new Date("2026-01-01T00:00:00.000Z")
const olderThanWatermark = new Date("2025-12-31T23:59:59.000Z")

const runWithProvider = <A, E>(
  f: (provider: typeof CoinbaseSourceSyncProvider.Service) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const provider = yield* CoinbaseSourceSyncProvider
    return yield* f(provider)
  }).pipe(
    Effect.provide(
      CoinbaseSourceSyncProviderLive.pipe(
        Layer.provide(
          Layer.succeed(CoinbaseSyncClient, {
            fetchAccountsPage: () => Effect.dieMessage("fetchAccountsPage should not be called"),
            fetchTransactionsPage: ({ cursor }) => {
              if (cursor === null) {
                return Effect.succeed({
                  records: [
                    {
                      id: "late-at-watermark",
                      accountId: "account-1",
                      parentId: null,
                      occurredAt: watermark,
                      payload: { id: "late-at-watermark" },
                    },
                  ],
                  nextCursor: "cursor-2",
                })
              }

              if (cursor === "cursor-2") {
                return Effect.succeed({
                  records: [
                    {
                      id: "checkpoint-1",
                      accountId: "account-1",
                      parentId: null,
                      occurredAt: watermark,
                      payload: { id: "checkpoint-1" },
                    },
                    {
                      id: "older-record",
                      accountId: "account-1",
                      parentId: null,
                      occurredAt: olderThanWatermark,
                      payload: { id: "older-record" },
                    },
                  ],
                  nextCursor: null,
                })
              }

              return Effect.dieMessage(`Unexpected cursor: ${String(cursor)}`)
            },
            fetchFiatCurrencies: () =>
              Effect.dieMessage("fetchFiatCurrencies should not be called"),
            fetchCryptoCurrencies: () =>
              Effect.dieMessage("fetchCryptoCurrencies should not be called"),
          } satisfies CoinbaseSyncClientShape)
        ),
        Layer.provide(
          Layer.succeed(CoinbaseReferenceDataService, {
            refreshReferenceData: () =>
              Effect.dieMessage("refreshReferenceData should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseReferenceMappingService, {
            ensureDefaultMappings: () =>
              Effect.dieMessage("ensureDefaultMappings should not be called"),
            resolveTransactionType: () =>
              Effect.dieMessage("resolveTransactionType should not be called"),
            resolveCurrency: () => Effect.dieMessage("resolveCurrency should not be called"),
            resolveAssetId: () => Effect.dieMessage("resolveAssetId should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseRecordNormalizer, {
            normalize: () => Effect.dieMessage("normalize should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseLegDerivationService, {
            deriveLegs: () => Effect.dieMessage("deriveLegs should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(AssetRepository, {
            findAssetById: () => Effect.dieMessage("findAssetById should not be called"),
            findAssetBySymbol: () => Effect.dieMessage("findAssetBySymbol should not be called"),
            findNativeAssetForBlockchain: () =>
              Effect.dieMessage("findNativeAssetForBlockchain should not be called"),
            findAssetByBlockchainAndContractAddress: () =>
              Effect.dieMessage("findAssetByBlockchainAndContractAddress should not be called"),
            listBlockchains: () => Effect.dieMessage("listBlockchains should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(ProviderAssetRepository, {
            upsertProviderAssets: () =>
              Effect.dieMessage("upsertProviderAssets should not be called"),
            upsertProviderAssetMappings: () =>
              Effect.dieMessage("upsertProviderAssetMappings should not be called"),
            seedProviderAssetMappingsIfMissing: () =>
              Effect.dieMessage("seedProviderAssetMappingsIfMissing should not be called"),
            backfillApprovedSymbolMappingsCanonicalAssetIds: () =>
              Effect.dieMessage(
                "backfillApprovedSymbolMappingsCanonicalAssetIds should not be called"
              ),
            findProviderAssetByProviderAssetId: () =>
              Effect.dieMessage("findProviderAssetByProviderAssetId should not be called"),
            findProviderAssetByNaturalKey: () =>
              Effect.dieMessage("findProviderAssetByNaturalKey should not be called"),
            findProviderAssetByCurrencyCode: () =>
              Effect.dieMessage("findProviderAssetByCurrencyCode should not be called"),
            findProviderAssetMapping: () =>
              Effect.dieMessage("findProviderAssetMapping should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(ProviderReferenceRepository, {
            upsertTransactionTypeCatalog: () =>
              Effect.dieMessage("upsertTransactionTypeCatalog should not be called"),
            ensureTransactionTypeMappings: () =>
              Effect.dieMessage("ensureTransactionTypeMappings should not be called"),
            findTransactionTypeMapping: () =>
              Effect.dieMessage("findTransactionTypeMapping should not be called"),
            recordPendingTransactionTypeMapping: () =>
              Effect.dieMessage("recordPendingTransactionTypeMapping should not be called"),
          })
        )
      )
    )
  )

describe("source sync resume boundary", () => {
  it("keeps scanning equal-watermark Coinbase pages until the checkpoint boundary", async () => {
    const firstBatch = await Effect.runPromise(
      runWithProvider((provider) =>
        provider.fetchRawBatch({
          providerKey: "coinbase",
          sourceId: "source-1",
          walletAddress: null,
          cursorPayload: {
            accountCursor: null,
            pendingAccounts: [],
            transactionAccountId: "account-1",
            transactionCursor: null,
            resumeBoundaryActive: true,
            resumeCheckpointExternalId: "checkpoint-1",
          },
          resumeHighWatermark: watermark,
          resumeCheckpointExternalId: "checkpoint-1",
          pageSize: 100,
        })
      )
    )

    expect(firstBatch.records.map((record) => record.externalRecordId)).toEqual([
      "late-at-watermark",
    ])
    expect(firstBatch.done).toBe(false)
    expect(firstBatch.cursorPayload).toMatchObject({
      transactionCursor: "cursor-2",
      resumeBoundaryActive: true,
      resumeCheckpointExternalId: "checkpoint-1",
    })

    const secondBatch = await Effect.runPromise(
      runWithProvider((provider) =>
        provider.fetchRawBatch({
          providerKey: "coinbase",
          sourceId: "source-1",
          walletAddress: null,
          cursorPayload: firstBatch.cursorPayload,
          resumeHighWatermark: watermark,
          resumeCheckpointExternalId: "checkpoint-1",
          pageSize: 100,
        })
      )
    )

    expect(secondBatch.records).toHaveLength(0)
    expect(secondBatch.done).toBe(true)
    expect(secondBatch.cursorPayload).toMatchObject({
      transactionAccountId: null,
      transactionCursor: null,
      resumeBoundaryActive: false,
      resumeCheckpointExternalId: null,
    })
  })
})
