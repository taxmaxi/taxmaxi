/**
 * CoinbaseSourceSyncProviderLive - Coinbase provider boundary implementation.
 *
 * @module CoinbaseSourceSyncProviderLive
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import type { SourceTransactionReviewDraft } from "../../../services/SourceNormalizationRepository.ts"
import { SourceRawRecordRepository } from "../../../services/SourceRawRecordRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncCursorDecodeError,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
  type FetchProviderRawBatchParams,
} from "../../../shared/SourceProviderRawBatch.ts"
import {
  CoinbaseLegDerivationError,
  CoinbaseLegDerivationService,
} from "../services/CoinbaseLegDerivationService.ts"
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
import { isNegativeAmount, isZeroAmount } from "../shared/CoinbaseDecimal.ts"

const COINBASE_PROVIDER_KEY = "coinbase"
const COINBASE_RECORD_TYPE_ACCOUNT = "coinbase_account"
const COINBASE_RECORD_TYPE_TRANSACTION = "coinbase_transaction"
const PROVIDER_ASSET_REVIEW_LAYER = "provider_asset_mapping"
const UNGROUPED_PAIRED_SPREAD_WINDOW_MILLIS = 60 * 1000
const COINBASE_UNSTAKING_PAIRING_RULE = "coinbase_unstaking_pair_v1" as const

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

const CoinbasePairedSpreadPayloadSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  amount: Schema.Struct({
    amount: Schema.String,
    currency: Schema.String,
  }),
  native_amount: Schema.Struct({
    amount: Schema.String,
    currency: Schema.String,
  }),
})

type CoinbasePairedSpreadPayload = Schema.Schema.Type<typeof CoinbasePairedSpreadPayloadSchema>

/**
 * CoinbasePairedSpreadRecord - Sibling principal row used to derive a spread fee.
 *
 * Coinbase reports paired flows such as instant unstaking as two rows at the same
 * timestamp: a negative full-principal release and a positive net principal credit.
 * The deductible fee is the spread between the two amounts.
 */
interface CoinbasePairedSpreadRecord {
  readonly externalId: string
  readonly amount: { readonly amount: string; readonly currency: string }
  readonly nativeAmount: { readonly amount: string; readonly currency: string }
  readonly pairingRule: typeof COINBASE_UNSTAKING_PAIRING_RULE
  readonly pairingKind: "provider_group" | "exact_time_same_type" | "timed_complementary_type"
  readonly timestampDistanceMillis: number
}

const SUCCESSFUL_PROVIDER_STATUSES = new Set(["completed", "succeeded"])

const hasSuccessfulProviderStatus = (status: string | null): boolean =>
  status !== null && SUCCESSFUL_PROVIDER_STATUSES.has(status.toLowerCase())

const isPositiveAmountSmallerThanRelease = ({
  candidateAmount,
  releaseAmount,
}: {
  readonly candidateAmount: string
  readonly releaseAmount: string
}): boolean => {
  const candidate = BigDecimal.fromString(candidateAmount.trim())
  const release = BigDecimal.fromString(releaseAmount.trim())

  if (Option.isNone(candidate) || Option.isNone(release)) {
    return false
  }

  return (
    BigDecimal.isGreaterThan(candidate.value, BigDecimal.fromBigInt(0n)) &&
    BigDecimal.isLessThanOrEqualTo(candidate.value, BigDecimal.abs(release.value))
  )
}

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
    retryable: Schema.is(CoinbaseSyncProviderError)(error) ? error.retryable : false,
  })

const mapCoinbaseClientError = (
  error: CoinbaseSyncClientError
): SourceSyncProviderFailureError | SyncEngineStorageError => {
  if (Schema.is(SyncEngineStorageError)(error)) {
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

    const decoded = yield* Schema.decodeEffect(CoinbaseCursorPayloadSchema)(payload).pipe(
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
  const sourceRawRecordRepository = yield* SourceRawRecordRepository

  /**
   * Find the positive principal sibling row of a negative paired-spread row.
   * Provider group identifiers allow siblings across provider accounts. When
   * Coinbase omits a group identifier, a unique row from a different account
   * may pair when it has the same type and exact timestamp, or a complementary
   * unstaking type inside a narrow time window.
   * Fails recoverably when the sibling is missing or ambiguous so the row is
   * retried on a later replay pass once all sibling rows are cached.
   */
  const resolvePairedSpreadRecord = ({
    sourceRecord,
    providerTransactionType,
    providerStatus,
    amount,
    nativeAmount,
  }: {
    readonly sourceRecord: {
      readonly id: string
      readonly sourceId: string
      readonly recordType: string
      readonly externalAccountId: string | null
      readonly externalParentId: string | null
      readonly occurredAt: Date
    }
    readonly providerTransactionType: string | null
    readonly providerStatus: string | null
    readonly amount: CoinbaseNormalizedMetadata["amount"]
    readonly nativeAmount: CoinbaseNormalizedMetadata["nativeAmount"]
  }): Effect.Effect<
    CoinbasePairedSpreadRecord,
    CoinbaseRecordNormalizationError | SyncEngineStorageError
  > =>
    Effect.gen(function* () {
      if (!hasSuccessfulProviderStatus(providerStatus)) {
        return yield* new CoinbaseRecordNormalizationError({
          message: `Expected one unambiguous paired principal row for ${providerTransactionType ?? "unknown"} near ${sourceRecord.occurredAt.toISOString()}, found 0`,
        })
      }

      const siblingRecords = yield* sourceRawRecordRepository.listRawRecordsByOccurredAt({
        sourceId: sourceRecord.sourceId,
        recordType: sourceRecord.recordType,
        occurredAt: sourceRecord.occurredAt,
      })

      const isCompatibleType = (candidateType: string): boolean => {
        if (candidateType === providerTransactionType) {
          return true
        }

        return (
          (providerTransactionType === "retail_instant_unstaking" &&
            candidateType === "unstaking_transfer") ||
          (providerTransactionType === "unstaking_transfer" &&
            candidateType === "retail_instant_unstaking")
        )
      }

      const isUngroupedPairMatch = ({
        releaseRecord,
        releaseType,
        releaseAmount,
        releaseNativeAmount,
        creditRecord,
        creditPayload,
      }: {
        readonly releaseRecord: {
          readonly externalAccountId: string | null
          readonly externalParentId: string | null
          readonly occurredAt: Date
        }
        readonly releaseType: string | null
        readonly releaseAmount: { readonly amount: string; readonly currency: string }
        readonly releaseNativeAmount: { readonly amount: string; readonly currency: string }
        readonly creditRecord: {
          readonly externalAccountId: string | null
          readonly externalParentId: string | null
          readonly occurredAt: Date
        }
        readonly creditPayload: CoinbasePairedSpreadPayload
      }): boolean => {
        const timestampDistance = Math.abs(
          creditRecord.occurredAt.getTime() - releaseRecord.occurredAt.getTime()
        )
        const hasSafeTypeAndTiming =
          (creditPayload.type === releaseType && timestampDistance === 0) ||
          (((releaseType === "retail_instant_unstaking" &&
            creditPayload.type === "unstaking_transfer") ||
            (releaseType === "unstaking_transfer" &&
              creditPayload.type === "retail_instant_unstaking")) &&
            timestampDistance <= UNGROUPED_PAIRED_SPREAD_WINDOW_MILLIS)

        return (
          releaseRecord.externalParentId === null &&
          creditRecord.externalParentId === null &&
          releaseRecord.externalAccountId !== null &&
          creditRecord.externalAccountId !== null &&
          creditRecord.externalAccountId !== releaseRecord.externalAccountId &&
          hasSafeTypeAndTiming &&
          creditPayload.amount.currency.toUpperCase() === releaseAmount.currency.toUpperCase() &&
          creditPayload.native_amount.currency.toUpperCase() ===
            releaseNativeAmount.currency.toUpperCase() &&
          isPositiveAmountSmallerThanRelease({
            candidateAmount: creditPayload.amount.amount,
            releaseAmount: releaseAmount.amount,
          }) &&
          isPositiveAmountSmallerThanRelease({
            candidateAmount: creditPayload.native_amount.amount,
            releaseAmount: releaseNativeAmount.amount,
          })
        )
      }

      const candidates = siblingRecords.flatMap((sibling) => {
        if (sibling.id === sourceRecord.id) {
          return []
        }

        const decoded = Schema.decodeUnknownOption(CoinbasePairedSpreadPayloadSchema)(
          sibling.payload
        )

        return Option.match(decoded, {
          onNone: () => [],
          onSome: (payload) => {
            if (
              !hasSuccessfulProviderStatus(payload.status) ||
              !isCompatibleType(payload.type) ||
              payload.amount.currency.toUpperCase() !== amount.currency.toUpperCase() ||
              payload.native_amount.currency.toUpperCase() !==
                nativeAmount.currency.toUpperCase() ||
              !isPositiveAmountSmallerThanRelease({
                candidateAmount: payload.amount.amount,
                releaseAmount: amount.amount,
              }) ||
              !isPositiveAmountSmallerThanRelease({
                candidateAmount: payload.native_amount.amount,
                releaseAmount: nativeAmount.amount,
              })
            ) {
              return []
            }

            const groupMatches =
              sourceRecord.externalParentId !== null &&
              sibling.externalParentId === sourceRecord.externalParentId
            const timestampDistance = Math.abs(
              sibling.occurredAt.getTime() - sourceRecord.occurredAt.getTime()
            )
            const ungroupedFallbackMatches = isUngroupedPairMatch({
              releaseRecord: sourceRecord,
              releaseType: providerTransactionType,
              releaseAmount: amount,
              releaseNativeAmount: nativeAmount,
              creditRecord: sibling,
              creditPayload: payload,
            })

            if (!groupMatches && !ungroupedFallbackMatches) {
              return []
            }

            const sameType = payload.type === providerTransactionType

            return [
              {
                payload,
                record: sibling,
                pairingKind: groupMatches
                  ? ("provider_group" as const)
                  : sameType
                    ? ("exact_time_same_type" as const)
                    : ("timed_complementary_type" as const),
                timestampDistance,
              },
            ]
          },
        })
      })

      const groupedCandidates = candidates.filter(
        (candidate) => candidate.pairingKind === "provider_group"
      )
      const ungroupedCandidates = candidates.filter(
        (candidate) => candidate.pairingKind !== "provider_group"
      )
      const [ungroupedCandidate] = ungroupedCandidates
      const hasCompetingUngroupedRelease = (
        candidate: (typeof ungroupedCandidates)[number]
      ): boolean =>
        siblingRecords.some((possibleRelease) => {
          if (
            possibleRelease.id === sourceRecord.id ||
            possibleRelease.id === candidate.record.id
          ) {
            return false
          }

          const decoded = Schema.decodeUnknownOption(CoinbasePairedSpreadPayloadSchema)(
            possibleRelease.payload
          )

          return Option.match(decoded, {
            onNone: () => false,
            onSome: (payload) =>
              hasSuccessfulProviderStatus(payload.status) &&
              isNegativeAmount(payload.amount.amount) &&
              isUngroupedPairMatch({
                releaseRecord: possibleRelease,
                releaseType: payload.type,
                releaseAmount: payload.amount,
                releaseNativeAmount: payload.native_amount,
                creditRecord: candidate.record,
                creditPayload: candidate.payload,
              }),
          })
        })
      const eligibleCandidates =
        groupedCandidates.length > 0
          ? groupedCandidates.length === 1
            ? groupedCandidates
            : []
          : ungroupedCandidate !== undefined &&
              ungroupedCandidates.length === 1 &&
              !hasCompetingUngroupedRelease(ungroupedCandidate)
            ? ungroupedCandidates
            : []
      const [paired] = eligibleCandidates

      if (paired === undefined) {
        return yield* new CoinbaseRecordNormalizationError({
          message: `Expected one unambiguous paired principal row for ${providerTransactionType ?? "unknown"} near ${sourceRecord.occurredAt.toISOString()}, found ${candidates.length}`,
        })
      }

      return {
        externalId: paired.payload.id,
        amount: paired.payload.amount,
        nativeAmount: paired.payload.native_amount,
        pairingRule: COINBASE_UNSTAKING_PAIRING_RULE,
        pairingKind: paired.pairingKind,
        timestampDistanceMillis: paired.timestampDistance,
      }
    })

  const decodeCoinbaseNormalizedMetadata = (
    metadata: unknown
  ): Effect.Effect<CoinbaseNormalizedMetadata, CoinbaseRecordNormalizationError> =>
    Schema.decodeUnknownEffect(CoinbaseNormalizedMetadataSchema)(metadata).pipe(
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
    assetRepository.listBlockchains.pipe(
      Effect.map(
        (blockchains): CoinbaseNormalizationLookups => ({
          blockchainIdByName: new Map(
            blockchains.map((blockchain) => [blockchain.name.toLowerCase(), blockchain.id] as const)
          ),
        })
      )
    )

  const determineCoinbaseReview = ({
    providerTransactionType,
    resolvedTransactionType,
    principalId,
  }: {
    readonly providerTransactionType: string | null
    readonly resolvedTransactionType: CoinbaseResolvedTransactionTypeMapping
    readonly principalId: string
  }) => {
    const makeNeedsReviewEntry = ({
      categorizationReason,
    }: {
      readonly categorizationReason: string
    }) =>
      ({
        principalId,
        reviewStatus: "needs_review",
        originalTypeKey: resolvedTransactionType.transactionType,
        originalConfidence: null,
        currentTypeKey: resolvedTransactionType.transactionType,
        legalRuleSetVersion: null,
        categorizationReason,
        matchedLayer: "coinbase_reference_mapping",
        needsReview: true,
        userNotes: null,
        reviewedAt: null,
      }) as const

    if (
      providerTransactionType === "send" &&
      resolvedTransactionType.transactionType === "internal_transfer" &&
      resolvedTransactionType.taxTreatment === "requires_additional_rule_logic"
    ) {
      return makeNeedsReviewEntry({
        categorizationReason:
          "Coinbase send requires user review to determine whether it was a self-transfer, gift, or payment before it can affect tax.",
      })
    }

    if (
      providerTransactionType === "tx" &&
      resolvedTransactionType.taxTreatment === "requires_additional_rule_logic"
    ) {
      return makeNeedsReviewEntry({
        categorizationReason:
          "Coinbase tx is an uncategorized ledger entry. Inventory is tracked from the amount sign, but the tax classification needs user review.",
      })
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
    principalId,
    affectedCurrencies,
  }: {
    readonly existingReview: SourceTransactionReviewDraft | null
    readonly resolvedTransactionType: CoinbaseResolvedTransactionTypeMapping
    readonly principalId: string
    readonly affectedCurrencies: ReadonlyArray<string>
  }): SourceTransactionReviewDraft | null => {
    const reason =
      affectedCurrencies.length === 1
        ? `provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for ${affectedCurrencies[0]}.`
        : `provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for ${affectedCurrencies.join(", ")}.`

    return {
      principalId,
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
          assetId: Option.fromNullishOr(mapping.canonicalAssetId),
          providerAssetRowId: mapping.providerAssetRowId,
          requiresReview:
            mapping.kind !== "excluded" &&
            mapping.mappingKind !== "fiat" &&
            mapping.canonicalAssetId === null,
          excluded: mapping.kind === "excluded",
        })),
        Effect.catchTags({
          CoinbaseProviderAssetMappingNotFoundError: (error) =>
            Effect.succeed({
              assetId: Option.none(),
              providerAssetRowId: error.providerAssetRowId,
              requiresReview: true,
              excluded: false,
            }),
          CoinbasePendingProviderAssetMappingError: (error) =>
            Effect.succeed({
              assetId: Option.none(),
              providerAssetRowId: error.providerAssetRowId,
              requiresReview: true,
              excluded: false,
            }),
        })
      )

  const prepareNormalization: CoinbaseSourceSyncProviderShape["prepareNormalization"] = ({
    source,
    sourceRecord,
    lookups,
  }) =>
    Effect.gen(function* () {
      const excludedAssetCurrencies = new Set<string>()
      const normalized = yield* coinbaseRecordNormalizer.normalize({
        source,
        sourceRecord,
        resolveAsset: (currencyCode) =>
          resolveOptionalAssetForReviewableNormalization({
            currencyCode,
            rawSourcePayload: sourceRecord.payload,
          }).pipe(
            Effect.map((resolution) => {
              const normalizedCurrencyCode = currencyCode.toUpperCase()
              if (resolution.excluded) {
                excludedAssetCurrencies.add(normalizedCurrencyCode)
              }
              return {
                assetId: resolution.assetId,
                providerAssetRowId: resolution.providerAssetRowId,
              }
            }),
            Effect.mapError(
              (cause) =>
                new CoinbaseRecordNormalizationError({
                  message: `Failed to resolve Coinbase asset for ${currencyCode}`,
                  cause,
                })
            )
          ),
        resolveBlockchainId: (networkName) =>
          Option.fromNullishOr(lookups.blockchainIdByName.get(networkName.toLowerCase())),
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

      const pairedRecord =
        resolvedTransactionType.resolutionStrategy === "paired_spread_fee" &&
        isNegativeAmount(normalizedMetadata.amount.amount)
          ? yield* resolvePairedSpreadRecord({
              sourceRecord,
              providerTransactionType: normalized.transaction.providerTransactionType,
              providerStatus: normalized.transaction.providerStatus,
              amount: normalizedMetadata.amount,
              nativeAmount: normalizedMetadata.nativeAmount,
            })
          : null

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
      const primaryProviderAssetId = primaryAssetResolution.providerAssetRowId
      const baseTransactionReview = determineCoinbaseReview({
        providerTransactionType: normalized.transaction.providerTransactionType,
        resolvedTransactionType,
        principalId: source.principalId,
      })
      const reviewableAssetCurrencies = primaryAssetResolution.requiresReview
        ? [normalized.primaryAssetCurrency.toUpperCase(), ...normalized.unresolvedAssetCurrencies]
        : normalized.unresolvedAssetCurrencies
      const unresolvedAssetCurrencies = Array.from(new Set(reviewableAssetCurrencies))
        .filter((currencyCode) => !excludedAssetCurrencies.has(currencyCode.toUpperCase()))
        .sort()
      const transactionReview =
        unresolvedAssetCurrencies.length === 0
          ? baseTransactionReview
          : buildProviderAssetMappingReview({
              existingReview: baseTransactionReview,
              resolvedTransactionType,
              principalId: source.principalId,
              affectedCurrencies: unresolvedAssetCurrencies,
            })
      const providerAssetRowIds = Array.from(
        new Set([primaryProviderAssetId, ...normalized.feeProviderAssetRowIds])
      )
      const primaryProviderTransfer =
        normalized.primaryProviderTransfer === null
          ? null
          : {
              ...normalized.primaryProviderTransfer,
              providerAssetId:
                normalized.primaryProviderTransfer.providerAssetId ?? primaryProviderAssetId,
            }
      const providerTransfers = primaryProviderTransfer === null ? [] : [primaryProviderTransfer]
      const shouldDeriveLegs =
        normalized.transaction.providerTransactionType !== "tx" ||
        (hasSuccessfulProviderStatus(normalized.transaction.providerStatus) &&
          !isZeroAmount(normalizedMetadata.amount.amount))
      const hasAssetDecisionOnlySkip =
        primaryAssetResolution.excluded ||
        primaryAssetResolution.requiresReview ||
        excludedAssetCurrencies.size > 0 ||
        unresolvedAssetCurrencies.length > 0
      const assetDecisionLegDerivationCandidate =
        shouldDeriveLegs && hasAssetDecisionOnlySkip && primaryProviderAssetId !== null
          ? {
              providerAssetRowId: primaryProviderAssetId,
              currencyCode: normalized.primaryAssetCurrency.toUpperCase(),
            }
          : null
      const shouldDeriveMainLeg =
        assetDecisionLegDerivationCandidate !== null ||
        normalized.transaction.providerTransactionType !== "tx" ||
        Option.isSome(maybePrimaryAsset)

      return {
        providerAssetRowIds,
        transaction: {
          ...normalized.transaction,
          transactionType: resolvedTransactionType.transactionType,
          metadata: {
            ...normalizedMetadata,
            coinbaseReferenceMapping: resolvedTransactionType,
            ...(primaryProviderAssetId === null
              ? {}
              : { providerAssetRowId: primaryProviderAssetId }),
            ...(pairedRecord === null ? {} : { pairedRecord }),
          },
        },
        venueContext: normalized.venueContext,
        providerTransfers,
        primaryProviderTransfer,
        canonicalTransfers: normalized.canonicalTransfers,
        feeTransferCandidates: normalized.feeTransferCandidates,
        transactionReview,
        transactionReviewWithoutProviderAssetMapping: baseTransactionReview,
        resolvedTransactionType,
        primaryAsset: Option.getOrNull(maybePrimaryAsset),
        legDerivationStrategy: !shouldDeriveLegs || hasAssetDecisionOnlySkip ? "skip" : "derive",
        assetDecisionLegDerivationCandidate,
        deriveMainLeg: shouldDeriveMainLeg,
      }
    })

  const deriveLegs: CoinbaseSourceSyncProviderShape["deriveLegs"] = ({
    transaction,
    venueContext,
    primaryAsset,
    primaryProviderTransferId,
    canonicalTransfers,
    deriveMainLeg,
  }) =>
    Effect.gen(function* () {
      const resolvedFeeTransfers = yield* Effect.forEach(canonicalTransfers, (transfer) =>
        Effect.gen(function* () {
          const asset = yield* resolveCanonicalAsset({
            assetId: transfer.assetId,
            message: `Missing asset row for fee transfer asset ${transfer.assetId}`,
          })
          if (transfer.providerAssetRowId === null || transfer.providerAssetRowId === undefined) {
            return yield* new CoinbaseLegDerivationError({
              message: "Coinbase fee transfer is missing its provider asset identity",
              cause: { transferId: transfer.id },
            })
          }
          return {
            transfer,
            asset,
            providerAssetRowId: transfer.providerAssetRowId,
          }
        })
      )

      const derived = yield* coinbaseLegDerivationService.deriveLegs({
        transaction,
        venueContext,
        primaryAsset,
        primaryProviderTransferId,
        feeTransfers: resolvedFeeTransfers,
        deriveMainLeg,
      })

      return { _tag: "derived", legs: derived.legs } as const
    }).pipe(
      Effect.catchTag("CoinbaseLegDerivationError", () =>
        Effect.succeed({ _tag: "withheld", reason: "malformed_movement" } as const)
      )
    )

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
    refreshDefaultMappings: coinbaseReferenceDataService.refreshDefaultMappings,
    loadNormalizationLookups,
    prepareNormalization,
    deriveLegs,
  } satisfies CoinbaseSourceSyncProviderShape)
})

/**
 * CoinbaseSourceSyncProviderLive - Live layer for the Coinbase provider module.
 */
export const CoinbaseSourceSyncProviderLive = Layer.effect(CoinbaseSourceSyncProvider, make)
