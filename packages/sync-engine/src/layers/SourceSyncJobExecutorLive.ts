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
import { FetchProviderRawBatchParams } from "../shared/SourceProviderRawBatch.ts"
import {
  SourceNormalizationRepository,
  SourceNotFoundError,
  SourceRawRecordRepository,
  SourceReplayDependencyError,
  SourceReplayRepository,
  SourceRepository,
  type SourceRawRecord,
  type SourceSyncExecutionState,
  type SourceSyncJobMode,
  type SourceSyncJobSummary,
  type SourceSyncSource,
  type SourceProviderModuleShape,
  type SourceProviderModuleError,
  type SourceProviderRawRecordNormalizer,
  SourceProviderRegistry,
  SourceSyncJobExecutionConflictError,
  SourceSyncJobExecutionNotFoundError,
  SourceSyncJobExecutionPayloadError,
  SourceSyncJobRetryableExecutionError,
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
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
  readonly failedRawRecordIds: ReadonlyArray<string>
}

/**
 * End-of-sync replay outcome. `failedRecordsDelta` adjusts the run's failure
 * counter: replayed rows already counted as failed this run are not counted
 * again, and rows that recover subtract their earlier failure.
 */
interface ReplaySummary {
  readonly normalizedRecords: number
  readonly failedRecordsDelta: number
}

interface SyncLoopState {
  readonly execution: SourceSyncExecutionState
  readonly done: boolean
}

interface ClassificationResult {
  readonly execution: SourceSyncExecutionState
  readonly failedRawRecordIds: ReadonlySet<string>
}

interface PrincipalReconciliationSummary {
  readonly evaluatedProviderTransfers: number
  readonly pending: number
  readonly needsReview: number
  readonly autoApplied: number
  readonly canonicalizedPairs: number
}

type SourceSyncExecutionError =
  | UnsupportedProviderError
  | SourceProviderModuleError
  | SourceReplayDependencyError
  | SyncEngineStorageError

const DEFAULT_SYNC_PAGE_SIZE = 100
const DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS = 3
const DEFAULT_SOURCE_SYNC_WORKER_ID = "source-sync-inline-executor"

const UnknownSyncErrorSchema = Schema.Struct({
  message: Schema.NonEmptyTrimmedString,
})

const decodeUnknownSyncError = Schema.decodeUnknownEither(UnknownSyncErrorSchema)

const SOURCE_SYNC_PAGE_SIZE_CONFIG = Config.integer("SOURCE_SYNC_PAGE_SIZE").pipe(
  Config.map((configuredPageSize) =>
    configuredPageSize > 0 ? configuredPageSize : DEFAULT_SYNC_PAGE_SIZE
  ),
  Config.orElse(() => Config.succeed(DEFAULT_SYNC_PAGE_SIZE))
)

const errorMessage = (error: unknown): string => {
  if (typeof error === "string" && error.trim() !== "") {
    return error
  }

  if (error instanceof UnsupportedProviderError) {
    return `Unsupported sync provider: ${error.provider}`
  }

  if (error instanceof SyncEngineStorageError) {
    return error.message
  }

  if (error instanceof Error && error.message.trim() !== "") {
    return error.message
  }

  return Either.match(decodeUnknownSyncError(error), {
    onLeft: () => "Sync execution failed",
    onRight: ({ message }) => message,
  })
}

const isRetryableExecutionError = (error: SourceSyncExecutionError): boolean =>
  error._tag === "SourceSyncProviderFailureError" && "retryable" in error && error.retryable

const make = Effect.gen(function* () {
  const sourceProviderRegistry = yield* SourceProviderRegistry
  const sourceRepository = yield* SourceRepository
  const sourceSyncJobRepository = yield* SourceSyncJobRepository
  const sourceSyncStateRepository = yield* SourceSyncStateRepository
  const sourceRawRecordRepository = yield* SourceRawRecordRepository
  const sourceNormalizationRepository = yield* SourceNormalizationRepository
  const sourceReplayRepository = yield* SourceReplayRepository
  const transferReconciliationService = yield* TransferReconciliationService
  const pageSize = yield* SOURCE_SYNC_PAGE_SIZE_CONFIG

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
  }): Effect.Effect<SourceProviderModuleShape, UnsupportedProviderError> => {
    return sourceProviderRegistry
      .resolveProviderModule({ providerKey })
      .pipe(Effect.mapError(() => new UnsupportedProviderError({ provider: providerKey })))
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
    readonly error: { readonly message: string }
  }) =>
    markRawRecordFailure({
      rawRecordId,
      message: error.message,
    }).pipe(
      Effect.as({
        normalizedRecords: 0,
        failedRecords: 1,
        failedRawRecordIds: [rawRecordId],
      } satisfies NormalizationSummary)
    )

  const normalizeRawRecord = ({
    source,
    rawRecord,
    normalizeRecord,
  }: {
    readonly source: SourceSyncSource
    readonly rawRecord: SourceRawRecord
    readonly normalizeRecord: SourceProviderRawRecordNormalizer
  }): Effect.Effect<NormalizationSummary, SyncEngineStorageError> =>
    Effect.gen(function* () {
      if (rawRecord.normalizedAt !== null) {
        return {
          normalizedRecords: 0,
          failedRecords: 0,
          failedRawRecordIds: [],
        } satisfies NormalizationSummary
      }

      const normalization = yield* normalizeRecord({ source, sourceRecord: rawRecord })

      if (normalization.kind === "skipped") {
        yield* sourceRawRecordRepository.markRawRecordNormalized({
          rawRecordId: rawRecord.id,
        })

        return {
          normalizedRecords: 1,
          failedRecords: 0,
          failedRawRecordIds: [],
        } satisfies NormalizationSummary
      }

      const persistenceResult = yield* sourceNormalizationRepository.persistNormalizedArtifacts({
        transaction: normalization.transaction,
        venueContext: normalization.venueContext,
        onchainContext: normalization.onchainContext,
        providerTransfers: normalization.providerTransfers,
        feeTransfers: normalization.feeTransfers,
        transactionReview: normalization.transactionReview,
        resolvedTransactionType: normalization.resolvedTransactionType,
        deriveLegs: normalization.deriveLegs,
      })

      if (persistenceResult.requiresReplay) {
        const replayJob = yield* sourceSyncJobRepository.createOrReuseJob({
          sourceId: source.id,
          principalId: source.principalId,
          mode: "replay",
          maxAttempts: DEFAULT_SOURCE_SYNC_MAX_ATTEMPTS,
        })

        yield* Effect.logInfo(
          { sourceId: source.id, replayJobId: replayJob.id },
          "Requested replay after an in-flight asset approval"
        )
      }

      return {
        normalizedRecords: 1,
        failedRecords: 0,
        failedRawRecordIds: [],
      } satisfies NormalizationSummary
    }).pipe(
      Effect.catchAll((error) =>
        error._tag === "SyncEngineStorageError"
          ? Effect.fail(error)
          : markRecoverableNormalizationFailure({ rawRecordId: rawRecord.id, error })
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
    normalizeRecord,
  }: {
    readonly source: SourceSyncSource
    readonly rawRecords: ReadonlyArray<SourceRawRecord>
    readonly normalizeRecord: SourceProviderRawRecordNormalizer
  }): Effect.Effect<NormalizationSummary, SyncEngineStorageError> =>
    Effect.reduce(
      rawRecords,
      { normalizedRecords: 0, failedRecords: 0, failedRawRecordIds: [] } as NormalizationSummary,
      (state, rawRecord) =>
        normalizeRawRecord({ source, rawRecord, normalizeRecord }).pipe(
          Effect.map((summary) => ({
            normalizedRecords: state.normalizedRecords + summary.normalizedRecords,
            failedRecords: state.failedRecords + summary.failedRecords,
            failedRawRecordIds: [...state.failedRawRecordIds, ...summary.failedRawRecordIds],
          }))
        )
    )

  const classifyRawRecords = ({
    source,
    jobId,
    workerId,
    provider,
    normalizeRecord,
    rawRecordIds,
    baseExecution,
  }: {
    readonly source: SourceSyncSource
    readonly jobId: string
    readonly workerId: string
    readonly provider: string
    readonly normalizeRecord: SourceProviderRawRecordNormalizer
    readonly rawRecordIds: ReadonlyArray<string>
    readonly baseExecution: SourceSyncExecutionState
  }): Effect.Effect<ClassificationResult, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const initialClassification: ClassificationResult = {
        execution: {
          ...baseExecution,
          phase: "classifying",
          processedRecords: 0,
          totalRecords: rawRecordIds.length,
          normalizedRecords: 0,
          failedRecords: 0,
        },
        failedRawRecordIds: new Set(),
      }

      yield* sourceSyncStateRepository.persistProgress({
        sourceId: source.id,
        jobId,
        state: initialClassification.execution,
        lastSyncedAt: null,
        lastErrorMessage: null,
      })

      return yield* Effect.iterate(initialClassification, {
        while: ({ execution }) => execution.processedRecords < rawRecordIds.length,
        body: (classification) =>
          Effect.gen(function* () {
            const batchIds = rawRecordIds.slice(
              classification.execution.processedRecords,
              classification.execution.processedRecords + pageSize
            )
            const rawRecords = yield* sourceRawRecordRepository
              .listRawRecordsByIds({ sourceId: source.id, rawRecordIds: batchIds })
              .pipe(
                sourceSyncSpan({
                  name: "source-sync.load-classification-batch",
                  attributes: { sourceId: source.id, jobId, provider },
                  kind: "client",
                })
              )
            const normalization = yield* normalizeRawBatch({
              source,
              rawRecords,
              normalizeRecord,
            }).pipe(
              sourceSyncSpan({
                name: "source-sync.normalize-raw-batch",
                attributes: {
                  sourceId: source.id,
                  jobId,
                  provider,
                  rawRecordCount: rawRecords.length,
                },
              })
            )
            const execution: SourceSyncExecutionState = {
              ...classification.execution,
              processedRecords: classification.execution.processedRecords + batchIds.length,
              normalizedRecords:
                classification.execution.normalizedRecords + normalization.normalizedRecords,
              failedRecords: classification.execution.failedRecords + normalization.failedRecords,
            }

            yield* sourceSyncStateRepository.persistProgress({
              sourceId: source.id,
              jobId,
              state: execution,
              lastSyncedAt: null,
              lastErrorMessage: null,
            })
            yield* heartbeatSourceSyncJob({ jobId, workerId })

            return {
              execution,
              failedRawRecordIds:
                normalization.failedRawRecordIds.length === 0
                  ? classification.failedRawRecordIds
                  : new Set([
                      ...classification.failedRawRecordIds,
                      ...normalization.failedRawRecordIds,
                    ]),
            } satisfies ClassificationResult
          }),
      })
    })

  const replayFailedRawRecords = ({
    source,
    normalizeRecord,
    countedFailedRawRecordIds,
  }: {
    readonly source: SourceSyncSource
    readonly normalizeRecord: SourceProviderRawRecordNormalizer
    readonly countedFailedRawRecordIds: ReadonlySet<string>
  }): Effect.Effect<ReplaySummary, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const replayCandidates = yield* sourceRawRecordRepository.listReplayCandidates({
        sourceId: source.id,
      })

      if (replayCandidates.length === 0) {
        return { normalizedRecords: 0, failedRecordsDelta: 0 } satisfies ReplaySummary
      }

      const replaySummary = yield* normalizeRawBatch({
        source,
        rawRecords: replayCandidates,
        normalizeRecord,
      })
      const replayFailedRawRecordIds = new Set(replaySummary.failedRawRecordIds)
      const newFailures = replaySummary.failedRawRecordIds.filter(
        (rawRecordId) => !countedFailedRawRecordIds.has(rawRecordId)
      ).length
      const recoveredCountedFailures = replayCandidates.filter(
        (candidate) =>
          countedFailedRawRecordIds.has(candidate.id) && !replayFailedRawRecordIds.has(candidate.id)
      ).length

      return {
        normalizedRecords: replaySummary.normalizedRecords,
        failedRecordsDelta: newFailures - recoveredCountedFailures,
      } satisfies ReplaySummary
    })

  const reconcilePrincipalTransfers = ({
    principalId,
    triggerSourceId,
    jobId,
    workerId,
    provider,
    spanPrefix,
  }: {
    readonly principalId: string
    readonly triggerSourceId: string
    readonly jobId: string
    readonly workerId: string
    readonly provider: string
    readonly spanPrefix: "source-sync" | "source-replay"
  }): Effect.Effect<PrincipalReconciliationSummary, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const principalSources = yield* sourceRepository.listPrincipalSourceSyncContexts({
        principalId,
      })

      return yield* Effect.reduce(
        principalSources,
        {
          evaluatedProviderTransfers: 0,
          pending: 0,
          needsReview: 0,
          autoApplied: 0,
          canonicalizedPairs: 0,
        } satisfies PrincipalReconciliationSummary,
        (summary, candidateSource) =>
          Effect.gen(function* () {
            const reconciliation = yield* transferReconciliationService
              .reconcileTransferCandidates({
                principalId,
                sourceId: candidateSource.id,
              })
              .pipe(
                sourceSyncSpan({
                  name: `${spanPrefix}.reconcile-transfers`,
                  attributes: {
                    sourceId: candidateSource.id,
                    triggerSourceId,
                    jobId,
                    provider,
                  },
                  kind: "client",
                })
              )
            const canonicalization = yield* transferReconciliationService
              .applyDeterministicInternalTransferCanonicalization({
                principalId,
                sourceId: candidateSource.id,
              })
              .pipe(
                sourceSyncSpan({
                  name: `${spanPrefix}.apply-transfer-canonicalization`,
                  attributes: {
                    sourceId: candidateSource.id,
                    triggerSourceId,
                    jobId,
                    provider,
                  },
                  kind: "client",
                })
              )

            yield* heartbeatSourceSyncJob({ jobId, workerId })

            return {
              evaluatedProviderTransfers:
                summary.evaluatedProviderTransfers + reconciliation.evaluatedProviderTransfers,
              pending: summary.pending + reconciliation.pending,
              needsReview: summary.needsReview + reconciliation.needsReview,
              autoApplied: summary.autoApplied + reconciliation.autoApplied,
              canonicalizedPairs: summary.canonicalizedPairs + canonicalization.canonicalizedPairs,
            } satisfies PrincipalReconciliationSummary
          })
      )
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
      const normalizeRecord = yield* providerModule.makeRawRecordNormalizer().pipe(
        sourceSyncSpan({
          name: "source-sync.make-raw-record-normalizer",
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
        execution: {
          ...initialExecution,
          phase: "discovering",
          processedRecords: 0,
          totalRecords: null,
        },
        done: false,
      }

      yield* sourceSyncStateRepository.persistProgress({
        sourceId: source.id,
        jobId,
        state: initialLoop.execution,
        lastSyncedAt: null,
        lastErrorMessage: null,
      })

      const finalLoop = yield* Effect.iterate(initialLoop, {
        while: (loop) => !loop.done,
        body: (loop) =>
          Effect.gen(function* () {
            const nextBatch = yield* providerModule
              .fetchRawBatch(
                FetchProviderRawBatchParams.make({
                  providerKey: provider,
                  sourceId: source.id,
                  walletAddress: source.walletAddress,
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
            const nextExecution: SourceSyncExecutionState = {
              ...loop.execution,
              importedRecords: loop.execution.importedRecords + nextBatch.records.length,
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

            return {
              execution: nextExecution,
              done: nextBatch.done,
            } satisfies SyncLoopState
          }),
      })

      const pendingRawRecordIds = yield* sourceRawRecordRepository
        .listPendingNormalizationRecordIds({ sourceId: source.id })
        .pipe(
          sourceSyncSpan({
            name: "source-sync.list-pending-normalization-records",
            attributes: { sourceId: source.id, jobId, provider },
            kind: "client",
          })
        )
      const classification = yield* classifyRawRecords({
        source,
        jobId,
        workerId,
        provider,
        normalizeRecord,
        rawRecordIds: pendingRawRecordIds,
        baseExecution: finalLoop.execution,
      })

      // Runs after all pages are cached so rows that failed earlier in this
      // run because a sibling row was on a later page can normalize now.
      const replaySummary = yield* replayFailedRawRecords({
        source,
        normalizeRecord,
        countedFailedRawRecordIds: classification.failedRawRecordIds,
      }).pipe(
        sourceSyncSpan({
          name: "source-sync.replay-failed-raw-records",
          attributes: { sourceId: source.id, jobId, provider },
        })
      )
      const reconciliationExecution: SourceSyncExecutionState = {
        ...classification.execution,
        phase: "reconciling",
        processedRecords: 0,
        totalRecords: null,
        normalizedRecords:
          classification.execution.normalizedRecords + replaySummary.normalizedRecords,
        failedRecords: classification.execution.failedRecords + replaySummary.failedRecordsDelta,
      }
      yield* sourceSyncStateRepository.persistProgress({
        sourceId: source.id,
        jobId,
        state: reconciliationExecution,
        lastSyncedAt: null,
        lastErrorMessage: null,
      })
      const reconciliationSummary = yield* reconcilePrincipalTransfers({
        principalId: source.principalId,
        triggerSourceId: source.id,
        jobId,
        workerId,
        provider,
        spanPrefix: "source-sync",
      })
      const completedAt = nowDate()
      const completedExecution: SourceSyncExecutionState = {
        ...reconciliationExecution,
        phase: "completed",
        processedRecords: classification.execution.totalRecords ?? 0,
        totalRecords: classification.execution.totalRecords,
      }

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
        canonicalizedInternalTransfers: reconciliationSummary.canonicalizedPairs,
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
          canonicalizedInternalTransfers: reconciliationSummary.canonicalizedPairs,
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
      const normalizeRecord = yield* providerModule.makeRawRecordNormalizer().pipe(
        sourceSyncSpan({
          name: "source-replay.make-raw-record-normalizer",
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
      const classification = yield* classifyRawRecords({
        source,
        jobId,
        workerId,
        provider,
        normalizeRecord,
        rawRecordIds: rawRecords.map((rawRecord) => rawRecord.id),
        baseExecution: {
          ...initialExecution,
          importedRecords: rawRecords.length,
        },
      })

      yield* sourceSyncStateRepository.clearReplayFailureMetadata({ sourceId: source.id })
      yield* heartbeatSourceSyncJob({ jobId, workerId })

      const reconciliationExecution: SourceSyncExecutionState = {
        ...classification.execution,
        phase: "reconciling",
        processedRecords: 0,
        totalRecords: null,
      }
      yield* sourceSyncStateRepository.persistProgress({
        sourceId: source.id,
        jobId,
        state: reconciliationExecution,
        lastSyncedAt: null,
        lastErrorMessage: null,
      })
      const reconciliationSummary = yield* reconcilePrincipalTransfers({
        principalId: source.principalId,
        triggerSourceId: source.id,
        jobId,
        workerId,
        provider,
        spanPrefix: "source-replay",
      })

      const replayExecution: SourceSyncExecutionState = {
        ...reconciliationExecution,
        phase: "completed",
        processedRecords: classification.execution.totalRecords ?? 0,
        totalRecords: classification.execution.totalRecords,
      }

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
        canonicalizedInternalTransfers: reconciliationSummary.canonicalizedPairs,
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
          canonicalizedInternalTransfers: reconciliationSummary.canonicalizedPairs,
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
