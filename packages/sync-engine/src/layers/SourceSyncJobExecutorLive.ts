/**
 * SourceSyncJobExecutorLive - Worker-facing source sync/replay execution.
 *
 * Owns provider execution for one existing DB job: sync/replay loops,
 * normalization, progress persistence, terminal completion/failure, and telemetry.
 * Provider failures are reified with `Effect.either` so failed jobs can be
 * persisted before returning a failed public summary.
 *
 * @module SourceSyncJobExecutorLive
 */

import * as Config from "effect/Config"
import * as Either from "effect/Either"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import {
  CoinbaseSourceSyncProvider,
  type CoinbaseRecoverableNormalizationError,
  type CoinbaseNormalizationLookups,
  type CoinbaseReferenceDataServiceError,
  type CoinbaseSourceSyncProviderShape,
} from "../providers/coinbase/index.ts"
import {
  type PersistNormalizedSourceArtifactsContext,
  FetchProviderRawBatchParams,
  SourceNormalizationRepository,
  SourceNotFoundError,
  SourceRawRecordRepository,
  SourceReplayRepository,
  SourceRepository,
  type SourceRawRecord,
  type SourceSyncExecutionState,
  type SourceSyncJobMode,
  type SourceSyncJobSummary,
  type SourceSyncSource,
  SourceSyncJobExecutionConflictError,
  SourceSyncJobExecutionNotFoundError,
  SourceSyncJobExecutionPayloadError,
  SourceSyncJobRetryableExecutionError,
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
  SourceSyncProvider,
  type SourceSyncProviderError,
  SourceSyncStateRepository,
  SyncEngineStorageError,
  TransferReconciliationService,
  UnsupportedProviderError,
  type SourceSyncJobExecutorShape,
} from "../services/index.ts"
import {
  highWatermarkToIso,
  nowDate,
  recordSourceSyncJobOutcome,
  sourceSyncSpan,
  trackSourceSyncJobDuration,
} from "./internal/SourceSyncTelemetry.ts"

interface NormalizationSummary {
  readonly normalizedRecords: number
  readonly failedRecords: number
}

interface SyncLoopState {
  readonly execution: SourceSyncExecutionState
  readonly done: boolean
}

type SourceProviderModule = CoinbaseSourceSyncProviderShape
type SourceProviderNormalizationLookups = CoinbaseNormalizationLookups
type SourceSyncExecutionError =
  | UnsupportedProviderError
  | CoinbaseReferenceDataServiceError
  | SourceSyncProviderError
  | SyncEngineStorageError

const DEFAULT_SYNC_PAGE_SIZE = 100
const DEFAULT_SOURCE_SYNC_WORKER_ID = "source-sync-inline-executor"

const UnknownSyncErrorSchema = Schema.Struct({
  message: Schema.NonEmptyTrimmedString,
})

const decodeUnknownSyncError = Schema.decodeUnknownEither(UnknownSyncErrorSchema)

const COINBASE_SYNC_PAGE_SIZE_CONFIG = Config.integer("COINBASE_SYNC_PAGE_SIZE").pipe(
  Config.map((configuredPageSize) =>
    configuredPageSize > 0 ? configuredPageSize : DEFAULT_SYNC_PAGE_SIZE
  ),
  Config.orElse(() => Config.succeed(DEFAULT_SYNC_PAGE_SIZE))
)

const errorMessage = (error: unknown): string => {
  if (typeof error === "string" && error.trim() !== "") {
    return error
  }

  return Either.match(decodeUnknownSyncError(error), {
    onLeft: () => "Sync execution failed",
    onRight: ({ message }) => message,
  })
}

const isRetryableExecutionError = (error: SourceSyncExecutionError): boolean =>
  error._tag === "SourceSyncProviderFailureError" && error.retryable

const make = Effect.gen(function* () {
  const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider
  const sourceRepository = yield* SourceRepository
  const sourceSyncJobRepository = yield* SourceSyncJobRepository
  const sourceSyncStateRepository = yield* SourceSyncStateRepository
  const sourceRawRecordRepository = yield* SourceRawRecordRepository
  const sourceNormalizationRepository = yield* SourceNormalizationRepository
  const sourceReplayRepository = yield* SourceReplayRepository
  const sourceSyncProvider = yield* SourceSyncProvider
  const transferReconciliationService = yield* TransferReconciliationService
  const pageSize = yield* COINBASE_SYNC_PAGE_SIZE_CONFIG

  const loadSource = ({
    principalId,
    sourceId,
  }: {
    readonly principalId: string
    readonly sourceId: string
  }): Effect.Effect<SourceSyncSource, SourceNotFoundError | SyncEngineStorageError> =>
    sourceRepository.findOwnedSourceSyncContext({ principalId, sourceId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new SourceNotFoundError({ sourceId })),
          onSome: Effect.succeed,
        })
      ),
      sourceSyncSpan({
        name: "source-sync-executor.load-source",
        attributes: { principalId, sourceId },
        kind: "client",
      })
    )

  const heartbeatSourceSyncJob = ({
    jobId,
    workerId,
  }: {
    readonly jobId: string
    readonly workerId: string
  }): Effect.Effect<void, SyncEngineStorageError> =>
    sourceSyncJobRepository.heartbeatJob({ jobId, workerId, heartbeatAt: nowDate() }).pipe(
      Effect.mapError((cause) => {
        if (cause._tag === "SyncEngineStorageError") {
          return cause
        }

        return new SyncEngineStorageError({
          operation: "sourceSyncJobExecutor.heartbeatJob",
          cause,
        })
      })
    )

  const resolveProviderModule = ({
    providerKey,
  }: {
    readonly providerKey: string
  }): Effect.Effect<SourceProviderModule, UnsupportedProviderError> => {
    switch (providerKey) {
      case "coinbase":
        return Effect.succeed(coinbaseSourceSyncProvider)
      default:
        return Effect.fail(new UnsupportedProviderError({ provider: providerKey }))
    }
  }

  const markRawRecordFailure = ({
    rawRecordId,
    message,
  }: {
    readonly rawRecordId: string
    readonly message: string
  }) => sourceRawRecordRepository.markRawRecordFailed({ rawRecordId, message })

  const markRecoverableNormalizationFailure = ({
    rawRecordId,
    error,
  }: {
    readonly rawRecordId: string
    readonly error: CoinbaseRecoverableNormalizationError
  }) =>
    markRawRecordFailure({
      rawRecordId,
      message: error.message,
    }).pipe(
      Effect.as({
        normalizedRecords: 0,
        failedRecords: 1,
      } satisfies NormalizationSummary)
    )

  const normalizeRawRecord = ({
    source,
    rawRecord,
    providerModule,
    lookups,
  }: {
    readonly source: SourceSyncSource
    readonly rawRecord: SourceRawRecord
    readonly providerModule: SourceProviderModule
    readonly lookups: SourceProviderNormalizationLookups
  }): Effect.Effect<NormalizationSummary, SyncEngineStorageError> =>
    Effect.gen(function* () {
      if (rawRecord.normalizedAt !== null) {
        return { normalizedRecords: 0, failedRecords: 0 } satisfies NormalizationSummary
      }

      if (rawRecord.recordType !== "coinbase_transaction") {
        yield* sourceRawRecordRepository.markRawRecordNormalized({
          rawRecordId: rawRecord.id,
        })

        return { normalizedRecords: 1, failedRecords: 0 } satisfies NormalizationSummary
      }

      const prepared = yield* providerModule.prepareNormalization({
        source,
        sourceRecord: rawRecord,
        lookups,
      })

      yield* sourceNormalizationRepository.persistNormalizedArtifacts(
        prepared.legDerivationStrategy === "derive"
          ? {
              transaction: prepared.transaction,
              venueContext: prepared.venueContext,
              providerTransfers: prepared.providerTransfers,
              feeTransfers: prepared.feeTransfers,
              transactionReview: prepared.transactionReview,
              resolvedTransactionType: prepared.resolvedTransactionType,
              deriveLegs: ({
                transaction,
                venueContext,
                feeTransfers,
              }: PersistNormalizedSourceArtifactsContext) =>
                providerModule.deriveLegs({
                  transaction,
                  venueContext,
                  primaryAsset: prepared.primaryAsset,
                  feeTransfers,
                }),
            }
          : {
              transaction: prepared.transaction,
              venueContext: prepared.venueContext,
              providerTransfers: prepared.providerTransfers,
              feeTransfers: prepared.feeTransfers,
              transactionReview: prepared.transactionReview,
              resolvedTransactionType: prepared.resolvedTransactionType,
              legs: [],
            }
      )

      return {
        normalizedRecords: 1,
        failedRecords: 0,
      } satisfies NormalizationSummary
    }).pipe(
      Effect.catchTag("CoinbaseRecordNormalizationError", (error) =>
        markRecoverableNormalizationFailure({ rawRecordId: rawRecord.id, error })
      ),
      Effect.catchTag("CoinbasePendingTransactionTypeMappingError", (error) =>
        markRecoverableNormalizationFailure({ rawRecordId: rawRecord.id, error })
      ),
      Effect.catchTag("CoinbaseBrokenApprovedProviderAssetMappingError", (error) =>
        markRecoverableNormalizationFailure({ rawRecordId: rawRecord.id, error })
      ),
      Effect.catchTag("CoinbaseLegDerivationError", (error) =>
        markRecoverableNormalizationFailure({ rawRecordId: rawRecord.id, error })
      ),
      Effect.mapError(
        (error) =>
          new SyncEngineStorageError({
            operation: "sourceSyncJobExecutor.normalizeRawRecord",
            cause: error,
          })
      )
    )

  const normalizeRawBatch = ({
    source,
    rawRecords,
    providerModule,
    lookups,
  }: {
    readonly source: SourceSyncSource
    readonly rawRecords: ReadonlyArray<SourceRawRecord>
    readonly providerModule: SourceProviderModule
    readonly lookups: SourceProviderNormalizationLookups
  }): Effect.Effect<NormalizationSummary, SyncEngineStorageError> =>
    Effect.reduce(
      rawRecords,
      { normalizedRecords: 0, failedRecords: 0 } as NormalizationSummary,
      (state, rawRecord) =>
        normalizeRawRecord({ source, rawRecord, providerModule, lookups }).pipe(
          Effect.map((summary) => ({
            normalizedRecords: state.normalizedRecords + summary.normalizedRecords,
            failedRecords: state.failedRecords + summary.failedRecords,
          }))
        )
    )

  const replayFailedRawRecords = ({
    source,
    providerModule,
    lookups,
    importedBefore,
  }: {
    readonly source: SourceSyncSource
    readonly providerModule: SourceProviderModule
    readonly lookups: SourceProviderNormalizationLookups
    readonly importedBefore: Date
  }): Effect.Effect<NormalizationSummary, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const replayCandidates = yield* sourceRawRecordRepository.listReplayCandidates({
        sourceId: source.id,
        importedBefore,
      })

      if (replayCandidates.length === 0) {
        return { normalizedRecords: 0, failedRecords: 0 } satisfies NormalizationSummary
      }

      return yield* normalizeRawBatch({
        source,
        rawRecords: replayCandidates,
        providerModule,
        lookups,
      })
    })

  const runSync = ({
    source,
    jobId,
    workerId,
  }: {
    readonly source: SourceSyncSource
    readonly jobId: string
    readonly workerId: string
  }): Effect.Effect<SourceSyncExecutionState, SourceSyncExecutionError> =>
    Effect.gen(function* () {
      const provider = source.providerKey ?? "unknown"
      const providerModule = yield* resolveProviderModule({ providerKey: provider })
      const replayImportedBefore = nowDate()
      const referenceRefresh = yield* providerModule.refreshReferenceData().pipe(
        sourceSyncSpan({
          name: "source-sync.refresh-reference-data",
          attributes: { sourceId: source.id, jobId, provider },
          kind: "client",
        })
      )

      yield* Effect.logInfo(
        {
          sourceId: source.id,
          jobId,
          provider,
          transactionTypeCatalogCount: referenceRefresh.transactionTypeCatalogCount,
          providerAssetCatalogCount: referenceRefresh.providerAssetCatalogCount,
          defaultTransactionMappingCount: referenceRefresh.defaultTransactionMappingCount,
          defaultProviderAssetMappingCount: referenceRefresh.defaultProviderAssetMappingCount,
        },
        "source-sync:reference-data-refreshed"
      )

      const initialExecution = yield* sourceSyncStateRepository
        .getExecutionState({ sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-sync.load-execution-state",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const lookups = yield* providerModule.loadNormalizationLookups().pipe(
        sourceSyncSpan({
          name: "source-sync.load-normalization-lookups",
          attributes: { sourceId: source.id, jobId, provider },
          kind: "client",
        })
      )
      const resumeHighWatermark = initialExecution.highWatermark
      const resumeCheckpointExternalId = initialExecution.checkpointExternalId

      yield* Effect.logInfo(
        {
          sourceId: source.id,
          jobId,
          provider,
          resumeHighWatermark: highWatermarkToIso(resumeHighWatermark),
          resumeCheckpointExternalId,
        },
        "source-sync:start"
      )

      const initialLoop: SyncLoopState = {
        execution: initialExecution,
        done: false,
      }

      const finalLoop = yield* Effect.iterate(initialLoop, {
        while: (loop) => !loop.done,
        body: (loop) =>
          Effect.gen(function* () {
            const nextBatch = yield* sourceSyncProvider
              .fetchRawBatch(
                FetchProviderRawBatchParams.make({
                  providerKey: provider,
                  sourceId: source.id,
                  cursorPayload: loop.execution.cursorPayload,
                  resumeHighWatermark,
                  resumeCheckpointExternalId,
                  pageSize,
                })
              )
              .pipe(
                sourceSyncSpan({
                  name: "source-sync.fetch-raw-batch",
                  attributes: { sourceId: source.id, jobId, provider },
                  kind: "client",
                })
              )

            const checkpoint = yield* sourceRawRecordRepository
              .upsertRawBatch({ sourceId: source.id, records: nextBatch.records })
              .pipe(
                sourceSyncSpan({
                  name: "source-sync.persist-raw-batch",
                  attributes: {
                    sourceId: source.id,
                    jobId,
                    provider,
                    recordCount: nextBatch.records.length,
                  },
                  kind: "client",
                })
              )
            const normalization = yield* normalizeRawBatch({
              source,
              rawRecords: checkpoint.rawRecords,
              providerModule,
              lookups,
            }).pipe(
              sourceSyncSpan({
                name: "source-sync.normalize-raw-batch",
                attributes: {
                  sourceId: source.id,
                  jobId,
                  provider,
                  rawRecordCount: checkpoint.rawRecords.length,
                },
              })
            )

            const nextExecution: SourceSyncExecutionState = {
              ...loop.execution,
              importedRecords: loop.execution.importedRecords + nextBatch.records.length,
              normalizedRecords: loop.execution.normalizedRecords + normalization.normalizedRecords,
              failedRecords: loop.execution.failedRecords + normalization.failedRecords,
              cursorPayload: nextBatch.cursorPayload,
              highWatermark: Timestamp.maxNullableDate(
                loop.execution.highWatermark,
                nextBatch.highWatermark
              ),
              checkpointExternalId:
                checkpoint.checkpointExternalId ?? loop.execution.checkpointExternalId,
              checkpointRawRecordId:
                checkpoint.checkpointRawRecordId ?? loop.execution.checkpointRawRecordId,
            }

            yield* sourceSyncStateRepository.persistProgress({
              sourceId: source.id,
              jobId,
              state: nextExecution,
              lastSyncedAt: null,
              lastErrorMessage: null,
            })
            yield* heartbeatSourceSyncJob({ jobId, workerId })

            yield* Effect.annotateCurrentSpan({
              sourceId: source.id,
              jobId,
              provider,
              importedRecords: nextExecution.importedRecords,
              normalizedRecords: nextExecution.normalizedRecords,
              failedRecords: nextExecution.failedRecords,
              done: nextBatch.done,
            })

            yield* Effect.logInfo(
              {
                sourceId: source.id,
                jobId,
                importedRecords: nextExecution.importedRecords,
                normalizedRecords: nextExecution.normalizedRecords,
                failedRecords: nextExecution.failedRecords,
                checkpointExternalId: nextExecution.checkpointExternalId,
                done: nextBatch.done,
              },
              "source-sync:batch"
            )

            return { execution: nextExecution, done: nextBatch.done } satisfies SyncLoopState
          }),
      })

      const replaySummary = yield* replayFailedRawRecords({
        source,
        providerModule,
        lookups,
        importedBefore: replayImportedBefore,
      }).pipe(
        sourceSyncSpan({
          name: "source-sync.replay-failed-raw-records",
          attributes: { sourceId: source.id, jobId, provider },
        })
      )
      const completedExecution: SourceSyncExecutionState = {
        ...finalLoop.execution,
        normalizedRecords: finalLoop.execution.normalizedRecords + replaySummary.normalizedRecords,
        failedRecords: finalLoop.execution.failedRecords + replaySummary.failedRecords,
      }
      const reconciliationSummary = yield* transferReconciliationService
        .reconcileTransferCandidates({ principalId: source.principalId, sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-sync.reconcile-transfers",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const canonicalizationSummary = yield* transferReconciliationService
        .applyDeterministicInternalTransferCanonicalization({
          principalId: source.principalId,
          sourceId: source.id,
        })
        .pipe(
          sourceSyncSpan({
            name: "source-sync.apply-transfer-canonicalization",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const completedAt = nowDate()

      yield* sourceSyncStateRepository.persistProgress({
        sourceId: source.id,
        jobId,
        state: completedExecution,
        lastSyncedAt: completedAt,
        lastErrorMessage: null,
      })

      yield* Effect.annotateCurrentSpan({
        sourceId: source.id,
        jobId,
        provider,
        importedRecords: completedExecution.importedRecords,
        normalizedRecords: completedExecution.normalizedRecords,
        failedRecords: completedExecution.failedRecords,
        reconciledProviderTransfers: reconciliationSummary.evaluatedProviderTransfers,
        pendingReconciliations: reconciliationSummary.pending,
        reviewReconciliations: reconciliationSummary.needsReview,
        autoAppliedReconciliations: reconciliationSummary.autoApplied,
        canonicalizedInternalTransfers: canonicalizationSummary.canonicalizedPairs,
      })

      yield* Effect.logInfo(
        {
          sourceId: source.id,
          jobId,
          importedRecords: completedExecution.importedRecords,
          normalizedRecords: completedExecution.normalizedRecords,
          failedRecords: completedExecution.failedRecords,
          reconciledProviderTransfers: reconciliationSummary.evaluatedProviderTransfers,
          pendingReconciliations: reconciliationSummary.pending,
          reviewReconciliations: reconciliationSummary.needsReview,
          autoAppliedReconciliations: reconciliationSummary.autoApplied,
          canonicalizedInternalTransfers: canonicalizationSummary.canonicalizedPairs,
        },
        "source-sync:completed"
      )

      return completedExecution
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.run",
        attributes: {
          sourceId: source.id,
          jobId,
          provider: source.providerKey ?? "unknown",
          mode: "sync",
        },
      })
    )

  const runReplay = ({
    source,
    jobId,
    workerId,
  }: {
    readonly source: SourceSyncSource
    readonly jobId: string
    readonly workerId: string
  }): Effect.Effect<SourceSyncExecutionState, SourceSyncExecutionError> =>
    Effect.gen(function* () {
      const provider = source.providerKey ?? "unknown"
      const providerModule = yield* resolveProviderModule({ providerKey: provider })
      const initialExecution = yield* sourceSyncStateRepository
        .getExecutionState({ sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-replay.load-execution-state",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const lookups = yield* providerModule.loadNormalizationLookups().pipe(
        sourceSyncSpan({
          name: "source-replay.load-normalization-lookups",
          attributes: { sourceId: source.id, jobId, provider },
          kind: "client",
        })
      )

      yield* Effect.logInfo({ sourceId: source.id, jobId, provider }, "source-replay:start")

      yield* sourceReplayRepository.resetSourceDerivedState({ sourceId: source.id }).pipe(
        sourceSyncSpan({
          name: "source-replay.reset-derived-state",
          attributes: { sourceId: source.id, jobId, provider },
          kind: "client",
        })
      )
      yield* heartbeatSourceSyncJob({ jobId, workerId })
      const rawRecords = yield* sourceRawRecordRepository
        .listAllRawRowsForReplay({ sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-replay.list-raw-rows",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const normalization = yield* normalizeRawBatch({
        source,
        rawRecords,
        providerModule,
        lookups,
      }).pipe(
        sourceSyncSpan({
          name: "source-replay.normalize-raw-batch",
          attributes: {
            sourceId: source.id,
            jobId,
            provider,
            rawRecordCount: rawRecords.length,
          },
        })
      )

      yield* sourceSyncStateRepository.clearReplayFailureMetadata({ sourceId: source.id })
      yield* heartbeatSourceSyncJob({ jobId, workerId })

      const replayExecution: SourceSyncExecutionState = {
        ...initialExecution,
        importedRecords: rawRecords.length,
        normalizedRecords: normalization.normalizedRecords,
        failedRecords: normalization.failedRecords,
      }
      const reconciliationSummary = yield* transferReconciliationService
        .reconcileTransferCandidates({ principalId: source.principalId, sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-replay.reconcile-transfers",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const canonicalizationSummary = yield* transferReconciliationService
        .applyDeterministicInternalTransferCanonicalization({
          principalId: source.principalId,
          sourceId: source.id,
        })
        .pipe(
          sourceSyncSpan({
            name: "source-replay.apply-transfer-canonicalization",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )

      yield* Effect.annotateCurrentSpan({
        sourceId: source.id,
        jobId,
        provider,
        importedRecords: replayExecution.importedRecords,
        normalizedRecords: replayExecution.normalizedRecords,
        failedRecords: replayExecution.failedRecords,
        reconciledProviderTransfers: reconciliationSummary.evaluatedProviderTransfers,
        pendingReconciliations: reconciliationSummary.pending,
        reviewReconciliations: reconciliationSummary.needsReview,
        autoAppliedReconciliations: reconciliationSummary.autoApplied,
        canonicalizedInternalTransfers: canonicalizationSummary.canonicalizedPairs,
      })

      yield* Effect.logInfo(
        {
          sourceId: source.id,
          jobId,
          importedRecords: replayExecution.importedRecords,
          normalizedRecords: replayExecution.normalizedRecords,
          failedRecords: replayExecution.failedRecords,
          reconciledProviderTransfers: reconciliationSummary.evaluatedProviderTransfers,
          pendingReconciliations: reconciliationSummary.pending,
          reviewReconciliations: reconciliationSummary.needsReview,
          autoAppliedReconciliations: reconciliationSummary.autoApplied,
          canonicalizedInternalTransfers: canonicalizationSummary.canonicalizedPairs,
        },
        "source-replay:completed"
      )

      return replayExecution
    }).pipe(
      sourceSyncSpan({
        name: "source-replay.run",
        attributes: {
          sourceId: source.id,
          jobId,
          provider: source.providerKey ?? "unknown",
          mode: "replay",
        },
      })
    )

  const finalizeSyncFailure = ({
    sourceId,
    jobId,
    provider,
    mode,
    error,
  }: {
    readonly sourceId: string
    readonly jobId: string
    readonly provider: string
    readonly mode: SourceSyncJobMode
    readonly error: unknown
  }): Effect.Effect<
    SourceSyncJobSummary,
    | SyncEngineStorageError
    | SourceSyncJobExecutionNotFoundError
    | SourceSyncJobExecutionConflictError
  > =>
    Effect.gen(function* () {
      const message = errorMessage(error)
      const completedAt = nowDate()

      yield* sourceSyncStateRepository
        .persistFailureMetadata({ sourceId, lastErrorMessage: message })
        .pipe(
          Effect.catchAll((persistError) =>
            Effect.logError(
              {
                sourceId,
                jobId,
                originalMessage: message,
                persistFailureMetadataError: persistError,
              },
              "source-sync:failed-to-persist-failure-metadata"
            )
          )
        )

      yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "failed" })

      yield* Effect.logError({ sourceId, jobId, provider, mode, message }, "source-sync:failed")

      yield* sourceSyncJobRepository.failJob({ jobId, message, completedAt }).pipe(
        Effect.catchTags({
          SourceSyncJobExecutionRecordNotFoundError: () =>
            Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId })),
          SourceSyncJobExecutionRecordConflictError: (recordError) =>
            Effect.fail(
              new SourceSyncJobExecutionConflictError({ jobId, reason: recordError.reason })
            ),
        })
      )

      return {
        sourceId,
        jobId,
        status: "failed",
        message,
      } satisfies SourceSyncJobSummary
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.finalize-failure",
        attributes: { sourceId, jobId, provider, mode },
      })
    )

  const recordRetryableSyncFailure = ({
    sourceId,
    jobId,
    provider,
    mode,
    error,
    attemptNumber,
    maxAttempts,
    nextRetryAt,
  }: {
    readonly sourceId: string
    readonly jobId: string
    readonly provider: string
    readonly mode: SourceSyncJobMode
    readonly error: SourceSyncExecutionError
    readonly attemptNumber: number
    readonly maxAttempts: number
    readonly nextRetryAt: Date
  }): Effect.Effect<
    never,
    | SyncEngineStorageError
    | SourceSyncJobExecutionNotFoundError
    | SourceSyncJobExecutionConflictError
    | SourceSyncJobRetryableExecutionError
  > =>
    Effect.gen(function* () {
      const message = errorMessage(error)

      yield* sourceSyncStateRepository
        .persistFailureMetadata({ sourceId, lastErrorMessage: message })
        .pipe(
          Effect.catchAll((persistError) =>
            Effect.logError(
              {
                sourceId,
                jobId,
                originalMessage: message,
                persistFailureMetadataError: persistError,
              },
              "source-sync:failed-to-persist-retryable-failure-metadata"
            )
          )
        )

      yield* sourceSyncJobRepository
        .recordRetryableFailure({
          jobId,
          message,
          attemptCount: attemptNumber,
          nextRetryAt,
        })
        .pipe(
          Effect.catchTags({
            SourceSyncJobExecutionRecordNotFoundError: () =>
              Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId })),
            SourceSyncJobExecutionRecordConflictError: (recordError) =>
              Effect.fail(
                new SourceSyncJobExecutionConflictError({ jobId, reason: recordError.reason })
              ),
          })
        )

      yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "retryable-failure" })

      yield* Effect.logWarning(
        {
          sourceId,
          jobId,
          provider,
          mode,
          message,
          attemptNumber,
          maxAttempts,
          nextRetryAt: nextRetryAt.toISOString(),
        },
        "source-sync:retryable-failure"
      )

      return yield* Effect.fail(
        new SourceSyncJobRetryableExecutionError({
          jobId,
          message,
          attemptNumber,
          maxAttempts,
          nextRetryAt,
        })
      )
    }).pipe(
      sourceSyncSpan({
        name: "source-sync.record-retryable-failure",
        attributes: { sourceId, jobId, provider, mode, attemptNumber, maxAttempts },
      })
    )

  const execute: SourceSyncJobExecutorShape["execute"] = ({
    jobId,
    workerId = DEFAULT_SOURCE_SYNC_WORKER_ID,
    retryPolicy,
  }) =>
    Effect.gen(function* () {
      yield* sourceSyncJobRepository.getExecutionJob({ jobId }).pipe(
        Effect.catchTag("SourceSyncJobExecutionRecordNotFoundError", () =>
          Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId }))
        ),
        Effect.catchTag("SourceSyncJobExecutionRecordConflictError", (error) =>
          Effect.fail(new SourceSyncJobExecutionConflictError({ jobId, reason: error.reason }))
        ),
        Effect.catchTag("SourceSyncJobExecutionRecordPayloadError", (error) =>
          Effect.fail(new SourceSyncJobExecutionPayloadError({ jobId, reason: error.reason }))
        )
      )
      const executionJob = yield* sourceSyncJobRepository
        .claimJob({ jobId, workerId, startedAt: nowDate() })
        .pipe(
          Effect.catchTag("SourceSyncJobExecutionRecordNotFoundError", () =>
            Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId }))
          ),
          Effect.catchTag("SourceSyncJobExecutionRecordConflictError", (error) =>
            Effect.fail(new SourceSyncJobExecutionConflictError({ jobId, reason: error.reason }))
          )
        )
      const source = yield* loadSource({
        principalId: executionJob.principalId,
        sourceId: executionJob.sourceId,
      }).pipe(
        Effect.catchTag("SourceNotFoundError", () =>
          Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId }))
        )
      )
      const provider = source.providerKey ?? "unknown"
      const mode = executionJob.mode

      yield* Effect.annotateCurrentSpan({
        principalId: source.principalId,
        sourceId: source.id,
        jobId,
        provider,
        mode,
      })

      const result = yield* (
        mode === "sync"
          ? runSync({ source, jobId, workerId })
          : runReplay({ source, jobId, workerId })
      ).pipe(trackSourceSyncJobDuration({ provider, mode }), Effect.either)

      return yield* Either.match(result, {
        onLeft: (error) => {
          if (
            retryPolicy !== undefined &&
            retryPolicy.attemptNumber < retryPolicy.maxAttempts &&
            isRetryableExecutionError(error)
          ) {
            return recordRetryableSyncFailure({
              sourceId: source.id,
              jobId,
              provider,
              mode,
              error,
              attemptNumber: retryPolicy.attemptNumber,
              maxAttempts: retryPolicy.maxAttempts,
              nextRetryAt: retryPolicy.nextRetryAt,
            })
          }

          return finalizeSyncFailure({
            sourceId: source.id,
            jobId,
            provider,
            mode,
            error,
          })
        },
        onRight: (state) =>
          Effect.gen(function* () {
            yield* sourceSyncJobRepository.completeJob({ jobId, state }).pipe(
              Effect.catchTags({
                SourceSyncJobExecutionRecordNotFoundError: () =>
                  Effect.fail(new SourceSyncJobExecutionNotFoundError({ jobId })),
                SourceSyncJobExecutionRecordConflictError: (recordError) =>
                  Effect.fail(
                    new SourceSyncJobExecutionConflictError({
                      jobId,
                      reason: recordError.reason,
                    })
                  ),
              })
            )

            yield* recordSourceSyncJobOutcome({ provider, mode, outcome: "completed" })

            yield* Effect.logInfo(
              {
                sourceId: source.id,
                jobId,
                provider,
                mode,
              },
              "source-sync:job-completed"
            )

            return {
              sourceId: source.id,
              jobId,
              status: "completed",
              message:
                mode === "sync" ? "Sync finished successfully." : "Replay finished successfully.",
            } satisfies SourceSyncJobSummary
          }),
      })
    }).pipe(sourceSyncSpan({ name: "source-sync-executor.execute", attributes: { jobId } }))

  return SourceSyncJobExecutor.of({ execute } satisfies SourceSyncJobExecutorShape)
})

/**
 * SourceSyncJobExecutorLive - Live source sync job executor layer.
 */
export const SourceSyncJobExecutorLive = Layer.effect(SourceSyncJobExecutor, make)
