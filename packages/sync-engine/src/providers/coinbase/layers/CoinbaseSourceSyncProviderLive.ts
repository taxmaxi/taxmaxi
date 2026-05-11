/**
 * CoinbaseSourceSyncProviderLive - Coinbase provider boundary implementation.
 *
 * @module CoinbaseSourceSyncProviderLive
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import { ProviderAssetRepository } from "../../../services/ProviderAssetRepository.ts"
import type { SourceTransactionReviewDraft } from "../../../services/SourceNormalizationRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncCursorDecodeError,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
  type FetchProviderRawBatchParams,
} from "../../../services/SourceSyncProvider.ts"
import { CoinbaseLegDerivationService } from "../services/CoinbaseLegDerivationService.ts"
import {
  CoinbaseRecordNormalizationError,
  CoinbaseRecordNormalizer,
} from "../services/CoinbaseRecordNormalizer.ts"
import { CoinbaseReferenceDataService } from "../services/CoinbaseReferenceDataService.ts"
import {
  CoinbaseReferenceMappingService,
  type CoinbaseResolvedTransactionTypeMapping,
} from "../services/CoinbaseReferenceMappingService.ts"
import {
  CoinbaseSourceSyncProvider,
  type CoinbaseSourceSyncProviderShape,
  type CoinbaseNormalizationLookups,
} from "../services/CoinbaseSourceSyncProvider.ts"
import {
  CoinbaseSyncAuthError,
  CoinbaseSyncClient,
  CoinbaseSyncPayloadDecodeError,
  CoinbaseSyncProviderError,
  type CoinbaseSyncClientError,
  type CoinbaseSyncCursor,
  type CoinbaseTransactionPageRecord,
} from "../services/CoinbaseSyncClient.ts"

const COINBASE_PROVIDER_KEY = "coinbase"
const COINBASE_RECORD_TYPE_ACCOUNT = "coinbase_account"
const COINBASE_RECORD_TYPE_TRANSACTION = "coinbase_transaction"
const PROVIDER_ASSET_REVIEW_LAYER = "provider_asset_mapping"

const CoinbaseNormalizedMetadataSchema = Schema.Struct({
  amount: Schema.Struct({
    amount: Schema.String,
    currency: Schema.String,
  }),
  nativeAmount: Schema.Struct({
    amount: Schema.String,
    currency: Schema.String,
  }),
  network: Schema.NullOr(Schema.Unknown),
  from: Schema.NullOr(Schema.Unknown),
  to: Schema.NullOr(Schema.Unknown),
})

type CoinbaseNormalizedMetadata = Schema.Schema.Type<typeof CoinbaseNormalizedMetadataSchema>

const makeRawBatchResult = ({
  records,
  cursorPayload,
  highWatermark,
  done,
}: {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly cursorPayload: unknown
  readonly highWatermark: Date | null
  readonly done: boolean
}): FetchProviderRawBatchResult =>
  FetchProviderRawBatchResult.make({
    records,
    cursorPayload,
    highWatermark,
    done,
  })

const makeTransactionRecord = ({
  id,
  accountId,
  parentId,
  occurredAt,
  payload,
}: {
  readonly id: string
  readonly accountId: string
  readonly parentId: string | null
  readonly occurredAt: Date
  readonly payload: unknown
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: COINBASE_PROVIDER_KEY,
    recordType: COINBASE_RECORD_TYPE_TRANSACTION,
    externalRecordId: id,
    externalAccountId: accountId,
    externalParentId: parentId,
    occurredAt,
    payload,
  })

const makeAccountRecord = ({
  accountId,
  occurredAt,
  payload,
}: {
  readonly accountId: string
  readonly occurredAt: Date
  readonly payload: unknown
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: COINBASE_PROVIDER_KEY,
    recordType: COINBASE_RECORD_TYPE_ACCOUNT,
    externalRecordId: accountId,
    externalAccountId: accountId,
    externalParentId: null,
    occurredAt,
    payload,
  })

const PendingAccountSchema = Schema.Struct({
  id: Schema.String,
  occurredAtIso: Schema.String,
  payload: Schema.Unknown,
})

const CoinbaseCursorPayloadSchema = Schema.Struct({
  accountCursor: Schema.optional(Schema.NullOr(Schema.String)),
  pendingAccounts: Schema.optional(Schema.Array(PendingAccountSchema)),
  transactionAccountId: Schema.optional(Schema.NullOr(Schema.String)),
  transactionCursor: Schema.optional(Schema.NullOr(Schema.String)),
  resumeBoundaryActive: Schema.optional(Schema.Boolean),
  resumeCheckpointExternalId: Schema.optional(Schema.NullOr(Schema.String)),
})

interface PendingAccount {
  readonly id: string
  readonly occurredAt: Date
  readonly payload: unknown
}

interface CoinbaseCursorPayload {
  readonly accountCursor: CoinbaseSyncCursor
  readonly pendingAccounts: ReadonlyArray<PendingAccount>
  readonly transactionAccountId: string | null
  readonly transactionCursor: CoinbaseSyncCursor
  readonly resumeBoundaryActive: boolean
  readonly resumeCheckpointExternalId: string | null
}

const defaultCoinbaseCursorPayload: CoinbaseCursorPayload = {
  accountCursor: null,
  pendingAccounts: [],
  transactionAccountId: null,
  transactionCursor: null,
  resumeBoundaryActive: false,
  resumeCheckpointExternalId: null,
}

const toCursorDecodeError = (message: string) =>
  new SourceSyncCursorDecodeError({
    providerKey: COINBASE_PROVIDER_KEY,
    message,
  })

const toProviderFailureError = (
  error: CoinbaseSyncAuthError | CoinbaseSyncProviderError | CoinbaseSyncPayloadDecodeError
) =>
  new SourceSyncProviderFailureError({
    providerKey: COINBASE_PROVIDER_KEY,
    message: error.message,
    retryable: error instanceof CoinbaseSyncProviderError ? error.retryable : false,
  })

const mapCoinbaseClientError = (
  error: CoinbaseSyncClientError
): SourceSyncProviderFailureError | SyncEngineStorageError => {
  if (error instanceof SyncEngineStorageError) {
    return error
  }

  return toProviderFailureError(error)
}

const decodeCoinbaseCursorPayload = (
  payload: unknown
): Effect.Effect<CoinbaseCursorPayload, SourceSyncCursorDecodeError> =>
  Effect.gen(function* () {
    if (payload === null || payload === undefined) {
      return defaultCoinbaseCursorPayload
    }

    const decoded = yield* Schema.decodeUnknown(CoinbaseCursorPayloadSchema)(payload).pipe(
      Effect.mapError((error) =>
        toCursorDecodeError(`Invalid persisted Coinbase cursor payload: ${error.message}`)
      )
    )

    const pendingAccounts = yield* Effect.forEach(decoded.pendingAccounts ?? [], (pending) =>
      Timestamp.fromString(pending.occurredAtIso).pipe(
        Effect.map(
          (timestamp): PendingAccount => ({
            id: pending.id,
            occurredAt: timestamp.toDate(),
            payload: pending.payload,
          })
        ),
        Effect.mapError(() =>
          toCursorDecodeError(
            `Invalid pending account timestamp for Coinbase account ${pending.id}: ${pending.occurredAtIso}`
          )
        )
      )
    )

    return {
      accountCursor: decoded.accountCursor ?? null,
      pendingAccounts,
      transactionAccountId: decoded.transactionAccountId ?? null,
      transactionCursor: decoded.transactionCursor ?? null,
      resumeBoundaryActive: decoded.resumeBoundaryActive ?? false,
      resumeCheckpointExternalId: decoded.resumeCheckpointExternalId ?? null,
    }
  })

const encodeCoinbaseCursorPayload = (payload: CoinbaseCursorPayload): unknown => ({
  accountCursor: payload.accountCursor,
  pendingAccounts: payload.pendingAccounts.map((account) => ({
    id: account.id,
    occurredAtIso: Timestamp.fromDate(account.occurredAt).toISOString(),
    payload: account.payload,
  })),
  transactionAccountId: payload.transactionAccountId,
  transactionCursor: payload.transactionCursor,
  resumeBoundaryActive: payload.resumeBoundaryActive,
  resumeCheckpointExternalId: payload.resumeCheckpointExternalId,
})

interface IncrementalBoundaryScanResult {
  readonly records: ReadonlyArray<CoinbaseTransactionPageRecord>
  readonly reachedBoundary: boolean
}

const scanIncrementalBoundary = ({
  records,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly records: ReadonlyArray<CoinbaseTransactionPageRecord>
  readonly resumeHighWatermark: Date
  readonly resumeCheckpointExternalId: string | null
}): IncrementalBoundaryScanResult => {
  const watermark = Timestamp.fromDate(resumeHighWatermark)
  const boundaryIndex = records.findIndex((record) => {
    const occurredAt = Timestamp.fromDate(record.occurredAt)
    const isAtWatermark = Timestamp.equals(occurredAt, watermark)

    return (
      Timestamp.isBefore(occurredAt, watermark) ||
      (isAtWatermark &&
        resumeCheckpointExternalId !== null &&
        record.id === resumeCheckpointExternalId)
    )
  })

  return {
    records: boundaryIndex === -1 ? records : records.slice(0, boundaryIndex),
    reachedBoundary: boundaryIndex !== -1,
  }
}

const make = Effect.gen(function* () {
  const coinbaseSyncClient = yield* CoinbaseSyncClient
  const coinbaseRecordNormalizer = yield* CoinbaseRecordNormalizer
  const coinbaseLegDerivationService = yield* CoinbaseLegDerivationService
  const coinbaseReferenceDataService = yield* CoinbaseReferenceDataService
  const coinbaseReferenceMappingService = yield* CoinbaseReferenceMappingService
  const assetRepository = yield* AssetRepository
  const providerAssetRepository = yield* ProviderAssetRepository

  const decodeCoinbaseNormalizedMetadata = (
    metadata: unknown
  ): Effect.Effect<CoinbaseNormalizedMetadata, CoinbaseRecordNormalizationError> =>
    Schema.decodeUnknown(CoinbaseNormalizedMetadataSchema)(metadata).pipe(
      Effect.mapError(
        (cause) =>
          new CoinbaseRecordNormalizationError({
            message: "Failed to decode normalized Coinbase transaction metadata",
            cause,
          })
      )
    )

  const continueTransactionPagination = ({
    state,
    sourceId,
    resumeHighWatermark,
    resumeCheckpointExternalId,
    pageSize,
  }: {
    readonly state: CoinbaseCursorPayload & { readonly transactionAccountId: string }
    readonly sourceId: string
    readonly resumeHighWatermark: Date | null
    readonly resumeCheckpointExternalId: string | null
    readonly pageSize: number
  }) =>
    Effect.gen(function* () {
      const transactionsPage = yield* coinbaseSyncClient
        .fetchTransactionsPage({
          sourceId,
          accountId: state.transactionAccountId,
          cursor: state.transactionCursor,
          pageSize,
        })
        .pipe(Effect.mapError(mapCoinbaseClientError))

      const isIncrementalBoundaryScan = state.resumeBoundaryActive && resumeHighWatermark !== null
      const boundaryScan = isIncrementalBoundaryScan
        ? scanIncrementalBoundary({
            records: transactionsPage.records,
            resumeHighWatermark,
            resumeCheckpointExternalId:
              state.resumeCheckpointExternalId ?? resumeCheckpointExternalId,
          })
        : {
            records: transactionsPage.records,
            reachedBoundary: false,
          }
      const filteredTransactions = boundaryScan.records

      const nextState: CoinbaseCursorPayload =
        boundaryScan.reachedBoundary || transactionsPage.nextCursor === null
          ? {
              ...state,
              transactionAccountId: null,
              transactionCursor: null,
              resumeBoundaryActive: false,
              resumeCheckpointExternalId: null,
            }
          : {
              ...state,
              transactionCursor: transactionsPage.nextCursor,
              resumeBoundaryActive: isIncrementalBoundaryScan,
              resumeCheckpointExternalId:
                state.resumeCheckpointExternalId ?? resumeCheckpointExternalId,
            }

      const nextHighWatermark = filteredTransactions.reduce<Date | null>(
        (current, record) => Timestamp.maxNullableDate(current, record.occurredAt),
        resumeHighWatermark
      )

      const done =
        nextState.transactionAccountId === null &&
        nextState.pendingAccounts.length === 0 &&
        nextState.accountCursor === null

      return makeRawBatchResult({
        records: filteredTransactions.map((record) =>
          makeTransactionRecord({
            id: record.id,
            accountId: record.accountId,
            parentId: record.parentId,
            occurredAt: record.occurredAt,
            payload: record.payload,
          })
        ),
        cursorPayload: encodeCoinbaseCursorPayload(nextState),
        highWatermark: nextHighWatermark,
        done,
      })
    })

  const drainNextPendingAccount = ({
    state,
    resumeHighWatermark,
    resumeCheckpointExternalId,
  }: {
    readonly state: CoinbaseCursorPayload
    readonly resumeHighWatermark: Date | null
    readonly resumeCheckpointExternalId: string | null
  }) => {
    const [currentAccount, ...remainingAccounts] = state.pendingAccounts

    if (currentAccount === undefined) {
      return Effect.succeed(
        makeRawBatchResult({
          records: [],
          cursorPayload: encodeCoinbaseCursorPayload(state),
          highWatermark: resumeHighWatermark,
          done: state.accountCursor === null,
        })
      )
    }

    const nextState: CoinbaseCursorPayload = {
      ...state,
      pendingAccounts: remainingAccounts,
      transactionAccountId: currentAccount.id,
      transactionCursor: null,
      resumeBoundaryActive: resumeHighWatermark !== null,
      resumeCheckpointExternalId,
    }

    return Effect.succeed(
      makeRawBatchResult({
        records: [
          makeAccountRecord({
            accountId: currentAccount.id,
            occurredAt: currentAccount.occurredAt,
            payload: currentAccount.payload,
          }),
        ],
        cursorPayload: encodeCoinbaseCursorPayload(nextState),
        highWatermark: resumeHighWatermark,
        done: false,
      })
    )
  }

  const fetchNextAccountsPage = ({
    state,
    sourceId,
    resumeHighWatermark,
    resumeCheckpointExternalId,
    pageSize,
  }: {
    readonly state: CoinbaseCursorPayload
    readonly sourceId: string
    readonly resumeHighWatermark: Date | null
    readonly resumeCheckpointExternalId: string | null
    readonly pageSize: number
  }) =>
    Effect.gen(function* () {
      const accountsPage = yield* coinbaseSyncClient
        .fetchAccountsPage({
          sourceId,
          cursor: state.accountCursor,
          pageSize,
        })
        .pipe(Effect.mapError(mapCoinbaseClientError))

      if (accountsPage.records.length === 0 && accountsPage.nextCursor === null) {
        return makeRawBatchResult({
          records: [],
          cursorPayload: encodeCoinbaseCursorPayload(defaultCoinbaseCursorPayload),
          highWatermark: resumeHighWatermark,
          done: true,
        })
      }

      const [currentAccount, ...remainingAccounts] = accountsPage.records

      if (currentAccount === undefined) {
        return makeRawBatchResult({
          records: [],
          cursorPayload: encodeCoinbaseCursorPayload({
            accountCursor: accountsPage.nextCursor,
            pendingAccounts: [],
            transactionAccountId: null,
            transactionCursor: null,
            resumeBoundaryActive: false,
            resumeCheckpointExternalId: null,
          }),
          highWatermark: resumeHighWatermark,
          done: accountsPage.nextCursor === null,
        })
      }

      return makeRawBatchResult({
        records: [
          makeAccountRecord({
            accountId: currentAccount.id,
            occurredAt: currentAccount.occurredAt,
            payload: currentAccount.payload,
          }),
        ],
        cursorPayload: encodeCoinbaseCursorPayload({
          accountCursor: accountsPage.nextCursor,
          pendingAccounts: remainingAccounts.map((account) => ({
            id: account.id,
            occurredAt: account.occurredAt,
            payload: account.payload,
          })),
          transactionAccountId: currentAccount.id,
          transactionCursor: null,
          resumeBoundaryActive: resumeHighWatermark !== null,
          resumeCheckpointExternalId,
        }),
        highWatermark: resumeHighWatermark,
        done: false,
      })
    })

  const fetchCoinbaseRawBatch = ({
    sourceId,
    cursorPayload,
    resumeHighWatermark,
    resumeCheckpointExternalId,
    pageSize,
  }: {
    readonly sourceId: string
    readonly cursorPayload: unknown
    readonly resumeHighWatermark: Date | null
    readonly resumeCheckpointExternalId: string | null
    readonly pageSize: number
  }) =>
    Effect.gen(function* () {
      const state = yield* decodeCoinbaseCursorPayload(cursorPayload)

      if (state.transactionAccountId !== null) {
        return yield* continueTransactionPagination({
          state: { ...state, transactionAccountId: state.transactionAccountId },
          sourceId,
          resumeHighWatermark,
          resumeCheckpointExternalId,
          pageSize,
        })
      }

      if (state.pendingAccounts.length > 0) {
        return yield* drainNextPendingAccount({
          state,
          resumeHighWatermark,
          resumeCheckpointExternalId,
        })
      }

      return yield* fetchNextAccountsPage({
        state,
        sourceId,
        resumeHighWatermark,
        resumeCheckpointExternalId,
        pageSize,
      })
    })

  const loadNormalizationLookups: CoinbaseSourceSyncProviderShape["loadNormalizationLookups"] =
    () =>
      assetRepository.listBlockchains().pipe(
        Effect.map(
          (blockchains): CoinbaseNormalizationLookups => ({
            blockchainIdByName: new Map(
              blockchains.map(
                (blockchain) => [blockchain.name.toLowerCase(), blockchain.id] as const
              )
            ),
          })
        )
      )

  const determineCoinbaseReview = ({
    providerTransactionType,
    resolvedTransactionType,
    userId,
  }: {
    readonly providerTransactionType: string | null
    readonly resolvedTransactionType: CoinbaseResolvedTransactionTypeMapping
    readonly userId: string | null
  }) => {
    if (
      userId !== null &&
      providerTransactionType === "send" &&
      resolvedTransactionType.transactionType === "internal_transfer" &&
      resolvedTransactionType.taxTreatment === "requires_additional_rule_logic"
    ) {
      return {
        userId,
        reviewStatus: "needs_review",
        originalTypeKey: resolvedTransactionType.transactionType,
        originalConfidence: null,
        currentTypeKey: resolvedTransactionType.transactionType,
        legalRuleSetVersion: null,
        categorizationReason:
          "Coinbase send requires user review to determine whether it was a self-transfer, gift, or payment before it can affect tax.",
        matchedLayer: "coinbase_reference_mapping",
        needsReview: true,
        userNotes: null,
        reviewedAt: null,
      } as const
    }

    return null
  }

  const resolveCanonicalAsset = ({
    assetId,
    message,
  }: {
    readonly assetId: string
    readonly message: string
  }) =>
    assetRepository.findAssetById({ assetId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SyncEngineStorageError({
                operation: "coinbaseSourceSyncProvider.resolveAsset",
                cause: message,
              })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const appendReviewSegment = ({
    existing,
    segment,
    separator,
  }: {
    readonly existing: string | null
    readonly segment: string
    readonly separator: string
  }): string =>
    existing === null || existing.trim() === ""
      ? segment
      : existing.includes(segment)
        ? existing
        : `${existing}${separator}${segment}`

  const buildProviderAssetMappingReview = ({
    existingReview,
    resolvedTransactionType,
    userId,
    affectedCurrencies,
  }: {
    readonly existingReview: SourceTransactionReviewDraft | null
    readonly resolvedTransactionType: CoinbaseResolvedTransactionTypeMapping
    readonly userId: string | null
    readonly affectedCurrencies: ReadonlyArray<string>
  }): SourceTransactionReviewDraft | null => {
    if (userId === null) {
      return existingReview
    }

    const reason =
      affectedCurrencies.length === 1
        ? `provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for ${affectedCurrencies[0]}.`
        : `provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for ${affectedCurrencies.join(", ")}.`

    return {
      userId,
      reviewStatus: "needs_review",
      originalTypeKey: existingReview?.originalTypeKey ?? resolvedTransactionType.transactionType,
      originalConfidence: existingReview?.originalConfidence ?? null,
      currentTypeKey: existingReview?.currentTypeKey ?? resolvedTransactionType.transactionType,
      legalRuleSetVersion: existingReview?.legalRuleSetVersion ?? null,
      categorizationReason: appendReviewSegment({
        existing: existingReview?.categorizationReason ?? null,
        segment: reason,
        separator: " ",
      }),
      matchedLayer: appendReviewSegment({
        existing: existingReview?.matchedLayer ?? null,
        segment: PROVIDER_ASSET_REVIEW_LAYER,
        separator: ",",
      }),
      needsReview: true,
      userNotes: existingReview?.userNotes ?? null,
      reviewedAt: null,
    }
  }

  const resolveOptionalAssetForReviewableNormalization = ({
    currencyCode,
    rawSourcePayload,
  }: {
    readonly currencyCode: string
    readonly rawSourcePayload: unknown
  }) =>
    coinbaseReferenceMappingService
      .resolveCurrency({
        currencyCode,
        rawSourcePayload,
      })
      .pipe(
        Effect.map((mapping) => ({
          assetId: Option.fromNullable(mapping.canonicalAssetId),
          requiresReview: mapping.mappingKind !== "fiat" && mapping.canonicalAssetId === null,
        })),
        Effect.catchTag("CoinbaseProviderAssetMappingNotFoundError", () =>
          Effect.succeed({
            assetId: Option.none(),
            requiresReview: true,
          })
        ),
        Effect.catchTag("CoinbasePendingProviderAssetMappingError", () =>
          Effect.succeed({
            assetId: Option.none(),
            requiresReview: true,
          })
        )
      )

  const loadProviderAssetIdentity = ({ currencyCode }: { readonly currencyCode: string }) =>
    Effect.gen(function* () {
      const maybeProviderAsset = yield* providerAssetRepository.findProviderAssetByCurrencyCode({
        providerKey: COINBASE_PROVIDER_KEY,
        currencyCode,
      })

      return Option.match(maybeProviderAsset, {
        onNone: () => null,
        onSome: (providerAsset) => providerAsset.id,
      })
    })

  const prepareNormalization: CoinbaseSourceSyncProviderShape["prepareNormalization"] = ({
    source,
    sourceRecord,
    lookups,
  }) =>
    Effect.gen(function* () {
      const normalized = yield* coinbaseRecordNormalizer.normalize({
        source,
        sourceRecord,
        resolveAssetId: (currencyCode) =>
          resolveOptionalAssetForReviewableNormalization({
            currencyCode,
            rawSourcePayload: sourceRecord.payload,
          }).pipe(
            Effect.map((resolution) => resolution.assetId),
            Effect.mapError(
              (cause) =>
                new CoinbaseRecordNormalizationError({
                  message: `Failed to resolve Coinbase asset for ${currencyCode}`,
                  cause,
                })
            )
          ),
        resolveBlockchainId: (networkName) =>
          Option.fromNullable(lookups.blockchainIdByName.get(networkName.toLowerCase())),
      })

      const normalizedMetadata = yield* decodeCoinbaseNormalizedMetadata(
        normalized.transaction.metadata
      )
      const resolvedTransactionType = yield* coinbaseReferenceMappingService.resolveTransactionType(
        {
          providerTransactionType: normalized.transaction.providerTransactionType ?? "unknown",
          venueSide: normalized.venueContext.side ?? null,
          nativeCurrency: normalizedMetadata.nativeAmount.currency,
          rawSourcePayload: sourceRecord.payload,
        }
      )

      const primaryAssetResolution = yield* resolveOptionalAssetForReviewableNormalization({
        currencyCode: normalized.primaryAssetCurrency,
        rawSourcePayload: sourceRecord.payload,
      })
      const maybePrimaryAsset = yield* Option.match(primaryAssetResolution.assetId, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (assetId) =>
          resolveCanonicalAsset({
            assetId,
            message: `Missing asset row for resolved Coinbase asset ${assetId}`,
          }).pipe(Effect.map(Option.some)),
      })
      const primaryProviderAssetId = yield* loadProviderAssetIdentity({
        currencyCode: normalized.primaryAssetCurrency,
      })
      const baseTransactionReview = determineCoinbaseReview({
        providerTransactionType: normalized.transaction.providerTransactionType,
        resolvedTransactionType,
        userId: source.userId,
      })
      const reviewableAssetCurrencies = primaryAssetResolution.requiresReview
        ? [normalized.primaryAssetCurrency.toUpperCase(), ...normalized.unresolvedAssetCurrencies]
        : normalized.unresolvedAssetCurrencies
      const unresolvedAssetCurrencies = Array.from(new Set(reviewableAssetCurrencies)).sort()
      const transactionReview =
        unresolvedAssetCurrencies.length === 0
          ? baseTransactionReview
          : buildProviderAssetMappingReview({
              existingReview: baseTransactionReview,
              resolvedTransactionType,
              userId: source.userId,
              affectedCurrencies: unresolvedAssetCurrencies,
            })

      return {
        transaction: {
          ...normalized.transaction,
          transactionType: resolvedTransactionType.transactionType,
          metadata: {
            ...normalizedMetadata,
            coinbaseReferenceMapping: resolvedTransactionType,
          },
        },
        venueContext: normalized.venueContext,
        providerTransfers: normalized.providerTransfers.map((providerTransfer) => ({
          ...providerTransfer,
          providerAssetId: providerTransfer.providerAssetId ?? primaryProviderAssetId,
        })),
        feeTransfers: normalized.feeTransfers,
        transactionReview,
        resolvedTransactionType,
        primaryAsset: Option.getOrNull(maybePrimaryAsset),
        legDerivationStrategy: unresolvedAssetCurrencies.length === 0 ? "derive" : "skip",
      }
    })

  const deriveLegs: CoinbaseSourceSyncProviderShape["deriveLegs"] = ({
    transaction,
    venueContext,
    primaryAsset,
    feeTransfers,
  }) =>
    Effect.gen(function* () {
      const resolvedFeeTransfers = yield* Effect.forEach(feeTransfers, (transfer) =>
        resolveCanonicalAsset({
          assetId: transfer.assetId,
          message: `Missing asset row for fee transfer asset ${transfer.assetId}`,
        }).pipe(
          Effect.map((asset) => ({
            transfer,
            asset,
          }))
        )
      )

      const derived = yield* coinbaseLegDerivationService.deriveLegs({
        transaction,
        venueContext,
        primaryAsset,
        feeTransfers: resolvedFeeTransfers,
      })

      return derived.legs
    })

  const fetchRawBatch: CoinbaseSourceSyncProviderShape["fetchRawBatch"] = (
    params: FetchProviderRawBatchParams
  ) => {
    if (params.providerKey !== COINBASE_PROVIDER_KEY) {
      return Effect.fail(new UnsupportedSyncProviderError({ providerKey: params.providerKey }))
    }

    return fetchCoinbaseRawBatch({
      sourceId: params.sourceId,
      cursorPayload: params.cursorPayload,
      resumeHighWatermark: params.resumeHighWatermark,
      resumeCheckpointExternalId: params.resumeCheckpointExternalId,
      pageSize: params.pageSize,
    })
  }

  return CoinbaseSourceSyncProvider.of({
    fetchRawBatch,
    refreshReferenceData: coinbaseReferenceDataService.refreshReferenceData,
    loadNormalizationLookups,
    prepareNormalization,
    deriveLegs,
  } satisfies CoinbaseSourceSyncProviderShape)
})

/**
 * CoinbaseSourceSyncProviderLive - Live layer for the Coinbase provider module.
 */
export const CoinbaseSourceSyncProviderLive = Layer.effect(CoinbaseSourceSyncProvider, make)
