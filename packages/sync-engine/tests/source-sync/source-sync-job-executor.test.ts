import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
} from "../../src/shared/SourceProviderRawBatch.ts"
import {
  ProviderAssetRepository,
  SourceNormalizationRepository,
  SourceProviderRecoverableNormalizationError,
  SourceProviderRegistry,
  SourceRawRecordRepository,
  SourceReplayRepository,
  SourceRepository,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  SourceSyncJobExecutionRecordPayloadError,
  SourceSyncCreditExhaustedError,
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
  SourceSyncStateRepository,
  SyncEngineStorageError,
  SyncEngineTransaction,
  TransferReconciliationService,
  type SourceSyncExecutionState,
  type SourceSyncJobMode,
  type SourceRawRecord,
  type SourceSyncSource,
  type SourceProviderModuleShape,
} from "../../src/services/index.ts"

const source: SourceSyncSource = {
  id: "source-1",
  principalId: "principal-1",
  providerKey: "coinbase",
  cexAccountId: "cex-account-1",
  addressId: null,
  walletAddress: null,
}

const initialExecution: SourceSyncExecutionState = {
  phase: "discovering",
  processedRecords: 0,
  totalRecords: null,
  fetchedRecords: 0,
  normalizedRecords: 0,
  failedRecords: 0,
  cursorPayload: null,
  highWatermark: null,
  checkpointExternalId: null,
  checkpointRawRecordId: null,
}

const replayRawRecord: SourceRawRecord = {
  id: "raw-1",
  sourceId: source.id,
  provider: "coinbase",
  recordType: "coinbase_account",
  externalAccountId: "account-1",
  externalRecordId: "account-1",
  externalParentId: null,
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  payload: { id: "account-1" },
  importedAt: new Date("2026-01-01T00:00:00.000Z"),
  normalizedAt: null,
  normalizationError: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
}

const makeReplayRawRecord = (index: number): SourceRawRecord => ({
  ...replayRawRecord,
  id: `raw-${index}`,
  externalAccountId: `account-${index}`,
  externalRecordId: `account-${index}`,
  payload: { id: `account-${index}` },
})

const unusedJobLifecycleMethods = {
  attachQueueMetadata: () => Effect.die("attachQueueMetadata should not be called"),
  claimJob: () => Effect.die("claimJob should not be called"),
  heartbeatJob: () => Effect.die("heartbeatJob should not be called"),
  recordRetryableFailure: () => Effect.die("recordRetryableFailure should not be called"),
  listStaleActiveJobs: () => Effect.die("listStaleActiveJobs should not be called"),
  listRepairableActiveJobs: () => Effect.die("listRepairableActiveJobs should not be called"),
  listPendingJobsNeedingDispatch: () =>
    Effect.die("listPendingJobsNeedingDispatch should not be called"),
}

const makeExecutorLayer = ({
  mode,
  failFetch = false,
  executionJobFailure,
  sourceProviderKey = "coinbase",
  fetchedProviderRecords = [],
  checkpointRawRecords = [],
  replayRawRecords = [],
  replayCandidates = [],
  failNormalizeOnce = false,
  principalSources,
  failReplayCreditReservation = false,
  failReplayPersistenceRawRecordId,
  failReplayPersistenceStorageRawRecordId,
  failCreditRawRecordId,
  failCreditAvailableCredits = 0,
  failCreditOnce = false,
  fetchHighWatermark = null,
  replayCreditReference,
  failReplayReset = false,
  holdReplayCreditReservation = false,
  holdReplayReset = false,
  heartbeatFailureAt,
  heartbeatIntervalMs = 10_000,
  pageSize = 100,
  prepareReplayTransactions = false,
  events,
}: {
  readonly mode: SourceSyncJobMode
  readonly failFetch?: boolean
  readonly executionJobFailure?: "not-found" | "conflict" | "payload"
  readonly sourceProviderKey?: string
  readonly fetchedProviderRecords?: ReadonlyArray<ProviderRawRecord>
  readonly checkpointRawRecords?: ReadonlyArray<SourceRawRecord>
  readonly replayRawRecords?: ReadonlyArray<SourceRawRecord>
  readonly replayCandidates?: ReadonlyArray<SourceRawRecord>
  readonly failNormalizeOnce?: boolean
  readonly principalSources?: ReadonlyArray<SourceSyncSource>
  readonly failReplayCreditReservation?: boolean
  readonly failReplayPersistenceRawRecordId?: string
  readonly failReplayPersistenceStorageRawRecordId?: string
  readonly failCreditRawRecordId?: string
  readonly failCreditAvailableCredits?: number
  readonly failCreditOnce?: boolean
  readonly fetchHighWatermark?: Date | null
  readonly replayCreditReference?: (sourceRawRecordId: string) => string
  readonly failReplayReset?: boolean
  readonly holdReplayCreditReservation?: boolean
  readonly holdReplayReset?: boolean
  readonly heartbeatFailureAt?: number
  readonly heartbeatIntervalMs?: number
  readonly pageSize?: number
  readonly prepareReplayTransactions?: boolean
  readonly events: Array<string>
}) => {
  let heartbeatCount = 0
  let remainingCreditFailures = failCreditOnce ? 1 : Number.POSITIVE_INFINITY
  const normalizedRawRecordIds = new Set<string>()
  const reservedReplayReferences = new Set<string>()
  const toReplayCreditReference =
    replayCreditReference ?? ((sourceRawRecordId: string) => `reserved-credit:${sourceRawRecordId}`)
  const syncSource = {
    ...source,
    providerKey: sourceProviderKey,
    walletAddress:
      sourceProviderKey === "helius-solana"
        ? "So11111111111111111111111111111111111111112"
        : source.walletAddress,
  }
  const SourceRepositoryTestLive = Layer.succeed(SourceRepository, {
    findOwnedSourceSyncContext: () => Effect.succeed(Option.some(syncSource)),
    listPrincipalSourceSyncContexts: () => Effect.succeed(principalSources ?? [syncSource]),
  })

  const SourceSyncJobRepositoryTestLive = Layer.succeed(SourceSyncJobRepository, {
    findActiveJob: () => Effect.die("findActiveJob should not be called"),
    createOrReuseJob: () => Effect.die("createOrReuseJob should not be called"),
    attachQueueMetadata: unusedJobLifecycleMethods.attachQueueMetadata,
    recoverStaleActiveJob: () => Effect.die("recoverStaleActiveJob should not be called"),
    getJob: () => Effect.die("getJob should not be called"),
    getExecutionJob: ({ jobId }) => {
      switch (executionJobFailure) {
        case "not-found":
          return Effect.fail(new SourceSyncJobExecutionRecordNotFoundError({ jobId }))
        case "conflict":
          return Effect.fail(
            new SourceSyncJobExecutionRecordConflictError({
              jobId,
              reason: "Job status completed is not executable.",
            })
          )
        case "payload":
          return Effect.fail(
            new SourceSyncJobExecutionRecordPayloadError({
              jobId,
              reason: "Source sync job is missing execution mode metadata.",
            })
          )
        default:
          return Effect.succeed({
            id: "job-1",
            sourceId: source.id,
            principalId: source.principalId,
            mode,
            status: "processing",
          })
      }
    },
    claimJob: ({ workerId }) =>
      Effect.sync(() => {
        events.push(`claim:${workerId}`)
        return {
          id: "job-1",
          sourceId: source.id,
          principalId: source.principalId,
          mode,
          status: "processing" as const,
        }
      }),
    heartbeatJob: ({ jobId, workerId }) =>
      Effect.suspend(() => {
        heartbeatCount += 1
        events.push(`heartbeat:${workerId}`)
        return heartbeatFailureAt !== undefined && heartbeatCount >= heartbeatFailureAt
          ? Effect.fail(
              new SourceSyncJobExecutionRecordConflictError({
                jobId,
                reason: "Worker no longer owns the processing job.",
              })
            )
          : Effect.void
      }),
    recordRetryableFailure: ({ message, attemptCount, nextRetryAt }) =>
      Effect.sync(() => {
        events.push(`retry:${message}:${attemptCount}:${nextRetryAt.toISOString()}`)
      }),
    listStaleActiveJobs: unusedJobLifecycleMethods.listStaleActiveJobs,
    listRepairableActiveJobs: unusedJobLifecycleMethods.listRepairableActiveJobs,
    listPendingJobsNeedingDispatch: unusedJobLifecycleMethods.listPendingJobsNeedingDispatch,
    completeJob: ({ state }) =>
      Effect.sync(() => {
        events.push(`complete:${state.fetchedRecords}:${state.normalizedRecords}`)
        events.push(`failed:${state.failedRecords}`)
      }),
    failJob: ({ message }) =>
      Effect.sync(() => {
        events.push(`fail:${message}`)
      }),
    failCreditRequiredJob: ({
      reasonCode,
      availableCredits,
      creditsConsumed,
      additionalCreditsRequired,
    }) =>
      Effect.sync(() => {
        events.push(
          `credit-required:${reasonCode}:${availableCredits}:${creditsConsumed}:${additionalCreditsRequired ?? "unknown"}`
        )
      }),
  })

  let latestExecutionState = initialExecution
  const SourceSyncStateRepositoryTestLive = Layer.succeed(SourceSyncStateRepository, {
    getExecutionState: () => Effect.succeed(latestExecutionState),
    persistProgress: ({ state, lastSyncedAt }) =>
      Effect.sync(() => {
        latestExecutionState = state
        events.push(`progress:${state.fetchedRecords}:${lastSyncedAt === null ? "open" : "done"}`)
        events.push(
          `phase:${state.phase}:${state.processedRecords}:${state.totalRecords ?? "unknown"}`
        )
      }),
    persistFailureMetadata: ({ lastErrorMessage }) =>
      Effect.sync(() => {
        events.push(`failure-metadata:${lastErrorMessage}`)
      }),
    clearReplayFailureMetadata: () =>
      Effect.sync(() => {
        events.push("clear-replay-failure-metadata")
      }),
  })

  const SourceRawRecordRepositoryTestLive = Layer.succeed(SourceRawRecordRepository, {
    upsertRawBatch: ({ records }) =>
      Effect.succeed({
        rawRecords: checkpointRawRecords,
        checkpointExternalId: records[0]?.externalRecordId ?? null,
        checkpointRawRecordId: null,
      }),
    listReplayCandidates: () => Effect.succeed(replayCandidates),
    listAllRawRowsForReplay: () => Effect.succeed(replayRawRecords),
    listPendingNormalizationRecordIds: () =>
      Effect.sync(() =>
        checkpointRawRecords
          .map((rawRecord) => rawRecord.id)
          .filter((rawRecordId) => !normalizedRawRecordIds.has(rawRecordId))
      ),
    listRawRecordsByIds: ({ rawRecordIds }) =>
      Effect.succeed(
        [...checkpointRawRecords, ...replayRawRecords].filter((rawRecord) =>
          rawRecordIds.includes(rawRecord.id)
        )
      ),
    listRawRecordsByOccurredAt: () => Effect.succeed([]),
    markRawRecordNormalized: ({ rawRecordId }) =>
      Effect.sync(() => {
        normalizedRawRecordIds.add(rawRecordId)
        events.push("mark-raw-normalized")
      }),
    markRawRecordFailed: ({ message }) =>
      Effect.sync(() => {
        events.push(`mark-raw-failed:${message}`)
      }),
    resetNormalizationStateForSource: () =>
      Effect.die("resetNormalizationStateForSource should not be called"),
  })

  const makeCoinbaseModule = (): SourceProviderModuleShape => ({
    fetchRawBatch: (params) =>
      failFetch
        ? Effect.fail(
            new SourceSyncProviderFailureError({
              providerKey: "coinbase",
              message: "provider unavailable",
              retryable: true,
            })
          )
        : Effect.sync(() => {
            events.push(`fetch:${params.resumeHighWatermark?.toISOString() ?? "none"}`)
            return FetchProviderRawBatchResult.make({
              records: fetchedProviderRecords,
              cursorPayload: null,
              highWatermark: fetchHighWatermark,
              done: true,
            })
          }),
    refreshReferenceData: () =>
      Effect.succeed({
        transactionTypeCatalogCount: 0,
        providerAssetCatalogCount: 0,
        defaultTransactionMappingCount: 0,
        defaultProviderAssetMappingCount: 0,
      }),
    makeRawRecordNormalizer: () =>
      Effect.succeed(({ source, sourceRecord }) => {
        events.push(`normalize:${sourceRecord.id}`)
        if (prepareReplayTransactions) {
          return Effect.succeed({
            kind: "prepared",
            providerAssetRowIds: [],
            transaction: {
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              externalId: sourceRecord.externalRecordId,
              externalGroupId: null,
              timestamp: sourceRecord.occurredAt,
              transactionType: null,
              providerTransactionType: "test",
              providerStatus: "completed",
              providerResourcePath: null,
              providerDescription: null,
              providerCreatedAt: sourceRecord.occurredAt,
              providerUpdatedAt: sourceRecord.occurredAt,
              metadata: null,
              principalId: source.principalId,
            },
            venueContext: {
              venueType: "cex",
              cexAccountId: source.cexAccountId,
              externalAccountId: sourceRecord.externalAccountId,
              externalOrderId: null,
              externalFillId: null,
              side: null,
              instrument: null,
              fillPrice: null,
              commissionAmount: null,
              commissionCurrency: null,
              metadata: null,
            },
            providerTransfers: [],
            canonicalTransfers: [],
            transactionReview: null,
            resolvedTransactionType: {
              providerTransactionType: "test",
              transactionType: null,
              inventoryEffect: "unknown",
              taxTreatment: "requires_additional_rule_logic",
              resolutionStrategy: "no_leg",
              pairedRecordRequired: false,
              mappingStatus: "pending_review",
            },
            deriveLegs: () =>
              sourceRecord.id === failReplayPersistenceRawRecordId
                ? Effect.fail(
                    new SourceProviderRecoverableNormalizationError({
                      providerKey: "coinbase",
                      message: "Prepared replay persistence failed.",
                    })
                  )
                : Effect.succeed([]),
          } as const)
        }
        return Effect.succeed({ kind: "skipped" } as const)
      }),
  })

  const makeStubModule = (): SourceProviderModuleShape => ({
    fetchRawBatch: () =>
      Effect.sync(() => {
        events.push("stub:fetch-raw-batch")
        return FetchProviderRawBatchResult.make({
          records: fetchedProviderRecords,
          cursorPayload: null,
          highWatermark: null,
          done: true,
        })
      }),
    refreshReferenceData: () =>
      Effect.sync(() => {
        events.push("stub:refresh-reference-data")
        return {
          transactionTypeCatalogCount: 0,
          providerAssetCatalogCount: 0,
          defaultTransactionMappingCount: 0,
          defaultProviderAssetMappingCount: 0,
        }
      }),
    makeRawRecordNormalizer: () =>
      Effect.sync(() => {
        events.push("stub:make-normalizer")
        let normalizeAttempts = 0
        return ({ source, sourceRecord }) =>
          Effect.gen(function* () {
            normalizeAttempts += 1
            events.push(`stub:normalize:${source.providerKey}:${sourceRecord.recordType}`)

            if (failNormalizeOnce && normalizeAttempts === 1) {
              return yield* new SourceProviderRecoverableNormalizationError({
                providerKey: "stub-chain",
                message: "Paired sibling row is not cached yet.",
              })
            }

            return { kind: "skipped" } as const
          })
      }),
  })

  const makeHeliusModule = (): SourceProviderModuleShape => ({
    fetchRawBatch: () =>
      Effect.sync(() => {
        events.push("helius:fetch-raw-batch")
        return FetchProviderRawBatchResult.make({
          records: fetchedProviderRecords,
          cursorPayload: { paginationToken: null },
          highWatermark: null,
          done: true,
        })
      }),
    refreshReferenceData: () =>
      Effect.sync(() => {
        events.push("helius:refresh-reference-data")
        return {
          transactionTypeCatalogCount: 0,
          providerAssetCatalogCount: 0,
          defaultTransactionMappingCount: 0,
          defaultProviderAssetMappingCount: 0,
        }
      }),
    makeRawRecordNormalizer: () =>
      Effect.sync(() => {
        events.push("helius:make-normalizer")
        return ({ source, sourceRecord }) =>
          Effect.sync(() => {
            events.push(`helius:normalize:${source.providerKey}:${sourceRecord.recordType}`)
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new SourceProviderRecoverableNormalizationError({
                  providerKey: "helius-solana",
                  message: "Helius Solana normalization is not implemented yet.",
                })
              )
            )
          )
      }),
  })

  const SourceProviderRegistryTestLive = Layer.succeed(SourceProviderRegistry, {
    resolveProviderModule: ({ providerKey }) => {
      switch (providerKey) {
        case "coinbase":
          return Effect.succeed(makeCoinbaseModule())
        case "helius-solana":
          return Effect.succeed(makeHeliusModule())
        case "stub-chain":
          return Effect.succeed(makeStubModule())
        default:
          return Effect.fail(new UnsupportedSyncProviderError({ providerKey }))
      }
    },
  })

  const SourceReplayRepositoryTestLive = Layer.succeed(SourceReplayRepository, {
    resetSourceDerivedState: () =>
      Effect.gen(function* () {
        events.push("reset-derived-state")
        if (holdReplayReset) {
          yield* Effect.sleep(25)
        }
        if (failReplayReset) {
          return yield* new SyncEngineStorageError({
            operation: "sourceReplayRepository.resetSourceDerivedState",
            cause: "Replay reset failed",
          })
        }
      }),
  })

  const SourceNormalizationRepositoryTestLive = Layer.succeed(SourceNormalizationRepository, {
    reserveReplayTransactionCredits: ({ transactions }) =>
      Effect.gen(function* () {
        events.push("reserve-replay-credits")
        if (holdReplayCreditReservation) {
          yield* Effect.sleep(25)
        }
        if (failReplayCreditReservation) {
          return yield* new SourceSyncCreditExhaustedError({
            reasonCode: "no_usable_credits",
            availableCredits: failCreditAvailableCredits,
          })
        }
        const reservations = transactions.flatMap(({ sourceRawRecordId }) =>
          sourceRawRecordId === null
            ? []
            : [
                {
                  reference: toReplayCreditReference(sourceRawRecordId),
                  sourceRawRecordId,
                },
              ]
        )
        for (const reservation of reservations) {
          reservedReplayReferences.add(reservation.reference)
        }
        return reservations
      }),
    releaseReplayTransactionCredits: ({ references, reservationId }) =>
      Effect.sync(() => {
        events.push(`cleanup-replay-credits:${reservationId}:${references.join(",")}`)
        const releasedReferences = references.filter((reference) =>
          reservedReplayReferences.delete(reference)
        )
        if (releasedReferences.length > 0) {
          events.push(`release-replay-credits:${reservationId}:${releasedReferences.join(",")}`)
        }
      }),
    persistNormalizedArtifacts: (params) =>
      Effect.gen(function* () {
        const transactionId = `transaction:${params.transaction.sourceRawRecordId ?? "unknown"}`
        const transaction = {
          id: transactionId,
          sourceId: params.transaction.sourceId,
          sourceRawRecordId: params.transaction.sourceRawRecordId,
          externalId: params.transaction.externalId,
          timestamp: params.transaction.timestamp,
          providerTransactionType: params.transaction.providerTransactionType,
          metadata: params.transaction.metadata,
          principalId: params.transaction.principalId,
        }
        const venueContext = {
          transactionId,
          side: params.venueContext.side,
          instrument: params.venueContext.instrument,
          fillPrice: params.venueContext.fillPrice,
        }
        events.push(`persist-normalized:${params.transaction.sourceRawRecordId ?? "unknown"}`)
        if (params.transaction.sourceRawRecordId === failReplayPersistenceStorageRawRecordId) {
          return yield* new SyncEngineStorageError({
            operation: "sourceNormalizationRepository.persistNormalizedArtifacts",
            cause: "Replay persistence failed",
          })
        }
        if (
          params.transaction.sourceRawRecordId === failCreditRawRecordId &&
          remainingCreditFailures > 0
        ) {
          remainingCreditFailures -= 1
          return yield* new SourceSyncCreditExhaustedError({
            reasonCode: "no_usable_credits",
            availableCredits: failCreditAvailableCredits,
          })
        }
        if ("deriveLegs" in params) {
          yield* params.deriveLegs({
            transaction,
            venueContext,
            providerTransfers: [],
            canonicalTransfers: [],
          })
        }
        if (params.transaction.sourceRawRecordId !== null) {
          // The real repository stamps normalizedAt in the same transaction, so a
          // persisted row leaves the pending-normalization set.
          normalizedRawRecordIds.add(params.transaction.sourceRawRecordId)
          reservedReplayReferences.delete(
            toReplayCreditReference(params.transaction.sourceRawRecordId)
          )
        }
        return {
          transaction,
          venueContext,
          providerTransfers: [],
          canonicalTransfers: [],
          legs: [],
        }
      }),
  })

  const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
    reconcileTransferCandidates: ({ sourceId }) =>
      Effect.sync(() => {
        events.push(`reconcile:${sourceId}`)
        return {
          evaluatedProviderTransfers: 0,
          pending: 0,
          needsReview: 0,
          autoApplied: 0,
        }
      }),
    rollbackReconciliationsForSourceReplay: () =>
      Effect.sync(() => {
        events.push("rollback-reconciliations")
      }),
    applyDeterministicInternalTransferCanonicalization: ({ sourceId }) =>
      Effect.sync(() => {
        events.push(`canonicalize:${sourceId}`)
        return { canonicalizedPairs: 0 }
      }),
  })
  const SyncEngineTransactionTestLive = Layer.succeed(
    SyncEngineTransaction,
    SyncEngineTransaction.of({ run: (effect) => effect })
  )
  const ProviderAssetRepositoryTestLive = Layer.succeed(ProviderAssetRepository, {
    upsertProviderAssets: () => Effect.die("upsertProviderAssets should not be called"),
    upsertProviderAssetMappings: () =>
      Effect.die("upsertProviderAssetMappings should not be called"),
    seedProviderAssetMappingsIfMissing: () =>
      Effect.die("seedProviderAssetMappingsIfMissing should not be called"),
    approveProviderAssetMappingAndRequestReplay: () =>
      Effect.die("approveProviderAssetMappingAndRequestReplay should not be called"),
    excludeProviderAssetMappingAndRequestReplay: () =>
      Effect.die("excludeProviderAssetMappingAndRequestReplay should not be called"),
    lockProviderAssetApprovalSnapshot: () =>
      Effect.die("lockProviderAssetApprovalSnapshot should not be called"),
    recordProviderAssetSourceUses: () => Effect.succeed(0),
    findProviderAssetByProviderAssetId: () =>
      Effect.die("findProviderAssetByProviderAssetId should not be called"),
    findProviderAssetByNaturalKey: () =>
      Effect.die("findProviderAssetByNaturalKey should not be called"),
    findProviderAssetByCurrencyCode: () =>
      Effect.die("findProviderAssetByCurrencyCode should not be called"),
    findProviderAssetReviewById: () =>
      Effect.die("findProviderAssetReviewById should not be called"),
    listProviderAssetReviews: () => Effect.die("listProviderAssetReviews should not be called"),
    listProviderAssetObservedRepresentations: () =>
      Effect.die("listProviderAssetObservedRepresentations should not be called"),
    findProviderAssetMapping: () => Effect.die("findProviderAssetMapping should not be called"),
    appendSupersedingAssetResolutionDecision: () =>
      Effect.die("appendSupersedingAssetResolutionDecision should not be called"),
    findActiveAssetResolutionDecision: () =>
      Effect.die("findActiveAssetResolutionDecision should not be called"),
    listAssetResolutionDecisions: () =>
      Effect.die("listAssetResolutionDecisions should not be called"),
    listAssetResolutionEvidence: () =>
      Effect.die("listAssetResolutionEvidence should not be called"),
    recordAssetResolutionDecision: () =>
      Effect.die("recordAssetResolutionDecision should not be called"),
  })

  return SourceSyncJobExecutorLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncJobRepositoryTestLive),
    Layer.provide(SourceSyncStateRepositoryTestLive),
    Layer.provide(SourceRawRecordRepositoryTestLive),
    Layer.provide(SourceProviderRegistryTestLive),
    Layer.provide(SourceReplayRepositoryTestLive),
    Layer.provide(SourceNormalizationRepositoryTestLive),
    Layer.provide(ProviderAssetRepositoryTestLive),
    Layer.provide(SyncEngineTransactionTestLive),
    Layer.provide(TransferReconciliationServiceTestLive),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SOURCE_SYNC_PAGE_SIZE: String(pageSize),
          SOURCE_SYNC_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
        })
      )
    )
  )
}

describe("SourceSyncJobExecutor", () => {
  it("reconciles every principal source before canonicalizing any source", async () => {
    const events: Array<string> = []
    const principalSources = ["source-c", "source-b", "source-a"].map((id) => ({
      ...source,
      id,
    }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            principalSources,
            events,
          })
        )
      )
    )

    expect(events.filter((event) => /^(reconcile|canonicalize):/.test(event))).toEqual([
      "reconcile:source-c",
      "reconcile:source-b",
      "reconcile:source-a",
      "canonicalize:source-c",
      "canonicalize:source-b",
      "canonicalize:source-a",
    ])
  })

  it("runs sync mode and marks the job completed", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(Effect.provide(makeExecutorLayer({ mode: "sync", events })))
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("progress:0:open")
    expect(events).toContain("heartbeat:source-sync-inline-executor")
    expect(events).toContain("progress:0:done")
    expect(events).toContain("complete:0:0")
  })

  it("runs a non-Coinbase provider module through fetch and normalization hooks", async () => {
    const events: Array<string> = []
    const fetchedProviderRecord = ProviderRawRecord.make({
      providerKey: "stub-chain",
      recordType: "stub_transaction",
      externalRecordId: "stub-tx-1",
      externalAccountId: null,
      externalParentId: null,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      payload: { id: "stub-tx-1" },
    })
    const checkpointRawRecord: SourceRawRecord = {
      ...replayRawRecord,
      id: "raw-stub-1",
      provider: "stub-chain",
      recordType: "stub_transaction",
      externalRecordId: "stub-tx-1",
      payload: { id: "stub-tx-1" },
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            sourceProviderKey: "stub-chain",
            fetchedProviderRecords: [fetchedProviderRecord],
            checkpointRawRecords: [checkpointRawRecord],
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("stub:fetch-raw-batch")
    expect(events).toContain("stub:refresh-reference-data")
    expect(events).toContain("stub:make-normalizer")
    expect(events).toContain("stub:normalize:stub-chain:stub_transaction")
    expect(events).toContain("mark-raw-normalized")
    expect(events).toContain("phase:discovering:0:unknown")
    expect(events).toContain("phase:classifying:0:1")
    expect(events).toContain("phase:classifying:1:1")
    expect(events).toContain("phase:reconciling:0:unknown")
    expect(events).toContain("phase:completed:1:1")
    expect(events).toContain("complete:1:1")
  })

  it("replays rows that failed during the current run before completing the sync", async () => {
    const events: Array<string> = []
    const fetchedProviderRecord = ProviderRawRecord.make({
      providerKey: "stub-chain",
      recordType: "stub_transaction",
      externalRecordId: "stub-tx-1",
      externalAccountId: null,
      externalParentId: null,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      payload: { id: "stub-tx-1" },
    })
    const checkpointRawRecord: SourceRawRecord = {
      ...replayRawRecord,
      id: "raw-stub-1",
      provider: "stub-chain",
      recordType: "stub_transaction",
      externalRecordId: "stub-tx-1",
      payload: { id: "stub-tx-1" },
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            sourceProviderKey: "stub-chain",
            fetchedProviderRecords: [fetchedProviderRecord],
            checkpointRawRecords: [checkpointRawRecord],
            replayCandidates: [checkpointRawRecord],
            failNormalizeOnce: true,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("mark-raw-failed:Paired sibling row is not cached yet.")
    expect(
      events.filter((event) => event === "stub:normalize:stub-chain:stub_transaction")
    ).toHaveLength(2)
    expect(events).toContain("mark-raw-normalized")
    expect(events).toContain("complete:1:1")
    expect(events).toContain("failed:0")
  })

  it("routes Solana production sources through the Helius provider key", async () => {
    const events: Array<string> = []
    const fetchedProviderRecord = ProviderRawRecord.make({
      providerKey: "helius-solana",
      recordType: "solana_transaction_full",
      externalRecordId: "solana-signature-1",
      externalAccountId: "So11111111111111111111111111111111111111112",
      externalParentId: null,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      payload: { transaction: { signatures: ["solana-signature-1"] } },
    })
    const checkpointRawRecord: SourceRawRecord = {
      ...replayRawRecord,
      id: "raw-solana-1",
      provider: "helius-solana",
      recordType: "solana_transaction_full",
      externalRecordId: "solana-signature-1",
      externalAccountId: "So11111111111111111111111111111111111111112",
      payload: { transaction: { signatures: ["solana-signature-1"] } },
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            sourceProviderKey: "helius-solana",
            fetchedProviderRecords: [fetchedProviderRecord],
            checkpointRawRecords: [checkpointRawRecord],
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("helius:fetch-raw-batch")
    expect(events).toContain("helius:normalize:helius-solana:solana_transaction_full")
    expect(events).toContain("mark-raw-failed:Helius Solana normalization is not implemented yet.")
    expect(events).toContain("complete:1:0")
    expect(events).toContain("failed:1")
  })

  it("keeps fetchedRecords and normalizedRecords distinct when every fetched record fails to persist", async () => {
    const events: Array<string> = []
    const fetchedProviderRecords = [1, 2, 3].map((index) =>
      ProviderRawRecord.make({
        providerKey: "helius-solana",
        recordType: "solana_transaction_full",
        externalRecordId: `solana-signature-${index}`,
        externalAccountId: "So11111111111111111111111111111111111111112",
        externalParentId: null,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        payload: { transaction: { signatures: [`solana-signature-${index}`] } },
      })
    )
    const checkpointRawRecords = [1, 2, 3].map((index) => ({
      ...replayRawRecord,
      id: `raw-solana-${index}`,
      provider: "helius-solana",
      recordType: "solana_transaction_full",
      externalRecordId: `solana-signature-${index}`,
      externalAccountId: "So11111111111111111111111111111111111111112",
      payload: { transaction: { signatures: [`solana-signature-${index}`] } },
    }))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            sourceProviderKey: "helius-solana",
            fetchedProviderRecords,
            checkpointRawRecords,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    // Every fetched batch is cached during discovery, before normalization runs,
    // so a run that persists nothing must still report the full fetched count.
    expect(events).toContain("complete:3:0")
    expect(events).toContain("failed:3")
    expect(events).not.toContain("complete:0:0")
  })

  it("runs replay mode with cached raw rows and marks the job completed", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({ mode: "replay", replayRawRecords: [replayRawRecord], events })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("rollback-reconciliations")
    expect(events).toContain("reset-derived-state")
    expect(events).toContain("heartbeat:source-sync-inline-executor")
    expect(events).toContain("mark-raw-normalized")
    expect(events).toContain("clear-replay-failure-metadata")
    expect(events).toContain("complete:1:1")
  })

  it("heartbeats between replay preparation batches and around destructive work", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            pageSize: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(
      events
        .filter(
          (event) =>
            event.startsWith("normalize:") ||
            event.startsWith("heartbeat:") ||
            event === "reserve-replay-credits" ||
            event === "rollback-reconciliations" ||
            event === "reset-derived-state"
        )
        .slice(0, 9)
    ).toEqual([
      "normalize:raw-1",
      "heartbeat:source-sync-inline-executor",
      "normalize:raw-2",
      "heartbeat:source-sync-inline-executor",
      "heartbeat:source-sync-inline-executor",
      "reserve-replay-credits",
      "heartbeat:source-sync-inline-executor",
      "rollback-reconciliations",
      "reset-derived-state",
    ])
  })

  it("stops a prepared replay before reserving credits when ownership is lost", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            heartbeatFailureAt: 3,
            pageSize: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).not.toContain("reserve-replay-credits")
    expect(events).not.toContain("reset-derived-state")
    expect(events).not.toContain("mark-raw-normalized")
  })

  it("does not reset replay state when ownership is lost during credit reservation", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            heartbeatFailureAt: 4,
            heartbeatIntervalMs: 1,
            holdReplayCreditReservation: true,
            pageSize: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).toContain("reserve-replay-credits")
    expect(events).not.toContain("reset-derived-state")
    expect(events.some((event) => event.startsWith("release-replay-credits:"))).toBe(false)
    expect(events).not.toContain("mark-raw-normalized")
  })

  it("interrupts replay reset when the active job lease is lost", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            heartbeatFailureAt: 6,
            heartbeatIntervalMs: 1,
            holdReplayReset: true,
            prepareReplayTransactions: true,
            pageSize: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).toContain("reset-derived-state")
    expect(events).toContain(
      "release-replay-credits:job-1:reserved-credit:raw-1,reserved-credit:raw-2"
    )
    expect(events).not.toContain("mark-raw-normalized")
  })

  it("releases replay credits when the derived-state reset fails", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1)],
            failReplayReset: true,
            prepareReplayTransactions: true,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).toContain("release-replay-credits:job-1:reserved-credit:raw-1")
    expect(events).not.toContain("mark-raw-normalized")
  })

  it("releases only the replay credit whose prepared persistence fails", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            prepareReplayTransactions: true,
            failReplayPersistenceRawRecordId: "raw-2",
            events,
          })
        )
      )
    )

    expect(result.status).toBe("completed")
    expect(events).toContain("persist-normalized:raw-1")
    expect(events).toContain("persist-normalized:raw-2")
    expect(events).toContain("release-replay-credits:job-1:reserved-credit:raw-2")
    expect(events).not.toContain("release-replay-credits:job-1:reserved-credit:raw-1")
    expect(events).toContain("mark-raw-failed:Prepared replay persistence failed.")
    expect(events).toContain("complete:2:1")
    expect(events).toContain("failed:1")
  })

  it("defers cleanup of a shared replay credit until every referencing row is processed", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            prepareReplayTransactions: true,
            failReplayPersistenceRawRecordId: "raw-1",
            replayCreditReference: () => "reserved-credit:shared",
            events,
          })
        )
      )
    )

    const siblingPersistenceIndex = events.indexOf("persist-normalized:raw-2")
    const sharedCleanupIndex = events.indexOf("cleanup-replay-credits:job-1:reserved-credit:shared")

    expect(result.status).toBe("completed")
    expect(siblingPersistenceIndex).toBeGreaterThan(-1)
    expect(sharedCleanupIndex).toBeGreaterThan(siblingPersistenceIndex)
    expect(events).not.toContain("release-replay-credits:job-1:reserved-credit:shared")
  })

  it("releases all still-owned replay credits when persistence fails", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [makeReplayRawRecord(1), makeReplayRawRecord(2)],
            prepareReplayTransactions: true,
            failReplayPersistenceStorageRawRecordId: "raw-2",
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).toContain("persist-normalized:raw-1")
    expect(events).toContain("persist-normalized:raw-2")
    expect(events).toContain("release-replay-credits:job-1:reserved-credit:raw-2")
    expect(events).not.toContain("release-replay-credits:job-1:reserved-credit:raw-1")
    expect(events).not.toContain("mark-raw-failed:Replay persistence failed")
  })

  it("checks replay ownership before resetting an empty source", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            heartbeatFailureAt: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(events).not.toContain("reserve-replay-credits")
    expect(events).not.toContain("reset-derived-state")
  })

  it("marks the job credit-required, not failed, when transaction credits cannot be reserved", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            replayRawRecords: [replayRawRecord],
            failReplayCreditReservation: true,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("credit_required")
    expect(result.resumable).toBe(true)
    expect(result.creditOutcome).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
      creditsConsumed: 0,
      additionalCreditsRequired: null,
    })
    expect(events).not.toContain("reset-derived-state")
    expect(events).not.toContain("mark-raw-normalized")
    expect(events.some((event) => event.startsWith("fail:"))).toBe(false)
    expect(events.some((event) => event.startsWith("credit-required:"))).toBe(true)
  })

  it("keeps earlier transactions committed and reports a resumable credit-required outcome for a sync run", async () => {
    const events: Array<string> = []
    const rawRecordOne = makeReplayRawRecord(1)
    const rawRecordTwo = makeReplayRawRecord(2)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "sync",
            checkpointRawRecords: [rawRecordOne, rawRecordTwo],
            prepareReplayTransactions: true,
            failCreditRawRecordId: rawRecordTwo.id,
            failCreditAvailableCredits: 0,
            pageSize: 1,
            events,
          })
        )
      )
    )

    expect(result.status).toBe("credit_required")
    expect(result.resumable).toBe(true)
    // No server-authored message: clients localize from the credit outcome.
    expect(result.message).toBeNull()
    expect(result.creditOutcome).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
      creditsConsumed: 1,
      additionalCreditsRequired: 1,
    })
    expect(Object.keys(result)).toEqual([
      "sourceId",
      "jobId",
      "status",
      "message",
      "resumable",
      "creditOutcome",
    ])

    // Record 1 already committed and must not be replayed away by the credit-required outcome.
    expect(events).toContain(`persist-normalized:${rawRecordOne.id}`)
    expect(events).toContain(`persist-normalized:${rawRecordTwo.id}`)
    expect(events.some((event) => event.startsWith("fail:"))).toBe(false)
    expect(events.some((event) => event.startsWith("credit-required:"))).toBe(true)
  })

  it("continues after a credit top-up reusing cached history without refetching or re-charging", async () => {
    const events: Array<string> = []
    const rawRecordOne = makeReplayRawRecord(1)
    const rawRecordTwo = makeReplayRawRecord(2)
    const watermark = new Date("2026-01-02T00:00:00.000Z")

    const executorLayer = makeExecutorLayer({
      mode: "sync",
      checkpointRawRecords: [rawRecordOne, rawRecordTwo],
      prepareReplayTransactions: true,
      failCreditRawRecordId: rawRecordTwo.id,
      failCreditOnce: true,
      fetchHighWatermark: watermark,
      pageSize: 1,
      events,
    })

    const [paused, continued, repeated] = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        const pausedRun = yield* executor.execute({ jobId: "job-1" })
        const continuedRun = yield* executor.execute({ jobId: "job-1" })
        const repeatedRun = yield* executor.execute({ jobId: "job-1" })
        return [pausedRun, continuedRun, repeatedRun] as const
      }).pipe(Effect.provide(executorLayer))
    )

    expect(paused.status).toBe("credit_required")
    expect(continued.status).toBe("completed")
    expect(repeated.status).toBe("completed")

    // The continue run resumes provider fetching from the stored high watermark
    // instead of refetching the history cached before the pause.
    expect(events.filter((event) => event.startsWith("fetch:"))).toEqual([
      "fetch:none",
      `fetch:${watermark.toISOString()}`,
      `fetch:${watermark.toISOString()}`,
    ])

    // The transaction covered before the pause is not persisted or charged again;
    // only the paused record is retried once credits exist.
    expect(
      events.filter((event) => event === `persist-normalized:${rawRecordOne.id}`)
    ).toHaveLength(1)
    expect(
      events.filter((event) => event === `persist-normalized:${rawRecordTwo.id}`)
    ).toHaveLength(2)
  })

  it("records retry metadata and returns a retryable error before the final attempt", async () => {
    const events: Array<string> = []
    const nextRetryAt = new Date("2026-01-01T00:05:00.000Z")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({
          jobId: "job-1",
          workerId: "worker-1",
          retryPolicy: {
            attemptNumber: 1,
            maxAttempts: 3,
            nextRetryAt,
          },
        })
      }).pipe(
        Effect.result,
        Effect.provide(makeExecutorLayer({ mode: "sync", failFetch: true, events }))
      )
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("SourceSyncJobRetryableExecutionError")
    }
    expect(events).toContain("failure-metadata:provider unavailable")
    expect(events).toContain("retry:provider unavailable:1:2026-01-01T00:05:00.000Z")
    expect(events).not.toContain("fail:provider unavailable")
  })

  it("maps provider failure into persisted failed job metadata", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(Effect.provide(makeExecutorLayer({ mode: "sync", failFetch: true, events })))
    )

    expect(result.status).toBe("failed")
    expect(result.message).toBe("provider unavailable")
    expect(events).toContain("failure-metadata:provider unavailable")
    expect(events).toContain("fail:provider unavailable")
  })

  it("records a readable message for unsupported sync providers", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({ mode: "sync", sourceProviderKey: "unknown-provider", events })
        )
      )
    )

    expect(result.status).toBe("failed")
    expect(result.message).toBe("Unsupported sync provider: unknown-provider")
    expect(events).toContain("failure-metadata:Unsupported sync provider: unknown-provider")
    expect(events).toContain("fail:Unsupported sync provider: unknown-provider")
  })

  it("marks retryable provider failure failed on the final attempt", async () => {
    const events: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({
          jobId: "job-1",
          workerId: "worker-1",
          retryPolicy: {
            attemptNumber: 3,
            maxAttempts: 3,
            nextRetryAt: new Date("2026-01-01T00:05:00.000Z"),
          },
        })
      }).pipe(Effect.provide(makeExecutorLayer({ mode: "sync", failFetch: true, events })))
    )

    expect(result.status).toBe("failed")
    expect(result.message).toBe("provider unavailable")
    expect(events).toContain("failure-metadata:provider unavailable")
    expect(events).toContain("fail:provider unavailable")
    expect(events).not.toContain("retry:provider unavailable:3:2026-01-01T00:05:00.000Z")
  })

  it("maps execution job load failures to executor errors", async () => {
    const notFound = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.result,
        Effect.provide(
          makeExecutorLayer({ mode: "sync", executionJobFailure: "not-found", events: [] })
        )
      )
    )
    const conflict = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.result,
        Effect.provide(
          makeExecutorLayer({ mode: "sync", executionJobFailure: "conflict", events: [] })
        )
      )
    )
    const payload = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-1" })
      }).pipe(
        Effect.result,
        Effect.provide(
          makeExecutorLayer({ mode: "sync", executionJobFailure: "payload", events: [] })
        )
      )
    )

    expect(notFound._tag).toBe("Failure")
    if (notFound._tag === "Failure") {
      expect(notFound.failure._tag).toBe("SourceSyncJobExecutionNotFoundError")
    }
    expect(conflict._tag).toBe("Failure")
    if (conflict._tag === "Failure") {
      expect(conflict.failure._tag).toBe("SourceSyncJobExecutionConflictError")
    }
    expect(payload._tag).toBe("Failure")
    if (payload._tag === "Failure") {
      expect(payload.failure._tag).toBe("SourceSyncJobExecutionPayloadError")
    }
  })
})
