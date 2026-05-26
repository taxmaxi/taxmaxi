/**
 * HeliusSolanaSourceSyncProviderLive - Helius Solana raw-history ingestion provider.
 *
 * @module HeliusSolanaSourceSyncProviderLive
 */

import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncCursorDecodeError,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
  type FetchProviderRawBatchParams,
  type SourceSyncProviderError,
} from "../../../shared/SourceProviderRawBatch.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
  HeliusSolanaCursorDecodeError,
  HeliusSolanaNormalizationNotImplementedError,
  HeliusSolanaPayloadDecodeError,
  HeliusSolanaSourceSyncProvider,
  type HeliusSolanaNormalizationLookups,
  type HeliusSolanaReferenceDataRefreshResult,
  type HeliusSolanaSourceSyncProviderShape,
} from "../services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientError,
} from "../services/HeliusSolanaSyncClient.ts"
import { HeliusSolanaAssetResolutionService } from "../services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaAssetResolutionServiceLive,
  toHeliusSolanaReferenceDataRefreshResult,
} from "./HeliusSolanaAssetResolutionServiceLive.ts"
import { HeliusSolanaSyncClientLive } from "./HeliusSolanaSyncClientLive.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

const HELIUS_SOLANA_NORMALIZATION_MESSAGE = "Helius Solana normalization is not implemented yet."

const emptyReferenceDataRefresh = {
  transactionTypeCatalogCount: 0,
  providerAssetCatalogCount: 0,
  defaultTransactionMappingCount: 0,
  defaultProviderAssetMappingCount: 0,
} satisfies HeliusSolanaReferenceDataRefreshResult

const normalizationLookups = {
  providerKey: HELIUS_SOLANA_PROVIDER_KEY,
} satisfies HeliusSolanaNormalizationLookups

const HeliusSolanaCursorPayloadSchema = Schema.Struct({
  paginationToken: Schema.NullOr(Schema.String),
  resumeBoundaryActive: Schema.optional(Schema.Boolean),
  resumeCheckpointExternalId: Schema.optional(Schema.NullOr(Schema.String)),
  resumeHighWatermarkIso: Schema.optional(Schema.NullOr(Schema.String)),
})

const HeliusSolanaTransactionsPageSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  paginationToken: Schema.NullOr(Schema.String),
})

const HeliusSolanaFullTransactionEntrySchema = Schema.Struct({
  slot: Schema.Number,
  transactionIndex: Schema.Number,
  transaction: Schema.Struct({
    signatures: Schema.Array(Schema.String),
  }),
  meta: Schema.NullOr(Schema.Unknown),
  blockTime: Schema.NullOr(Schema.Number),
})

interface HeliusSolanaCursorPayload {
  readonly paginationToken: string | null
  readonly resumeBoundaryActive: boolean
  readonly resumeCheckpointExternalId: string | null
  readonly resumeHighWatermark: Date | null
}

interface HeliusSolanaEncodedCursorPayload {
  readonly paginationToken: string | null
  readonly resumeBoundaryActive?: boolean
  readonly resumeCheckpointExternalId?: string | null
  readonly resumeHighWatermarkIso?: string | null
}

interface DecodedHeliusSolanaTransactionEntry {
  readonly signature: string
  readonly blockTime: number
  readonly payload: unknown
}

const decodeUnknownCursorPayload = Schema.decodeUnknown(HeliusSolanaCursorPayloadSchema)
const decodeUnknownTransactionsPage = Schema.decodeUnknown(HeliusSolanaTransactionsPageSchema)
const decodeUnknownFullTransactionEntry = Schema.decodeUnknown(
  HeliusSolanaFullTransactionEntrySchema
)

const toCursorDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaCursorDecodeError({ message })
    : new HeliusSolanaCursorDecodeError({ message, cause })

const toPayloadDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaPayloadDecodeError({ message })
    : new HeliusSolanaPayloadDecodeError({ message, cause })

const decodeCursorPayload = (
  payload: unknown
): Effect.Effect<HeliusSolanaCursorPayload, HeliusSolanaCursorDecodeError> => {
  if (payload === null || payload === undefined) {
    return Effect.succeed({
      paginationToken: null,
      resumeBoundaryActive: false,
      resumeCheckpointExternalId: null,
      resumeHighWatermark: null,
    })
  }

  return Effect.gen(function* () {
    const decoded = yield* decodeUnknownCursorPayload(payload).pipe(
      Effect.mapError((cause) =>
        toCursorDecodeError(
          `Invalid persisted Helius Solana cursor payload: ${cause.message}`,
          cause
        )
      )
    )
    const resumeHighWatermarkIso = decoded.resumeHighWatermarkIso ?? null
    const resumeHighWatermark =
      resumeHighWatermarkIso === null
        ? null
        : yield* Timestamp.fromString(resumeHighWatermarkIso).pipe(
            Effect.map((timestamp) => timestamp.toDate()),
            Effect.mapError((cause) =>
              toCursorDecodeError(
                `Invalid persisted Helius Solana resume high watermark: ${resumeHighWatermarkIso}`,
                cause
              )
            )
          )

    return {
      paginationToken: decoded.paginationToken,
      resumeBoundaryActive: decoded.resumeBoundaryActive ?? false,
      resumeCheckpointExternalId: decoded.resumeCheckpointExternalId ?? null,
      resumeHighWatermark,
    }
  })
}

const encodeCursorPayload = (payload: HeliusSolanaCursorPayload): unknown => {
  const encoded: HeliusSolanaEncodedCursorPayload =
    payload.resumeBoundaryActive ||
    payload.resumeCheckpointExternalId !== null ||
    payload.resumeHighWatermark !== null
      ? {
          paginationToken: payload.paginationToken,
          resumeBoundaryActive: payload.resumeBoundaryActive,
          resumeCheckpointExternalId: payload.resumeCheckpointExternalId,
          resumeHighWatermarkIso:
            payload.resumeHighWatermark === null
              ? null
              : Timestamp.fromDate(payload.resumeHighWatermark).toISOString(),
        }
      : {
          paginationToken: payload.paginationToken,
        }

  return encoded
}

const decodeTransactionsPage = (
  payload: unknown
): Effect.Effect<
  { readonly data: ReadonlyArray<unknown>; readonly paginationToken: string | null },
  HeliusSolanaPayloadDecodeError
> =>
  decodeUnknownTransactionsPage(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana transactions page: ${cause.message}`, cause)
    )
  )

const decodeTransactionEntry = (
  payload: unknown
): Effect.Effect<DecodedHeliusSolanaTransactionEntry, HeliusSolanaPayloadDecodeError> =>
  decodeUnknownFullTransactionEntry(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana full transaction entry: ${cause.message}`, cause)
    ),
    Effect.flatMap((decoded) => {
      const signature = decoded.transaction.signatures[0]

      if (signature === undefined || signature.trim() === "") {
        return Effect.fail(
          toPayloadDecodeError("Invalid Helius Solana full transaction entry: missing signature")
        )
      }

      if (decoded.blockTime === null) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}: missing blockTime`
          )
        )
      }

      if (!Number.isFinite(decoded.blockTime)) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}`
          )
        )
      }

      return Effect.succeed({
        signature,
        blockTime: decoded.blockTime,
        payload,
      })
    })
  )

const occurredAtFromBlockTime = (blockTime: number): Date => new Date(blockTime * 1_000)

const makeRawRecord = ({
  walletAddress,
  entry,
}: {
  readonly walletAddress: string
  readonly entry: DecodedHeliusSolanaTransactionEntry
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    recordType: HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
    externalRecordId: entry.signature,
    externalAccountId: walletAddress,
    externalParentId: null,
    occurredAt: occurredAtFromBlockTime(entry.blockTime),
    payload: entry.payload,
  })

const maxOccurredAt = (records: ReadonlyArray<ProviderRawRecord>): Date | null =>
  records.reduce<Date | null>(
    (current, record) => Timestamp.maxNullableDate(current, record.occurredAt),
    null
  )

interface IncrementalBoundaryScanResult {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly reachedBoundary: boolean
}

const inactiveCursorPayload = (paginationToken: string | null): HeliusSolanaCursorPayload => ({
  paginationToken,
  resumeBoundaryActive: false,
  resumeCheckpointExternalId: null,
  resumeHighWatermark: null,
})

const makeNextCursorPayload = ({
  paginationToken,
  isIncrementalBoundaryScan,
  reachedBoundary,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly paginationToken: string | null
  readonly isIncrementalBoundaryScan: boolean
  readonly reachedBoundary: boolean
  readonly resumeHighWatermark: Date | null
  readonly resumeCheckpointExternalId: string | null
}): HeliusSolanaCursorPayload => {
  if (reachedBoundary || paginationToken === null) {
    return inactiveCursorPayload(null)
  }

  if (isIncrementalBoundaryScan && resumeHighWatermark !== null) {
    return {
      paginationToken,
      resumeBoundaryActive: true,
      resumeCheckpointExternalId,
      resumeHighWatermark,
    }
  }

  return inactiveCursorPayload(paginationToken)
}

const scanIncrementalBoundary = ({
  records,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly records: ReadonlyArray<ProviderRawRecord>
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
        record.externalRecordId === resumeCheckpointExternalId)
    )
  })

  return {
    records: boundaryIndex === -1 ? records : records.slice(0, boundaryIndex),
    reachedBoundary: boundaryIndex !== -1,
  }
}

const toSharedCursorDecodeError = (error: HeliusSolanaCursorDecodeError) =>
  new SourceSyncCursorDecodeError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
  })

const toProviderFailureError = (
  error: HeliusSolanaSyncClientError | HeliusSolanaPayloadDecodeError
): SourceSyncProviderFailureError => {
  if (error instanceof HeliusSolanaAuthError) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: false,
    })
  }

  if (error instanceof HeliusSolanaProviderError) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: error.retryable,
    })
  }

  return new SourceSyncProviderFailureError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
    retryable: false,
  })
}

const normalizationNotImplemented = (cause: unknown) =>
  new HeliusSolanaNormalizationNotImplementedError({
    message: HELIUS_SOLANA_NORMALIZATION_MESSAGE,
    cause,
  })

const isRetryableFailure = (error: SourceSyncProviderError): boolean =>
  error._tag === "SourceSyncProviderFailureError" && error.retryable

const toReferenceRefreshStorageError = (cause: unknown): SyncEngineStorageError =>
  cause instanceof SyncEngineStorageError
    ? cause
    : new SyncEngineStorageError({
        operation: "heliusSolanaSourceSyncProvider.refreshReferenceData",
        cause,
      })

const make = ({
  refreshReferenceData,
}: {
  readonly refreshReferenceData: HeliusSolanaSourceSyncProviderShape["refreshReferenceData"]
}) =>
  Effect.gen(function* () {
    const heliusSyncClient = yield* HeliusSolanaSyncClient

    const fetchHeliusRawBatch = ({
      sourceId,
      walletAddress,
      cursorPayload,
      resumeHighWatermark,
      resumeCheckpointExternalId,
      pageSize,
    }: {
      readonly sourceId: string
      readonly walletAddress: string | null
      readonly cursorPayload: unknown
      readonly resumeHighWatermark: Date | null
      readonly resumeCheckpointExternalId: string | null
      readonly pageSize: number
    }) =>
      Effect.gen(function* () {
        const cursor = yield* decodeCursorPayload(cursorPayload).pipe(
          Effect.mapError(toSharedCursorDecodeError)
        )

        if (walletAddress === null || walletAddress.trim() === "") {
          return yield* Effect.fail(
            new SourceSyncProviderFailureError({
              providerKey: HELIUS_SOLANA_PROVIDER_KEY,
              message: `Helius Solana source ${sourceId} has no wallet address`,
              retryable: false,
            })
          )
        }

        const page = yield* heliusSyncClient
          .fetchTransactionsForAddress({
            walletAddress,
            config: {
              limit: pageSize,
              paginationToken: cursor.paginationToken,
              transactionDetails: "full",
              sortOrder: "desc",
              filters: {
                status: "any",
                tokenAccounts: "balanceChanged",
              },
            },
          })
          .pipe(Effect.mapError(toProviderFailureError))

        const decodedPage = yield* decodeTransactionsPage(page).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const entries = yield* Effect.forEach(decodedPage.data, decodeTransactionEntry).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const records = entries.map((entry) => makeRawRecord({ walletAddress, entry }))
        const activeResumeHighWatermark = cursor.resumeHighWatermark ?? resumeHighWatermark
        const activeResumeCheckpointExternalId =
          cursor.resumeCheckpointExternalId ?? resumeCheckpointExternalId
        const isIncrementalBoundaryScan =
          activeResumeHighWatermark !== null &&
          (cursor.resumeBoundaryActive || cursor.paginationToken === null)
        const boundaryScan = isIncrementalBoundaryScan
          ? scanIncrementalBoundary({
              records,
              resumeHighWatermark: activeResumeHighWatermark,
              resumeCheckpointExternalId: activeResumeCheckpointExternalId,
            })
          : {
              records,
              reachedBoundary: false,
            }
        const filteredRecords = boundaryScan.records
        const nextCursor = makeNextCursorPayload({
          paginationToken: decodedPage.paginationToken,
          isIncrementalBoundaryScan,
          reachedBoundary: boundaryScan.reachedBoundary,
          resumeHighWatermark: activeResumeHighWatermark,
          resumeCheckpointExternalId: activeResumeCheckpointExternalId,
        })

        yield* Effect.logInfo(
          {
            sourceId,
            provider: HELIUS_SOLANA_PROVIDER_KEY,
            pageSize,
            hasPaginationToken: cursor.paginationToken !== null,
            resumeBoundaryActive: isIncrementalBoundaryScan,
            reachedResumeBoundary: boundaryScan.reachedBoundary,
            recordCount: filteredRecords.length,
            retryable: false,
          },
          "helius-solana:raw-batch"
        )

        return FetchProviderRawBatchResult.make({
          records: filteredRecords,
          cursorPayload: encodeCursorPayload(nextCursor),
          highWatermark: maxOccurredAt(filteredRecords),
          done: boundaryScan.reachedBoundary || decodedPage.paginationToken === null,
        })
      })

    const fetchRawBatch: HeliusSolanaSourceSyncProviderShape["fetchRawBatch"] = (
      params: FetchProviderRawBatchParams
    ) => {
      if (params.providerKey !== HELIUS_SOLANA_PROVIDER_KEY) {
        return Effect.fail(new UnsupportedSyncProviderError({ providerKey: params.providerKey }))
      }

      return fetchHeliusRawBatch({
        sourceId: params.sourceId,
        walletAddress: params.walletAddress,
        cursorPayload: params.cursorPayload,
        resumeHighWatermark: params.resumeHighWatermark,
        resumeCheckpointExternalId: params.resumeCheckpointExternalId,
        pageSize: params.pageSize,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            {
              sourceId: params.sourceId,
              provider: HELIUS_SOLANA_PROVIDER_KEY,
              pageSize: params.pageSize,
              hasPaginationToken:
                params.cursorPayload !== null && params.cursorPayload !== undefined,
              recordCount: 0,
              retryable: isRetryableFailure(error),
            },
            "helius-solana:raw-batch-failed"
          )
        )
      )
    }

    return HeliusSolanaSourceSyncProvider.of({
      fetchRawBatch,
      refreshReferenceData,
      loadNormalizationLookups: () => Effect.succeed(normalizationLookups),
      prepareNormalization: ({ source, sourceRecord, lookups }) =>
        Effect.fail(
          normalizationNotImplemented({
            sourceId: source.id,
            providerKey: lookups.providerKey,
            recordType: sourceRecord.recordType,
            externalRecordId: sourceRecord.externalRecordId,
          })
        ),
      deriveLegs: ({ transaction }) =>
        Effect.fail(
          normalizationNotImplemented({
            transactionId: transaction.id,
            externalId: transaction.externalId,
          })
        ),
    } satisfies HeliusSolanaSourceSyncProviderShape)
  })

const makeWithEmptyReferenceData = make({
  refreshReferenceData: () => Effect.succeed(emptyReferenceDataRefresh),
})

const makeWithAssetResolutionReferenceData = Effect.gen(function* () {
  const assetResolutionService = yield* HeliusSolanaAssetResolutionService

  return yield* make({
    refreshReferenceData: () =>
      assetResolutionService
        .ensureDefaultMappings()
        .pipe(
          Effect.map(toHeliusSolanaReferenceDataRefreshResult),
          Effect.mapError(toReferenceRefreshStorageError)
        ),
  })
})

/**
 * HeliusSolanaSourceSyncProviderFromClientLive - Helius provider layer with an injectable client.
 */
export const HeliusSolanaSourceSyncProviderFromClientLive: Layer.Layer<
  HeliusSolanaSourceSyncProvider,
  never,
  HeliusSolanaSyncClient
> = Layer.effect(HeliusSolanaSourceSyncProvider, makeWithEmptyReferenceData)

/**
 * HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive - Injectable Helius provider with asset reference refresh.
 */
export const HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive = Layer.effect(
  HeliusSolanaSourceSyncProvider,
  makeWithAssetResolutionReferenceData
)

/**
 * HeliusSolanaSourceSyncProviderLive - Production Helius Solana provider layer.
 */
export const HeliusSolanaSourceSyncProviderLive =
  HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive.pipe(
    Layer.provide(HeliusSolanaAssetResolutionServiceLive),
    Layer.provide(HeliusSolanaSyncClientLive)
  )
