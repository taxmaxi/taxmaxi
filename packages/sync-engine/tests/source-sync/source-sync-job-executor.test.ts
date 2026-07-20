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
  PrincipalReplayRepository,
  SourceNormalizationRepository,
  SourceProviderRecoverableNormalizationError,
  SourceProviderRegistry,
  SourceRawRecordRepository,
  SourceReplayRepository,
  SourceRepository,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  SourceSyncJobExecutionRecordPayloadError,
  SourceSyncJobExecutor,
  SourceSyncJobRepository,
  SourceSyncStateRepository,
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
  importedRecords: 0,
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

const unusedJobLifecycleMethods = {
  attachQueueMetadata: () => Effect.dieMessage("attachQueueMetadata should not be called"),
  claimJob: () => Effect.dieMessage("claimJob should not be called"),
  heartbeatJob: () => Effect.dieMessage("heartbeatJob should not be called"),
  recordRetryableFailure: () => Effect.dieMessage("recordRetryableFailure should not be called"),
  listStaleActiveJobs: () => Effect.dieMessage("listStaleActiveJobs should not be called"),
  listRepairableActiveJobs: () =>
    Effect.dieMessage("listRepairableActiveJobs should not be called"),
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
  principalReplayPlan,
  principalSources,
  unmatchedReviewIdentities = [],
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
  readonly principalReplayPlan?: {
    readonly runId: string
    readonly principalId: string
    readonly sourceJobs: ReadonlyArray<{
      readonly sourceId: string
      readonly jobId: string
      readonly isCoordinator: boolean
    }>
  }
  readonly principalSources?: ReadonlyArray<SourceSyncSource>
  readonly unmatchedReviewIdentities?: ReadonlyArray<string>
  readonly events: Array<string>
}) => {
  const syncSource = {
    ...source,
    providerKey: sourceProviderKey,
    walletAddress:
      sourceProviderKey === "helius-solana"
        ? "So11111111111111111111111111111111111111112"
        : source.walletAddress,
  }
  const replaySources = principalSources ?? [syncSource]
  const SourceRepositoryTestLive = Layer.succeed(SourceRepository, {
    findOwnedSourceSyncContext: ({ sourceId }) =>
      Effect.succeed(
        Option.fromNullable(replaySources.find((candidate) => candidate.id === sourceId))
      ),
    listPrincipalSourceSyncContexts: () => Effect.succeed(replaySources),
  })

  const SourceSyncJobRepositoryTestLive = Layer.succeed(SourceSyncJobRepository, {
    findActiveJob: () => Effect.dieMessage("findActiveJob should not be called"),
    createOrReuseJob: () => Effect.dieMessage("createOrReuseJob should not be called"),
    attachQueueMetadata: unusedJobLifecycleMethods.attachQueueMetadata,
    recoverStaleActiveJob: () => Effect.dieMessage("recoverStaleActiveJob should not be called"),
    getJob: () => Effect.dieMessage("getJob should not be called"),
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
    heartbeatJob: ({ workerId }) =>
      Effect.sync(() => {
        events.push(`heartbeat:${workerId}`)
      }),
    recordRetryableFailure: ({ message, attemptCount, nextRetryAt }) =>
      Effect.sync(() => {
        events.push(`retry:${message}:${attemptCount}:${nextRetryAt.toISOString()}`)
      }),
    listStaleActiveJobs: unusedJobLifecycleMethods.listStaleActiveJobs,
    listRepairableActiveJobs: unusedJobLifecycleMethods.listRepairableActiveJobs,
    completeJob: ({ state }) =>
      Effect.sync(() => {
        events.push(`complete:${state.importedRecords}:${state.normalizedRecords}`)
        events.push(`failed:${state.failedRecords}`)
      }),
    failJob: ({ message }) =>
      Effect.sync(() => {
        events.push(`fail:${message}`)
      }),
  })

  const SourceSyncStateRepositoryTestLive = Layer.succeed(SourceSyncStateRepository, {
    getExecutionState: () => Effect.succeed(initialExecution),
    persistProgress: ({ state, lastSyncedAt }) =>
      Effect.sync(() => {
        events.push(`progress:${state.importedRecords}:${lastSyncedAt === null ? "open" : "done"}`)
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
    listPrincipalRawRowsForReplay: () => Effect.succeed(replayRawRecords),
    listPendingNormalizationRecordIds: () =>
      Effect.succeed(checkpointRawRecords.map((rawRecord) => rawRecord.id)),
    listRawRecordsByIds: ({ rawRecordIds }) =>
      Effect.succeed(
        [...checkpointRawRecords, ...replayRawRecords].filter((rawRecord) =>
          rawRecordIds.includes(rawRecord.id)
        )
      ),
    listRawRecordsByOccurredAt: () => Effect.succeed([]),
    markRawRecordNormalized: () =>
      Effect.sync(() => {
        events.push("mark-raw-normalized")
      }),
    markRawRecordFailed: ({ message }) =>
      Effect.sync(() => {
        events.push(`mark-raw-failed:${message}`)
      }),
    resetNormalizationStateForSource: () =>
      Effect.dieMessage("resetNormalizationStateForSource should not be called"),
  })

  const makeCoinbaseModule = (): SourceProviderModuleShape => ({
    fetchRawBatch: () =>
      failFetch
        ? Effect.fail(
            new SourceSyncProviderFailureError({
              providerKey: "coinbase",
              message: "provider unavailable",
              retryable: true,
            })
          )
        : Effect.succeed(
            FetchProviderRawBatchResult.make({
              records: fetchedProviderRecords,
              cursorPayload: null,
              highWatermark: null,
              done: true,
            })
          ),
    refreshReferenceData: () =>
      Effect.succeed({
        transactionTypeCatalogCount: 0,
        providerAssetCatalogCount: 0,
        defaultTransactionMappingCount: 0,
        defaultProviderAssetMappingCount: 0,
      }),
    makeRawRecordNormalizer: () =>
      Effect.succeed(({ sourceRecord }) => {
        events.push(`normalize:${sourceRecord.provider}:${sourceRecord.recordType}`)
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
            events.push(`source:${source.id}:normalize:${sourceRecord.externalRecordId}`)

            if (failNormalizeOnce && normalizeAttempts === 1) {
              return yield* Effect.fail(
                new SourceProviderRecoverableNormalizationError({
                  providerKey: "stub-chain",
                  message: "Paired sibling row is not cached yet.",
                })
              )
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
      Effect.sync(() => {
        events.push("reset-derived-state")
      }),
  })

  const PrincipalReplayRepositoryTestLive = Layer.succeed(PrincipalReplayRepository, {
    createOrReuseReplayRun: () => Effect.dieMessage("createOrReuseReplayRun should not be called"),
    findPlanByCoordinatorJobId: () => Effect.succeed(Option.fromNullable(principalReplayPlan)),
    claimPlan: () => Effect.sync(() => events.push("principal:claim")),
    heartbeatPlan: () => Effect.sync(() => events.push("principal:heartbeat")),
    recordRetryableFailure: ({ attemptCount }) =>
      Effect.sync(() => events.push(`principal:retry:${attemptCount}`)),
    failPlan: () => Effect.sync(() => events.push("principal:fail")),
    completePlan: ({ sourceResults }) =>
      Effect.sync(() => events.push(`principal:complete:${sourceResults.length}`)),
    preparePrincipalReplay: () => Effect.sync(() => events.push("principal:prepare")),
    restorePrincipalReviews: () =>
      Effect.sync(() => {
        events.push("principal:restore-reviews")
        return { restoredCount: 0, unmatchedTransactionIdentities: unmatchedReviewIdentities }
      }),
  })

  const SourceNormalizationRepositoryTestLive = Layer.succeed(SourceNormalizationRepository, {
    persistNormalizedArtifacts: () =>
      Effect.dieMessage("persistNormalizedArtifacts should not be called"),
  })

  const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
    reconcileTransferCandidates: () =>
      Effect.succeed({
        evaluatedProviderTransfers: 0,
        pending: 0,
        needsReview: 0,
        autoApplied: 0,
      }),
    applyDeterministicInternalTransferCanonicalization: () =>
      Effect.succeed({ canonicalizedPairs: 0 }),
  })

  return SourceSyncJobExecutorLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncJobRepositoryTestLive),
    Layer.provide(SourceSyncStateRepositoryTestLive),
    Layer.provide(SourceRawRecordRepositoryTestLive),
    Layer.provide(SourceProviderRegistryTestLive),
    Layer.provide(SourceReplayRepositoryTestLive),
    Layer.provide(PrincipalReplayRepositoryTestLive),
    Layer.provide(SourceNormalizationRepositoryTestLive),
    Layer.provide(TransferReconciliationServiceTestLive)
  )
}

describe("SourceSyncJobExecutor", () => {
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
    expect(events).toContain("reset-derived-state")
    expect(events).toContain("heartbeat:source-sync-inline-executor")
    expect(events).toContain("mark-raw-normalized")
    expect(events).toContain("clear-replay-failure-metadata")
    expect(events).toContain("complete:1:1")
  })

  it("replays principal rows in one chronological stream across source child jobs", async () => {
    const events: Array<string> = []
    const sourceA: SourceSyncSource = {
      ...source,
      id: "source-a",
      providerKey: "stub-chain",
    }
    const sourceB: SourceSyncSource = {
      ...source,
      id: "source-b",
      providerKey: "stub-chain",
    }
    const rowB: SourceRawRecord = {
      ...replayRawRecord,
      id: "raw-b",
      sourceId: sourceB.id,
      externalRecordId: "row-b-first",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    }
    const rowA: SourceRawRecord = {
      ...replayRawRecord,
      id: "raw-a",
      sourceId: sourceA.id,
      externalRecordId: "row-a-second",
      occurredAt: new Date("2025-01-02T00:00:00.000Z"),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({ jobId: "job-a" })
      }).pipe(
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            sourceProviderKey: "stub-chain",
            principalSources: [sourceA, sourceB],
            principalReplayPlan: {
              runId: "run-1",
              principalId: source.principalId,
              sourceJobs: [
                { sourceId: sourceA.id, jobId: "job-a", isCoordinator: true },
                { sourceId: sourceB.id, jobId: "job-b", isCoordinator: false },
              ],
            },
            replayRawRecords: [rowB, rowA],
            events,
          })
        )
      )
    )

    expect(result).toMatchObject({
      status: "completed",
      message: "Principal replay finished successfully.",
    })
    expect(
      events.filter((event) => event.startsWith("source:") && event.includes(":normalize:"))
    ).toEqual(["source:source-b:normalize:row-b-first", "source:source-a:normalize:row-a-second"])
    expect(events).toContain("principal:prepare")
    expect(events).toContain("principal:restore-reviews")
    expect(events).toContain("principal:complete:2")
  })

  it("returns every principal child job to pending when a partial replay must retry", async () => {
    const events: Array<string> = []
    const replayPlan = {
      runId: "run-1",
      principalId: source.principalId,
      sourceJobs: [{ sourceId: source.id, jobId: "job-1", isCoordinator: true }],
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* SourceSyncJobExecutor
        return yield* executor.execute({
          jobId: "job-1",
          retryPolicy: {
            attemptNumber: 1,
            maxAttempts: 3,
            nextRetryAt: new Date("2026-01-01T00:05:00.000Z"),
          },
        })
      }).pipe(
        Effect.either,
        Effect.provide(
          makeExecutorLayer({
            mode: "replay",
            principalReplayPlan: replayPlan,
            replayRawRecords: [replayRawRecord],
            unmatchedReviewIdentities: ["source-1:external:missing-reviewed-transaction"],
            events,
          })
        )
      )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SourceSyncJobRetryableExecutionError",
        attemptNumber: 1,
      })
    }
    expect(events).toContain("principal:retry:1")
    expect(events).not.toContain("principal:complete:1")
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
        Effect.either,
        Effect.provide(makeExecutorLayer({ mode: "sync", failFetch: true, events }))
      )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SourceSyncJobRetryableExecutionError")
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
        Effect.either,
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
        Effect.either,
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
        Effect.either,
        Effect.provide(
          makeExecutorLayer({ mode: "sync", executionJobFailure: "payload", events: [] })
        )
      )
    )

    expect(notFound._tag).toBe("Left")
    if (notFound._tag === "Left") {
      expect(notFound.left._tag).toBe("SourceSyncJobExecutionNotFoundError")
    }
    expect(conflict._tag).toBe("Left")
    if (conflict._tag === "Left") {
      expect(conflict.left._tag).toBe("SourceSyncJobExecutionConflictError")
    }
    expect(payload._tag).toBe("Left")
    if (payload._tag === "Left") {
      expect(payload.left._tag).toBe("SourceSyncJobExecutionPayloadError")
    }
  })
})
