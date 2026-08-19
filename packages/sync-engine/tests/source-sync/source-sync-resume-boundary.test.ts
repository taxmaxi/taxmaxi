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
  SourceRawRecordRepository,
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
            fetchAccountsPage: () => Effect.die("fetchAccountsPage should not be called"),
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

              return Effect.die(`Unexpected cursor: ${String(cursor)}`)
            },
            fetchFiatCurrencies: () => Effect.die("fetchFiatCurrencies should not be called"),
            fetchCryptoCurrencies: () => Effect.die("fetchCryptoCurrencies should not be called"),
          } satisfies CoinbaseSyncClientShape)
        ),
        Layer.provide(
          Layer.succeed(CoinbaseReferenceDataService, {
            refreshReferenceData: () => Effect.die("refreshReferenceData should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseReferenceMappingService, {
            ensureDefaultMappings: () => Effect.die("ensureDefaultMappings should not be called"),
            resolveTransactionType: () => Effect.die("resolveTransactionType should not be called"),
            resolveCurrency: () => Effect.die("resolveCurrency should not be called"),
            resolveAssetId: () => Effect.die("resolveAssetId should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseRecordNormalizer, {
            normalize: () => Effect.die("normalize should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(CoinbaseLegDerivationService, {
            deriveLegs: () => Effect.die("deriveLegs should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(AssetRepository, {
            findAssetById: () => Effect.die("findAssetById should not be called"),
            findAssetByCoinGeckoId: () => Effect.die("findAssetByCoinGeckoId should not be called"),
            findRepresentationById: () => Effect.die("findRepresentationById should not be called"),
            findNativeRepresentationForBlockchain: () =>
              Effect.die("findNativeRepresentationForBlockchain should not be called"),
            findRepresentationByBlockchainAndAddress: () =>
              Effect.die("findRepresentationByBlockchainAndAddress should not be called"),
            listBlockchains: () => Effect.die("listBlockchains should not be called"),
            upsertEconomicAssetRepresentation: () =>
              Effect.die("upsertEconomicAssetRepresentation should not be called"),
            findAssetResolutionCandidatesBySymbol: () =>
              Effect.die("findAssetResolutionCandidatesBySymbol should not be called"),
            attachRepresentationToExistingAsset: () =>
              Effect.die("attachRepresentationToExistingAsset should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(ProviderAssetRepository, {
            upsertProviderAssets: () => Effect.die("upsertProviderAssets should not be called"),
            upsertProviderAssetMappings: () =>
              Effect.die("upsertProviderAssetMappings should not be called"),
            seedProviderAssetMappingsIfMissing: () =>
              Effect.die("seedProviderAssetMappingsIfMissing should not be called"),
            approveProviderAssetMappingAndRequestReplay: () =>
              Effect.die("approveProviderAssetMappingAndRequestReplay should not be called"),
            lockProviderAssetApprovalSnapshot: () =>
              Effect.die("lockProviderAssetApprovalSnapshot should not be called"),
            recordProviderAssetSourceUses: () =>
              Effect.die("recordProviderAssetSourceUses should not be called"),
            findProviderAssetByProviderAssetId: () =>
              Effect.die("findProviderAssetByProviderAssetId should not be called"),
            findProviderAssetByNaturalKey: () =>
              Effect.die("findProviderAssetByNaturalKey should not be called"),
            findProviderAssetByCurrencyCode: () =>
              Effect.die("findProviderAssetByCurrencyCode should not be called"),
            findProviderAssetReviewById: () =>
              Effect.die("findProviderAssetReviewById should not be called"),
            listProviderAssetReviews: () =>
              Effect.die("listProviderAssetReviews should not be called"),
            listProviderAssetObservedRepresentations: () =>
              Effect.die("listProviderAssetObservedRepresentations should not be called"),
            findProviderAssetMapping: () =>
              Effect.die("findProviderAssetMapping should not be called"),
            scheduleUnresolvedResolutionJob: () =>
              Effect.die("scheduleUnresolvedResolutionJob should not be called"),
            claimResolutionJob: () => Effect.die("claimResolutionJob should not be called"),
            heartbeatResolutionJob: () => Effect.die("heartbeatResolutionJob should not be called"),
            releaseResolutionJobAfterFailure: () =>
              Effect.die("releaseResolutionJobAfterFailure should not be called"),
            finishResolutionJob: () => Effect.die("finishResolutionJob should not be called"),
            recordAssetResolutionDecision: () =>
              Effect.die("recordAssetResolutionDecision should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(ProviderReferenceRepository, {
            upsertTransactionTypeCatalog: () =>
              Effect.die("upsertTransactionTypeCatalog should not be called"),
            ensureTransactionTypeMappings: () =>
              Effect.die("ensureTransactionTypeMappings should not be called"),
            findTransactionTypeMapping: () =>
              Effect.die("findTransactionTypeMapping should not be called"),
            recordPendingTransactionTypeMapping: () =>
              Effect.die("recordPendingTransactionTypeMapping should not be called"),
          })
        ),
        Layer.provide(
          Layer.succeed(SourceRawRecordRepository, {
            upsertRawBatch: () => Effect.die("upsertRawBatch should not be called"),
            listReplayCandidates: () => Effect.die("listReplayCandidates should not be called"),
            listAllRawRowsForReplay: () =>
              Effect.die("listAllRawRowsForReplay should not be called"),
            listPendingNormalizationRecordIds: () =>
              Effect.die("listPendingNormalizationRecordIds should not be called"),
            listRawRecordsByIds: () => Effect.die("listRawRecordsByIds should not be called"),
            listRawRecordsByOccurredAt: () =>
              Effect.die("listRawRecordsByOccurredAt should not be called"),
            markRawRecordNormalized: () =>
              Effect.die("markRawRecordNormalized should not be called"),
            markRawRecordFailed: () => Effect.die("markRawRecordFailed should not be called"),
            resetNormalizationStateForSource: () =>
              Effect.die("resetNormalizationStateForSource should not be called"),
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
